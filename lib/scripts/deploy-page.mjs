#!/usr/bin/env node
// Publishes the built bare page (lib/page/dist) as the fork's GitHub Pages site.
//
//   node lib/scripts/deploy-page.mjs [--remote origin]
//
// The `gh-pages` branch is build output only: each deploy replaces it with one
// commit, so it never carries history worth keeping and is pushed with --force.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PAGE_DIST_DIR, ROOT_DIR, relative } from './layout.mjs';

const PAGES_BRANCH = 'gh-pages';

const fail = (message) => {
    console.error(`deploy-page: ${message}`);
    process.exit(1);
};

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// a setting git may not have; empty when it does not
const setting = (name) => {
    try {
        return git(ROOT_DIR, 'config', name);
    } catch {
        return '';
    }
};

const remoteIndex = process.argv.indexOf('--remote');
const remote = remoteIndex === -1 ? 'origin' : process.argv[remoteIndex + 1];

if (!fs.existsSync(path.join(PAGE_DIST_DIR, 'index.html'))) {
    fail(`${relative(PAGE_DIST_DIR)}/index.html is missing: run node lib/scripts/build.mjs first`);
}

// the staging repository below starts without this repository's identity
const userName = setting('user.name');
const userEmail = setting('user.email');
if (!userName || !userEmail) {
    fail('git has no user.name and user.email for this repository; the deploy commit needs an author');
}

const url = git(ROOT_DIR, 'remote', 'get-url', '--push', remote);
const source = git(ROOT_DIR, 'rev-parse', '--short', 'HEAD');
const dirty = git(ROOT_DIR, 'status', '--porcelain') !== '';

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'supersplat-page-'));
try {
    fs.cpSync(PAGE_DIST_DIR, staging, { recursive: true });
    // the site is plain files; without this GitHub runs them through Jekyll
    fs.writeFileSync(path.join(staging, '.nojekyll'), '');

    git(staging, 'init', '--quiet', '--initial-branch', PAGES_BRANCH);
    git(staging, 'add', '--all');
    git(
        staging,
        '-c',
        `user.name=${userName}`,
        '-c',
        `user.email=${userEmail}`,
        'commit',
        '--quiet',
        '--message',
        `Bare page built from ${source}${dirty ? ' (with uncommitted changes)' : ''}`
    );
    git(staging, 'push', '--quiet', '--force', url, `${PAGES_BRANCH}:${PAGES_BRANCH}`);
    console.log(`deploy-page: pushed the page built from ${source} to ${remote}/${PAGES_BRANCH}`);
} finally {
    fs.rmSync(staging, { recursive: true, force: true });
}
