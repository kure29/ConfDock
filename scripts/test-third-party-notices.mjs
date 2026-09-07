#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectedLicenses } from './generate-third-party-notices.mjs';

test('dual-license choices are explicit and permissive', () => {
  assert.deepEqual(selectedLicenses('MIT OR Apache-2.0'), ['MIT']);
  assert.deepEqual(selectedLicenses('Apache-2.0 OR BSL-1.0'), ['Apache-2.0']);
  assert.deepEqual(
    selectedLicenses('(Apache-2.0 OR MIT) AND BSD-3-Clause'),
    ['MIT', 'BSD-3-Clause'],
  );
});

test('unknown and restrictive licenses fail closed', () => {
  assert.throws(() => selectedLicenses('GPL-3.0-only'), /unapproved license expression/);
  assert.throws(() => selectedLicenses('LicenseRef-Proprietary'), /unapproved license expression/);
  assert.throws(() => selectedLicenses(undefined), /missing license expression/);
});
