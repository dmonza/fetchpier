// Type contract for the Electron per-process memory benchmark (REQ-0059).
//
// Script-local on purpose: these types do NOT cross IPC, so they live here and
// NOT in `src/shared/types.ts`. They are also not wired into `npm run typecheck`
// (no tsconfig includes `scripts/`). The runtime drivers
// (`electron-memory.bench.mjs` / `electron-memory.report.mjs`) are `.mjs` and
// cannot import this file at runtime — they mirror these shapes via JSDoc
// `@typedef`. This file is the canonical, human-readable contract.

export interface ProcessMemorySnapshot {
  pid: number
  type: 'Browser' | 'Tab' | 'GPU' | 'Utility' | 'Sandbox helper' | 'Zygote' | string
  name?: string
  rssKb: number
  privateBytesKb?: number // Windows
  workingSetKb?: number // Windows/Linux
  residentSetKb?: number // macOS/Linux
}

export interface BenchSnapshot {
  label: 'T+0' | 'T+5s' | 'T+30s'
  electronVersion: string
  chromiumVersion: string
  v8Version: string
  os: { platform: string; arch: string; release: string }
  processes: ProcessMemorySnapshot[]
  totalRssKb: number
}

export interface BenchRun {
  startedAt: string // ISO
  gitSha: string
  snapshots: BenchSnapshot[]
}

// ── Cold-startup timing benchmark (REQ-0062) ────────────────────────────────
//
// A separate bench from the memory one: it measures time-to-usable, not RSS.
// Same script-local contract rules apply (not in any tsconfig; mirrored via
// JSDoc in `electron-startup.bench.mjs` / `electron-startup.report.mjs`).

/** Four timing points, all in ms relative to the moment `_electron.launch()` is invoked. */
export interface StartupTimingPoints {
  tWindowCreated: number // ms from launch — `app.firstWindow()` resolved
  tShellPaint: number // ms from launch — the startup shell is on screen
  tDomContentLoaded: number // ms from launch — renderer fired DOMContentLoaded
  tFirstUsablePaint: number // ms from launch — first usable UI element visible
}

export interface StartupSummary {
  cold: StartupTimingPoints // run 1 (cold OS page cache + cold V8 code cache)
  warm: {
    // runs 2–5
    median: StartupTimingPoints
    p95: StartupTimingPoints
    min: StartupTimingPoints
    max: StartupTimingPoints
  }
}

export interface StartupBenchRun {
  startedAt: string // ISO
  gitSha: string
  electronVersion: string
  os: { platform: string; arch: string; release: string }
  fixture: string // 'perf-minimal'
  iterations: number // 5
  rawRuns: StartupTimingPoints[] // length === iterations
  summary: StartupSummary
}
