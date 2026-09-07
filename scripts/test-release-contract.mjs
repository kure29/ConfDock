#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDirectory = path.join(repoRoot, '.github/workflows');
const read = (name) => fs.readFileSync(path.join(workflowsDirectory, name), 'utf8');
const release = read('release.yml');
const dryRun = read('release-dry-run.yml');

const triggerBlock = release.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1];
assert.ok(triggerBlock, 'manual release trigger block is missing');
assert.match(triggerBlock, /^  workflow_dispatch:/m);
assert.doesNotMatch(triggerBlock, /^  (?:push|pull_request|pull_request_target):/m);

assert.match(release, /^permissions:\n  contents: read$/m);
assert.equal((release.match(/^      contents: write$/gm) ?? []).length, 1);
assert.equal((release.match(/^      packages: write$/gm) ?? []).length, 1);
assert.match(release, /^    environment: release$/m);
assert.doesNotMatch(release, /pull_request_target|secrets\.|(?:^|\s)PAT(?:\s|$)/);
assert.doesNotMatch(release, /^\s*id-token: write$/m);

const validateJob = release.match(/^  validate:\n([\s\S]*?)^  publish:/m)?.[1];
assert.ok(validateJob, 'validate job is missing');
assert.doesNotMatch(validateJob, /contents: write|packages: write|docker\/login-action|docker push|gh release create/);

for (const line of release.split('\n')) {
  if (line.includes('${{ inputs.')) {
    assert.match(line, /^\s+(?:ref|RELEASE_VERSION|RELEASE_SHA|RELEASE_CONFIRMATION): /,
      `manual input is interpolated outside a data-only field: ${line.trim()}`);
  }
}
assert.match(release, /check-ghcr-immutable-tags\.sh[\s\S]*docker push/);
assert.match(release, /local_image='confdock:release-candidate'/);
assert.match(release, /confdock-registry-binary[\s\S]*cmp .*confdock-registry-binary.*image-binary\/confdock/);
assert.match(release, /imagetools inspect --format '\{\{json \.Manifest\}\}'[\s\S]*\.digest/);
assert.doesNotMatch(release, /manifest_digest=.*sha256sum/);
assert.match(release, /partial publication/);

assert.match(dryRun, /^permissions:\n  contents: read$/m);
assert.doesNotMatch(dryRun,
  /contents: write|packages: write|pull_request_target|secrets\.|docker\/login-action|docker push|gh release create/);

for (const file of fs.readdirSync(workflowsDirectory).filter((name) => name.endsWith('.yml'))) {
  const contents = read(file);
  assert.doesNotMatch(contents, /pull_request_target/, `${file} must not use pull_request_target`);
  assert.doesNotMatch(contents,
    /BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
    `${file} contains secret-like material`);
  for (const match of contents.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
    const reference = match[1].split('@')[1];
    assert.match(reference ?? '', /^[0-9a-f]{40}$/,
      `${file} contains a GitHub Action that is not pinned to a full commit SHA: ${match[1]}`);
  }
}

process.stdout.write('release workflow static contract passed\n');
