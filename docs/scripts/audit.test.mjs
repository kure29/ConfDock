import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAuditJson, validateAuditReport } from './audit.mjs'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadFixture(name) {
  return parseAuditJson(readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'))
}

function assertFixturePasses(name) {
  const result = validateAuditReport(loadFixture(name))
  assert.equal(result.ok, true, result.errors.join('\n'))
}

function assertFixtureFails(name) {
  const result = validateAuditReport(loadFixture(name))
  assert.equal(result.ok, false)
  assert.ok(result.errors.length > 0)
}

test('allowlisted GHSA dependency chain passes', () => {
  assertFixturePasses('known')
})

test('zero vulnerabilities passes and can remove the whitelist', () => {
  const report = loadFixture('clean')
  const result = validateAuditReport(report)
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.vulnerabilityCount, 0)
  assert.equal(result.advisoryIds.size, 0)
})

test('unknown advisory fails', () => {
  assertFixtureFails('unknown-advisory')
})

test('Critical advisory fails', () => {
  assertFixtureFails('critical')
})

test('unexpected package fails', () => {
  assertFixtureFails('unexpected-package')
})

test('unexpected dependency chain fails', () => {
  assertFixtureFails('unexpected-chain')
})

test('malformed JSON fails closed', () => {
  assert.throws(() => loadFixture('malformed'), /malformed JSON/)
})

test('incomplete JSON fails closed', () => {
  assertFixtureFails('incomplete')
})
