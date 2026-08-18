#!/usr/bin/env node
// Bump package.json's patch version by one. Run by the Pages deploy
// workflow before the build, so every push that reaches main ships a new
// number - the status bar reads it straight out of package.json the same
// way the service worker reads its cache-busting version.
//
// Edits the version line in place with a targeted regex rather than
// re-serialising the whole file, so key order and formatting elsewhere in
// package.json are untouched.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../package.json', import.meta.url));
const text = readFileSync(path, 'utf8');

const match = text.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/);
if (!match) {
    throw new Error('package.json: no "version": "x.y.z" field found');
}

const [full, major, minor, patch] = match;
const nextVersion = `${major}.${minor}.${parseInt(patch, 10) + 1}`;
const nextLine = full.replace(/"(\d+)\.(\d+)\.(\d+)"/, `"${nextVersion}"`);

writeFileSync(path, text.replace(full, nextLine));

// the workflow reads this to build the commit message
console.log(nextVersion);
