# UI-less library build of SuperSplat

`lib/` adds a second build to this repository: SuperSplat's kernel as one ES module with type declarations, without the editor's interface. A host page brings its own interface and drives upstream's objects directly: the scene and its WebGPU renderer, the event bus, the edit history, the editor API, selection, hide and undo, the move and rotate tools, the tool overlay and the file readers.

The fork is kept thin so that it can follow upstream releases. Everything it adds is under `lib/`; upstream files are changed in the four small places listed under [Patches to upstream files](#patches-to-upstream-files). Upstream's `package.json`, lockfile, build and editor entry are untouched, and the editor application still builds and passes its checks.

## Using it

The artifact is an npm tarball published on this fork's release page. The engine and the reader library are peer dependencies at exactly the versions upstream pins, so the host page holds one copy of each.

```ts
import { createCore, SelectOp } from '@lanvada/supersplat-lib';

// the container is observed for size and listened on for pointer input;
// the canvas normally fills it
const core = await createCore({ canvas, container, config: { show: { grid: false } } });

const splat = await core.load('scene.ply', blob);
core.events.fire('view.setOutlineSelection', true);
await core.editHistory.add(new SelectOp(splat, 'set', indices));

core.destroy();
```

`createCore` rejects with `WebGPU is not available: …` when the browser has no WebGPU or no adapter, and leaves the canvas without a context. `lib/src/index.ts` is the whole entry and documents every option; the rest of the surface is upstream's own classes, re-exported.

What a host should know (from the source unless marked as checked by the smoke):

- **Rows, instances and file order.** By default a file that is not already spatially ordered is Morton-ordered on load. `splat.resource.source` is then a `PermutedChunkSource` whose `order[row]` is the row in the file (checked). `reorder: false` keeps file order. An instance index is not a row: `splat.instances.sourceRow[i]` maps one to the other, and deleting gaussians shifts instance indices.
- **Selecting by index.** `SelectOp` with a `Uint32Array` expects sorted, unique instance indices; a `Uint8Array` mask with 255 for a hit is the alternative.
- **The file stays in use.** Data is read lazily from the Blob given to `load`, which must stay readable while the splat lives. A `Uint8Array` is copied into a Blob.
- **Default look.** The loaded splat becomes the active layer, the grid is on, the active layer's bound corners are drawn, a selection shows as centre dots until `view.setOutlineSelection` is fired, and hidden gaussians are drawn with `lockedClr` (alpha 0.05 by default). The canvas is composited over the page: the host paints the background, from the `bgClr` bus property if it wants upstream's.
- **The camera reads the page URL.** `focal`, `angles` and `distance` query parameters set the starting pose.
- **One fill colour per overlay.** `ToolOverlay.fillColor` is settable; line and dot colours are upstream's constants.
- **Several instances on a page** each get their own scene config and bus (checked: an edit in one leaves the other unchanged, and destroying one leaves the other rendering). The engine binds a new entity to the application that was constructed or ticked last; the entry rebinds elements as they are added to a scene, which does not cover entities the engine creates lazily during a gizmo drag.
- **Destroying.** `destroy()` destroys every texture, buffer and render target of the instance itself rather than leaving them to the destroyed device or to garbage collection, and the scene and its data can then be collected (checked, with no other instance on the page) once the host lets go of what it holds: the core, and every element it added, such as a `ToolOverlay`, whose entities still name the engine objects of the instance it was in. The engine keeps the device it drew with last in module scope until another instance draws: the destroyed device object lingers, and so does anything a host's listener on its `GPUDevice` captures, so remove those listeners before `destroy()`.
- **Leaving the page.** The editor's unsaved-changes prompt is not installed and `scene.dirty` is always false: a host's edits go through the edit history and there is no document to lose.

## Layout

| Path                                 | What it is                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | The entry: wires the kernel in the order `src/main.ts` does, without the editor application's parts.                 |
| `src/localization.ts`                | Stands in for `src/ui/localization`, the one UI module the kernel imports.                                           |
| `rollup.config.mjs`, `tsconfig.json` | The library build.                                                                                                   |
| `seams.json`                         | What the seam check is told: bus functions that are expected to be missing, and the names behind computed bus calls. |
| `page/`                              | The bare page: one canvas, a file picker, timings. Also what the smoke drives.                                       |
| `scripts/`                           | Build, checks, packaging, upgrade and page deploy (below).                                                           |

## Commands

All from the repository root, after `npm ci`.

| Command                                                    | What it does                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node lib/scripts/build.mjs [--only lib\|page]`            | Builds the library into `lib/dist` (bundle, module graph, declarations), then the bare page into `lib/page/dist`. A bundler warning or a type error fails it. |
| `node lib/scripts/check-seams.mjs [--verbose]`             | Checks the seams of the last build (below).                                                                                                                   |
| `CHROME_PATH=… node lib/scripts/smoke.mjs`                 | Drives the bare page in headless Chromium: create, load, render, select, hide, undo, transform, overlay, tools, teardown, two instances.                      |
| `CHROME_PATH=… node lib/scripts/verify.mjs`                | The gate: all of the above plus lint and format of `lib`, and upstream's build, lint, format check and tests.                                                 |
| `node lib/scripts/pack.mjs [n]`                            | Writes the release tarball `lib/dist/supersplat-lib-<upstream version>-lib.<n>.tgz` and prints its integrity hash.                                            |
| `node lib/scripts/deploy-page.mjs`                         | Replaces the `gh-pages` branch with the built bare page.                                                                                                      |
| `CHROME_PATH=… node lib/scripts/upgrade.mjs [--to vX.Y.Z]` | Re-stacks the library on an upstream release (below).                                                                                                         |

The smoke starts the browser with `--no-sandbox` and only ever points it at the server it starts on `127.0.0.1`. Without a GPU the WebGPU adapter is software and its work lands on the CPU: the smoke keeps its workload small and fixed, lowers its own priority, and kills the browser at a deadline (180 s by default). On a shared machine, confine it further, for example `taskset -c 0,1 node lib/scripts/verify.mjs`. With a GPU, pass `--hardware`.

## Seams

The kernel talks to the rest of the editor through the event bus: `events.function(name, fn)` registers a function and `events.invoke(name)` calls it, logging an error when nothing is registered. Leaving the interface out removes registrations, and an upstream release can add invocations. The seam check reads the module graph of the build and fails when:

- a module the library must not carry is in the graph (the UI, its component and i18n libraries, the video encoder, the editor application's own modules);
- a bundled module invokes a bus function that no bundled module registers, unless `seams.json` lists it with the reason;
- a bus call has a computed name that `seams.json` does not expand;
- `seams.json` holds an entry that no longer applies.

## Patches to upstream files

Each is its own commit, so that a re-stack reports a conflict in the one patch it concerns.

| File                            | Change                                                                                                                                                                                                                      | Why                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/controllers.ts`            | `PointerController.destroy()` no longer calls itself.                                                                                                                                                                       | Upstream's version recurses until the stack overflows, so a camera could never be removed. Drop this patch when upstream fixes it.                                                                                       |
| `src/scene.ts`, `src/camera.ts` | The scene takes the container element as an optional constructor argument instead of looking up `#canvas-container`.                                                                                                        | A host page has its own markup and may hold several scenes.                                                                                                                                                              |
| `src/scene.ts`                  | `Scene.destroy()`: removes every element, detaches what the constructor attached to the container, destroys the application and its graphics device, then whatever the device still lists, and drops the device's handlers. | A host creates and destroys scenes as its pages come and go. A browser may free a destroyed device's resources only as their wrappers are collected, and the engine keeps the last device, with its handlers, reachable. |
| `src/tool-overlay.ts`           | `ToolOverlay.fillColor`.                                                                                                                                                                                                    | A host draws in its own colour.                                                                                                                                                                                          |

Two things are handled in the entry instead of by a patch: each instance gets its own copy of the scene config, and the editor's `beforeunload` listener is withheld while `registerEditorEvents` runs. That listener cannot be removed afterwards and its closure would keep a destroyed scene alive for the life of the page. The smoke checks both, by collecting destroyed scenes (also when no other instance is left on the page) and by navigating away after edits.

## Branches, releases, upgrading

- `lib/<upstream tag>` (for example `lib/v3.8.1`) is the stack of commits on that upstream release. Changes reach it through pull requests within this fork. Nothing is sent to upstream.
- A release is the tarball from `pack.mjs`, attached to a tag `<upstream tag>-lib.<n>` on that branch. A host pins it by URL and integrity hash.
- `gh-pages` holds the built bare page.

To follow an upstream release, run `upgrade.mjs` by hand on the current library branch. It fetches upstream's release tags, creates `lib/<new tag>` beside the current branch, rebases the stack onto the new tag, reinstalls and runs the gate. It never pushes and never rewrites the old branch, so a bad upgrade is abandoned by deleting the new branch. When it passes: push the new branch, pack and publish a release, redeploy the page, and move the host's pin.

## Not verified

- A real GPU, a phone, touch input: the smoke has only run on a software adapter. The bare page is there for this.
- Load time, frame time and memory on scenes of real size.
- SOG files and `webpWasmUrl`, the `lod` option, multi-file sets.
- Reusing one canvas for a second core after the first was destroyed: the bare page makes a fresh canvas each time.
- Pointer-driven gizmo drags (the smoke drives the pivot the way a drag does, not the pointer), and the lazily created gizmo entities with several instances on a page.
- The declarations under a host's own compiler options. They need `moduleResolution: bundler` and DOM and WebGPU ambient types.
