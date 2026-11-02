#!/usr/bin/env node
/**
 * post-req — REQ-0055 §4.6.3 orchestrator.
 *
 * Runs after every REQ to make sure nothing regressed. Each step inherits
 * stdio so the developer sees the same output they'd see running the
 * underlying command directly. Aborts on the first non-zero exit.
 *
 * Steps:
 *   1. atomic-write audit                 (npm run audit:atomicwrites — source-level, no build needed)
 *   2. typecheck                          (npm run typecheck)
 *   3. lint                               (npm run lint)
 *   4. format drift                       (npm run format:check)
 *   5. unit + coverage                    (npm run test:coverage)
 *   6. coverage no-regression gate        (this file)
 *   7. build if `out/main/index.js` is missing  (so smoke has something to launch)
 *   8. smoke                              (npm run test:smoke)
 *
 * Exit codes:
 *   0  every step passed
 *   1  a step failed; the offending step is the last line of stderr
 *   2  internal error (missing baseline, malformed JSON, etc.)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const REPO_ROOT = process.cwd()
const COVERAGE_SUMMARY = resolve(REPO_ROOT, 'coverage', 'coverage-summary.json')
const COVERAGE_BASELINE = resolve(REPO_ROOT, 'test', 'coverage-baseline.json')
const MAIN_ENTRY = resolve(REPO_ROOT, 'out', 'main', 'index.js')

const isWindows = process.platform === 'win32'
const NPM = isWindows ? 'npm.cmd' : 'npm'

const METRICS = /** @type {const} */ (['statements', 'branches', 'functions', 'lines'])
const PROJECT_PREFIX = {
  main: '/src/main/',
  shared: '/src/shared/',
  renderer: '/src/renderer/',
  core: '/packages/fetchpier-core/',
  cli: '/packages/fetchpier-cli/'
}

let stepCounter = 0
function announce(title) {
  stepCounter += 1
  process.stdout.write(`\n\x1b[36m▶ [${stepCounter}] ${title}\x1b[0m\n`)
}

function runStep(title, cmd, args) {
  announce(title)
  const started = performance.now()
  // shell:true with a single command string avoids the DEP0190 deprecation
  // (Node 24+) that fires when args are passed as a separate array under
  // shell:true. All callers here use static, shell-safe args (no user input).
  const result = spawnSync([cmd, ...args].join(' '), {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    shell: true
  })
  const elapsed = ((performance.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    process.stderr.write(`\n\x1b[31m✗ FAILED: ${title} (after ${elapsed}s)\x1b[0m\n`)
    process.exit(1)
  }
  process.stdout.write(`\x1b[32m✓ ${title} (${elapsed}s)\x1b[0m\n`)
}

function computePerProject(summary) {
  const groups = {}
  for (const proj of Object.keys(PROJECT_PREFIX)) {
    groups[proj] = {}
    for (const m of METRICS) groups[proj][m] = { covered: 0, total: 0 }
  }
  for (const [key, val] of Object.entries(summary)) {
    if (key === 'total') continue
    const norm = key.replace(/\\/g, '/')
    let proj = null
    for (const [name, prefix] of Object.entries(PROJECT_PREFIX)) {
      if (norm.includes(prefix)) {
        proj = name
        break
      }
    }
    if (!proj) continue
    for (const m of METRICS) {
      groups[proj][m].covered += val[m].covered
      groups[proj][m].total += val[m].total
    }
  }
  const out = {}
  for (const [proj, buckets] of Object.entries(groups)) {
    out[proj] = {}
    for (const m of METRICS) {
      out[proj][m] =
        buckets[m].total === 0
          ? 0
          : Number(((100 * buckets[m].covered) / buckets[m].total).toFixed(2))
    }
  }
  // Totals come straight from the summary's `total` block — that already
  // excludes filtered files.
  out.total = {}
  for (const m of METRICS) {
    out.total[m] = Number(summary.total[m].pct.toFixed(2))
  }
  return out
}

function checkCoverageGate() {
  announce('coverage no-regression gate')
  if (!existsSync(COVERAGE_BASELINE)) {
    process.stderr.write(`\x1b[31m✗ baseline missing: ${COVERAGE_BASELINE}\x1b[0m\n`)
    process.exit(2)
  }
  if (!existsSync(COVERAGE_SUMMARY)) {
    process.stderr.write(
      `\x1b[31m✗ coverage summary missing: ${COVERAGE_SUMMARY}\n` +
        `  (did the previous step actually run with --coverage?)\x1b[0m\n`
    )
    process.exit(2)
  }
  const baseline = JSON.parse(readFileSync(COVERAGE_BASELINE, 'utf8'))
  const summary = JSON.parse(readFileSync(COVERAGE_SUMMARY, 'utf8'))
  const current = computePerProject(summary)
  const tolerance = Number(baseline.regressionTolerance ?? 0.5)

  /** @type {Array<{project: string; metric: string; baseline: number; current: number; delta: number}>} */
  const regressions = []
  /** @type {Array<{project: string; metric: string; baseline: number; current: number; delta: number}>} */
  const improvements = []
  for (const [project, expected] of Object.entries(baseline.projects)) {
    const actual = current[project]
    if (!actual) {
      process.stderr.write(
        `\x1b[33m⚠ baseline declares "${project}" but current run produced no data — skipping\x1b[0m\n`
      )
      continue
    }
    for (const metric of METRICS) {
      const want = Number(expected[metric])
      const have = Number(actual[metric])
      if (!Number.isFinite(want)) continue
      const delta = Number((have - want).toFixed(2))
      if (delta < -tolerance) {
        regressions.push({ project, metric, baseline: want, current: have, delta })
      } else if (delta >= 1) {
        improvements.push({ project, metric, baseline: want, current: have, delta })
      }
    }
  }

  if (improvements.length > 0) {
    process.stdout.write('\x1b[32mImprovements vs baseline (≥+1 pp):\x1b[0m\n')
    for (const imp of improvements) {
      process.stdout.write(
        `  ${imp.project.padEnd(8)} ${imp.metric.padEnd(10)} ${imp.baseline.toFixed(2)}% → ${imp.current.toFixed(2)}% (+${imp.delta.toFixed(2)} pp)\n`
      )
    }
  }

  if (regressions.length > 0) {
    process.stderr.write(`\x1b[31mCoverage regression beyond ±${tolerance} pp tolerance:\x1b[0m\n`)
    for (const reg of regressions) {
      process.stderr.write(
        `  ${reg.project.padEnd(8)} ${reg.metric.padEnd(10)} ${reg.baseline.toFixed(2)}% → ${reg.current.toFixed(2)}% (${reg.delta > 0 ? '+' : ''}${reg.delta.toFixed(2)} pp)\n`
      )
    }
    process.stderr.write(
      '\nIf this regression is intentional, update both `test/coverage-baseline.json` ' +
        'and `test/coverage-baseline.md` in the same commit with the rationale.\n'
    )
    process.exit(1)
  }

  process.stdout.write(`\x1b[32m✓ coverage no-regression (tolerance ±${tolerance} pp)\x1b[0m\n`)
}

function ensureBuildIfMissing() {
  if (existsSync(MAIN_ENTRY)) return
  announce('build (out/main/index.js missing — smoke needs it)')
  const started = performance.now()
  const result = spawnSync(`${NPM} run build`, {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    shell: true
  })
  const elapsed = ((performance.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    process.stderr.write(`\n\x1b[31m✗ FAILED: build (after ${elapsed}s)\x1b[0m\n`)
    process.exit(1)
  }
  process.stdout.write(`\x1b[32m✓ build (${elapsed}s)\x1b[0m\n`)
}

const totalStart = performance.now()
runStep('atomic-write audit', NPM, ['run', 'audit:atomicwrites'])
runStep('typecheck', NPM, ['run', 'typecheck'])
runStep('lint', NPM, ['run', 'lint'])
runStep('format', NPM, ['run', 'format:check'])
runStep('unit tests + coverage', NPM, ['run', 'test:coverage'])
checkCoverageGate()
ensureBuildIfMissing()
runStep('smoke', NPM, ['run', 'test:smoke'])

const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(1)
process.stdout.write(`\n\x1b[32m✔ post-req green in ${totalElapsed}s\x1b[0m\n`)
