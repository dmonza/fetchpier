// Electron per-process memory benchmark (REQ-0059 / PLAN-0060).
//
// Boots the built app against a minimal fixture workspace via Playwright
// `_electron`, snapshots `app.getAppMetrics()` at three time points (startup,
// 5 s idle, 30 s after one HTTP send), and writes a machine-readable run to
// `coverage/perf/electron-memory.json`. Always exits 0 — the comparison is soft
// (see `electron-memory.report.mjs`).
//
// Run: `npm run perf:memory` (requires `npm run build` first).
//
// This file mirrors the seeding logic in `test/e2e/helpers/electron-app.ts`. It
// is reimplemented here because a `.mjs` cannot import that `.ts` helper at
// runtime. Type shapes match `scripts/perf/types.ts` (referenced via JSDoc).
//
// Launch path and `lastVersion`: Electron is pointed at the repo root, not at
// `out/main/index.js`, so it resolves the entry through `package.json` and
// `app.getVersion()` reports the product version — pointing it at the bare entry
// leaves it without a manifest and it falls back to reporting Electron's own
// version. That matters because the seeded `appsettings.json` must mark the
// launched version as already seen: otherwise the once-per-version About dialog
// opens over the tree and the request row can never be clicked. Same rationale
// as `APP_LAUNCH_PATH` / `LaunchOptions.lastVersion` in the e2e helper.
//
/** @typedef {import('./types.ts').ProcessMemorySnapshot} ProcessMemorySnapshot */
/** @typedef {import('./types.ts').BenchSnapshot} BenchSnapshot */
/** @typedef {import('./types.ts').BenchRun} BenchRun */

import { _electron as electron } from '@playwright/test'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, platform as osPlatform, arch as osArch, release as osRelease } from 'node:os'
import { execSync } from 'node:child_process'

const REPO_ROOT = process.cwd()
const MAIN_ENTRY = resolve(REPO_ROOT, 'out', 'main', 'index.js')
/** What Electron is launched against — see the header note on the launch path. */
const APP_LAUNCH_PATH = REPO_ROOT
/** The version `app.getVersion()` reports for `APP_LAUNCH_PATH`. */
const APP_VERSION = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')).version
const FIXTURE = resolve(REPO_ROOT, 'test', 'workspaces', 'perf-minimal')
const OUT_DIR = resolve(REPO_ROOT, 'coverage', 'perf')
const OUT_FILE = join(OUT_DIR, 'electron-memory.json')
const BASELINE_FILE = resolve(REPO_ROOT, 'test', 'perf-baseline.json')

const IDLE_MS = 5_000
const WORKING_MS = 30_000

function fail(msg) {
  console.error(`\n[perf:memory] ${msg}\n`)
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
  const dest = await fs.mkdtemp(join(tmpdir(), 'fp-perf-ws-'))
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
  const userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-perf-userdata-'))
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
        }
      },
      null,
      2
    ),
    'utf-8'
  )
  return userDataDir
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Capture one snapshot. `app.getAppMetrics()` returns memory in KB; we treat
 * `workingSetSize` as the RSS proxy (it maps to resident set on every OS) and
 * keep `privateBytes` / `residentSet` when the platform exposes them.
 * @returns {Promise<BenchSnapshot>}
 */
async function takeSnapshot(app, label) {
  const { metrics, versions } = await app.evaluate(({ app }) => ({
    metrics: app.getAppMetrics(),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      v8: process.versions.v8
    }
  }))

  /** @type {ProcessMemorySnapshot[]} */
  const processes = metrics.map((m) => {
    const mem = m.memory ?? {}
    const rssKb = mem.workingSetSize ?? mem.privateBytes ?? 0
    return {
      pid: m.pid,
      type: m.type,
      name: m.name || m.serviceName || undefined,
      rssKb,
      privateBytesKb: mem.privateBytes,
      workingSetKb: mem.workingSetSize,
      residentSetKb: mem.residentSet
    }
  })

  const totalRssKb = processes.reduce((sum, p) => sum + p.rssKb, 0)

  return {
    label,
    electronVersion: versions.electron,
    chromiumVersion: versions.chrome,
    v8Version: versions.v8,
    os: { platform: osPlatform(), arch: osArch(), release: osRelease() },
    processes,
    totalRssKb
  }
}

function mb(kb) {
  return (kb / 1024).toFixed(1)
}

async function main() {
  if (!existsSync(MAIN_ENTRY)) {
    fail(`Electron bundle missing: ${MAIN_ENTRY}\n  Run \`npm run build\` first.`)
  }

  const workspacePath = await prepareWorkspace()
  const userDataDir = await seedUserData(workspacePath)

  console.log('[perf:memory] launching Electron…')
  const app = await electron.launch({
    args: [APP_LAUNCH_PATH, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    env: { ...process.env, FETCHPIER_DISABLE_UPDATES: '1' }
  })

  /** @type {BenchSnapshot[]} */
  const snapshots = []
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // T+0 — right after the renderer mounts.
    snapshots.push(await takeSnapshot(app, 'T+0'))
    console.log(`[perf:memory] T+0    total RSS ${mb(snapshots[0].totalRssKb)} MB`)

    // T+5s — idle steady state.
    await sleep(IDLE_MS)
    snapshots.push(await takeSnapshot(app, 'T+5s'))
    console.log(`[perf:memory] T+5s   total RSS ${mb(snapshots[1].totalRssKb)} MB`)

    // Drive one HTTP send (auto-opened workspace → request tree → Send).
    // Request rows are `role="treeitem"` (see CollectionTree.tsx), not buttons.
    const requestRow = page.getByRole('treeitem', { name: 'get-httpbin' })
    await requestRow.waitFor({ state: 'visible', timeout: 15_000 })
    await requestRow.click()
    const sendButton = page.getByRole('button', { name: 'Send', exact: true })
    await sendButton.waitFor({ state: 'visible', timeout: 15_000 })
    await sendButton.click()
    await page.getByText('200 OK', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })

    // T+30s — minimal working state after a response landed.
    await sleep(WORKING_MS)
    snapshots.push(await takeSnapshot(app, 'T+30s'))
    console.log(`[perf:memory] T+30s  total RSS ${mb(snapshots[2].totalRssKb)} MB`)
  } finally {
    try {
      await app.close()
    } catch {
      // already gone
    }
    await Promise.allSettled([
      fs.rm(userDataDir, { recursive: true, force: true }),
      fs.rm(workspacePath, { recursive: true, force: true })
    ])
  }

  /** @type {BenchRun} */
  const run = { startedAt: new Date().toISOString(), gitSha: gitSha(), snapshots }
  await fs.mkdir(OUT_DIR, { recursive: true })
  await fs.writeFile(OUT_FILE, JSON.stringify(run, null, 2), 'utf-8')
  console.log(`\n[perf:memory] wrote ${OUT_FILE}`)

  // Soft delta vs frozen baseline (the full table lives in the report script).
  if (existsSync(BASELINE_FILE)) {
    try {
      /** @type {BenchRun} */
      const base = JSON.parse(await fs.readFile(BASELINE_FILE, 'utf-8'))
      const idleNow = run.snapshots.find((s) => s.label === 'T+5s')?.totalRssKb
      const idleBase = base.snapshots.find((s) => s.label === 'T+5s')?.totalRssKb
      if (idleNow && idleBase) {
        const deltaPct = (((idleNow - idleBase) / idleBase) * 100).toFixed(1)
        console.log(
          `[perf:memory] idle T+5s vs baseline: ${mb(idleBase)} → ${mb(idleNow)} MB (${deltaPct}%)`
        )
        if (idleNow > idleBase * 1.1) {
          console.warn('[perf:memory] WARNING: idle RSS exceeds baseline by >10% (soft).')
        }
      }
    } catch {
      // baseline unreadable — ignore, soft by design
    }
  } else {
    console.log('[perf:memory] no baseline yet (test/perf-baseline.json) — skipping diff.')
  }
}

main().catch((err) => {
  console.error('[perf:memory] benchmark failed:', err)
  process.exit(1)
})
