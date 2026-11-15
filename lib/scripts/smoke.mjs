#!/usr/bin/env node
// Headless smoke of the library build: serves the bare page on 127.0.0.1,
// drives it in headless Chromium over the DevTools protocol and checks that
// the kernel creates, loads, renders, edits and tears down.
//
//   CHROME_PATH=<chrome or chrome-headless-shell> node lib/scripts/smoke.mjs
//       [--out <dir>] [--scene <file>]... [--deadline <seconds>] [--hardware]
//
// The browser runs with --no-sandbox, so it is only ever pointed at the
// server this script starts. The workload is small and fixed (one viewport
// of 480x360 at device pixel ratio 1, a few thousand gaussians, frames
// rendered on demand) so that it stays cheap on a software adapter.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { DIST_DIR, PAGE_DIST_DIR } from './layout.mjs';

// On a machine without a GPU the WebGPU adapter is software and its work lands
// on the CPU: run at the lowest priority, which the browser inherits.
try {
    os.setPriority(19);
} catch {
    // not permitted here; the run is still bounded by the deadline
}

// Without a GPU the adapter is SwiftShader, and a WebGPU canvas only presents
// when the compositor runs on SwiftShader's Vulkan as well: with the flag for
// the adapter alone, compute passes run but configuring a canvas loses the device.
const SOFTWARE_FLAGS = [
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'
];

const VIEWPORT = { width: 480, height: 360 };
const PAIR_VIEWPORT = { width: 320, height: 240 };
const WINDOW = { width: 720, height: 800 };
const SPIN_FRAMES = 12;
const CYCLES = 3;

// pixel tests: a pixel differs when a channel moved by more than this
const CHANNEL_TOLERANCE = 24;
// share of the viewport that must differ for a change to count as visible,
// and the most that may differ for two frames to count as the same
const CHANGED = 0.01;
const UNCHANGED = 0.004;
// a gizmo is a few thin handles: the least of the viewport one must cover
const GIZMO = 0.002;

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
};
const options = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));

const outDir = path.resolve(option('--out', path.join(DIST_DIR, 'smoke')));
const deadlineSeconds = Number(option('--deadline', '180'));
const extraScenes = options('--scene').map((file) => path.resolve(file));
// --hardware leaves the software flags out, for a machine whose GPU should be used
const hardware = args.includes('--hardware');
const chromePath = process.env.CHROME_PATH;

const started = Date.now();
const summary = {
    ok: false,
    adapter: null,
    checks: [],
    scenes: [],
    observations: {},
    consoleErrors: [],
    screenshots: outDir,
    wallMs: 0
};

let browser = null;

const killBrowser = () => {
    if (browser && browser.pid) {
        try {
            // the browser leads its own process group: this takes the GPU and renderer processes with it
            process.kill(-browser.pid, 'SIGKILL');
        } catch {
            // already gone
        }
        browser = null;
    }
};

const finish = (code) => {
    killBrowser();
    fs.rmSync(path.join(outDir, 'profile'), { recursive: true, force: true });
    summary.wallMs = Date.now() - started;
    summary.ok = code === 0;
    console.log(JSON.stringify(summary, null, 2));
    const adapter = summary.adapter;
    console.log(
        `smoke ${code === 0 ? 'passed' : 'FAILED'} in ${(summary.wallMs / 1000).toFixed(1)} s on ${
            adapter
                ? `${adapter.vendor || 'unknown vendor'} / ${adapter.architecture || 'unknown architecture'} (${
                      adapter.fallback ? 'fallback adapter' : 'not a fallback adapter'
                  })`
                : 'no adapter'
        }`
    );
    process.exit(code);
};

process.on('exit', killBrowser);
process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));
process.on('SIGHUP', () => finish(129));

const deadline = setTimeout(() => {
    summary.checks.push({ id: 'deadline', ok: false, detail: `not finished within ${deadlineSeconds} s` });
    finish(1);
}, deadlineSeconds * 1000);
deadline.unref();

const check = (id, ok, detail) => {
    summary.checks.push({ id, ok: !!ok, detail });
    return !!ok;
};

// scenes

// A unit cube's six faces as a 3DGS PLY, each face a grid of gaussians in its
// own colour, written face after face so a face is a range of file rows.
const syntheticCube = (perSide, colors) => {
    const properties = [
        'x',
        'y',
        'z',
        'f_dc_0',
        'f_dc_1',
        'f_dc_2',
        'opacity',
        'scale_0',
        'scale_1',
        'scale_2',
        'rot_0',
        'rot_1',
        'rot_2',
        'rot_3'
    ];
    const count = 6 * perSide * perSide;
    const header = [
        'ply',
        'format binary_little_endian 1.0',
        `element vertex ${count}`,
        ...properties.map((name) => `property float ${name}`),
        'end_header',
        ''
    ].join('\n');

    const SH_C0 = 0.28209479177387814;
    const scale = Math.log(1.1 / perSide);
    const rows = new Float32Array(count * properties.length);
    let row = 0;
    for (let face = 0; face < 6; face++) {
        const axis = face >> 1;
        const sign = face & 1 ? -1 : 1;
        const [r, g, b] = colors[face];
        for (let i = 0; i < perSide; i++) {
            for (let j = 0; j < perSide; j++) {
                const position = [0, 0, 0];
                position[axis] = sign;
                position[(axis + 1) % 3] = ((i + 0.5) / perSide) * 2 - 1;
                position[(axis + 2) % 3] = ((j + 0.5) / perSide) * 2 - 1;
                rows.set(
                    [
                        ...position,
                        (r - 0.5) / SH_C0,
                        (g - 0.5) / SH_C0,
                        (b - 0.5) / SH_C0,
                        4,
                        scale,
                        scale,
                        scale,
                        1,
                        0,
                        0,
                        0
                    ],
                    row * properties.length
                );
                row++;
            }
        }
    }
    return { bytes: Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(rows.buffer)]), count };
};

const scenes = [];
const addScene = (filename, bytes, expectedCount) => {
    scenes.push({ filename, bytes, expectedCount, url: `/__scenes/${scenes.length}/${filename}` });
    return scenes[scenes.length - 1];
};

const cubeA = syntheticCube(24, [
    [0.9, 0.15, 0.15],
    [0.1, 0.75, 0.8],
    [0.15, 0.75, 0.2],
    [0.8, 0.2, 0.8],
    [0.25, 0.35, 0.9],
    [0.55, 0.35, 0.2]
]);
const cubeB = syntheticCube(16, [
    [0.1, 0.5, 0.3],
    [0.2, 0.7, 0.5],
    [0.1, 0.6, 0.6],
    [0.3, 0.8, 0.4],
    [0.2, 0.4, 0.4],
    [0.4, 0.7, 0.6]
]);
const sceneA = addScene('synthetic-cube-a.ply', cubeA.bytes, cubeA.count);
const sceneB = addScene('synthetic-cube-b.ply', cubeB.bytes, cubeB.count);
const sceneExtras = extraScenes.map((file) => addScene(path.basename(file), fs.readFileSync(file), null));

// server

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };

const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const scene = scenes.find((candidate) => candidate.url === decodeURIComponent(url.pathname));
    if (scene) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(scene.bytes);
        return;
    }

    const file = path.join(PAGE_DIST_DIR, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(PAGE_DIST_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        // browsers ask for a favicon on their own; the page has none
        response.writeHead(url.pathname === '/favicon.ico' ? 204 : 404);
        response.end();
        return;
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    response.end(fs.readFileSync(file));
});

// browser, over the DevTools protocol

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const launch = async () => {
    const profile = path.join(outDir, 'profile');
    fs.rmSync(profile, { recursive: true, force: true });
    fs.mkdirSync(profile, { recursive: true });

    browser = spawn(
        chromePath,
        [
            '--no-sandbox',
            '--enable-unsafe-webgpu',
            ...(hardware ? [] : SOFTWARE_FLAGS),
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            `--window-size=${WINDOW.width},${WINDOW.height}`,
            '--force-device-scale-factor=1',
            '--hide-scrollbars',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            // exact heap figures rather than the bucketed ones pages normally get
            '--enable-precise-memory-info',
            '--enable-logging=stderr',
            'about:blank'
        ],
        // the browser's own log is kept next to the screenshots: when the GPU
        // process fails, the reason is only there
        { stdio: ['ignore', 'ignore', fs.openSync(path.join(outDir, 'browser.log'), 'w')], detached: true }
    );
    browser.on('exit', () => {
        browser = null;
    });

    // the browser writes the port it chose into its profile
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
        await sleep(100);
    }
    if (!fs.existsSync(portFile)) {
        throw new Error('The browser did not open a DevTools port');
    }
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];

    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error('Could not connect to the DevTools socket'));
    });

    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    socket.onmessage = (message) => {
        const data = JSON.parse(message.data);
        if (data.id && pending.has(data.id)) {
            pending.get(data.id)(data);
            pending.delete(data.id);
        } else if (data.method) {
            (listeners.get(data.method) ?? []).forEach((listener) => listener(data.params));
        }
    };

    return {
        send: (method, params = {}) => {
            return new Promise((resolve, reject) => {
                nextId++;
                pending.set(nextId, (data) => {
                    if (data.error) {
                        reject(new Error(`${method}: ${data.error.message}`));
                    } else {
                        resolve(data.result);
                    }
                });
                socket.send(JSON.stringify({ id: nextId, method, params }));
            });
        },
        on: (method, listener) => {
            listeners.set(method, [...(listeners.get(method) ?? []), listener]);
        }
    };
};

// images

// Decodes the PNGs the browser produces (8 bit, RGB or RGBA, not interlaced) to RGBA.
const decodePng = (buffer) => {
    let offset = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    const data = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const body = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            const colorType = body[9];
            if (body[8] !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) {
                throw new Error('Unsupported PNG layout');
            }
            channels = colorType === 6 ? 4 : 3;
        } else if (type === 'IDAT') {
            data.push(body);
        }
        offset += 12 + length;
    }

    const raw = zlib.inflateSync(Buffer.concat(data));
    const stride = width * channels;
    const pixels = new Uint8Array(width * height * 4);
    const line = new Uint8Array(stride);
    const previous = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const start = y * (stride + 1) + 1;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? line[x - channels] : 0;
            const b = previous[x];
            const c = x >= channels ? previous[x - channels] : 0;
            let predicted = 0;
            if (filter === 1) {
                predicted = a;
            } else if (filter === 2) {
                predicted = b;
            } else if (filter === 3) {
                predicted = (a + b) >> 1;
            } else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            line[x] = (raw[start + x] + predicted) & 0xff;
        }
        for (let x = 0; x < width; x++) {
            const target = (y * width + x) * 4;
            pixels[target] = line[x * channels];
            pixels[target + 1] = line[x * channels + 1];
            pixels[target + 2] = line[x * channels + 2];
            pixels[target + 3] = channels === 4 ? line[x * channels + 3] : 255;
        }
        previous.set(line);
    }
    return { width, height, pixels };
};

// the share of pixels a predicate holds for
const share = (image, predicate) => {
    let hits = 0;
    const total = image.width * image.height;
    for (let i = 0; i < total; i++) {
        const o = i * 4;
        if (predicate(image.pixels[o], image.pixels[o + 1], image.pixels[o + 2], i)) {
            hits++;
        }
    }
    return hits / total;
};

// a predicate for the pixels of another screenshot that differ from this one's
const differsFrom = (reference) => (red, green, blue, i) => {
    const o = i * 4;
    return (
        Math.abs(red - reference.pixels[o]) > CHANNEL_TOLERANCE ||
        Math.abs(green - reference.pixels[o + 1]) > CHANNEL_TOLERANCE ||
        Math.abs(blue - reference.pixels[o + 2]) > CHANNEL_TOLERANCE
    );
};

// the share of the viewport that differs between two screenshots
const difference = (a, b) => {
    if (a.width !== b.width || a.height !== b.height) {
        return 1;
    }
    return share(a, differsFrom(b));
};

const percent = (value) => `${(value * 100).toFixed(2)}%`;

// the viewport background is the scene config's default background, black
const isLit = (red, green, blue) => Math.max(red, green, blue) > 24;
// the default selection colour is yellow
const isYellow = (red, green, blue) => red > 170 && green > 170 && blue < 120;
const isBlue = (red, green, blue) => blue > 140 && blue > red + 60 && blue > green + 30;
const isOrange = (red, green, blue) => red > 170 && green > 60 && green < 170 && blue < 90;
const isGreen = (red, green, blue) => green > 140 && green > red + 60 && green > blue + 60;
const isWhite = (red, green, blue) => red > 200 && green > 200 && blue > 200;

// code that runs in the page (serialised: it cannot see this module's scope)

const inPage = {
    ready: () => typeof globalThis.__page === 'object',

    configure: (size) => globalThis.__page.configure(size),

    create: async (slot) => (await globalThis.__page.create(slot)).adapter,

    load: async (slot, url, filename, loadOptions) => {
        const page = globalThis.__page;
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const result = await page.load(slot, filename, bytes, loadOptions);
        const core = page.core(slot);
        const splat = core.scene.getElementsByType(page.lib.ElementType.splat)[0];
        const { source } = splat.resource;
        return {
            ...result,
            frames: page.stats(slot).frames,
            layers: core.editor.layers.list().length,
            permuted: source instanceof page.lib.PermutedChunkSource,
            orderLength: source instanceof page.lib.PermutedChunkSource ? source.order.length : null
        };
    },

    rect: (slot) => globalThis.__page.rect(slot),

    settle: (slot) => globalThis.__page.settle(slot, 3),

    spin: (slot, frames) => globalThis.__page.spin(slot, { frames }),

    // show the selection the two ways a host can: tinted gaussians and an outline
    selectionView: async (slot, on) => {
        const page = globalThis.__page;
        const { events } = page.core(slot);
        events.fire('view.setOutlineSelection', on);
        events.fire('view.setSelectionColor', on);
        await page.settle(slot, 3);
    },

    // select the first half of the gaussians by index, through the edit history
    selectHalf: async (slot) => {
        const page = globalThis.__page;
        const core = page.core(slot);
        const splat = core.events.invoke('selection');
        const indices = new Uint32Array(Math.floor(splat.instances.count / 2));
        for (let i = 0; i < indices.length; i++) {
            indices[i] = i;
        }
        await core.editHistory.add(new page.lib.SelectOp(splat, 'set', indices));
        await page.settle(slot, 3);
        return { requested: indices.length, selected: splat.numSelected, historyCursor: core.editHistory.cursor };
    },

    hide: async (slot) => {
        const page = globalThis.__page;
        const core = page.core(slot);
        const result = await core.editor.selection.hide();
        await page.settle(slot, 3);
        return { affected: result.affected, hidden: result.layers[0].hidden };
    },

    undo: async (slot) => {
        const page = globalThis.__page;
        const core = page.core(slot);
        const result = await core.editor.history.undo();
        await page.settle(slot, 3);
        const splat = core.events.invoke('selection');
        return { changed: result.changed, hidden: splat.numLocked, selected: splat.numSelected };
    },

    // move the selected gaussians up by a good part of the scene's size
    transform: async (slot) => {
        const page = globalThis.__page;
        const core = page.core(slot);
        const splat = core.events.invoke('selection');
        const radius = core.scene.bound.halfExtents.length();
        const result = await core.editor.transform(splat.uid, 'selection', {
            translate: new page.pc.Vec3(0, radius * 0.5, 0)
        });
        await page.settle(slot, 3);
        return { affected: result.affected };
    },

    // the editor API's scene summary: it queries most of the state the kernel keeps on the bus
    inspect: async (slot) => {
        const scene = await globalThis.__page.core(slot).editor.inspect.scene();
        return {
            layers: scene.layers.length,
            unsavedChanges: scene.document.unsavedChanges,
            canUndo: scene.history.canUndo,
            timelineFrames: scene.timeline.frames
        };
    },

    clearSelection: async (slot) => {
        const page = globalThis.__page;
        await page.core(slot).editor.selection.none();
        await page.settle(slot, 3);
    },

    // a filled quad facing the camera, in front of the scene but inside its
    // bound (the camera fits its clip planes to the bound), with a line and a
    // dot above it: upstream biases a line behind a fill in the same plane,
    // so one drawn across an opaque fill would be hidden by it
    overlay: async (slot, fillColor) => {
        const page = globalThis.__page;
        const core = page.core(slot);
        const { bound, camera } = core.scene;
        const radius = bound.halfExtents.length();
        const toEye = camera.position.clone().sub(bound.center).normalize();
        const origin = bound.center.clone().add(toEye.mulScalar(radius * 0.87));
        const right = camera.worldTransform.getX().normalize();
        const up = camera.worldTransform.getY().normalize();
        const corner = (x, y) => {
            return origin
                .clone()
                .add(right.clone().mulScalar(x * radius * 0.14))
                .add(up.clone().mulScalar(y * radius * 0.14));
        };
        const [a, b, c, d] = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];

        const overlay = new page.lib.ToolOverlay();
        if (fillColor) {
            overlay.fillColor = fillColor;
        }
        const [from, to, mark] = [corner(-1, 1.5), corner(1, 1.5), corner(0, 2)];
        overlay.provider = (writer) => {
            writer.fill(a, b, c);
            writer.fill(a, c, d);
            writer.segment(from, to);
            writer.dot(mark);
        };
        await core.scene.add(overlay);
        await page.settle(slot, 3);
        globalThis.__overlays = { ...globalThis.__overlays, [slot]: overlay };
    },

    tool: async (slot, name) => {
        const page = globalThis.__page;
        const core = page.core(slot);
        if (core.tools.active !== name) {
            core.tools.activate(name);
        }
        await page.settle(slot, 3);
        return core.tools.active;
    },

    // what a gizmo drag does, without the pointer: the tools move the pivot,
    // and the transform handler moves the layer with it and records the edit
    movePivot: async (slot) => {
        const page = globalThis.__page;
        const core = page.core(slot);
        const splat = core.events.invoke('selection');
        const pivot = core.events.invoke('pivot');
        const distance = core.scene.bound.halfExtents.length() * 0.4;
        const before = splat.entity.getLocalPosition().y;
        const cursor = core.editHistory.cursor;
        const { position, rotation, scale } = pivot.transform;
        pivot.start();
        pivot.moveTRS(new page.pc.Vec3(position.x, position.y + distance, position.z), rotation, scale);
        pivot.end();
        await page.settle(slot, 3);
        return {
            distance,
            moved: splat.entity.getLocalPosition().y - before,
            recorded: core.editHistory.cursor - cursor
        };
    },

    layerHeight: (slot) => globalThis.__page.core(slot).events.invoke('selection').entity.getLocalPosition().y,

    // a fill colour set while the overlay is in the scene
    overlayColor: async (slot, fillColor) => {
        const page = globalThis.__page;
        globalThis.__overlays[slot].fillColor = fillColor;
        await page.settle(slot, 3);
    },

    // the fill moved from among the gaussians to over the rendered scene
    overlayOnTop: async (slot, fillColor) => {
        const page = globalThis.__page;
        const overlay = globalThis.__overlays[slot];
        overlay.fillColor = fillColor;
        overlay.fillOnTop = true;
        await page.settle(slot, 3);
    },

    removeOverlay: async (slot) => {
        const page = globalThis.__page;
        globalThis.__overlays[slot].destroy();
        delete globalThis.__overlays[slot];
        await page.settle(slot, 3);
    },

    // what the unload prompt would do: the page's listeners decide through returnValue
    beforeUnload: (slot) => {
        const core = slot ? globalThis.__page.core(slot) : null;
        const event = globalThis.document.createEvent('BeforeUnloadEvent');
        event.initEvent('beforeunload', false, true);
        globalThis.dispatchEvent(event);
        return {
            historyCursor: core ? core.editHistory.cursor : null,
            blocks: event.returnValue !== '' || event.defaultPrevented
        };
    },

    // createCore where the browser has no WebGPU: it must reject and leave the canvas without a context
    withoutWebGpu: async () => {
        const { document, navigator } = globalThis;
        const container = document.createElement('div');
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        document.body.appendChild(container);

        // an own property shadows the prototype's getter until it is deleted again
        Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
        let message = null;
        try {
            await globalThis.__page.lib.createCore({ canvas, container });
        } catch (error) {
            message = error.message;
        } finally {
            delete navigator.gpu;
        }
        // a canvas hands out a 2d context only while it has no other
        const untouched = canvas.getContext('2d') !== null;
        container.remove();
        return { message, untouched, restored: !!navigator.gpu };
    },

    // loads that must reject: aborted before and during the load, and bytes that are no scene
    rejectedLoads: async (slot, url, filename) => {
        const page = globalThis.__page;
        const core = page.core(slot);
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const layers = () => core.editor.layers.list().length;
        const outcome = async (promise) => {
            try {
                await promise;
                return 'resolved';
            } catch (error) {
                return `${error.name}: ${error.message}`;
            }
        };

        const before = layers();
        const aborted = new AbortController();
        aborted.abort();
        const abortedBefore = await outcome(core.load(filename, bytes, { signal: aborted.signal }));
        const aborting = new AbortController();
        const pending = core.load(filename, bytes, { signal: aborting.signal });
        aborting.abort();
        const abortedDuring = await outcome(pending);
        const garbage = await outcome(core.load('garbage.ply', new Uint8Array(4096).fill(7)));
        await page.settle(slot, 1);
        return { before, after: layers(), abortedBefore, abortedDuring, garbage };
    },

    // an instance destroyed while its load is in flight
    destroyedDuringLoad: async (slot, url, filename) => {
        const page = globalThis.__page;
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        await page.create(slot);
        const pending = page.core(slot).load(filename, bytes);
        page.destroy(slot);
        try {
            await pending;
            return 'resolved';
        } catch (error) {
            return `${error.name}: ${error.message}`;
        }
    },

    // two instances created with different overrides must not share a config
    configs: (first, second) => {
        const page = globalThis.__page;
        const a = page.core(first).scene.config;
        const b = page.core(second).scene.config;
        return {
            shared: a === b || a.show === b.show,
            gridA: a.show.grid,
            gridB: b.show.grid,
            fovA: a.camera.fov,
            fovB: b.camera.fov
        };
    },

    createWith: async (slot, config) => (await globalThis.__page.create(slot, config)).adapter,

    // destroys the instance, keeping weak references to its scene and to the
    // data of its splats to see whether they are released, and its device to
    // see what the device still lists
    destroy: (slot) => {
        const page = globalThis.__page;
        const { scene } = page.core(slot);
        const watch = (globalThis.__watch ??= { weak: [], devices: [] });
        watch.weak.push(['scene', new WeakRef(scene)]);
        for (const splat of scene.getElementsByType(page.lib.ElementType.splat)) {
            watch.weak.push(['splat data', new WeakRef(splat.resource.source)]);
        }
        watch.devices.push(scene.graphicsDevice);
        page.destroy(slot);
        // as a host must: an element it added still names the engine objects
        // of the instance it was in, and would keep the scene alive
        delete globalThis.__overlays?.[slot];
        return page.slots();
    },

    // what the devices destroyed since the last call still list; they are let
    // go of here, so that the watch itself keeps nothing alive
    leftovers: () => {
        const devices = globalThis.__watch?.devices.splice(0) ?? [];
        return devices.reduce(
            (sum, device) => sum + device.textures.size + device.buffers.size + device.targets.size,
            0
        );
    },

    released: () =>
        (globalThis.__watch?.weak ?? []).map(([kind, ref]) => ({ kind, released: ref.deref() === undefined })),

    errors: () => globalThis.__page.errors(),

    heap: () => globalThis.performance.memory?.usedJSHeapSize ?? null
};

// run

const main = async () => {
    if (!chromePath || !fs.existsSync(chromePath)) {
        throw new Error('Set CHROME_PATH to a Chrome or chrome-headless-shell binary');
    }
    if (!fs.existsSync(path.join(PAGE_DIST_DIR, 'index.html'))) {
        throw new Error('The page is not built: run node lib/scripts/build.mjs first');
    }
    fs.mkdirSync(outDir, { recursive: true });

    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    const cdp = await launch();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('HeapProfiler.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: WINDOW.width,
        height: WINDOW.height,
        deviceScaleFactor: 1,
        mobile: false
    });

    // everything the page reports as an error, with the phase it happened in
    let phase = 'start';
    const errors = [];
    const report = (text) => {
        errors.push({ phase, text });
        summary.consoleErrors.push(`[${phase}] ${text}`);
    };
    cdp.on('Runtime.consoleAPICalled', ({ type, args: values }) => {
        if (type === 'error' || type === 'assert') {
            report(values.map((value) => value.value ?? value.description ?? '').join(' '));
        }
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        report(exceptionDetails.exception?.description ?? exceptionDetails.text);
    });
    cdp.on('Log.entryAdded', ({ entry }) => {
        if (entry.level === 'error') {
            report(`${entry.source}: ${entry.text}`);
        }
    });
    let dialogs = 0;
    cdp.on('Page.javascriptDialogOpening', () => {
        dialogs++;
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {
            // the dialog is already gone
        });
    });

    const evaluate = async (fn, ...values) => {
        const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
            expression: `(${fn})(...${JSON.stringify(values)})`,
            awaitPromise: true,
            returnByValue: true
        });
        if (exceptionDetails) {
            throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        }
        return result.value;
    };

    const open = async () => {
        const loaded = new Promise((resolve) => {
            cdp.on('Page.loadEventFired', resolve);
        });
        await cdp.send('Page.navigate', { url: `${origin}/index.html` });
        await loaded;
        for (let i = 0; i < 100 && !(await evaluate(inPage.ready)); i++) {
            await sleep(100);
        }
    };

    const screenshot = async (slot, name) => {
        const { x, y, width, height } = await evaluate(inPage.rect, slot);
        const { data } = await cdp.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x, y, width, height, scale: 1 }
        });
        const buffer = Buffer.from(data, 'base64');
        fs.writeFileSync(path.join(outDir, `${name}.png`), buffer);
        return decodePng(buffer);
    };

    // a group of checks on a freshly opened page; a throw fails the group, not the run
    // twice: what the first pass finalizes, the second can collect
    const collect = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        await cdp.send('HeapProfiler.collectGarbage');
    };

    const describeReleased = (released) => {
        const kinds = [...new Set(released.map((entry) => entry.kind))];
        return kinds
            .map((kind) => {
                const ofKind = released.filter((entry) => entry.kind === kind);
                return `${ofKind.filter((entry) => entry.released).length} of ${ofKind.length} ${kind}`;
            })
            .join(', ');
    };

    const group = async (name, run) => {
        phase = name;
        const before = errors.length;
        let recorded = [];
        try {
            await open();
            await run();
        } catch (error) {
            check(`${name}: completed`, false, error.message);
        }
        try {
            // the page keeps its own list: protocol events can arrive after
            // the reply to the call that caused them
            recorded = await evaluate(inPage.errors);
        } catch {
            // the page is gone; the protocol's events are what there is
        }
        await sleep(250);
        const found = [...new Set([...recorded, ...errors.slice(before).map((error) => error.text)])];
        check(
            `${name}: no console errors or uncaught exceptions`,
            found.length === 0,
            found.length === 0 ? 'none' : found.slice(0, 5).join(' | ')
        );
    };

    // (a) create and load, then (e) the editing subsystems, on one scene
    const sceneChecks = async (scene, tag) => {
        const entry = { file: scene.filename, timings: {} };
        summary.scenes.push(entry);

        await evaluate(inPage.configure, VIEWPORT);
        let mark = Date.now();
        const adapter = await evaluate(inPage.create, 'main');
        entry.timings.createMs = Date.now() - mark;
        summary.adapter ??= adapter;

        // file order, so that an index range is a known part of the scene
        mark = Date.now();
        const loaded = await evaluate(inPage.load, 'main', scene.url, scene.filename, { reorder: false });
        entry.timings.loadMs = Date.now() - mark;
        entry.count = loaded.count;
        entry.load = loaded.load;
        check(
            `${tag}: create and load`,
            loaded.count > 0 &&
                (scene.expectedCount === null || loaded.count === scene.expectedCount) &&
                loaded.layers === 1 &&
                !loaded.permuted,
            `${loaded.count} gaussians${scene.expectedCount === null ? '' : ` (expected ${scene.expectedCount})`}, ${loaded.layers} layer, file order kept: ${!loaded.permuted}`
        );
        check(`${tag}: frames rendered`, loaded.frames > 0, `${loaded.frames} frames`);

        const base = await screenshot('main', `${tag}-1-loaded`);
        const lit = share(base, isLit);
        check(`${tag}: screenshot shows the scene`, lit > 0.02, `${percent(lit)} of the viewport is not background`);

        entry.spin = await evaluate(inPage.spin, 'main', SPIN_FRAMES);
        await evaluate(inPage.settle, 'main');

        // selection, through upstream's SelectOp and the edit history
        await evaluate(inPage.selectionView, 'main', true);
        const unselected = await screenshot('main', `${tag}-2-unselected`);
        const selection = await evaluate(inPage.selectHalf, 'main');
        const selected = await screenshot('main', `${tag}-3-selected`);
        const yellow = share(selected, isYellow) - share(unselected, isYellow);
        check(
            `${tag}: selecting gaussians by index shows`,
            selection.selected === selection.requested &&
                difference(selected, unselected) > CHANGED &&
                yellow > CHANGED / 2,
            `${selection.selected} of ${selection.requested} selected, ${percent(difference(selected, unselected))} of the viewport changed, ${percent(yellow)} turned to the selection colour`
        );

        // hide, through upstream's HideSelectionOp and the edit history, and undo
        const hidden = await evaluate(inPage.hide, 'main');
        const hiddenShot = await screenshot('main', `${tag}-4-hidden`);
        check(
            `${tag}: hiding the selection shows`,
            hidden.hidden === selection.selected && difference(hiddenShot, selected) > CHANGED,
            `${hidden.hidden} hidden, ${percent(difference(hiddenShot, selected))} of the viewport changed`
        );
        const undone = await evaluate(inPage.undo, 'main');
        const undoneShot = await screenshot('main', `${tag}-5-hide-undone`);
        check(
            `${tag}: undo restores the hidden gaussians`,
            undone.changed && undone.hidden === 0 && difference(undoneShot, selected) < UNCHANGED,
            `${undone.hidden} hidden after undo, ${percent(difference(undoneShot, selected))} of the viewport differs from before the hide`
        );

        // transform, through upstream's SplatsTransformOp
        const moved = await evaluate(inPage.transform, 'main');
        const movedShot = await screenshot('main', `${tag}-6-moved`);
        check(
            `${tag}: transforming the selection moves it`,
            moved.affected === selection.selected && difference(movedShot, undoneShot) > CHANGED,
            `${moved.affected} gaussians moved, ${percent(difference(movedShot, undoneShot))} of the viewport changed`
        );
        await evaluate(inPage.undo, 'main');

        const inspected = await evaluate(inPage.inspect, 'main');
        check(
            `${tag}: the editor API reads the scene, with nothing unsaved after edits`,
            inspected.layers === 1 && inspected.canUndo && !inspected.unsavedChanges && inspected.timelineFrames > 0,
            `${inspected.layers} layer, undo available: ${inspected.canUndo}, unsaved changes: ${inspected.unsavedChanges}, timeline of ${inspected.timelineFrames} frames`
        );

        // tool overlay with a fill colour of the caller's
        await evaluate(inPage.clearSelection, 'main');
        await evaluate(inPage.selectionView, 'main', false);
        const plain = await screenshot('main', `${tag}-7-before-overlay`);
        await evaluate(inPage.overlay, 'main', [0, 0.35, 1, 1]);
        const overlaid = await screenshot('main', `${tag}-8-overlay`);
        const changed = differsFrom(plain);
        const drawn = share(overlaid, changed);
        const blue = share(overlaid, (r, g, b, i) => changed(r, g, b, i) && isBlue(r, g, b));
        const orange = share(overlaid, (r, g, b, i) => changed(r, g, b, i) && isOrange(r, g, b));
        const white = share(overlaid, (r, g, b, i) => changed(r, g, b, i) && isWhite(r, g, b));
        check(
            `${tag}: tool overlay draws its fill in the colour set and its line`,
            drawn > CHANGED && blue > drawn * 0.6 && orange < drawn * 0.02 && white > 0.0005,
            `${percent(drawn)} of the viewport drawn over: ${percent(blue)} in the fill colour set, ${percent(orange)} in upstream's default orange, ${percent(white)} white line and dot`
        );
        await evaluate(inPage.overlayColor, 'main', [0.1, 0.8, 0.2, 1]);
        const recoloured = await screenshot('main', `${tag}-9-overlay-recoloured`);
        const green = share(recoloured, (r, g, b, i) => changed(r, g, b, i) && isGreen(r, g, b));
        check(
            `${tag}: a fill colour set on a live overlay takes effect`,
            green > drawn * 0.6,
            `${percent(green)} of the viewport in the new fill colour`
        );
        // The same fill at half strength, drawn over the scene: every pixel
        // the opaque fill covered is now a tint of what lies under it. Among
        // the gaussians, half of them would be left exactly as they were.
        await evaluate(inPage.overlayOnTop, 'main', [0.1, 0.8, 0.2, 0.5]);
        const tinted = await screenshot('main', `${tag}-9b-overlay-on-top`);
        const opaque = differsFrom(recoloured);
        const tint = share(tinted, (r, g, b, i) => {
            const o = i * 4;
            const [fr, fg, fb] = [recoloured.pixels[o], recoloured.pixels[o + 1], recoloured.pixels[o + 2]];
            return changed(fr, fg, fb, i) && isGreen(fr, fg, fb) && changed(r, g, b, i) && opaque(r, g, b, i);
        });
        check(
            `${tag}: a translucent fill drawn on top tints all that it covers`,
            tint > green * 0.9,
            `${percent(tint)} of the viewport tinted, of the ${percent(green)} the opaque fill covered`
        );
        await evaluate(inPage.removeOverlay, 'main');
        const removed = await screenshot('main', `${tag}-10-overlay-removed`);
        check(
            `${tag}: removing the overlay clears it`,
            difference(removed, plain) < UNCHANGED,
            `${percent(difference(removed, plain))} of the viewport differs from before the overlay`
        );

        // the move and rotate tools: their gizmos, and the pivot path a drag takes
        const height = await evaluate(inPage.layerHeight, 'main');
        await evaluate(inPage.tool, 'main', 'move');
        const moveGizmo = await screenshot('main', `${tag}-11-move-tool`);
        const dragged = await evaluate(inPage.movePivot, 'main');
        const draggedShot = await screenshot('main', `${tag}-12-pivot-moved`);
        check(
            `${tag}: the move tool shows its gizmo and moving its pivot moves the layer`,
            difference(moveGizmo, removed) > GIZMO &&
                Math.abs(dragged.moved - dragged.distance) < dragged.distance * 0.01 &&
                dragged.recorded === 1 &&
                difference(draggedShot, moveGizmo) > CHANGED,
            `gizmo covers ${percent(difference(moveGizmo, removed))} of the viewport; layer moved ${dragged.moved.toFixed(4)} of ${dragged.distance.toFixed(4)}, ${dragged.recorded} edit recorded, ${percent(difference(draggedShot, moveGizmo))} of the viewport changed`
        );
        await evaluate(inPage.undo, 'main');
        const restored = await evaluate(inPage.layerHeight, 'main');
        await evaluate(inPage.tool, 'main', 'rotate');
        const rotateGizmo = await screenshot('main', `${tag}-13-rotate-tool`);
        const active = await evaluate(inPage.tool, 'main', null);
        const idle = await screenshot('main', `${tag}-14-tools-off`);
        check(
            `${tag}: undo puts the layer back, the rotate tool shows its gizmo and deactivating clears it`,
            Math.abs(restored - height) < 1e-4 &&
                difference(rotateGizmo, removed) > GIZMO &&
                active === null &&
                difference(idle, removed) < UNCHANGED,
            `layer back at its height: ${Math.abs(restored - height) < 1e-4}; rotate gizmo covers ${percent(difference(rotateGizmo, removed))} of the viewport; ${percent(difference(idle, removed))} differs once the tools are off`
        );
    };

    await group('synthetic', async () => {
        const refused = await evaluate(inPage.withoutWebGpu);
        check(
            'synthetic: createCore rejects where WebGPU is missing and leaves the canvas alone',
            /WebGPU is not available/.test(refused.message ?? '') && refused.untouched && refused.restored,
            `rejected with "${refused.message}", canvas left without a context: ${refused.untouched}`
        );

        await sceneChecks(sceneA, 'synthetic');

        const rejected = await evaluate(inPage.rejectedLoads, 'main', sceneB.url, sceneB.filename);
        check(
            'synthetic: aborted and unreadable loads reject and leave nothing in the scene',
            rejected.abortedBefore.startsWith('AbortError') &&
                rejected.abortedDuring.startsWith('AbortError') &&
                rejected.garbage !== 'resolved' &&
                rejected.after === rejected.before,
            `aborted before: ${rejected.abortedBefore}; aborted during: ${rejected.abortedDuring}; not a scene: ${rejected.garbage}; layers ${rejected.before} -> ${rejected.after}`
        );
        const orphaned = await evaluate(inPage.destroyedDuringLoad, 'orphan', sceneB.url, sceneB.filename);
        check('synthetic: destroying an instance rejects its load in flight', /destroyed/.test(orphaned), orphaned);

        // (c) the unload prompt, with edits in history and after destroy
        await evaluate(inPage.selectHalf, 'main');
        const live = await evaluate(inPage.beforeUnload, 'main');
        check(
            'synthetic: edits in history do not block unload',
            live.historyCursor > 0 && !live.blocks,
            `history cursor ${live.historyCursor}, unload blocked: ${live.blocks}`
        );
        await evaluate(inPage.destroy, 'main');
        const dead = await evaluate(inPage.beforeUnload, null);
        check('synthetic: a destroyed instance does not block unload', !dead.blocks, `unload blocked: ${dead.blocks}`);

        // Nothing is live on the page now, which is the case that shows what
        // a destroyed instance is still held by: with another one drawing,
        // the engine lets go of the previous one by itself.
        const listed = await evaluate(inPage.leftovers);
        check(
            'synthetic: destroy leaves no GPU resource to the garbage collector',
            listed === 0,
            `${listed} textures, buffers and render targets still listed on the destroyed device`
        );
        await collect();
        const alone = await evaluate(inPage.released);
        check(
            'synthetic: a destroyed instance is released with no other on the page',
            alone.length > 1 && alone.every((entry) => entry.released),
            `garbage collected: ${describeReleased(alone)}`
        );

        // (c) destroy, create and load again
        const heap = [];
        for (let i = 1; i <= CYCLES; i++) {
            await evaluate(inPage.create, 'main');
            // the loader's default order this time: gaussians are reordered on load
            const loaded = await evaluate(inPage.load, 'main', sceneA.url, sceneA.filename, {});
            const shot = await screenshot('main', `synthetic-cycle-${i}`);
            const lit = share(shot, isLit);
            check(
                `synthetic: cycle ${i} creates, loads and renders again`,
                loaded.count === sceneA.expectedCount && lit > 0.02 && loaded.permuted,
                `${loaded.count} gaussians, ${percent(lit)} of the viewport is not background, reordered with a ${loaded.orderLength}-row permutation exposed: ${loaded.permuted}`
            );
            if (i < CYCLES) {
                await evaluate(inPage.destroy, 'main');
                await cdp.send('HeapProfiler.collectGarbage');
                heap.push(await evaluate(inPage.heap));
            }
        }
        summary.observations.heapBytesAfterEachDestroy = heap;
        await evaluate(inPage.leftovers);
        await collect();
        const released = await evaluate(inPage.released);
        check(
            'synthetic: destroyed instances are released',
            released.length > 0 && released.every((entry) => entry.released),
            `garbage collected: ${describeReleased(released)}`
        );

        // (c) navigating away with edits in the history of a live instance,
        // after a click (browsers only prompt on pages the user interacted with)
        await evaluate(inPage.selectHalf, 'main');
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 8, y: 8, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: 8,
            y: 8,
            button: 'left',
            clickCount: 1
        });
        dialogs = 0;
        await open();
        check('synthetic: navigation after edits is not blocked', dialogs === 0, `${dialogs} unload prompts`);
    });

    // (d) two instances on one page
    await group('two instances', async () => {
        await evaluate(inPage.configure, PAIR_VIEWPORT);
        await evaluate(inPage.createWith, 'a', { show: { grid: false }, camera: { fov: 60 } });
        await evaluate(inPage.createWith, 'b', undefined);
        const configs = await evaluate(inPage.configs, 'a', 'b');
        check(
            'two instances: each has its own scene config',
            !configs.shared &&
                configs.gridA === false &&
                configs.gridB === true &&
                configs.fovA === 60 &&
                configs.fovB === 85,
            `grid ${configs.gridA} and ${configs.gridB}, fov ${configs.fovA} and ${configs.fovB}, shared object: ${configs.shared}`
        );
        const loadedA = await evaluate(inPage.load, 'a', sceneA.url, sceneA.filename, { reorder: false });
        const loadedB = await evaluate(inPage.load, 'b', sceneB.url, sceneB.filename, { reorder: false });
        const a1 = await screenshot('a', 'pair-1-a');
        const b1 = await screenshot('b', 'pair-1-b');
        check(
            'two instances: each loads and renders its own scene',
            loadedA.count === sceneA.expectedCount &&
                loadedB.count === sceneB.expectedCount &&
                share(a1, isLit) > 0.02 &&
                share(b1, isLit) > 0.02 &&
                difference(a1, b1) > CHANGED,
            `${loadedA.count} and ${loadedB.count} gaussians, ${percent(share(a1, isLit))} and ${percent(share(b1, isLit))} of the viewports not background, ${percent(difference(a1, b1))} differs between them`
        );

        // an edit and an overlay in the first instance, which is not the one
        // the engine ticked last, must stay in the first
        await evaluate(inPage.selectionView, 'a', true);
        await evaluate(inPage.selectHalf, 'a');
        await evaluate(inPage.overlay, 'a', [0, 0.35, 1, 1]);
        await evaluate(inPage.settle, 'b');
        const a2 = await screenshot('a', 'pair-2-a-edited');
        const b2 = await screenshot('b', 'pair-2-b-untouched');
        const changed = differsFrom(a1);
        const blue = share(a2, (r, g, b, i) => changed(r, g, b, i) && isBlue(r, g, b));
        check(
            'two instances: an edit and an overlay in one stay in that one',
            difference(a2, a1) > CHANGED && blue > 0.005 && difference(b2, b1) < UNCHANGED,
            `first instance: ${percent(difference(a2, a1))} of the viewport changed, ${percent(blue)} in the overlay's fill colour; second instance: ${percent(difference(b2, b1))} changed`
        );

        await evaluate(inPage.destroy, 'a');
        await evaluate(inPage.settle, 'b');
        const b3 = await screenshot('b', 'pair-3-b-after-a-destroyed');
        check(
            'two instances: destroying one leaves the other rendering',
            difference(b3, b1) < UNCHANGED && share(b3, isLit) > 0.02,
            `${percent(difference(b3, b1))} of the surviving viewport changed`
        );
        await evaluate(inPage.destroy, 'b');
        const listed = await evaluate(inPage.leftovers);
        await collect();
        const released = await evaluate(inPage.released);
        check(
            'two instances: both are released once destroyed',
            listed === 0 && released.length > 0 && released.every((entry) => entry.released),
            `${listed} GPU resources still listed on the destroyed devices; garbage collected: ${describeReleased(released)}`
        );
    });

    // the same create, load and editing checks on the scenes given on the command line
    for (const [index, scene] of sceneExtras.entries()) {
        await group(`scene ${index + 1} (${scene.filename})`, async () => {
            await sceneChecks(scene, `scene-${index + 1}`);
            await evaluate(inPage.destroy, 'main');
        });
    }

    return summary.checks.every((result) => result.ok) ? 0 : 1;
};

main()
    .then(finish)
    .catch((error) => {
        check('smoke: ran to the end', false, error.message);
        finish(1);
    });
