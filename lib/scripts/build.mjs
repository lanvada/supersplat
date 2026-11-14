#!/usr/bin/env node
// Builds the UI-less library into lib/dist (ESM bundle, module graph,
// declarations) and then the bare page that hosts it into lib/page/dist.
//
//   node lib/scripts/build.mjs [--only lib|page]
//
// A bundler warning or a type error fails the build: after an upstream
// upgrade either one is a seam that moved and needs a look.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { rollup } from 'rollup';
import ts from 'typescript';

import { DIST_DIR, LIB_DIR, PAGE_DIST_DIR, ROOT_DIR, isExternal, relative } from './layout.mjs';
import { createLibraryProgram, formatDiagnostics, readModuleGraph } from './program.mjs';

const TYPES_DIR = path.join(DIST_DIR, 'types');
const ENTRY_DECLARATION = path.join(TYPES_DIR, 'lib/src/index.d.ts');

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const bundle = async (configFile, outDir) => {
    const { default: config } = await import(pathToFileURL(configFile).href);
    const warnings = [];

    fs.rmSync(outDir, { recursive: true, force: true });
    const build = await rollup({
        ...config,
        onwarn: (warning) => warnings.push(warning)
    });
    try {
        const { output } = await build.write(config.output);
        if (warnings.length > 0) {
            fail(warnings.map((warning) => [warning.message, warning.frame].filter(Boolean).join('\n')).join('\n\n'));
        }
        return output;
    } finally {
        await build.close();
    }
};

// Declarations for the entry and for what its declarations reach, checked
// against the same module resolution the bundle was built with. tsc on its
// own would emit a file per module of the whole program, the editor UI's
// among them.
const buildDeclarations = () => {
    const program = createLibraryProgram(readModuleGraph(), {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        sourceMap: false,
        inlineSources: false,
        rootDir: ROOT_DIR,
        outDir: TYPES_DIR
    });

    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
        fail(formatDiagnostics(diagnostics));
    }

    const emitted = new Map();
    const result = program.emit(undefined, (fileName, text) => emitted.set(path.normalize(fileName), text));
    if (result.diagnostics.length > 0) {
        fail(formatDiagnostics(result.diagnostics));
    }

    // walk the entry's declarations: every import must be another emitted
    // declaration or a package the consuming site provides
    const kept = new Map();
    const problems = [];
    const pending = [ENTRY_DECLARATION];
    while (pending.length > 0) {
        const file = pending.pop();
        if (kept.has(file)) {
            continue;
        }
        const text = emitted.get(file);
        kept.set(file, text);

        const { importedFiles, referencedFiles } = ts.preProcessFile(text, true, false);
        for (const { fileName: specifier } of importedFiles) {
            if (specifier.startsWith('.')) {
                const base = path.resolve(path.dirname(file), specifier);
                const target = [`${base}.d.ts`, path.join(base, 'index.d.ts')].find((name) => emitted.has(name));
                if (target) {
                    pending.push(target);
                } else {
                    problems.push(`${relative(file)} imports '${specifier}', which has no emitted declaration`);
                }
            } else if (!isExternal(specifier)) {
                problems.push(`${relative(file)} imports '${specifier}', which a consuming site does not provide`);
            }
        }
        for (const { fileName: reference } of referencedFiles) {
            problems.push(`${relative(file)} references the file '${reference}'`);
        }
    }
    if (problems.length > 0) {
        fail(`The declarations are not self-contained:\n  ${problems.join('\n  ')}`);
    }

    for (const [file, text] of kept) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    return kept.size;
};

const buildLibrary = async () => {
    const output = await bundle(path.join(LIB_DIR, 'rollup.config.mjs'), DIST_DIR);
    const entry = output.find((file) => file.type === 'chunk' && file.isEntry);
    const { modules, externals } = readModuleGraph();
    console.log(
        `library: ${relative(path.join(DIST_DIR, entry.fileName))} ${kib(Buffer.byteLength(entry.code))} (not minified), ` +
            `${modules.length} modules, externals ${externals.join(', ')}`
    );

    const declarations = buildDeclarations();
    console.log(`library: ${declarations} declaration files under ${relative(TYPES_DIR)}`);
};

const buildPage = async () => {
    if (!fs.existsSync(path.join(DIST_DIR, 'index.mjs')) || !fs.existsSync(ENTRY_DECLARATION)) {
        fail('The page hosts the built library: build the library first.');
    }
    const output = await bundle(path.join(LIB_DIR, 'page/rollup.config.mjs'), PAGE_DIST_DIR);
    const bytes = output.reduce(
        (sum, file) => sum + Buffer.byteLength(file.type === 'chunk' ? file.code : file.source),
        0
    );
    console.log(`page: ${relative(PAGE_DIST_DIR)} ${output.length} files, ${kib(bytes)}`);
};

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
if (only !== null && only !== 'lib' && only !== 'page') {
    fail('usage: node lib/scripts/build.mjs [--only lib|page]');
}

// the TypeScript plugin resolves its file filter against the working directory
process.chdir(ROOT_DIR);

if (only !== 'page') {
    await buildLibrary();
}
if (only !== 'lib') {
    await buildPage();
}
