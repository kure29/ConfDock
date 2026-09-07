#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repoRoot, 'web/dist');
const allowedCopyrights = [
  'Copyright (c) Meta Platforms, Inc. and affiliates.',
  'Copyright (c) Remix Software Inc.',
];
let markers = 0;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (!entry.isFile() || !/\.(?:html|css|js|svg)$/.test(entry.name)) continue;
    const contents = fs.readFileSync(absolute, 'utf8');
    for (const line of contents.split('\n')) {
      if (!/@license|copyright|licensed under/i.test(line)) continue;
      markers += 1;
      const trimmed = line.replace(/^.*?\*\s?/, '').trim();
      const allowed = /^@license (?:React|MIT)$/.test(trimmed)
        || /^This source code is licensed under the MIT license found in the$/.test(trimmed)
        || allowedCopyrights.includes(trimmed);
      if (!allowed) {
        process.stderr.write(`unexpected production bundle attribution marker in ${path.relative(repoRoot, absolute)}: ${trimmed}\n`);
        process.exit(1);
      }
    }
  }
}

if (!fs.statSync(dist, { throwIfNoEntry: false })?.isDirectory()) {
  process.stderr.write('web/dist is missing; build the production bundle first\n');
  process.exit(1);
}
walk(dist);
if (markers === 0) {
  process.stderr.write('no production bundle attribution markers were found\n');
  process.exit(1);
}
process.stdout.write(`production bundle attribution markers verified: ${markers}\n`);
