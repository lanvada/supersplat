#!/usr/bin/env node
// Assembles the release artifact from the last library build: an npm tarball
// in lib/dist holding the ESM bundle, its declarations, upstream's licence
// and a generated package.json.
//
//   node lib/scripts/pack.mjs [n]
//
// The version is upstream's with a `-lib.<n>` suffix (n defaults to 1), and
// the engine and splat-transform are peer dependencies at exactly the
// versions upstream pins, read from the root package.json so an upgrade
// carries them along.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DIST_DIR, ROOT_DIR, relative } from './layout.mjs';

const NAME = '@lanvada/supersplat-lib';
const TYPES = './types/lib/src/index.d.ts';
const PEERS = ['playcanvas', '@playcanvas/splat-transform'];

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

const build = process.argv[2] ?? '1';
if (!/^[1-9]\d*$/.test(build)) {
    fail('usage: node lib/scripts/pack.mjs [n]   (n: the library build number, a positive integer)');
}

for (const file of ['index.mjs', 'index.mjs.map', 'types/lib/src/index.d.ts']) {
    if (!fs.existsSync(path.join(DIST_DIR, file))) {
        fail(`${relative(path.join(DIST_DIR, file))} is missing: run node lib/scripts/build.mjs first`);
    }
}

const upstream = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const peerDependencies = {};
for (const peer of PEERS) {
    const version = upstream.devDependencies?.[peer];
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
        fail(`The root package.json does not pin ${peer} to an exact version (found ${version})`);
    }
    peerDependencies[peer] = version;
}

const manifest = {
    name: NAME,
    version: `${upstream.version}-lib.${build}`,
    description: 'UI-less library build of SuperSplat',
    license: upstream.license,
    type: 'module',
    main: './index.mjs',
    module: './index.mjs',
    types: TYPES,
    exports: {
        '.': {
            types: TYPES,
            default: './index.mjs'
        }
    },
    peerDependencies
};

// stage exactly what ships, then let npm write the tarball in its own layout
const stage = path.join(DIST_DIR, 'package');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
fs.copyFileSync(path.join(ROOT_DIR, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(DIST_DIR, 'index.mjs'), path.join(stage, 'index.mjs'));
fs.copyFileSync(path.join(DIST_DIR, 'index.mjs.map'), path.join(stage, 'index.mjs.map'));
fs.cpSync(path.join(DIST_DIR, 'types'), path.join(stage, 'types'), { recursive: true });

const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', DIST_DIR], { cwd: stage, encoding: 'utf8' })
);
fs.rmSync(stage, { recursive: true, force: true });

// npm names a scoped package's tarball after scope and name; the artifact goes by the name alone
const tarball = path.join(DIST_DIR, `supersplat-lib-${manifest.version}.tgz`);
fs.renameSync(path.join(DIST_DIR, packed.filename), tarball);

const bytes = fs.readFileSync(tarball);
const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;

console.log(`${manifest.name}@${manifest.version}`);
console.log(`peers: ${PEERS.map((peer) => `${peer}@${peerDependencies[peer]}`).join(', ')}`);
console.log(`tarball: ${relative(tarball)} (${packed.files.length} files, ${(bytes.length / 1024).toFixed(1)} KiB)`);
console.log(`integrity: ${integrity}`);
