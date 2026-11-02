// Human-readable report for the Electron memory benchmark (REQ-0059 / PLAN-0060).
//
// Reads `coverage/perf/electron-memory.json` (produced by
// `electron-memory.bench.mjs`), prints a per-process-type breakdown for each
// snapshot, and — when `test/perf-baseline.json` exists — a delta vs that frozen
// baseline. Soft by design: a regression prints a warning but exits 0.
//
// Run: `npm run perf:memory:report` (after `npm run perf:memory`).
//
/** @typedef {import('./types.ts').BenchRun} BenchRun */
/** @typedef {import('./types.ts').BenchSnapshot} BenchSnapshot */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = process.cwd()
const RUN_FILE = resolve(REPO_ROOT, 'coverage', 'perf', 'electron-memory.json')
const BASELINE_FILE = resolve(REPO_ROOT, 'test', 'perf-baseline.json')
const REGRESSION_PCT = 10

const mb = (kb) => (kb / 1024).toFixed(1)

function load(file) {
  return /** @type {BenchRun} */ (JSON.parse(readFileSync(file, 'utf-8')))
}

/** Sum RSS per process type for one snapshot. */
function byType(snapshot) {
  /** @type {Record<string, number>} */
  const totals = {}
  for (const p of snapshot.processes) {
    const key = p.name ? `${p.type} (${p.name})` : p.type
    totals[key] = (totals[key] ?? 0) + p.rssKb
  }
  return totals
}

function printSnapshot(snapshot) {
  console.log(`\n  ${snapshot.label}  —  total RSS ${mb(snapshot.totalRssKb)} MB`)
  const totals = byType(snapshot)
  for (const [key, kb] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${key.padEnd(28)} ${mb(kb).padStart(8)} MB`)
  }
}

function main() {
  if (!existsSync(RUN_FILE)) {
    console.error(
      `\n[perf:memory:report] No run found: ${RUN_FILE}\n  Run \`npm run perf:memory\` first.\n`
    )
    process.exit(1)
  }

  const run = load(RUN_FILE)
  const head = run.snapshots[0]
  console.log('Electron memory report')
  console.log('======================')
  if (head) {
    console.log(
      `  Electron ${head.electronVersion}  Chromium ${head.chromiumVersion}  V8 ${head.v8Version}`
    )
    console.log(`  ${head.os.platform}/${head.os.arch} ${head.os.release}`)
  }
  console.log(`  git ${run.gitSha.slice(0, 12)}  •  ${run.startedAt}`)
  console.log(`  processes: ${head ? head.processes.length : 0}`)

  for (const snapshot of run.snapshots) printSnapshot(snapshot)

  if (!existsSync(BASELINE_FILE)) {
    console.log('\n  (no test/perf-baseline.json — skipping delta)\n')
    return
  }

  const base = load(BASELINE_FILE)
  console.log('\n  Delta vs baseline')
  console.log('  -----------------')
  let regressed = false
  for (const snapshot of run.snapshots) {
    const b = base.snapshots.find((s) => s.label === snapshot.label)
    if (!b) continue
    const deltaKb = snapshot.totalRssKb - b.totalRssKb
    const deltaPct = ((deltaKb / b.totalRssKb) * 100).toFixed(1)
    const sign = deltaKb >= 0 ? '+' : ''
    console.log(
      `    ${snapshot.label.padEnd(6)} ${mb(b.totalRssKb).padStart(8)} → ${mb(snapshot.totalRssKb).padStart(8)} MB  (${sign}${deltaPct}%)`
    )
    if (
      snapshot.label === 'T+5s' &&
      snapshot.totalRssKb > b.totalRssKb * (1 + REGRESSION_PCT / 100)
    ) {
      regressed = true
    }
  }

  if (regressed) {
    console.warn(
      `\n  WARNING: idle (T+5s) RSS exceeds baseline by >${REGRESSION_PCT}%. Soft — not failing.\n`
    )
  } else {
    console.log('')
  }
}

main()
