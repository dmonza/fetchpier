// Human-readable report for the Electron cold-startup benchmark (REQ-0062 / PLAN-0063).
//
// Reads `coverage/perf/electron-startup.json` (produced by
// `electron-startup.bench.mjs`), prints cold and warm timing breakdowns —
// each timing point as both an **absolute** delta (from launch) and a
// **segmental** delta (from the previous point) — side by side, and, when
// `test/perf-startup-baseline.json` exists, a delta vs that frozen baseline.
// Soft by design: a regression prints a warning but exits 0.
//
// Run: `npm run perf:startup:report` (after `npm run perf:startup`).
//
/** @typedef {import('./types.ts').StartupBenchRun} StartupBenchRun */
/** @typedef {import('./types.ts').StartupTimingPoints} StartupTimingPoints */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = process.cwd()
const RUN_FILE = resolve(REPO_ROOT, 'coverage', 'perf', 'electron-startup.json')
const BASELINE_FILE = resolve(REPO_ROOT, 'test', 'perf-startup-baseline.json')
const REGRESSION_PCT = 10

const KEYS = /** @type {const} */ ([
  'tWindowCreated',
  'tShellPaint',
  'tDomContentLoaded',
  'tFirstUsablePaint'
])
const LABELS = {
  tWindowCreated: 'window created',
  tShellPaint: 'shell painted',
  tDomContentLoaded: 'DOMContentLoaded',
  tFirstUsablePaint: 'first usable paint'
}
// The shell paint races DOMContentLoaded — they land within a few ms of each
// other in either order — so it is reported as an absolute point only. Giving it
// a segment would print a delta whose sign flips run to run.
const SEGMENT_KEYS = /** @type {const} */ ([
  'tWindowCreated',
  'tDomContentLoaded',
  'tFirstUsablePaint'
])
const SEG_LABELS = {
  tWindowCreated: 'main boot',
  tDomContentLoaded: 'bundle parse',
  tFirstUsablePaint: 'renderer bootstrap'
}

const fmt = (n) => `${Number(n).toFixed(1)} ms`

function load(file) {
  return /** @type {StartupBenchRun} */ (JSON.parse(readFileSync(file, 'utf-8')))
}

/** Print a single set of timing points with absolute + segmental deltas. */
function printPoints(title, points) {
  console.log(`\n  ${title}`)
  let prev = 0
  for (const key of KEYS) {
    const abs = points[key]
    if (!SEGMENT_KEYS.includes(key)) {
      console.log(`    ${LABELS[key].padEnd(20)} ${fmt(abs).padStart(10)}`)
      continue
    }
    const seg = abs - prev
    prev = abs
    console.log(
      `    ${LABELS[key].padEnd(20)} ${fmt(abs).padStart(10)}` +
        `   (+${fmt(seg).padStart(9)}  ${SEG_LABELS[key]})`
    )
  }
}

/** Side-by-side cold vs warm-median absolute table. */
function printColdVsWarm(summary) {
  console.log('\n  Cold vs warm (absolute, ms from launch)')
  console.log('  ---------------------------------------')
  console.log(
    `    ${''.padEnd(20)} ${'cold'.padStart(10)} ${'warm med'.padStart(10)} ${'warm p95'.padStart(10)}`
  )
  for (const key of KEYS) {
    console.log(
      `    ${LABELS[key].padEnd(20)} ` +
        `${fmt(summary.cold[key]).padStart(10)} ` +
        `${fmt(summary.warm.median[key]).padStart(10)} ` +
        `${fmt(summary.warm.p95[key]).padStart(10)}`
    )
  }
}

function printBaselineDelta(summary, base) {
  console.log('\n  Delta vs baseline (warm median)')
  console.log('  -------------------------------')
  const ref = base.summary?.warm?.median
  if (!ref) {
    console.log('    (baseline has no warm-median summary — skipping)')
    return false
  }
  let regressed = false
  for (const key of KEYS) {
    const now = summary.warm.median[key]
    const was = ref[key]
    // A point added after the baseline was frozen has nothing to compare
    // against; say so rather than printing a delta against `undefined`.
    if (typeof was !== 'number') {
      console.log(`    ${LABELS[key].padEnd(20)} ${fmt(now).padStart(10)}  (new — not in baseline)`)
      continue
    }
    const deltaMs = now - was
    const deltaPct = was ? ((deltaMs / was) * 100).toFixed(1) : 'n/a'
    const sign = deltaMs >= 0 ? '+' : ''
    console.log(
      `    ${LABELS[key].padEnd(20)} ` +
        `${fmt(was).padStart(10)} → ${fmt(now).padStart(10)}  ` +
        `(${sign}${fmt(deltaMs)}, ${sign}${deltaPct}%)`
    )
    if (was && now > was * (1 + REGRESSION_PCT / 100)) regressed = true
  }
  return regressed
}

function main() {
  if (!existsSync(RUN_FILE)) {
    console.error(
      `\n[perf:startup:report] No run found: ${RUN_FILE}\n  Run \`npm run perf:startup\` first.\n`
    )
    process.exit(1)
  }

  const run = load(RUN_FILE)
  console.log('Electron cold-startup report')
  console.log('============================')
  console.log(
    `  Electron ${run.electronVersion}  •  ${run.os.platform}/${run.os.arch} ${run.os.release}`
  )
  console.log(`  git ${run.gitSha.slice(0, 12)}  •  ${run.startedAt}`)
  console.log(`  fixture: ${run.fixture}  •  iterations: ${run.iterations}`)

  printPoints('Cold (run 1)', run.summary.cold)
  printPoints('Warm (median of runs 2–' + run.iterations + ')', run.summary.warm.median)
  printColdVsWarm(run.summary)

  if (!existsSync(BASELINE_FILE)) {
    console.log('\n  (no test/perf-startup-baseline.json — skipping delta)\n')
    return
  }

  const regressed = printBaselineDelta(run.summary, load(BASELINE_FILE))
  if (regressed) {
    console.warn(
      `\n  WARNING: a warm-median timing point exceeds baseline by >${REGRESSION_PCT}%. Soft — not failing.\n`
    )
  } else {
    console.log('')
  }
}

main()
