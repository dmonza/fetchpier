// Electron cold-startup timing benchmark (REQ-0062 / PLAN-0063).
//
// Boots the built app against the `test/workspaces/perf-minimal` fixture via
// Playwright `_electron`, 5 times, and captures three timing points per launch,
// all referenced to the moment `_electron.launch()` is invoked:
//
//   tWindowCreated     — `await app.firstWindow()` resolved.
//   tDomContentLoaded  — renderer fired DOMContentLoaded (bundle parsed).
//   tFirstUsablePaint  — the first usable UI element is visible.
//
// It reports cold (run 1) + warm (median/p95/min/max of runs 2–5) and writes a
// machine-readable run to `coverage/perf/electron-startup.json`. The app is
// closed immediately after `tFirstUsablePaint` — no sleeps — to bound variance.
// Always exits 0 on a successful measurement; the comparison is soft (see
// `electron-startup.report.mjs`).
//
// First-usable-paint selector: the `get-httpbin` request row
// (`page.getByRole('button', { name: 'get-httpbin' })`) — chosen because the
// `perf-minimal` fixture auto-opens a workspace whose single request is
// `requests/get-httpbin.http`, so that row is the first element signalling the
// renderer is *usable* (main boot → renderer mount → workspace IPC load → tree
// render). The REQ's suggested `[data-testid="collection-tree"]` /
// `[data-testid="welcome-screen"]` do not exist in the renderer; this locator is
// the one the memory bench already proves reliable for this fixture.
//
// Run: `npm run perf:startup` (requires `npm run build` first).
//
// This file mirrors the seeding logic in `electron-memory.bench.mjs` (a `.mjs`
// cannot import the `.ts` e2e helper at runtime). Type shapes match
// `scripts/perf/types.ts` (referenced via JSDoc).
//
// Launch path and `lastVersion`: Electron is pointed at the repo root, not at
// `out/main/index.js`, so it resolves the entry through `package.json` and
// `app.getVersion()` reports the product version — pointing it at the bare entry
// leaves it without a manifest and it falls back to reporting Electron's own
// version. That matters because the seeded `appsettings.json` must mark the
// launched version as already seen: otherwise the once-per-version About dialog
// opens over the tree and the first-usable-paint locator can never resolve.
// Same rationale as `APP_LAUNCH_PATH` / `LaunchOptions.lastVersion` in
// `test/e2e/helpers/electron-app.ts`.
//
/** @typedef {import('./types.ts').StartupTimingPoints} StartupTimingPoints */
/** @typedef {import('./types.ts').StartupSummary} StartupSummary */
/** @typedef {import('./types.ts').StartupBenchRun} StartupBenchRun */

import { _electron as electron } from '@playwright/test'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, platform as osPlatform, arch as osArch, release as osRelease } from 'node:os'
import { execSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const REPO_ROOT = process.cwd()
const MAIN_ENTRY = resolve(REPO_ROOT, 'out', 'main', 'index.js')
/** What Electron is launched against — see the header note on the launch path. */
const APP_LAUNCH_PATH = REPO_ROOT
/** The version `app.getVersion()` reports for `APP_LAUNCH_PATH`. */
const APP_VERSION = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')).version
const FIXTURE = resolve(REPO_ROOT, 'test', 'workspaces', 'perf-minimal')
const OUT_DIR = resolve(REPO_ROOT, 'coverage', 'perf')
const OUT_FILE = join(OUT_DIR, 'electron-startup.json')
const BASELINE_FILE = resolve(REPO_ROOT, 'test', 'perf-startup-baseline.json')

const ITERATIONS = 5
const FIXTURE_NAME = 'perf-minimal'
const SELECTOR_TIMEOUT_MS = 30_000

function fail(msg) {
  console.error(`\n[perf:startup] ${msg}\n`)
  process.exit(1)
}

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim()
  } catch {
    return 'unknown'
  }
}

/** Copy the fixture to a tmpdir and apply the optional httpbin override. */
async function prepareWorkspace() {
  if (!existsSync(FIXTURE)) fail(`Fixture missing: ${FIXTURE}`)
  const dest = await fs.mkdtemp(join(tmpdir(), 'fp-startup-ws-'))
  await fs.cp(FIXTURE, dest, { recursive: true })

  const override = process.env.FETCHPIER_TEST_HTTPBIN_URL?.trim()
  if (override) {
    const cfgPath = join(dest, 'environments', 'default', 'config.json')
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'))
    if (cfg.variables && typeof cfg.variables.baseUrl === 'string') {
      cfg.variables.baseUrl = override
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8')
    }
  }
  return dest
}

/**
 * Seed an isolated user-data-dir that auto-opens the workspace in English, with
 * both startup dialogs suppressed: `lastVersion` marks the launched version as
 * already seen (else the About opens over the tree), and a fresh `lastCheckAt`
 * keeps the interval-based update prompt shut.
 */
async function seedUserData(workspacePath) {
  const userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-startup-userdata-'))
  await fs.writeFile(
    join(userDataDir, 'last-workspace.json'),
    JSON.stringify({ path: workspacePath, recent: [workspacePath] }, null, 2),
    'utf-8'
  )
  await fs.writeFile(
    join(userDataDir, 'appsettings.json'),
    JSON.stringify(
      {
        language: 'en',
        zoomFactor: 1,
        lastVersion: APP_VERSION,
        updates: {
          autoCheckEnabled: false,
          intervalDays: 30,
          lastCheckAt: new Date().toISOString()
        },
        // Pinned rather than left to the host: the theme is resolved before the
        // window is created, so leaving it to whatever the machine is would let
        // a runner's own theme decide what the shell paints and make runs on
        // different machines incomparable.
        theme: 'light'
      },
      null,
      2
    ),
    'utf-8'
  )
  return userDataDir
}

/**
 * The first-usable-paint locator never resolved. The overwhelmingly likely cause
 * is a startup modal covering the tree — the About and the update prompt both
 * open on boot under the wrong seed — so name it instead of surfacing a bare
 * Playwright timeout. Always throws (rather than `fail()`ing) so the caller's
 * `finally` still closes the app and removes the tmpdirs.
 */
async function diagnoseBlockedPaint(page, iteration, cause) {
  let hint = ''
  try {
    const dialog = page.locator('[role="dialog"]').first()
    if (await dialog.count()) {
      const text = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 100)
      hint =
        `\n  A modal is covering the UI: "${text}…"\n` +
        `  Startup dialogs must stay shut for this bench: check the \`lastVersion\`\n` +
        `  and \`updates\` fields written by seedUserData(), and that Electron is\n` +
        `  launched against the repo root so app.getVersion() matches the seed.`
    }
  } catch {
    // Renderer unreachable — fall through with the raw cause.
  }
  throw new Error(
    `Iteration ${iteration}: the request row never became visible ` +
      `within ${SELECTOR_TIMEOUT_MS} ms.${hint}\n  Cause: ${cause?.message ?? cause}`
  )
}

/**
 * One launch → capture the three timing points → close immediately.
 * @returns {Promise<{ points: StartupTimingPoints; electronVersion: string }>}
 */
async function measureOnce(iteration) {
  const workspacePath = await prepareWorkspace()
  const userDataDir = await seedUserData(workspacePath)

  let app
  try {
    const t0 = performance.now()
    app = await electron.launch({
      args: [APP_LAUNCH_PATH, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
      env: { ...process.env, FETCHPIER_DISABLE_UPDATES: '1' }
    })

    const page = await app.firstWindow()
    const tWindowCreated = performance.now() - t0

    await page.waitForLoadState('domcontentloaded')
    const tDomContentLoaded = performance.now() - t0

    // Nothing is probed between DCL and first paint — an extra query here would
    // perturb the very interval being measured. A modal that swallows the row is
    // diagnosed only after the wait gives up, so the cost is one timeout, once.
    try {
      await page
        .getByRole('treeitem', { name: 'get-httpbin' })
        .waitFor({ state: 'visible', timeout: SELECTOR_TIMEOUT_MS })
    } catch (err) {
      await diagnoseBlockedPaint(page, iteration, err)
    }
    const tFirstUsablePaint = performance.now() - t0

    const electronVersion = await app.evaluate(() => process.versions.electron)

    // Read only now that every wall-clock point is captured: probing earlier
    // would perturb the intervals being measured. Paint entries persist for the
    // life of the document, so nothing is lost by asking late.
    //
    // The renderer's clock and this process's clock share no origin, so the
    // shell's paint is anchored to a point both can see: the distance from
    // first paint to DOMContentLoaded is measured inside the renderer, then
    // subtracted from the DOMContentLoaded this process already timed.
    const shellPaintBeforeDcl = await page.evaluate(() => {
      const [navigation] = performance.getEntriesByType('navigation')
      const [firstPaint] = performance.getEntriesByName('first-paint')
      if (!navigation || !firstPaint) return null
      return navigation.domContentLoadedEventEnd - firstPaint.startTime
    })
    if (shellPaintBeforeDcl === null) {
      fail(
        `Iteration ${iteration}: the renderer reported no first-paint entry, so the ` +
          `startup shell cannot be timed. Paint timing is what this benchmark measures ` +
          `the shell with — investigate rather than skipping the point.`
      )
    }

    /** @type {StartupTimingPoints} */
    const points = {
      tWindowCreated: round(tWindowCreated),
      tShellPaint: round(tDomContentLoaded - shellPaintBeforeDcl),
      tDomContentLoaded: round(tDomContentLoaded),
      tFirstUsablePaint: round(tFirstUsablePaint)
    }

    // Sanity: monotonic within the run, else the instrumentation is wrong.
    // The shell paint is deliberately NOT ordered against DOMContentLoaded: the
    // entry bundle executes fast enough off the V8 code cache that the two land
    // within a few milliseconds of each other, in either order from run to run
    // (measured). What must hold is that the shell is on screen before the
    // interface is usable — that is the whole claim it exists to support.
    if (!(
      points.tWindowCreated < points.tShellPaint &&
      points.tShellPaint < points.tFirstUsablePaint &&
      points.tWindowCreated < points.tDomContentLoaded &&
      points.tDomContentLoaded < points.tFirstUsablePaint
    )) {
      fail(
        `Non-monotonic timing in iteration ${iteration}: ` +
          `tWindowCreated=${points.tWindowCreated} ` +
          `tShellPaint=${points.tShellPaint} ` +
          `tDomContentLoaded=${points.tDomContentLoaded} ` +
          `tFirstUsablePaint=${points.tFirstUsablePaint}`
      )
    }

    console.log(
      `[perf:startup] run ${iteration}/${ITERATIONS}  ` +
        `window=${points.tWindowCreated}ms  ` +
        `shell=${points.tShellPaint}ms  ` +
        `dcl=${points.tDomContentLoaded}ms  ` +
        `usable=${points.tFirstUsablePaint}ms`
    )

    return { points, electronVersion }
  } finally {
    if (app) {
      try {
        await app.close()
      } catch {
        // already gone
      }
    }
    await Promise.allSettled([
      fs.rm(userDataDir, { recursive: true, force: true }),
      fs.rm(workspacePath, { recursive: true, force: true })
    ])
  }
}

const round = (n) => Math.round(n * 10) / 10

/** Median of a numeric array (sorted-copy; average of the two middle for even length). */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Nearest-rank p95 (matches the percentile a small-sample report can defend). */
function p95(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(0.95 * sorted.length)
  return sorted[Math.min(rank, sorted.length) - 1]
}

const KEYS = /** @type {const} */ ([
  'tWindowCreated',
  'tShellPaint',
  'tDomContentLoaded',
  'tFirstUsablePaint'
])

/** Apply a reducer per timing key over a set of runs. @returns {StartupTimingPoints} */
function reducePoints(runs, reducer) {
  /** @type {any} */
  const out = {}
  for (const key of KEYS) out[key] = round(reducer(runs.map((r) => r[key])))
  return out
}

/**
 * @param {StartupTimingPoints[]} rawRuns
 * @returns {StartupSummary}
 */
function summarize(rawRuns) {
  const cold = rawRuns[0]
  const warmRuns = rawRuns.slice(1)
  return {
    cold,
    warm: {
      median: reducePoints(warmRuns, median),
      p95: reducePoints(warmRuns, p95),
      min: reducePoints(warmRuns, (xs) => Math.min(...xs)),
      max: reducePoints(warmRuns, (xs) => Math.max(...xs))
    }
  }
}

const ms = (n) => `${n.toFixed(1)} ms`

async function main() {
  if (!existsSync(MAIN_ENTRY)) {
    fail(`Electron bundle missing: ${MAIN_ENTRY}\n  Run \`npm run build\` first.`)
  }

  console.log(`[perf:startup] ${ITERATIONS} launches against the \`${FIXTURE_NAME}\` fixture…`)

  /** @type {StartupTimingPoints[]} */
  const rawRuns = []
  let electronVersion = 'unknown'
  for (let i = 1; i <= ITERATIONS; i++) {
    const { points, electronVersion: v } = await measureOnce(i)
    rawRuns.push(points)
    electronVersion = v
  }

  const summary = summarize(rawRuns)

  /** @type {StartupBenchRun} */
  const run = {
    startedAt: new Date().toISOString(),
    gitSha: gitSha(),
    electronVersion,
    os: { platform: osPlatform(), arch: osArch(), release: osRelease() },
    fixture: FIXTURE_NAME,
    iterations: ITERATIONS,
    rawRuns,
    summary
  }

  await fs.mkdir(OUT_DIR, { recursive: true })
  await fs.writeFile(OUT_FILE, JSON.stringify(run, null, 2), 'utf-8')
  console.log(`\n[perf:startup] wrote ${OUT_FILE}`)
  console.log(
    `[perf:startup] cold tFirstUsablePaint ${ms(summary.cold.tFirstUsablePaint)}  •  ` +
      `warm median ${ms(summary.warm.median.tFirstUsablePaint)}  •  ` +
      `warm p95 ${ms(summary.warm.p95.tFirstUsablePaint)}`
  )

  // Variance signal: warm-median should be within 2× of warm-min.
  const wm = summary.warm.median.tFirstUsablePaint
  const wMin = summary.warm.min.tFirstUsablePaint
  if (wMin > 0 && wm / wMin > 2) {
    console.warn(
      `[perf:startup] WARNING: warm-median is ${(wm / wMin).toFixed(2)}× warm-min — high noise, ` +
        `treat the baseline with caution (background load / AV / indexing).`
    )
  }

  // Soft delta vs frozen baseline (the full breakdown lives in the report script).
  if (existsSync(BASELINE_FILE)) {
    try {
      /** @type {StartupBenchRun} */
      const base = JSON.parse(await fs.readFile(BASELINE_FILE, 'utf-8'))
      const now = summary.warm.median.tFirstUsablePaint
      const ref = base.summary?.warm?.median?.tFirstUsablePaint
      if (typeof ref === 'number' && ref > 0) {
        const deltaPct = (((now - ref) / ref) * 100).toFixed(1)
        console.log(
          `[perf:startup] warm-median tFirstUsablePaint vs baseline: ` +
            `${ms(ref)} → ${ms(now)} (${deltaPct}%)`
        )
        if (now > ref * 1.1) {
          console.warn('[perf:startup] WARNING: warm-median exceeds baseline by >10% (soft).')
        }
      }
    } catch {
      // baseline unreadable — ignore, soft by design
    }
  } else {
    console.log('[perf:startup] no baseline yet (test/perf-startup-baseline.json) — skipping diff.')
  }
}

main().catch((err) => {
  console.error('[perf:startup] benchmark failed:', err)
  process.exit(1)
})
