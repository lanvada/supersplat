// Entry of the UI-less library build of SuperSplat. It wires the kernel in the
// order src/main.ts does and leaves out what belongs to the editor
// application: the UI, shortcuts, the file handler, documents, export,
// publish, preferences, the iframe API and WebMCP. The caller drives
// upstream's objects directly; this file adds no layer over them.

import { WebPCodec } from '@playcanvas/splat-transform';
import { Color, Entity, WebgpuGraphicsDevice } from 'playcanvas';

import { Camera } from '../../src/camera';
import type { CameraFrame } from '../../src/camera';
import { registerCameraPosesEvents } from '../../src/camera-poses';
import type { GradeParams } from '../../src/color-grade';
import { CommandQueue } from '../../src/command-queue';
import type { CommandContext } from '../../src/command-queue';
import { EditHistory } from '../../src/edit-history';
import {
    EntityTransformOp,
    HideSelectionOp,
    MultiOp,
    SelectAllOp,
    SelectInvertOp,
    SelectNoneOp,
    SelectOp,
    SplatsTransformOp,
    UnhideAllOp
} from '../../src/edit-ops';
import type { EditOp } from '../../src/edit-ops';
import { registerEditorEvents } from '../../src/editor';
import { createEditorAPI } from '../../src/editor-api';
import type {
    ChangeDetail,
    ChangeEvent,
    DepthHit,
    EditorAPI,
    LayerId,
    LayerInfo,
    RectangleOptions,
    ScreenPoint,
    ScreenRect,
    SelectionOp,
    SelectionOptions
} from '../../src/editor-api';
import { EditorError } from '../../src/editor-command';
import type { CommandOptions, EditScope } from '../../src/editor-command';
import type { EditorSplatResource } from '../../src/editor-splat-resource';
import { Element, ElementType } from '../../src/element';
import { Events } from '../../src/events';
import type { GaussianInstances } from '../../src/gaussian-instances';
import { IndexRanges } from '../../src/index-ranges';
import { MappedReadFileSystem, PermutedChunkSource } from '../../src/io';
import { Scene } from '../../src/scene';
import { getSceneConfig } from '../../src/scene-config';
import type { SceneConfig } from '../../src/scene-config';
import { registerSelectionEvents } from '../../src/selection';
import { registerSequenceEvents } from '../../src/sequence';
import { Splat } from '../../src/splat';
import { State } from '../../src/splat-state';
import { registerTimelineEvents } from '../../src/timeline';
import { OverlayWriter, ToolOverlay } from '../../src/tool-overlay';
import { MoveTool } from '../../src/tools/move-tool';
import { RotateTool } from '../../src/tools/rotate-tool';
import { ToolManager } from '../../src/tools/tool-manager';
import { registerTrackManagerEvents } from '../../src/track-manager';
import { Transform } from '../../src/transform';
import { registerTransformHandlerEvents } from '../../src/transform-handler';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

interface CoreOptions {
    /**
     * The canvas to render into. It is composited over the page: where no
     * gaussian covers it the page shows through, so the background colour
     * (the `bgClr` bus property) is the host's to paint.
     */
    canvas: HTMLCanvasElement;
    /**
     * Observed for size, listened on for pointer input. The canvas backing
     * store follows this element's size, so it is normally the canvas's
     * parent, with the canvas filling it.
     */
    container: HTMLElement;
    /** Overrides applied to this instance's own copy of the default scene config. */
    config?: DeepPartial<SceneConfig>;
    /**
     * URL of splat-transform's webp.wasm; only SOG reading needs it. It is a
     * static of the shared splat-transform module, so it applies to every
     * instance on the page.
     */
    webpWasmUrl?: string;
}

interface LoadOptions {
    /** The LOD to load from a file that holds several; the loader's default when omitted. */
    lod?: number;
    /**
     * False keeps the gaussians in file order. By default formats that are not
     * already spatially ordered are Morton-ordered on load, and the splat's
     * `resource.source` is then a PermutedChunkSource whose `order` maps a row
     * to its file row.
     */
    reorder?: boolean;
    /**
     * Aborting rejects the load and leaves nothing in the scene. The read and
     * upload in progress are not interrupted: the signal is honoured when the
     * loader returns and again once the splat is in the scene.
     */
    signal?: AbortSignal;
}

interface Core {
    readonly events: Events;
    readonly scene: Scene;
    readonly editor: EditorAPI;
    readonly editHistory: EditHistory;
    readonly commandQueue: CommandQueue;
    readonly tools: ToolManager;
    /**
     * Loads one scene from a file name and its bytes and adds it to the scene.
     * The name selects the format. The bytes are read lazily for as long as the
     * splat lives, so a Blob passed here must stay readable.
     */
    load(filename: string, contents: Blob | Uint8Array, options?: LoadOptions): Promise<Splat>;
    /**
     * Releases the scene, the graphics device and every listener the kernel
     * attached. Commands still in flight reject; call it from outside the
     * frame callbacks.
     */
    destroy(): void;
}

// The options upstream passes to createGraphicsDevice. The device is
// constructed directly because createGraphicsDevice always appends a WebGL2
// fallback: without WebGPU it would bind the caller's canvas to a context the
// kernel cannot render with, where this rejects and leaves the canvas alone.
const createDevice = async (canvas: HTMLCanvasElement) => {
    if (!navigator.gpu) {
        throw new Error(
            'WebGPU is not available: navigator.gpu is missing (it needs a secure context and a browser that supports it)'
        );
    }

    const device = new WebgpuGraphicsDevice(canvas, {
        antialias: false,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance'
    });

    try {
        await device.initWebGpu(undefined, undefined);
    } catch (error) {
        try {
            device.destroy();
        } catch {
            // a device that never initialised has nothing to release
        }
        throw new Error(`WebGPU is not available: ${error.message ?? error}`, { cause: error });
    }

    return device;
};

// The editor module asks before the page unloads while there is unsaved work,
// through an anonymous listener nothing can remove afterwards. Its closure
// shares a scope with every other closure of that module, so it would keep the
// scene, the edit history and the editor API of a destroyed instance alive for
// the life of the page. The library has no document to lose: the listener is
// withheld while the module registers.
const withoutUnloadPrompt = (register: () => void) => {
    type Add = typeof window.addEventListener;
    const own = Object.prototype.hasOwnProperty.call(window, 'addEventListener');
    const add = window.addEventListener as (...args: unknown[]) => void;
    window.addEventListener = function (this: Window, type: string, ...rest: unknown[]) {
        if (type !== 'beforeunload') {
            add.call(this, type, ...rest);
        }
    } as Add;
    try {
        register();
    } finally {
        if (own) {
            window.addEventListener = add as Add;
        } else {
            Reflect.deleteProperty(window, 'addEventListener');
        }
    }
};

// The engine binds an Entity to the app that was constructed or ticked last,
// not to the one it ends up in. With several instances on a page an element
// built outside its own instance's frame carries another instance's app, and
// the components it adds would register with that app's systems and layers.
const bindEntities = (element: Element, scene: Scene) => {
    for (const value of Object.values(element)) {
        if (value instanceof Entity) {
            value.forEach((node) => {
                (node as unknown as { _app: unknown })._app = scene.app;
            });
        }
    }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const applyOverrides = (target: Record<string, unknown>, overrides: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(overrides)) {
        const current = target[key];
        if (isPlainObject(current) && isPlainObject(value)) {
            applyOverrides(current, value);
        } else if (value !== undefined) {
            target[key] = value;
        }
    }
};

const createCore = async (options: CoreOptions): Promise<Core> => {
    const { canvas, container } = options;

    const graphicsDevice = await createDevice(canvas);

    // Nothing below awaits until the scene has started. The engine binds a new
    // Entity to whichever app was constructed or ticked last, so construction
    // interleaved with another instance's frames would attach this instance's
    // cameras and gizmos to that one.
    let scene: Scene | null = null;

    try {
        // root events object
        const events = new Events();

        // shared command queue for all async splat work, and the edit history on it
        const commandQueue = new CommandQueue();
        const editHistory = new EditHistory(events, commandQueue);

        events.function('queue', (fn: () => Promise<void> | void) => commandQueue.enqueue(fn));

        if (options.webpWasmUrl) {
            WebPCodec.wasmUrl = options.webpWasmUrl;
        }

        // register events that only need the events object
        registerTimelineEvents(events);
        registerCameraPosesEvents(events);
        registerTrackManagerEvents(events);
        registerTransformHandlerEvents(events);

        events.function('scene.gpu', () => {
            // the renderer's own adapter, which the engine types as private
            const device = graphicsDevice as unknown as {
                gpuAdapter?: { info?: { description: string; vendor: string; architecture: string; device: string } };
            };
            const info = device.gpuAdapter?.info;
            return info?.description || [info?.vendor, info?.architecture, info?.device].filter(Boolean).join(' / ');
        });

        // getSceneConfig resolves overrides into one module-level object, which
        // every instance on the page would share: take a copy of the defaults
        // and apply this instance's overrides to the copy
        const sceneConfig: SceneConfig = structuredClone(getSceneConfig([]));
        if (options.config) {
            applyOverrides(sceneConfig, options.config);
        }

        scene = new Scene(events, sceneConfig, canvas, graphicsDevice, commandQueue, container);
        const liveScene = scene;

        const addElement = liveScene.add.bind(liveScene);
        liveScene.add = (element: Element) => {
            bindEntities(element, liveScene);
            return addElement(element);
        };

        // colors
        const bgClr = new Color();
        const selectedClr = new Color();
        const unselectedClr = new Color();
        const lockedClr = new Color();

        const setClr = (target: Color, value: Color, event: string) => {
            if (!target.equals(value)) {
                target.copy(value);
                events.fire(event, target);
            }
        };

        events.on('setBgClr', (clr: Color) => setClr(bgClr, clr, 'bgClr'));
        events.on('setSelectedClr', (clr: Color) => setClr(selectedClr, clr, 'selectedClr'));
        events.on('setUnselectedClr', (clr: Color) => setClr(unselectedClr, clr, 'unselectedClr'));
        events.on('setLockedClr', (clr: Color) => setClr(lockedClr, clr, 'lockedClr'));

        events.function('bgClr', () => bgClr);
        events.function('selectedClr', () => selectedClr);
        events.function('unselectedClr', () => unselectedClr);
        events.function('lockedClr', () => lockedClr);

        ['selectedClr', 'unselectedClr', 'lockedClr'].forEach((event) => {
            events.on(event, () => {
                liveScene.forceRender = true;
            });
        });

        // initialize colors from the scene config
        const toColor = (value: { r: number; g: number; b: number; a: number }) => {
            return new Color(value.r, value.g, value.b, value.a);
        };
        setClr(bgClr, toColor(sceneConfig.bgClr), 'bgClr');
        setClr(selectedClr, toColor(sceneConfig.selectedClr), 'selectedClr');
        setClr(unselectedClr, toColor(sceneConfig.unselectedClr), 'unselectedClr');
        setClr(lockedClr, toColor(sceneConfig.lockedClr), 'lockedClr');

        // tool manager
        const toolManager = new ToolManager(events);
        toolManager.register('move', new MoveTool(events, liveScene));
        toolManager.register('rotate', new RotateTool(events, liveScene));

        // the typed command/query surface
        const editor = createEditorAPI(events, liveScene, editHistory, commandQueue);

        // register events that need the scene or other dependencies
        withoutUnloadPrompt(() => registerEditorEvents(events, editHistory, liveScene, editor));
        registerSelectionEvents(events, liveScene);
        registerSequenceEvents(events, liveScene);

        // The editor counts edit history as unsaved work, and a host's own
        // hide and move edits go through history too. There is no document to
        // lose here, so nothing is ever unsaved.
        events.functions.set('scene.dirty', () => false);

        // queries the kernel makes of parts of the editor the library leaves
        // out, answered as those parts answer when they have nothing to report:
        // no grade previewed by the colour panel, no open document, no polygon
        // selection in progress
        events.function('colorPanel.pending', (): GradeParams | null => null);
        events.function('doc.name', (): string | null => null);
        events.function('polygonSelection.removeLastPoint', () => false);

        liveScene.start();

        let destroyed = false;

        const load = async (filename: string, contents: Blob | Uint8Array, loadOptions: LoadOptions = {}) => {
            const { signal } = loadOptions;

            const checkLive = () => {
                if (destroyed) {
                    throw new Error('The core was destroyed');
                }
                signal?.throwIfAborted();
            };
            checkLive();

            const fileSystem = new MappedReadFileSystem();
            fileSystem.addFile(filename, contents instanceof Blob ? contents : new Blob([contents as BlobPart]));

            let model: Splat;
            try {
                // the options object is always passed: without one the loader
                // asks which LOD to load through a popup
                model = await liveScene.assetLoader.load(filename, fileSystem, false, loadOptions.reorder === false, {
                    lod: loadOptions.lod
                });
            } catch (error) {
                // a load that outlived the core fails on the released device;
                // report the cause rather than the symptom
                checkLive();
                throw error;
            }
            model.resource.fileSources = fileSystem.sources;

            try {
                checkLive();
                await liveScene.add(model);
                checkLive();
            } catch (error) {
                // after destroy() the device and the asset registry the model
                // would release into are already gone
                if (!destroyed) {
                    model.destroy();
                }
                throw error;
            }

            return model;
        };

        const destroy = () => {
            if (destroyed) {
                return;
            }
            destroyed = true;

            // history operations hold the splats they edit
            editHistory.history = [];
            editHistory.cursor = 0;

            liveScene.destroy();

            // a host may hold on to the bus: emptied, it no longer reaches the
            // scene through the handlers and queries registered on it
            events.off();
            events.functions.clear();
        };

        return {
            events,
            scene: liveScene,
            editor,
            editHistory,
            commandQueue,
            tools: toolManager,
            load,
            destroy
        };
    } catch (error) {
        // release what was built so a failed start leaves no device or frame loop behind
        if (scene) {
            scene.destroy();
        } else {
            graphicsDevice.destroy();
        }
        throw error;
    }
};

export {
    createCore,
    Camera,
    CommandQueue,
    EditHistory,
    EditorError,
    Element,
    ElementType,
    EntityTransformOp,
    Events,
    HideSelectionOp,
    IndexRanges,
    MappedReadFileSystem,
    MultiOp,
    OverlayWriter,
    PermutedChunkSource,
    Scene,
    SelectAllOp,
    SelectInvertOp,
    SelectNoneOp,
    SelectOp,
    Splat,
    SplatsTransformOp,
    State,
    ToolManager,
    ToolOverlay,
    Transform,
    UnhideAllOp
};
export type {
    CameraFrame,
    ChangeDetail,
    ChangeEvent,
    CommandContext,
    CommandOptions,
    Core,
    CoreOptions,
    DeepPartial,
    DepthHit,
    EditOp,
    EditorAPI,
    EditorSplatResource,
    EditScope,
    GaussianInstances,
    LayerId,
    LayerInfo,
    LoadOptions,
    RectangleOptions,
    SceneConfig,
    ScreenPoint,
    ScreenRect,
    SelectionOp,
    SelectionOptions
};
