#!/usr/bin/env node
// @ts-check
/**
 * shipped-runtime — the release and nightly gate for what ends up in users' hands.
 *
 * Three checks, all reported together:
 *
 *   1. No advisory of moderate severity or higher in the audited tree
 *      (`npm audit --omit=dev`).
 *   2. The desktop runtime is still in that tree. It is there only because it is
 *      a peer of a runtime dependency, although package.json lists it under
 *      devDependencies, so a dependency cleanup could drop it from the audit
 *      without anyone noticing.
 *   3. The runtime is on the latest stable release of its major line, and that
 *      line is one of the three the runtime's project supports. Fixes to the
 *      embedded browser engine arrive as runtime patch releases and cannot be
 *      relied on to show up as advisories, so being current is what protects.
 *
 * Releases younger than the dependency freshness rule (two days) are invisible
 * to check 3: the gate must never demand a version the rule forbids installing.
 *
 * Data that cannot be fetched or read is a failure of its own kind. It never
 * reads as a pass.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUNTIME = 'electron'
const BLOCKING_SEVERITIES = new Set(['moderate', 'high', 'critical'])
const FRESHNESS_DAYS = 2
const SUPPORTED_LINES = 3
const MS_PER_DAY = 24 * 60 * 60 * 1000
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/

/** @typedef {{ name: string, severity: string, advisories: string[] }} Finding */
/** @typedef {{ kind: string, message: string }} Failure */

/**
 * @param {any} report parsed `npm audit --json` output
 * @returns {{ status: 'ok' | 'findings' | 'unavailable', findings: Finding[] }}
 */
export function evaluateAudit(report) {
  if (!report?.metadata?.vulnerabilities || !report.vulnerabilities) {
    return { status: 'unavailable', findings: [] }
  }
  /** @type {Finding[]} */
  const findings = Object.entries(report.vulnerabilities)
    .filter(([, entry]) => BLOCKING_SEVERITIES.has(/** @type {any} */ (entry).severity))
    .map(([name, entry]) => {
      const { severity, via } = /** @type {any} */ (entry)
      const advisories = (via ?? [])
        .filter((/** @type {any} */ item) => typeof item === 'object' && item.url)
        .map((/** @type {any} */ item) => String(item.url))
      return { name, severity, advisories }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { status: findings.length > 0 ? 'findings' : 'ok', findings }
}

/** @param {string} version */
function parseStable(version) {
  const match = STABLE_VERSION.exec(version)
  return match ? match.slice(1, 4).map(Number) : undefined
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * @param {{ installed: string, times: Record<string, string>, now: Date }} input
 * @returns {{ status: 'ok' | 'behind' | 'unsupported' | 'unavailable', message?: string }}
 */
export function evaluateRuntimeCurrency({ installed, times, now }) {
  const cutoff = now.getTime() - FRESHNESS_DAYS * MS_PER_DAY
  const eligible = Object.entries(times)
    .filter(([, published]) => Date.parse(published) <= cutoff)
    .map(([version]) => parseStable(version))
    .filter((parsed) => parsed !== undefined)
    .sort((a, b) => compareVersions(b, a))

  if (eligible.length === 0) {
    return { status: 'unavailable', message: `no published releases of ${RUNTIME} were readable` }
  }

  const majors = [...new Set(eligible.map(([major]) => major))]
  const supported = majors.slice(0, SUPPORTED_LINES)
  const supportedText = supported.join(', ')

  const current = parseStable(installed)
  if (!current) {
    return {
      status: 'unsupported',
      message: `${RUNTIME} ${installed} is not a stable release; supported lines: ${supportedText}`
    }
  }
  // A line newer than anything past the freshness window is ahead, not behind.
  if (current[0] > majors[0]) return { status: 'ok' }
  if (!supported.includes(current[0])) {
    return {
      status: 'unsupported',
      message: `${RUNTIME} ${installed} is on an unsupported line; supported lines: ${supportedText}`
    }
  }

  const latest = eligible.find(([major]) => major === current[0])
  if (latest && compareVersions(current, latest) < 0) {
    return {
      status: 'behind',
      message: `${RUNTIME} ${installed} is behind ${latest.join('.')}, the latest release of its line`
    }
  }
  return { status: 'ok' }
}

/**
 * @param {any} tree parsed `npm ls --json` output
 * @returns {boolean}
 */
export function isRuntimeInAuditedTree(tree) {
  const dependencies = tree?.dependencies
  if (!dependencies) return false
  return (
    RUNTIME in dependencies ||
    Object.values(dependencies).some((child) => isRuntimeInAuditedTree(child))
  )
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * @param {{
 *   runNpm: (args: string[]) => { stdout: string },
 *   readInstalledVersion: () => string | undefined,
 *   now: Date
 * }} deps
 * @returns {{ ok: boolean, failures: Failure[] }}
 */
export function runShippedRuntimeAudit({ runNpm, readInstalledVersion, now }) {
  /** @type {Failure[]} */
  const failures = []
  /** @param {string} what */
  const unavailable = (what) =>
    failures.push({ kind: 'unavailable', message: `Could not ${what}; nothing was verified.` })

  const audit = evaluateAudit(parseJson(runNpm(['audit', '--omit=dev', '--json']).stdout))
  if (audit.status === 'unavailable') unavailable('read the advisory data from the registry')
  for (const { name, severity, advisories } of audit.findings) {
    const links = advisories.length > 0 ? ` (${advisories.join(', ')})` : ''
    failures.push({
      kind: 'finding',
      message: `${severity} advisory in shipped package ${name}${links}`
    })
  }

  const tree = parseJson(runNpm(['ls', RUNTIME, '--omit=dev', '--all', '--json']).stdout)
  if (tree === undefined) {
    unavailable('read the production dependency tree')
  } else if (!isRuntimeInAuditedTree(tree)) {
    failures.push({
      kind: 'not-audited',
      message: `${RUNTIME} is no longer in the production dependency tree, so the audit above does not cover it`
    })
  }

  const installed = readInstalledVersion()
  const times = parseJson(runNpm(['view', RUNTIME, 'time', '--json']).stdout)
  if (installed === undefined) {
    unavailable(`find the ${RUNTIME} version in the lockfile`)
  } else if (times === undefined) {
    unavailable(`read the ${RUNTIME} release history from the registry`)
  } else {
    const currency = evaluateRuntimeCurrency({ installed, times, now })
    if (currency.status === 'unavailable') {
      unavailable(`read the ${RUNTIME} release history from the registry`)
    } else if (currency.status !== 'ok') {
      failures.push({ kind: currency.status, message: currency.message ?? '' })
    }
  }

  return { ok: failures.length === 0, failures }
}

/** @param {string[]} args */
function runNpm(args) {
  // `npm audit` and `npm ls` exit non-zero when they have something to report,
  // and still print their JSON, so the exit status is deliberately not read.
  // shell:true with one static command string: no user input reaches it.
  const result = spawnSync(['npm', ...args].join(' '), {
    cwd: process.cwd(),
    shell: true,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024
  })
  return { stdout: result.stdout ?? '' }
}

function readInstalledVersion() {
  const lock = JSON.parse(readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf-8'))
  return lock.packages?.[`node_modules/${RUNTIME}`]?.version
}

function main() {
  const { ok, failures } = runShippedRuntimeAudit({
    runNpm,
    readInstalledVersion,
    now: new Date()
  })
  if (ok) {
    process.stdout.write('shipped-runtime: no blocking advisories, and the runtime is current.\n')
    return
  }
  for (const { message } of failures) process.stderr.write(`shipped-runtime: ${message}\n`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
