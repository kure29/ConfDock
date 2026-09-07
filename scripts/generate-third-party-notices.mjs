#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GENERATOR_VERSION = '1.0.0';

const EXPRESSION_POLICY = new Map([
  ['(Apache-2.0 OR MIT) AND BSD-3-Clause', ['MIT', 'BSD-3-Clause']],
  ['(MIT OR Apache-2.0) AND Unicode-3.0', ['MIT', 'Unicode-3.0']],
  ['Apache-2.0', ['Apache-2.0']],
  ['Apache-2.0 OR BSL-1.0', ['Apache-2.0']],
  ['Apache-2.0 OR MIT', ['MIT']],
  ['Apache-2.0/MIT', ['MIT']],
  ['BSD-3-Clause', ['BSD-3-Clause']],
  ['MIT', ['MIT']],
  ['MIT AND BSD-3-Clause', ['MIT', 'BSD-3-Clause']],
  ['MIT OR Apache-2.0', ['MIT']],
  ['MIT/Apache-2.0', ['MIT']],
  ['Unicode-3.0', ['Unicode-3.0']],
  ['Unlicense OR MIT', ['MIT']],
  ['Unlicense/MIT', ['MIT']],
  ['Zlib', ['Zlib']],
]);

export function selectedLicenses(expression) {
  if (typeof expression !== 'string' || expression.length === 0) {
    throw new Error('missing license expression');
  }
  const selected = EXPRESSION_POLICY.get(expression);
  if (!selected) {
    throw new Error(`unapproved license expression: ${expression}`);
  }
  return [...selected];
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';
}

function command(commandName, argumentsList, cwd) {
  return execFileSync(commandName, argumentsList, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function dependencyKeys(treeOutput) {
  const result = new Set();
  for (let line of treeOutput.split('\n')) {
    line = line.replace(/ \(\*\)$/, '').replace(/ \(proc-macro\)$/, '').trim();
    const match = /^([^ ]+) v([^ ]+)(?: \(.+\))?$/.exec(line);
    if (match) result.add(`${match[1]}@${match[2]}`);
  }
  return result;
}

function walkLicenseCandidates(root) {
  const result = [];
  const walk = (directory, depth, inLicenseDirectory = false) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 1 && /^licenses?$/i.test(entry.name)) walk(absolute, depth + 1, true);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!inLicenseDirectory && !/(licen[cs]e|copying|copyright|notice)/i.test(entry.name)) continue;
      result.push({
        absolute,
        relative: path.relative(root, absolute).split(path.sep).join('/'),
        text: normalizeText(fs.readFileSync(absolute, 'utf8')),
      });
    }
  };
  walk(root, 0);
  return result.sort((left, right) => left.relative.localeCompare(right.relative, 'en'));
}

function textMatchesLicense(text, license) {
  switch (license) {
    case 'MIT':
      return /Permission is hereby granted, free of charge/i.test(text)
        && /THE SOFTWARE IS PROVIDED [“"']?AS IS[”"']?/i.test(text);
    case 'Apache-2.0':
      return /Apache License/i.test(text) && /Version 2\.0/i.test(text);
    case 'BSD-3-Clause':
      return /Redistribution and use in source and binary forms/i.test(text)
        && /Neither the name[\s\S]{0,160}names? of its[\s\S]{0,40}contributors/i.test(text);
    case 'Unicode-3.0':
      return /UNICODE LICENSE V3/i.test(text) && /COPYRIGHT AND PERMISSION NOTICE/i.test(text);
    case 'Zlib':
      return /This software is provided ['’]as-is['’]/i.test(text)
        && /Altered source versions must be plainly marked/i.test(text);
    default:
      return false;
  }
}

function chooseLicenseFile(candidates, license, packageKey) {
  const matching = candidates.filter((candidate) => textMatchesLicense(candidate.text, license));
  if (matching.length === 0) {
    throw new Error(`${packageKey}: no distributable text found for selected ${license}`);
  }
  const token = license === 'Apache-2.0' ? 'apache'
    : license === 'BSD-3-Clause' ? 'whatwg|bsd|httprouter'
      : license === 'Unicode-3.0' ? 'unicode'
        : license === 'Zlib' ? 'zlib'
          : 'mit';
  matching.sort((left, right) => {
    const leftPreferred = new RegExp(token, 'i').test(left.relative) ? 0 : 1;
    const rightPreferred = new RegExp(token, 'i').test(right.relative) ? 0 : 1;
    return leftPreferred - rightPreferred || left.relative.localeCompare(right.relative, 'en');
  });
  return matching[0];
}

function sqlitePublicDomainNotice(packageRoot, packageKey) {
  if (packageKey !== 'libsqlite3-sys@0.30.1') return null;
  const source = fs.readFileSync(path.join(packageRoot, 'sqlite3/sqlite3.c'), 'utf8');
  const match = source.match(/The author disclaims copyright to this source code\.[\s\S]*?May you share freely, never taking more than you give\./);
  if (!match) throw new Error(`${packageKey}: bundled SQLite public-domain notice is missing`);
  return {
    absolute: path.join(packageRoot, 'sqlite3/sqlite3.c'),
    relative: 'sqlite3/sqlite3.c (public-domain notice)',
    text: normalizeText(match[0]),
  };
}

function addTextBlock(blocks, candidate, packageKey) {
  const digest = sha256(candidate.text);
  const existing = blocks.get(digest) ?? {
    digest,
    text: candidate.text,
    sources: new Set(),
    packages: new Set(),
  };
  existing.sources.add(candidate.relative);
  existing.packages.add(packageKey);
  blocks.set(digest, existing);
}

function cargoPackages(repoRoot) {
  const treeArguments = [
    ['tree', '--locked', '-p', 'confdock-service', '--features', 'embedded-web', '--target', 'x86_64-unknown-linux-gnu', '-e', 'normal', '--prefix', 'none', '--format', '{p}'],
    ['tree', '--locked', '-p', 'confdock-wasm', '--target', 'wasm32-unknown-unknown', '-e', 'normal', '--prefix', 'none', '--format', '{p}'],
  ];
  const selected = new Set();
  for (const argumentsList of treeArguments) {
    for (const key of dependencyKeys(command('cargo', argumentsList, repoRoot))) selected.add(key);
  }

  const metadataPackages = [];
  for (const argumentsList of [
    ['metadata', '--locked', '--features', 'confdock-service/embedded-web', '--filter-platform', 'x86_64-unknown-linux-gnu', '--format-version', '1'],
    ['metadata', '--locked', '--filter-platform', 'wasm32-unknown-unknown', '--format-version', '1'],
  ]) {
    metadataPackages.push(...JSON.parse(command('cargo', argumentsList, repoRoot)).packages);
  }
  const packages = metadataPackages
    .filter((item) => item.source?.startsWith('registry+'))
    .filter((item) => selected.has(`${item.name}@${item.version}`))
    .map((item) => ({
      ecosystem: 'Cargo',
      name: item.name,
      version: item.version,
      declared: item.license,
      root: path.dirname(item.manifest_path),
      packageKey: `${item.name}@${item.version}`,
    }))
    .filter((item, index, array) => array.findIndex((candidate) => candidate.packageKey === item.packageKey) === index);

  const found = new Set(packages.map((item) => item.packageKey));
  const workspacePackageNames = new Set([
    'confdock-core',
    'confdock-service',
    'confdock-validator',
    'confdock-wasm',
  ]);
  const unresolved = [...selected].filter((key) => {
    const packageName = key.slice(0, key.lastIndexOf('@'));
    return !workspacePackageNames.has(packageName) && !found.has(key);
  });
  if (unresolved.length > 0) {
    throw new Error(`Cargo release graph was not resolved: ${unresolved.join(', ')}`);
  }
  return packages;
}

function npmPackages(repoRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'web/package-lock.json'), 'utf8'));
  const packages = [];
  for (const [packagePath, item] of Object.entries(lock.packages ?? {})) {
    if (packagePath === '' || item.dev === true) continue;
    if (!packagePath.startsWith('node_modules/')) {
      throw new Error(`unexpected production npm package path: ${packagePath}`);
    }
    const name = packagePath.slice('node_modules/'.length);
    const packageRoot = path.join(repoRoot, 'web', packagePath);
    const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (installed.name !== name || installed.version !== item.version) {
      throw new Error(`${name}: installed package does not match web/package-lock.json`);
    }
    packages.push({
      ecosystem: 'npm',
      name,
      version: item.version,
      declared: item.license ?? installed.license,
      root: packageRoot,
      packageKey: `${name}@${item.version}`,
    });
  }
  return packages;
}

export function renderNotices(repoRoot) {
  const packages = [...cargoPackages(repoRoot), ...npmPackages(repoRoot)]
    .sort((left, right) => left.ecosystem.localeCompare(right.ecosystem, 'en')
      || left.name.localeCompare(right.name, 'en')
      || left.version.localeCompare(right.version, 'en'));
  const blocks = new Map();

  for (const item of packages) {
    item.selected = selectedLicenses(item.declared);
    const candidates = walkLicenseCandidates(item.root);
    const chosen = item.selected.map((license) => chooseLicenseFile(candidates, license, item.packageKey));
    const requiredAttributions = candidates.filter((candidate) =>
      /(copyright|notice|third[-_. ]party)/i.test(candidate.relative));
    for (const candidate of [...chosen, ...requiredAttributions]) {
      addTextBlock(blocks, candidate, item.packageKey);
    }
    const sqliteNotice = sqlitePublicDomainNotice(item.root, item.packageKey);
    if (sqliteNotice) addTextBlock(blocks, sqliteNotice, item.packageKey);
  }

  const cargoLock = fs.readFileSync(path.join(repoRoot, 'Cargo.lock'));
  const webLock = fs.readFileSync(path.join(repoRoot, 'web/package-lock.json'));
  const docsLock = fs.readFileSync(path.join(repoRoot, 'docs/package-lock.json'));
  const lines = [
    '# ConfDock Third-Party Notices',
    '',
    'This is the release notices artifact for the ConfDock Linux x86-64 single binary and its embedded Web/WASM application.',
    'It is generated deterministically from the locked normal dependency graphs for `confdock-service` with `embedded-web` on `x86_64-unknown-linux-gnu`, `confdock-wasm` on `wasm32-unknown-unknown`, and the non-development records in `web/package-lock.json`.',
    '',
    `Generator: \`scripts/generate-third-party-notices.mjs\` version ${GENERATOR_VERSION}.`,
    `Cargo.lock SHA-256: \`${sha256(cargoLock)}\`.`,
    `web/package-lock.json SHA-256: \`${sha256(webLock)}\`.`,
    '',
    'Every dual-license expression below has an explicit selected license. Unknown, missing, or unapproved expressions fail generation. Build/test dependencies that are not in either target-specific normal Cargo graph are excluded.',
    `The documentation tool graph is development-only and is deliberately excluded; its independent \`docs/package-lock.json\` SHA-256 is \`${sha256(docsLock)}\` and is audited separately.`,
    '',
    'The embedded production bundle retains upstream license comments. Its production npm packages are also listed here; CI separately rejects unexpected license/copyright markers in the generated bundle.',
    '',
    '## Distributed dependency inventory',
    '',
    '| Ecosystem | Package | Version | Declared expression | Selected license(s) |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const item of packages) {
    lines.push(`| ${item.ecosystem} | \`${item.name}\` | \`${item.version}\` | \`${item.declared}\` | ${item.selected.map((license) => `\`${license}\``).join(', ')} |`);
  }
  lines.push('', '## License and attribution texts', '');
  const sortedBlocks = [...blocks.values()].sort((left, right) => left.digest.localeCompare(right.digest, 'en'));
  for (const block of sortedBlocks) {
    lines.push(`### SHA-256 ${block.digest}`, '');
    lines.push(`Packages: ${[...block.packages].sort().map((item) => `\`${item}\``).join(', ')}.`);
    lines.push(`Upstream file names: ${[...block.sources].sort().map((item) => `\`${item}\``).join(', ')}.`);
    lines.push('', '```text', block.text.trimEnd(), '```', '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length !== 2 || argumentsList[0] !== '--output') {
    process.stderr.write('usage: generate-third-party-notices.mjs --output PATH\n');
    process.exit(2);
  }
  const output = path.resolve(argumentsList[1]);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.third-party-notices.${process.pid}.${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(temporary, renderNotices(repoRoot), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
