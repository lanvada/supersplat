#!/usr/bin/env node
// The library's gate: every check, one after another, stopping at the first
// failure.
//
//   CHROME_PATH=<chrome or chrome-headless-shell> node lib/scripts/verify.mjs [smoke options]
//
// Run it before a change to the stack is merged and after every re-stack on a
// new upstream release (upgrade.mjs runs it). Upstream's own build, lint,
// format check and tests are part of it: the patches to upstream files must
// leave the editor application working. Options are passed on to smoke.mjs
// (--hardware, --deadline, --scene, --out).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { ROOT_DIR } from './layout.mjs';

const node = process.execPath;

const steps = [
    ['library build', node, ['lib/scripts/build.mjs', '--only', 'lib']],
    ['seam check', node, ['lib/scripts/check-seams.mjs']],
    ['page build', node, ['lib/scripts/build.mjs', '--only', 'page']],
    ['lint (lib)', 'npx', ['eslint', 'lib']],
    ['format (lib)', 'npx', ['prettier', '--check', 'lib']],
    ['upstream build', 'npm', ['run', 'build']],
    ['upstream lint', 'npm', ['run', 'lint']],
    ['upstream format', 'npm', ['run', 'fmt']],
    ['upstream tests', 'npm', ['test']],
    ['smoke', node, ['lib/scripts/smoke.mjs', ...process.argv.slice(2)]]
];

// asked up front: the smoke is the last step, minutes in
if (!process.env.CHROME_PATH || !fs.existsSync(process.env.CHROME_PATH)) {
    console.error('verify: set CHROME_PATH to a Chrome or chrome-headless-shell binary; the smoke needs a browser');
    process.exit(1);
}

process.chdir(ROOT_DIR);

for (const [name, command, args] of steps) {
    console.log(`\nverify: ${name}`);
    const started = Date.now();
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.status !== 0) {
        console.error(`\nverify: FAILED at '${name}'`);
        process.exit(1);
    }
    console.log(`verify: ${name} passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

console.log(`\nverify: all ${steps.length} steps passed`);
