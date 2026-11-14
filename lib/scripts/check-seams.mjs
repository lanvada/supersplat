#!/usr/bin/env node
// Checks the seams between the library and the parts of the editor it leaves
// out, from the module graph of the last library build:
//
//   - no module the library must not carry is in the graph;
//   - every bus function a bundled module invokes is registered by a bundled
//     module or the entry, or is listed in lib/seams.json with the reason it
//     cannot be;
//   - lib/seams.json holds nothing stale.
//
//   node lib/scripts/check-seams.mjs [--verbose]
//
// It guards the fork across upstream upgrades: a new invocation, a moved
// registration or a new import shows up here before it shows up in a browser.

import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { DIST_DIR, LIB_DIR, ROOT_DIR, isExternal, relative } from './layout.mjs';
import { createLibraryProgram, readModuleGraph } from './program.mjs';

const SEAMS_FILE = path.join(LIB_DIR, 'seams.json');
const EVENTS_FILE = path.join(ROOT_DIR, 'src/events.ts');
const BUNDLE_FILE = path.join(DIST_DIR, 'index.mjs');

// What must not be in the graph, bundled or tree-shaken away alike: the editor
// UI, its component and i18n libraries, the video encoder, and the editor
// modules the library deliberately leaves out.
const FORBIDDEN = [
    { pattern: /^src\/ui\//, why: 'editor UI' },
    { pattern: /node_modules\/@playcanvas\/pcui\//, why: 'UI component library' },
    { pattern: /node_modules\/i18next/, why: 'i18n runtime' },
    { pattern: /node_modules\/mediabunny\//, why: 'video encoder' },
    { pattern: /^src\/(main|index)\.ts$/, why: 'editor application entry' },
    { pattern: /^src\/file-handler\.ts$/, why: 'file handler (file input, drag and drop, export)' },
    { pattern: /^src\/(shortcuts|shortcut-manager)\.ts$/, why: 'keyboard shortcuts' },
    { pattern: /^src\/doc\.ts$/, why: 'documents' },
    { pattern: /^src\/publish\.ts$/, why: 'publish' },
    { pattern: /^src\/preferences\.ts$/, why: 'preferences' },
    { pattern: /^src\/iframe-api\.ts$/, why: 'iframe API' },
    { pattern: /^src\/webmcp\.ts$/, why: 'WebMCP' }
];

const verbose = process.argv.includes('--verbose');
const failures = [];

const graph = readModuleGraph();
const seams = JSON.parse(fs.readFileSync(SEAMS_FILE, 'utf8'));

// forbidden modules

for (const { id } of graph.modules) {
    const hit = FORBIDDEN.find(({ pattern }) => pattern.test(id));
    if (hit) {
        failures.push(`forbidden module in the graph: ${id} (${hit.why})`);
    }
}
for (const id of graph.externals) {
    if (!isExternal(id)) {
        failures.push(`unexpected external: ${id}`);
    }
}

// bus functions

const firstArgument = (call, sourceFile) => {
    const [argument] = call.arguments;
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        return { name: argument.text };
    }
    return { expression: argument ? argument.getText(sourceFile) : '' };
};

const busMethod = (call) => {
    if (!ts.isPropertyAccessExpression(call.expression)) {
        return null;
    }
    const method = call.expression.name.text;
    return method === 'invoke' || method === 'function' ? method : null;
};

// name -> where, per kind, and the sites whose name is not a literal
const sites = { invoke: new Map(), function: new Map() };
const dynamicSites = [];

const program = createLibraryProgram(graph);
const checker = program.getTypeChecker();

// a call counts when the method it resolves to is the bus's own
const isBusCall = (call) => {
    const declaration = checker.getSymbolAtLocation(call.expression.name)?.declarations?.[0];
    const owner = declaration?.parent;
    return (
        !!owner &&
        ts.isClassDeclaration(owner) &&
        owner.name?.text === 'Events' &&
        path.normalize(owner.getSourceFile().fileName) === EVENTS_FILE
    );
};

// modules with code in the bundle; a module that was tree-shaken away whole has no say
const bundled = graph.modules.filter((module) => module.renderedLength > 0 && !module.id.startsWith('\0'));
for (const { id } of bundled) {
    const sourceFile = program.getSourceFile(path.join(ROOT_DIR, id));
    if (!sourceFile) {
        failures.push(`bundled module missing from the type program: ${id}`);
        continue;
    }
    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const method = busMethod(node);
            if (method && isBusCall(node)) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                const where = `${id}:${line + 1}`;
                const { name, expression } = firstArgument(node, sourceFile);
                if (name !== undefined) {
                    sites[method].set(name, [...(sites[method].get(name) ?? []), where]);
                } else {
                    dynamicSites.push({ module: id, call: method, expression, where });
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
}

// The bundle itself decides what shipped: a registration inside a function
// the bundler dropped must not vouch for an invocation, and an invocation it
// dropped needs no registration. The sources say where each one is.
const shipped = { invoke: new Set(), function: new Set() };
{
    const bundle = ts.createSourceFile(
        BUNDLE_FILE,
        fs.readFileSync(BUNDLE_FILE, 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.JS
    );
    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const method = busMethod(node);
            const { name } = method ? firstArgument(node, bundle) : {};
            if (name !== undefined) {
                shipped[method].add(name);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(bundle);
}
for (const method of ['invoke', 'function']) {
    for (const name of shipped[method]) {
        if (!sites[method].has(name)) {
            failures.push(
                `the bundle calls ${method}('${name}') but no bundled module's source does through the bus type`
            );
        }
    }
    for (const name of [...sites[method].keys()]) {
        if (!shipped[method].has(name)) {
            sites[method].delete(name);
        }
    }
}

// sites whose name is computed: lib/seams.json says which names each one stands for
const declaredDynamic = seams.dynamic ?? [];
const dynamicNames = { invoke: new Map(), function: new Map() };
for (const declared of declaredDynamic) {
    const found = dynamicSites.filter((site) => {
        return (
            site.module === declared.module && site.call === declared.call && site.expression === declared.expression
        );
    });
    if (found.length === 0) {
        failures.push(
            `stale entry in lib/seams.json: no ${declared.call}(${declared.expression}) in ${declared.module} any more`
        );
        continue;
    }
    found.forEach((site) => {
        site.declared = declared;
    });
    for (const name of declared.names) {
        dynamicNames[declared.call].set(
            name,
            found.map((site) => site.where)
        );
    }
}
for (const site of dynamicSites) {
    if (!site.declared) {
        failures.push(
            `${site.where}: ${site.call}(${site.expression}) has a computed name; list the names it stands for under "dynamic" in lib/seams.json`
        );
    }
}

const invoked = new Map([...dynamicNames.invoke, ...sites.invoke]);
const registered = new Map([...dynamicNames.function, ...sites.function]);

const expectedMissing = seams.expectedMissing ?? {};
const missing = [];
for (const [name, where] of invoked) {
    if (!registered.has(name)) {
        if (name in expectedMissing) {
            missing.push({ name, where, why: expectedMissing[name] });
        } else {
            failures.push(`invoked but never registered: '${name}' (${where.join(', ')})`);
        }
    }
}
for (const name of Object.keys(expectedMissing)) {
    if (!invoked.has(name)) {
        failures.push(`stale entry in lib/seams.json: '${name}' is no longer invoked by a bundled module`);
    } else if (registered.has(name)) {
        failures.push(
            `stale entry in lib/seams.json: '${name}' is now registered (${registered.get(name).join(', ')})`
        );
    }
}

// report

const entryId = relative(path.join(LIB_DIR, 'src/index.ts'));
const byEntry = [...sites.function].filter(([, where]) => where.some((site) => site.startsWith(`${entryId}:`)));

console.log(`module graph: ${graph.modules.length} modules, ${bundled.length} with code in the bundle`);
console.log(`externals: ${graph.externals.join(', ')}`);
console.log(`bus functions: ${invoked.size} invoked, ${registered.size} registered`);
console.log(`\nregistered by the entry (${byEntry.length}):`);
byEntry.forEach(([name]) => console.log(`  ${name}`));

console.log(`\ncomputed names (${dynamicSites.length} sites):`);
for (const site of dynamicSites) {
    console.log(`  ${site.where}  ${site.call}(${site.expression})`);
    if (site.declared) {
        console.log(`      stands for: ${site.declared.names.join(', ')}`);
    }
}

console.log(`\nexpected missing (${missing.length}):`);
for (const { name, where, why } of missing) {
    console.log(`  ${name}  (${where.join(', ')})`);
    console.log(`      ${why}`);
}

if (verbose) {
    for (const [title, names] of [
        ['invoked', invoked],
        ['registered', registered]
    ]) {
        console.log(`\n${title}:`);
        [...names]
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([name, where]) => console.log(`  ${name}  (${where.join(', ')})`));
    }
}

if (failures.length > 0) {
    console.error(`\nFAILED (${failures.length}):`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
}
console.log('\nseams ok');
