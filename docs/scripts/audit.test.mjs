import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ALLOWED_ADVISORIES, parseAuditJson, validateAuditReport } from './audit.mjs'

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

function assertFixtureAdvisory(name, advisory) {
  const result = validateAuditReport(loadFixture(name))
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual([...result.advisoryIds], [advisory.toUpperCase()])
}

test('allowlisted GHSA dependency chain passes', () => {
  assertFixturePasses('known')
})

test('Vite optimized-deps path traversal advisory passes', () => {
  assertFixtureAdvisory('vite-path-traversal', 'GHSA-4w7w-66w2-5vf9')
})

test('Vite launch-editor UNC advisory passes', () => {
  assertFixtureAdvisory('vite-ntlm', 'GHSA-v6wh-96g9-6wx3')
})

test('Vite server.fs.deny advisory passes', () => {
  assertFixtureAdvisory('vite-fs-deny', 'GHSA-fx2h-pf6j-xcff')
})

test('current four-advisory report passes with the exact allowlist', () => {
  const result = validateAuditReport(loadFixture('combined'))
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual([...result.advisoryIds].sort(), ALLOWED_ADVISORIES.map((advisory) => advisory.toUpperCase()).sort())
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
