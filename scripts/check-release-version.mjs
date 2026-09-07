#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

function fail(message) {
  process.stderr.write(`release version check: ${message}\n`);
  process.exit(1);
}

const version = read('VERSION').trim();
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
  fail(`VERSION is not a strict stable SemVer: ${version}`);
}

const cargoManifest = read('Cargo.toml');
const cargoMatch = cargoManifest.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
if (!cargoMatch || cargoMatch[1] !== version) {
  fail('Cargo workspace version does not match VERSION');
}

const cargoLock = read('Cargo.lock');
for (const crate of ['confdock-core', 'confdock-service', 'confdock-validator', 'confdock-wasm']) {
  const escaped = crate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cargoLock.match(new RegExp(`name = "${escaped}"\\nversion = "([^"]+)"`));
  if (!match || match[1] !== version) {
    fail(`${crate} in Cargo.lock does not match VERSION`);
  }
}

for (const directory of ['web', 'docs']) {
  const manifest = readJson(`${directory}/package.json`);
  const lock = readJson(`${directory}/package-lock.json`);
  if (manifest.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
    fail(`${directory} package metadata does not match VERSION`);
  }
}

const dockerfile = read('Dockerfile');
if (!dockerfile.includes(`ARG VERSION=${version}`)) {
  fail('Dockerfile VERSION default does not match VERSION');
}

const compose = read('deploy/docker/compose.yaml');
if (!compose.includes(`ghcr.io/kure29/confdock:${version}`)) {
  fail('production Compose image default does not match VERSION');
}

const packageScript = read('scripts/package-single-binary.sh');
const dockerBundleScript = read('scripts/package-docker-bundle.sh');
for (const [name, contents] of [
  ['binary package script', packageScript],
  ['Docker bundle script', dockerBundleScript],
]) {
  if (!contents.includes('VERSION')) {
    fail(`${name} does not read the canonical VERSION file`);
  }
}

process.stdout.write(`ConfDock release version is consistent: ${version}\n`);
