import path from 'node:path';

import alias from '@rollup/plugin-alias';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

import {
    DIST_DIR,
    LIB_DIR,
    LOCALIZATION_IMPORT,
    LOCALIZATION_STUB,
    ROOT_DIR,
    isExternal,
    relative
} from './scripts/layout.mjs';

// Writes the module graph of the build next to the bundle. The declaration
// build and the seam check both work from it, so neither keeps a list of the
// kernel's modules by hand.
const moduleGraph = () => ({
    name: 'module-graph',
    generateBundle(_options, bundle) {
        const rendered = new Map();
        for (const chunk of Object.values(bundle)) {
            if (chunk.type === 'chunk') {
                for (const [id, module] of Object.entries(chunk.modules)) {
                    rendered.set(id, module.renderedLength);
                }
            }
        }

        const modules = [];
        const externals = [];
        for (const id of this.getModuleIds()) {
            if (this.getModuleInfo(id).isExternal) {
                externals.push(id);
            } else {
                modules.push({
                    // virtual modules (a leading NUL) have no path to relate
                    id: id.startsWith('\0') ? id : relative(id),
                    renderedLength: rendered.get(id) ?? 0
                });
            }
        }
        modules.sort((a, b) => a.id.localeCompare(b.id));
        externals.sort();

        this.emitFile({
            type: 'asset',
            fileName: 'modules.json',
            source: `${JSON.stringify({ modules, externals }, null, 4)}\n`
        });
    }
});

export default {
    input: path.join(LIB_DIR, 'src/index.ts'),
    output: {
        dir: DIST_DIR,
        entryFileNames: 'index.mjs',
        format: 'esm',
        sourcemap: true
    },
    external: isExternal,
    plugins: [
        alias({
            entries: [{ find: LOCALIZATION_IMPORT, replacement: LOCALIZATION_STUB }]
        }),
        typescript({
            tsconfig: path.join(LIB_DIR, 'tsconfig.json'),
            // the entry and the upstream sources it bundles; the page has its own build
            include: ['lib/src/**/*.ts', 'src/**/*.ts', 'global.d.ts'],
            filterRoot: ROOT_DIR
        }),
        resolve(),
        json(),
        moduleGraph()
    ],
    cache: false
};
