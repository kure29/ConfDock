import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ALLOWED_ADVISORIES = Object.freeze([
  'GHSA-67mh-4wv8-2f99',
  'GHSA-4w7w-66w2-5vf9',
  'GHSA-v6wh-96g9-6wx3',
  'GHSA-fx2h-pf6j-xcff',
])
const ALLOWED_ADVISORY_SET = new Set(ALLOWED_ADVISORIES.map((advisory) => advisory.toUpperCase()))

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']
const EXPECTED_PACKAGES = new Set(['esbuild', 'vite', 'vitepress'])
const EXPECTED_UPSTREAM = {
  esbuild: [],
  vite: ['esbuild'],
  vitepress: ['vite'],
}
const EXPECTED_DOWNSTREAM = {
  esbuild: ['vite'],
  vite: ['vitepress'],
  vitepress: [],
}
const ADVISORY_PATTERN = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/gi

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && expected.every((value) => actual.includes(value))
}

function addError(errors, message) {
  errors.push(message)
}

export function parseAuditJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('npm audit returned empty JSON output')
  }

  let report
  try {
    report = JSON.parse(raw)
  } catch (error) {
    throw new Error(`npm audit returned malformed JSON: ${error.message}`)
  }

  if (!isRecord(report)) {
    throw new Error('npm audit JSON must be an object')
  }

  return report
}

export function validateAuditReport(report) {
  const errors = []
  const advisoryIds = new Set()

  if (!isRecord(report)) {
    return { ok: false, errors: ['npm audit JSON must be an object'], advisoryIds, vulnerabilityCount: null }
  }

  if (report.auditReportVersion !== 2) {
    addError(errors, 'unsupported or missing auditReportVersion (expected 2)')
  }

  const vulnerabilities = report.vulnerabilities
  if (!isRecord(vulnerabilities)) {
    addError(errors, 'missing vulnerabilities object')
  }

  const metadata = report.metadata
  const metadataVulnerabilities = isRecord(metadata) ? metadata.vulnerabilities : null
  if (!isRecord(metadataVulnerabilities)) {
    addError(errors, 'missing metadata.vulnerabilities object')
  }

  let vulnerabilityCount = null
  if (isRecord(metadataVulnerabilities)) {
    const missingLevels = SEVERITIES.filter((severity) => !hasOwn(metadataVulnerabilities, severity))
    if (missingLevels.length > 0) {
      addError(errors, `metadata.vulnerabilities is missing: ${missingLevels.join(', ')}`)
    }

    const counts = SEVERITIES.map((severity) => metadataVulnerabilities[severity])
    if (counts.some((count) => !Number.isInteger(count) || count < 0)) {
      addError(errors, 'metadata vulnerability severity counts must be non-negative integers')
    }

    if (!Number.isInteger(metadataVulnerabilities.total) || metadataVulnerabilities.total < 0) {
      addError(errors, 'metadata.vulnerabilities.total must be a non-negative integer')
    } else if (counts.every((count) => Number.isInteger(count) && count >= 0)) {
      vulnerabilityCount = counts.reduce((sum, count) => sum + count, 0)
      if (metadata.vulnerabilities.total !== vulnerabilityCount) {
        addError(errors, 'metadata vulnerability total does not match severity counts')
      }
    }
    if (metadataVulnerabilities.critical > 0) {
      addError(errors, 'metadata reports Critical vulnerabilities')
    }

    if (!isRecord(metadata.dependencies)) {
      addError(errors, 'missing metadata.dependencies object')
    }
  }

  const vulnerabilityEntries = isRecord(vulnerabilities) ? Object.entries(vulnerabilities) : []
  for (const [packageName, vulnerability] of vulnerabilityEntries) {
    if (!EXPECTED_PACKAGES.has(packageName)) {
      addError(errors, `unexpected vulnerable package: ${packageName}`)
      continue
    }

    if (!isRecord(vulnerability)) {
      addError(errors, `${packageName} vulnerability entry must be an object`)
      continue
    }

    if (vulnerability.name !== packageName) {
      addError(errors, `${packageName} vulnerability has an unexpected name`)
    }
    if (!SEVERITIES.includes(vulnerability.severity)) {
      addError(errors, `${packageName} vulnerability has an invalid severity`)
    } else if (vulnerability.severity === 'critical') {
      addError(errors, `${packageName} vulnerability is critical`)
    }
    if (typeof vulnerability.isDirect !== 'boolean') {
      addError(errors, `${packageName} vulnerability is missing boolean isDirect`)
    }
    if (typeof vulnerability.range !== 'string' || vulnerability.range.length === 0) {
      addError(errors, `${packageName} vulnerability is missing range`)
    }
    if (!hasOwn(vulnerability, 'fixAvailable')) {
      addError(errors, `${packageName} vulnerability is missing fixAvailable`)
    }

    const nodes = vulnerability.nodes
    if (!Array.isArray(nodes) || nodes.length === 0) {
      addError(errors, `${packageName} vulnerability is missing nodes`)
    } else {
      for (const node of nodes) {
        const nodePackage = typeof node === 'string' ? node.split('/').at(-1) : null
        if (!nodePackage || nodePackage !== packageName || node.includes('..')) {
          addError(errors, `${packageName} vulnerability contains an unexpected dependency node`)
        }
      }
    }

    const effects = vulnerability.effects
    if (!Array.isArray(effects) || !effects.every((effect) => typeof effect === 'string')) {
      addError(errors, `${packageName} vulnerability is missing effects array`)
    } else if (!sameMembers(effects, EXPECTED_DOWNSTREAM[packageName])) {
      addError(errors, `${packageName} vulnerability contains an unexpected dependency chain`)
    }

    const via = vulnerability.via
    if (!Array.isArray(via) || via.length === 0) {
      addError(errors, `${packageName} vulnerability is missing via entries`)
      continue
    }

    for (const advisory of via) {
      if (typeof advisory === 'string') {
        if (!EXPECTED_UPSTREAM[packageName].includes(advisory)) {
          addError(errors, `${packageName} references an unexpected dependency: ${advisory}`)
        }
        continue
      }

      if (!isRecord(advisory)) {
        addError(errors, `${packageName} contains a malformed advisory entry`)
        continue
      }
      if (advisory.name !== packageName || advisory.dependency !== packageName) {
        addError(errors, `${packageName} advisory identifies an unexpected package`)
      }
      if (!Number.isInteger(advisory.source) || advisory.source <= 0) {
        addError(errors, `${packageName} advisory is missing numeric source`)
      }
      if (typeof advisory.title !== 'string' || advisory.title.length === 0) {
        addError(errors, `${packageName} advisory is missing title`)
      }
      if (typeof advisory.range !== 'string' || advisory.range.length === 0) {
        addError(errors, `${packageName} advisory is missing range`)
      }
      if (!SEVERITIES.includes(advisory.severity)) {
        addError(errors, `${packageName} advisory has an invalid severity`)
      } else if (advisory.severity === 'critical') {
        addError(errors, `${packageName} advisory is critical`)
      }

      if (typeof advisory.url !== 'string') {
        addError(errors, `${packageName} advisory is missing URL`)
      } else {
        const ids = [...advisory.url.matchAll(ADVISORY_PATTERN)].map(([id]) => id.toUpperCase())
        if (ids.length !== 1) {
          addError(errors, `${packageName} advisory URL does not contain exactly one GHSA ID`)
        } else {
          advisoryIds.add(ids[0])
          if (!ALLOWED_ADVISORY_SET.has(ids[0])) {
            addError(errors, `unexpected advisory ${ids[0]}`)
          }
        }
      }
    }
  }

  if (vulnerabilityCount !== null) {
    if (vulnerabilityCount === 0 && vulnerabilityEntries.length !== 0) {
      addError(errors, 'metadata reports no vulnerabilities but entries are present')
    }
    if (vulnerabilityCount > 0 && vulnerabilityEntries.length === 0) {
      addError(errors, 'metadata reports vulnerabilities but entries are missing')
    }
    if (vulnerabilityCount > 0 && advisoryIds.size === 0) {
      addError(errors, 'vulnerability entries contain no advisory ID')
    }
  }

  return { ok: errors.length === 0, errors, advisoryIds, vulnerabilityCount }
}

function npmAuditInvocation() {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, 'audit', '--json'] }
  }
  return { command: 'npm', args: ['audit', '--json'] }
}

export function runAudit() {
  const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const invocation = npmAuditInvocation()
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: docsDir,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) {
    throw new Error(`unable to execute npm audit: ${result.error.message}`)
  }
  if (result.signal || result.status === null) {
    throw new Error(`npm audit terminated unexpectedly${result.signal ? ` by ${result.signal}` : ''}`)
  }

  let report
  try {
    report = parseAuditJson(result.stdout)
  } catch (error) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    throw new Error(`${error.message}${stderr ? `\n${stderr}` : ''}`)
  }

  const validation = validateAuditReport(report)
  if (!validation.ok) {
    throw new Error(`npm audit validation failed:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`)
  }

  const expectedExit = validation.vulnerabilityCount === 0 ? 0 : 1
  if (result.status !== expectedExit) {
    throw new Error(`npm audit exited with ${result.status}; expected ${expectedExit} for this report`)
  }

  return validation
}

export function main() {
  try {
    const validation = runAudit()
    if (validation.vulnerabilityCount === 0) {
      console.log(`npm audit found no vulnerabilities; remove the ${ALLOWED_ADVISORIES.join(', ')} whitelist after confirming the clean result.`)
    } else {
      console.log(`npm audit passed with only the allowlisted advisories ${ALLOWED_ADVISORIES.join(', ')}; all other advisories and Critical findings remain blocking.`)
    }
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  process.exitCode = main()
}
