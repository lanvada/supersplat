import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { DIST_DIR, LIB_DIR, LOCALIZATION_IMPORT, LOCALIZATION_STUB, ROOT_DIR, relative } from './layout.mjs';

const GRAPH_FILE = path.join(DIST_DIR, 'modules.json');
const ENTRY_FILE = path.join(LIB_DIR, 'src/index.ts');

/**
 * The module graph the library build recorded: every module the bundler
 * loaded, with how much of it reached the bundle, and the externals.
 *
 * @returns {{ modules: { id: string, renderedLength: number }[], externals: string[] }} The graph.
 */
const readModuleGraph = () => {
    if (!fs.existsSync(GRAPH_FILE)) {
        throw new Error(`${relative(GRAPH_FILE)} is missing: run node lib/scripts/build.mjs first`);
    }
    return JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
};

const formatDiagnostics = (diagnostics) => {
    return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => ROOT_DIR,
        getNewLine: () => '\n'
    });
};

/**
 * The TypeScript program of the library entry. Module resolution is the
 * bundler's: a bundled module's import of the UI's localization resolves to
 * the stub, so the kernel is checked against what it will run with. `paths`
 * cannot express that, since it does not apply to relative imports.
 *
 * @param {{ modules: { id: string }[] }} graph - The module graph of the build.
 * @param {ts.CompilerOptions} [overrides] - Compiler options on top of lib/tsconfig.json.
 * @returns {ts.Program} The program.
 */
const createLibraryProgram = (graph, overrides = {}) => {
    const configPath = path.join(LIB_DIR, 'tsconfig.json');
    const config = ts.getParsedCommandLineOfConfigFile(configPath, overrides, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(formatDiagnostics([diagnostic]));
        }
    });
    if (config.errors.length > 0) {
        throw new Error(formatDiagnostics(config.errors));
    }

    const { options } = config;
    const host = ts.createCompilerHost(options);
    const cache = ts.createModuleResolutionCache(ROOT_DIR, (fileName) => fileName, options);
    const bundled = new Set(graph.modules.map((module) => path.join(ROOT_DIR, module.id)));

    host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, compilerOptions) => {
        return literals.map((literal) => {
            if (LOCALIZATION_IMPORT.test(literal.text) && bundled.has(path.normalize(containingFile))) {
                return {
                    resolvedModule: {
                        resolvedFileName: LOCALIZATION_STUB,
                        extension: ts.Extension.Ts,
                        isExternalLibraryImport: false
                    }
                };
            }
            return ts.resolveModuleName(
                literal.text,
                containingFile,
                compilerOptions,
                host,
                cache,
                redirectedReference
            );
        });
    };

    return ts.createProgram({
        rootNames: [ENTRY_FILE, path.join(ROOT_DIR, 'global.d.ts')],
        options,
        host
    });
};

export { ENTRY_FILE, createLibraryProgram, formatDiagnostics, readModuleGraph };
