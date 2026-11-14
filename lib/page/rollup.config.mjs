import fs from 'node:fs';
import path from 'node:path';

import alias from '@rollup/plugin-alias';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';

import { DIST_DIR, LIB_DIR, PAGE_DIST_DIR, ROOT_DIR } from '../scripts/layout.mjs';

// The page is a host of the built library: it bundles lib/dist/index.mjs with
// the one copy of the engine and of splat-transform the library leaves external.
const LIBRARY = path.join(DIST_DIR, 'index.mjs');
const ENGINE = path.join(ROOT_DIR, 'node_modules/playcanvas/build/playcanvas/src/index.js');

// PAGE_MINIFY=0 skips minification, for reading stack traces
const MINIFY = process.env.PAGE_MINIFY !== '0';

const staticFiles = (files) => ({
    name: 'static-files',
    buildStart() {
        files.forEach(({ src }) => this.addWatchFile(src));
    },
    generateBundle() {
        for (const { src, fileName } of files) {
            this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(src) });
        }
    }
});

export default {
    input: path.join(LIB_DIR, 'page/src/page.ts'),
    output: {
        dir: PAGE_DIST_DIR,
        entryFileNames: 'page.js',
        chunkFileNames: '[name]-[hash].js',
        format: 'esm'
    },
    // splat-transform reaches for these only when it runs under Node
    external: [/^node:/],
    plugins: [
        alias({
            entries: {
                'supersplat-lib': LIBRARY,
                playcanvas: ENGINE
            }
        }),
        typescript({
            tsconfig: path.join(LIB_DIR, 'tsconfig.json'),
            include: ['lib/page/src/**/*.ts', 'global.d.ts'],
            filterRoot: ROOT_DIR,
            sourceMap: false,
            inlineSources: false
        }),
        resolve(),
        staticFiles([
            { src: path.join(LIB_DIR, 'page/index.html'), fileName: 'index.html' },
            // the WebP decoder's wasm must match the glue bundled from
            // splat-transform, so it comes from the installed package
            {
                src: path.join(ROOT_DIR, 'node_modules/@playcanvas/splat-transform/lib/webp.wasm'),
                fileName: 'webp.wasm'
            }
        ]),
        MINIFY && terser()
    ],
    cache: false
};
