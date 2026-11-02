import { defineConfig } from '@playwright/test'

/**
 * Playwright config for Fetchpier's Electron E2E suite.
 *
 * Each spec drives the built Electron app (`out/main/index.js`) through
 * `_electron.launch()` and asserts against the renderer Page.
 *
 * Suites:
 * - `smoke.spec.ts` — single fast smoke test (REQ-0055 §4.4). Target <30 s.
 *   Run via `npm run test:smoke`.
 * - `*.spec.ts` (others) — full UI suite (Phase 5). Run via `npm run test:e2e`.
 *
 * Notes on environment expectations:
 * - The app bundle must be built before running specs (`npm run build`).
 *   `helpers/electron-app.ts` fails fast with a clear message if `out/main/index.js`
 *   is missing.
 * - Each spec gets an isolated `--user-data-dir` (tmpdir) so app state from a
 *   real install never leaks in, and parallel runs do not collide.
 * - HTTP target: `globalSetup` brings up a local `httpbin:local` container
 *   (`docker run -d --name httpbin-test -p 8080:8080 httpbin:local`) when both
 *   Docker and the image are available, sets `FETCHPIER_TEST_HTTPBIN_URL=
 *   http://localhost:8080`, and tears it down in `globalTeardown`. If Docker
 *   or the image is missing, the setup falls back silently to
 *   `https://httpbin.org`. Setting `FETCHPIER_TEST_HTTPBIN_URL` yourself
 *   skips the Docker branch entirely. See PLAN-0078.
 */
export default defineConfig({
  testDir: './test/e2e',
  // Playwright's default testMatch takes BOTH `*.spec.ts` and `*.test.ts`. The
  // harness's own Vitest suites live in `test/e2e/helpers/*.test.ts`, so without
  // this Playwright would try to run them and fail on the `vitest` import.
  // The split is: `.spec.ts` → Playwright, `.test.ts` → Vitest (see the
  // `e2e-helpers` project in vitest.config.ts, which mirrors this restriction).
  testMatch: '**/*.spec.ts',
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  // Each Electron launch reads test/workspaces/* — keep specs serial so the
  // fixture copy step is not racing the previous tmpdir cleanup. Playwright
  // workers are still cheap to start; this is a deliberate tradeoff for clarity.
  workers: 1,
  fullyParallel: false,

  // Per-test timeout. Smoke is the tightest and stays under this; the broader
  // UI specs in Phase 5 may approach it (workspace lifecycle, schema import).
  timeout: 60_000,
  expect: {
    // Most renderer assertions complete in <2 s. The 200-OK status badge can
    // take longer because of the httpbin round-trip.
    timeout: 10_000
  },

  // Local: fail fast. CI: be more tolerant of network jitter to httpbin.
  retries: process.env.CI ? 2 : 0,

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    // Capture trace + screenshot only on failures — keeps the on-disk footprint
    // small for a green smoke run.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
