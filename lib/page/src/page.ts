// The bare page of the library build: the manual check on a desktop or a
// phone, and the page the headless smoke drives through window.__page. It
// consumes the built library the way any host does.

// 'supersplat-lib' is the built library: lib/tsconfig.json maps it to the
// declarations and the page's bundler to the bundle. The lint's resolver reads
// only the root tsconfig.json, which has no such mapping.
/* eslint-disable import-x/no-unresolved */
import { Color, Mat4, Quat, Vec3 } from 'playcanvas';
import * as lib from 'supersplat-lib';
import type { Core, CoreOptions, LoadOptions } from 'supersplat-lib';
/* eslint-enable import-x/no-unresolved */

type AdapterInfo = {
    description: string;
    vendor: string;
    architecture: string;
    fallback: boolean | null;
};

type LoadTimings = {
    readDecodeMs: number;
    sortMs: number;
    uploadMs: number;
    addMs: number;
    totalMs: number;
};

type SpinResult = {
    frames: number;
    medianMs: number;
    p95Ms: number;
    // the kernel's own per-frame timings over the same frames
    kernel: { cpuMedianMs: number; gpuMedianMs: number | null; width: number; height: number };
};

type Slot = {
    id: string;
    container: HTMLDivElement;
    core: Core;
    adapter: AdapterInfo;
    frames: number;
    filename: string | null;
    count: number | null;
    load: LoadTimings | null;
    spin: SpinResult | null;
};

const MAIN = 'main';

// longest a wait for a rendered frame or a spin may last, so a stalled render
// loop (a hidden tab) surfaces as an error instead of a page that hangs
const FRAME_TIMEOUT_MS = 20000;
const SPIN_LIMIT_MS = 60000;

const slots = new Map<string, Slot>();
let fixedSize: { width: number; height: number } | null = null;
let lastFile: File | null = null;
let heapSamples: (number | null)[] = [];

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const log = (text: string) => {
    const target = element<HTMLPreElement>('log');
    target.textContent += `${text}\n`;
    target.scrollTop = target.scrollHeight;
};

// everything the page saw go wrong, for the log on the page and for scripts
const errors: string[] = [];

const logError = (text: string) => {
    errors.push(text);
    log(`error: ${text}`);
};

const median = (values: number[]) => {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

const percentile = (values: number[], p: number) => {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const round = (value: number) => Math.round(value * 10) / 10;

// usedJSHeapSize is Chromium's; other browsers have no synchronous heap figure
const heapBytes = () => {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return memory ? memory.usedJSHeapSize : null;
};

const slotOf = (id: string) => {
    const slot = slots.get(id);
    if (!slot) {
        throw new Error(`No instance in slot '${id}'`);
    }
    return slot;
};

const adapterOf = (core: Core): AdapterInfo => {
    const device = core.scene.graphicsDevice as unknown as {
        gpuAdapter?: GPUAdapter & { isFallbackAdapter?: boolean };
    };
    const adapter = device.gpuAdapter;
    const info = adapter?.info as (GPUAdapterInfo & { isFallbackAdapter?: boolean }) | undefined;
    return {
        description: core.events.invoke<string>('scene.gpu'),
        vendor: info?.vendor ?? '',
        architecture: info?.architecture ?? '',
        fallback: info?.isFallbackAdapter ?? adapter?.isFallbackAdapter ?? null
    };
};

// The canvas is composited over its container, so the background colour is
// the page's to show.
const showBackground = (container: HTMLElement, clr: Color) => {
    const channel = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    container.style.backgroundColor = `rgb(${channel(clr.r)}, ${channel(clr.g)}, ${channel(clr.b)})`;
};

const renderStats = () => {
    const slot = slots.get(MAIN);
    const rows: [string, string][] = [];

    if (slot) {
        const { adapter, load, spin } = slot;
        rows.push(['Adapter', `${adapter.description || 'unknown'}${adapter.fallback ? ' (fallback adapter)' : ''}`]);
        if (slot.filename) {
            rows.push(['File', slot.filename]);
            rows.push(['Gaussians', slot.count.toLocaleString()]);
        }
        if (load) {
            rows.push([
                'Load (ms)',
                `read and decode ${round(load.readDecodeMs)}, sort ${round(load.sortMs)}, upload ${round(load.uploadMs)}, add ${round(load.addMs)}, total ${round(load.totalMs)}`
            ]);
        }
        rows.push(['Frames rendered', String(slot.frames)]);
        if (spin) {
            const { kernel } = spin;
            rows.push([
                'Spin (ms per frame)',
                `median ${round(spin.medianMs)}, p95 ${round(spin.p95Ms)} over ${spin.frames} frames`
            ]);
            rows.push([
                'Kernel timings (ms)',
                `cpu median ${round(kernel.cpuMedianMs)}, gpu median ${
                    kernel.gpuMedianMs === null ? 'not measurable here' : round(kernel.gpuMedianMs)
                } at ${kernel.width}x${kernel.height}`
            ]);
        }
    }
    if (heapSamples.length > 0) {
        rows.push([
            'JS heap after each cycle (MB)',
            heapSamples.map((bytes) => (bytes === null ? 'n/a' : round(bytes / 1048576))).join(', ')
        ]);
    }

    const list = element<HTMLDListElement>('stats');
    list.replaceChildren(
        ...rows.flatMap(([name, value]) => {
            const dt = document.createElement('dt');
            dt.textContent = name;
            const dd = document.createElement('dd');
            dd.textContent = value;
            return [dt, dd];
        })
    );

    element<HTMLButtonElement>('spin').disabled = !slot?.filename;
    element<HTMLButtonElement>('destroy').disabled = !slot;
    element<HTMLButtonElement>('cycle').disabled = !lastFile;
};

// Sizes the viewports created from now on to a fixed CSS size instead of the
// responsive layout, so a script gets the same canvas wherever it runs.
const configure = (options: { width: number; height: number } | null) => {
    fixedSize = options;
};

const create = async (id = MAIN, config?: CoreOptions['config']) => {
    if (slots.has(id)) {
        throw new Error(`Slot '${id}' already holds an instance`);
    }

    // every instance gets a container and a canvas of its own
    const container = document.createElement('div');
    container.className = 'slot';
    container.dataset.slot = id;
    if (fixedSize) {
        container.classList.add('fixed');
        container.style.width = `${fixedSize.width}px`;
        container.style.height = `${fixedSize.height}px`;
    }
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    element('viewports').appendChild(container);

    let core: Core;
    try {
        core = await lib.createCore({
            canvas,
            container,
            config,
            webpWasmUrl: new URL('./webp.wasm', document.baseURI).href
        });
    } catch (error) {
        container.remove();
        throw error;
    }

    const slot: Slot = {
        id,
        container,
        core,
        adapter: adapterOf(core),
        frames: 0,
        filename: null,
        count: null,
        load: null,
        spin: null
    };
    slots.set(id, slot);

    core.events.on('postrender', () => {
        slot.frames++;
    });

    // validation errors reach nobody unless a host listens for them
    const { wgpu } = core.scene.graphicsDevice as unknown as { wgpu?: GPUDevice };
    wgpu?.addEventListener('uncapturederror', (event) => {
        logError(`WebGPU (${id}): ${(event as GPUUncapturedErrorEvent).error.message}`);
    });
    core.events.on('bgClr', (clr: Color) => showBackground(container, clr));
    showBackground(container, core.events.invoke('bgClr'));

    renderStats();
    return { adapter: slot.adapter };
};

// one rendered frame, requested: the kernel renders on demand
const nextFrame = (core: Core) => {
    return new Promise<void>((resolve, reject) => {
        const handle = core.events.on('postrender', () => {
            clearTimeout(timer);
            handle.off();
            resolve();
        });
        const timer = setTimeout(() => {
            handle.off();
            reject(new Error(`No frame rendered within ${FRAME_TIMEOUT_MS} ms`));
        }, FRAME_TIMEOUT_MS);
        core.scene.forceRender = true;
    });
};

// Resolves once the queued commands have run and the result has been drawn
// and presented.
const settle = async (id = MAIN, frames = 2) => {
    const { core } = slotOf(id);
    await core.commandQueue.enqueue(() => {
        // an empty task: it runs after everything queued before it
    });
    for (let i = 0; i < frames; i++) {
        await nextFrame(core);
    }
    await new Promise(requestAnimationFrame);
};

const load = async (id: string, filename: string, contents: Blob | Uint8Array, options: LoadOptions = {}) => {
    const slot = slotOf(id);
    const { core } = slot;

    // the loader announces its stages on the bus, which is all that can be
    // observed of them from outside
    const marks: { sort?: number; upload?: number; end?: number } = {};
    const onUpdate = core.events.on('progressUpdate', (update: { text: string }) => {
        if (update.text === 'Sorting') {
            marks.sort ??= performance.now();
        } else if (update.text === 'Uploading') {
            marks.upload ??= performance.now();
        }
    });
    const onEnd = core.events.on('progressEnd', () => {
        marks.end ??= performance.now();
    });

    const start = performance.now();
    let count: number;
    try {
        const splat = await core.load(filename, contents, options);
        count = splat.numSplats;
    } finally {
        onUpdate.off();
        onEnd.off();
    }
    const done = performance.now();

    const end = marks.end ?? done;
    const upload = marks.upload ?? end;
    const sort = marks.sort ?? upload;
    slot.load = {
        readDecodeMs: sort - start,
        sortMs: upload - sort,
        uploadMs: end - upload,
        addMs: done - end,
        totalMs: done - start
    };
    slot.filename = filename;
    slot.count = count;

    await core.editor.viewport.focus('scene');
    await settle(id);

    renderStats();
    return { count, load: slot.load };
};

// Orbits the camera while timing the frames the kernel renders, for a number
// of frames or of seconds.
const spin = async (id = MAIN, options: { frames?: number; seconds?: number } = {}) => {
    const slot = slotOf(id);
    const { core } = slot;
    const { camera } = core.scene;
    const seconds = options.frames ? undefined : (options.seconds ?? 5);

    const stamps: number[] = [];
    const handle = core.events.on('postrender', () => {
        stamps.push(performance.now());
    });

    // while the timing overlay is on the kernel renders every frame and keeps
    // its GPU timer running
    core.events.fire('view.setPerfOverlay', true);
    const began = performance.now();
    try {
        await new Promise<void>((resolve) => {
            const step = () => {
                const elapsed = performance.now() - began;
                const done = options.frames ? stamps.length > options.frames : elapsed >= seconds * 1000;
                if (done || elapsed >= SPIN_LIMIT_MS || slots.get(id) !== slot) {
                    resolve();
                    return;
                }
                camera.setAzimElev(camera.azim + 2, camera.elevation, 0);
                requestAnimationFrame(step);
            };
            step();
        });
    } finally {
        handle.off();
        if (slots.get(id) === slot) {
            core.events.fire('view.setPerfOverlay', false);
        }
    }

    const intervals = stamps.slice(1).map((stamp, i) => stamp - stamps[i]);
    const timings = core.events.invoke('scene.frameTimings');
    const recent = <T>(values: T[]) => values.slice(-intervals.length);
    slot.spin = {
        frames: intervals.length,
        medianMs: median(intervals),
        p95Ms: percentile(intervals, 0.95),
        kernel: {
            cpuMedianMs: median(recent(timings.cpu)),
            gpuMedianMs: timings.gpuSupported ? median(recent(timings.gpu)) : null,
            width: timings.width,
            height: timings.height
        }
    };

    renderStats();
    return slot.spin;
};

const destroy = (id = MAIN) => {
    const slot = slotOf(id);
    slots.delete(id);
    slot.core.destroy();
    slot.container.remove();
    renderStats();
};

// create, load, destroy, a number of times over, sampling the JS heap after
// each round to see whether memory falls back
const cycle = async (
    id: string,
    times: number,
    filename: string,
    contents: Blob | Uint8Array,
    options: LoadOptions = {}
) => {
    heapSamples = [];
    for (let i = 0; i < times; i++) {
        await create(id);
        await load(id, filename, contents, options);
        destroy(id);
        // a turn of the event loop lets what the teardown queued run first
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        heapSamples.push(heapBytes());
        renderStats();
    }
    return heapSamples.slice();
};

const stats = (id = MAIN) => {
    const slot = slotOf(id);
    return {
        adapter: slot.adapter,
        filename: slot.filename,
        count: slot.count,
        frames: slot.frames,
        load: slot.load,
        spin: slot.spin,
        heapBytes: heapBytes()
    };
};

// the slot's viewport rectangle in CSS pixels, for a script that crops screenshots to it
const rect = (id = MAIN) => {
    const { x, y, width, height } = slotOf(id).container.getBoundingClientRect();
    return { x, y, width, height };
};

const page = {
    // the library's exports and the engine's math types, for scripts that
    // exercise upstream's API directly
    lib,
    pc: { Color, Mat4, Quat, Vec3 },
    configure,
    create,
    load,
    settle,
    spin,
    destroy,
    cycle,
    stats,
    rect,
    core: (id = MAIN) => slots.get(id)?.core ?? null,
    slots: () => Array.from(slots.keys()),
    errors: () => errors.slice()
};

declare global {
    interface Window {
        __page: typeof page;
    }
}

window.__page = page;

// user interface

const run = (action: () => Promise<unknown> | void) => {
    Promise.resolve()
        .then(action)
        .catch((error) => {
            console.error(error);
        });
};

const loadOptions = (): LoadOptions => ({
    reorder: !element<HTMLInputElement>('file-order').checked
});

const numberOf = (id: string, fallback: number) => {
    const value = parseInt(element<HTMLInputElement>(id).value, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

element<HTMLInputElement>('file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) {
        return;
    }
    lastFile = file;
    run(async () => {
        if (slots.has(MAIN)) {
            destroy(MAIN);
        }
        await create(MAIN);
        await load(MAIN, file.name, file, loadOptions());
    });
});

element('spin').addEventListener('click', () => {
    run(() => spin(MAIN, { seconds: numberOf('spin-seconds', 5) }));
});

element('destroy').addEventListener('click', () => {
    run(() => destroy(MAIN));
});

element('cycle').addEventListener('click', () => {
    run(async () => {
        if (slots.has(MAIN)) {
            destroy(MAIN);
        }
        await cycle(MAIN, numberOf('cycle-count', 3), lastFile.name, lastFile, loadOptions());
    });
});

// a phone has no console to read: show errors on the page as well
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
    consoleError(...args);
    logError(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
};
window.addEventListener('error', (event) => logError(event.message));
window.addEventListener('unhandledrejection', (event) => logError(String(event.reason?.message ?? event.reason)));

if (!navigator.gpu) {
    const notice = element('notice');
    notice.hidden = false;
    notice.textContent = window.isSecureContext
        ? 'WebGPU is not available in this browser, so nothing can be loaded here.'
        : 'WebGPU is not available: this page is not in a secure context. Open it over https (or on localhost).';
}

renderStats();
