#!/usr/bin/env node
// Re-stacks the library branch on an upstream release, then runs the gate.
//
//   CHROME_PATH=<browser> node lib/scripts/upgrade.mjs            # onto the newest upstream release
//   CHROME_PATH=<browser> node lib/scripts/upgrade.mjs --to v3.9.0
//
// Run it by hand from a clean checkout of the current `lib/<upstream tag>`
// branch. It creates `lib/<new tag>` beside it and never pushes: the old
// branch and its releases stay as they are, so a bad upgrade is abandoned by
// deleting the new branch.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { ROOT_DIR } from './layout.mjs';

const UPSTREAM_URL = 'https://github.com/playcanvas/supersplat.git';
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const BRANCH_PREFIX = 'lib/';

process.chdir(ROOT_DIR);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    return result.status === 0;
};

const fail = (message) => {
    console.error(`\nupgrade: ${message}`);
    process.exit(1);
};

const compareTags = (a, b) => {
    const [, ...pa] = a.match(RELEASE_TAG);
    const [, ...pb] = b.match(RELEASE_TAG);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) {
            return Number(pa[i]) - Number(pb[i]);
        }
    }
    return 0;
};

const toIndex = process.argv.indexOf('--to');
const requested = toIndex === -1 ? null : (process.argv[toIndex + 1] ?? '');
if (requested !== null && !RELEASE_TAG.test(requested)) {
    fail('--to takes an upstream release tag such as v3.9.0');
}

// asked up front: the gate is the last step, after the re-stack and the install
if (!process.env.CHROME_PATH || !fs.existsSync(process.env.CHROME_PATH)) {
    fail('set CHROME_PATH to a Chrome or chrome-headless-shell binary; the gate needs a browser');
}

if (git('status', '--porcelain') !== '') {
    fail('the working tree has uncommitted changes; commit or stash them first');
}

const branch = git('branch', '--show-current');
const base = branch.slice(BRANCH_PREFIX.length);
if (!branch.startsWith(BRANCH_PREFIX) || !RELEASE_TAG.test(base)) {
    fail(`run this on the current library branch (${BRANCH_PREFIX}<upstream tag>); this is '${branch}'`);
}

if (!git('remote').split('\n').includes('upstream')) {
    git('remote', 'add', 'upstream', UPSTREAM_URL);
}
// tags only: the stack sits on releases, never on upstream's main
if (!run('git', ['fetch', 'upstream', 'refs/tags/v*:refs/tags/v*'])) {
    fail('could not fetch the upstream release tags');
}

const releases = git('tag', '--list', 'v*')
    .split('\n')
    .filter((tag) => RELEASE_TAG.test(tag))
    .sort(compareTags);
const target = requested ?? releases.at(-1);
if (!releases.includes(target)) {
    fail(`upstream has no release tag ${target}`);
}
if (target === base) {
    console.log(`upgrade: already on ${base}, the newest upstream release; nothing to do`);
    process.exit(0);
}
if (compareTags(target, base) < 0) {
    fail(`${target} is older than the current base ${base}`);
}

const next = `${BRANCH_PREFIX}${target}`;
console.log(`upgrade: re-stacking ${branch} onto ${target} as ${next}`);
git('checkout', '-b', next);
if (!run('git', ['rebase', '--onto', target, base])) {
    fail(
        [
            `the stack does not apply cleanly on ${target}.`,
            'Resolve each conflict, `git rebase --continue` until the rebase ends, then run',
            '  npm ci && node lib/scripts/verify.mjs',
            `To give up instead: git rebase --abort && git checkout ${branch} && git branch -D ${next}`
        ].join('\n')
    );
}

// the dependency pins moved with upstream's lockfile
if (!run('npm', ['ci', '--no-audit', '--no-fund'])) {
    fail('npm ci failed');
}
if (!run(process.execPath, ['lib/scripts/verify.mjs'])) {
    fail(`the gate failed on ${next}; fix the stack there and rerun node lib/scripts/verify.mjs`);
}

console.log(
    [
        '',
        `upgrade: ${next} passes the gate. Nothing was pushed. Next, by hand:`,
        `  git range-diff ${base}..${branch} ${target}..${next}   # what the re-stack changed in the stack's commits`,
        `  git push origin ${next}`,
        '  node lib/scripts/pack.mjs        # then publish the tarball as a release of the fork',
        '  node lib/scripts/deploy-page.mjs # the bare page, for a look on real devices'
    ].join('\n')
);
