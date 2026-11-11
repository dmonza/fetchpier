# `test/` — Non-product testing artifacts

This directory holds artifacts that are **not** product code: workspace fixtures, binary fixtures, and Playwright end-to-end specs. Unit and integration tests for product code continue to live next to their source (`foo.ts` ↔ `foo.test.ts`).

## Layout

```
test/
├── README.md                # this file
├── coverage-baseline.md     # human-readable baseline snapshot
├── coverage-baseline.json   # machine-readable sidecar (regression gate)
├── httpbin-image.json       # pinned HTTP test target (image + immutable digest + ports)
│                            #   single source of truth; the harness provisions the
│                            #   container from it, locally and in CI
├── perf-baseline.json       # performance benchmark baselines
├── perf-startup-baseline.json
├── workspaces/              # Fetchpier workspaces consumed by E2E specs
│   ├── default/             # shared read-only httpbin workspace: 2 envs + canonical GET + full httpbin tour
│   ├── binary-tests/        # binary request bodies and scripts that read them
│   ├── body-modes/          # body-mode round-trip target
│   ├── instances/           # request instances
│   ├── perf-minimal/        # minimal workspace for the startup benchmarks
│   └── postman-import/      # Postman v2.1 JSON inputs for the importer; NOT a live Fetchpier workspace
├── fixtures/
│   └── binary/              # small files used as binary request bodies
└── e2e/                     # Playwright + Electron specs
    └── helpers/             # launchApp(), copyWorkspaceFixture(), host preconditions, shared types
```

## Workspaces

Every Fetchpier workspace is a folder containing `.fetchpier/settings.json`, an `environments/` tree, and a `requests/` tree. The fixtures below follow that exact shape so the app can open them with no further setup.

### `default/`

The single shared **read-only** httpbin workspace. It is the consolidation of the former `smoke`
and `public-apis` fixtures (no coverage lost): the minimal smoke surface (one `default` environment
and a canonical `GET {{baseUrl}}/get` request) plus the full httpbin tour organized into collections
by capability, and a second `httpbin` environment carrying the auth variables. Two environments are
kept on purpose so specs can exercise environment switching.

Read-only means no spec mutates it in place — `copyWorkspaceFixture` copies it to a per-test tmpdir
on every launch, so "shared" never implies shared mutable state. Specs that need to mutate workspace
state copy a template into their own tmpdir and never rely on `default` being pristine.

Consumed by the smoke test, the request-pipeline / request-settings / cold-path / sandbox /
network-egress / ui-state / security-findings specs, and schema-import. (The smoke test budget: end-to-end run under 30 s.)

```
default/
├── .fetchpier/settings.json
├── environments/
│   ├── default/config.json   # baseUrl only
│   └── httpbin/config.json    # baseUrl + auth vars
└── requests/
    ├── get-httpbin.http       # canonical GET {{baseUrl}}/get (smoke surface)
    ├── methods/               # GET, POST, PUT, PATCH, DELETE
    ├── status/                # /status/{200,301,404,500}
    ├── redirects/             # /redirect/3
    ├── auth/                  # basic-auth + bearer
    ├── cookies/               # /cookies/set + /cookies (+ /cookies with the jar disabled)
    ├── content-types/         # /json, /xml
    ├── misc/                  # /delay/2, /headers, /gzip
    └── scripts/               # pre-request + post-response script samples
```

Environment variables exposed by the `httpbin` env (`environments/httpbin/config.json`):

| Variable        | Value                 |
| --------------- | --------------------- |
| `baseUrl`       | `https://httpbin.org` |
| `basicAuthUser` | `user`                |
| `basicAuthPass` | `pass`                |
| `bearerToken`   | `test-bearer-token`   |

> The `default` env carries only `baseUrl` (same value). Which env is active on boot follows
> `fs.readdir` order; specs that care select an env explicitly rather than rely on it.

#### Pointing at a different httpbin

The whole suite resolves through `{{baseUrl}}`. There are three modes — they apply uniformly to `npm run test:e2e` **and** `npm run test:smoke`:

1. **Automatic local Docker (default when available).** Playwright's `globalSetup` (`test/e2e/global-setup.ts`) checks for the `httpbin:local` image. If it exists, the setup runs `docker run -d --name httpbin-test -p 8080:8080 httpbin:local` (or reuses it if already running), waits for `GET http://localhost:8080/get` to respond, and exports `FETCHPIER_TEST_HTTPBIN_URL=http://localhost:8080` for the run. The container is removed by `globalTeardown` at the end (every run starts/ends clean).
2. **Public fallback (no Docker, no image, or healthcheck failed).** Setup logs a `[e2e/docker]` warning and leaves the env var unset; `copyWorkspaceFixture` then uses the default `https://httpbin.org`. This is the legacy behavior on machines without Docker — the run is not aborted.
3. **Operator override.** Setting `FETCHPIER_TEST_HTTPBIN_URL` yourself bypasses Docker entirely; setup respects whatever URL you provide.

```bash
# Force the public endpoint
FETCHPIER_TEST_HTTPBIN_URL=https://httpbin.org npm run test:e2e

# Point at a non-default local instance
FETCHPIER_TEST_HTTPBIN_URL=http://localhost:9090 npm run test:e2e

# Windows PowerShell
$env:FETCHPIER_TEST_HTTPBIN_URL = "http://localhost:9090"; npm run test:e2e
```

If a run is interrupted (`Ctrl+C`) the teardown may not fire; clean up the leftover container manually:

```bash
docker rm -f httpbin-test
```

> Note: `httpbin.org` is the only sanctioned **remote** endpoint. Local-Docker / operator-provided URLs are fine, but do not add fixtures that hit other external services.

### `postman-import/`

**Not a Fetchpier workspace.** A pile of Postman v2.1 collection exports used as input by the schema-import UI spec:

| File                            | Purpose                                                                                     | Expected import warnings        |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| `tiny-collection.json`          | 6 requests, no folders, no scripts, no variables. Pure happy path.                          | none                            |
| `collection-with-env-vars.json` | 6 requests in 2 folders + 5 collection-level variables (`{{baseUrl}}`, `{{apiKey}}`, etc.). | `variable-collected`            |
| `collection-with-scripts.json`  | 3 requests with `prerequest` and/or `test` Postman scripts.                                 | `script-copied-asis` (multiple) |

These exist so the schema-import spec can drive the Import Schema UI, pick each file, and assert both the resulting tree and the warning list. Unit-level coverage of the importer itself lives in `packages/fetchpier-core/src/schema-import/importers/postman.test.ts` against its own fixtures under `__fixtures__/postman/` — do not consolidate the two.

## Coverage baseline

`coverage-baseline.json` is the source of truth for the regression gate in `scripts/post-req.mjs`. It records per-project lines/branches/functions/statements at the moment of capture. `npm run post-req` compares against it and fails if any metric drops below baseline by more than `regressionTolerance` percentage points.

`coverage-baseline.md` is the human-readable companion — useful for code review and audits.

**Regenerate** with `npm run test:coverage` followed by `node scripts/compute-coverage-summary.mjs > coverage/per-project.json`, then manually copy the relevant numbers into both files **and commit them together**. Never edit one without the other.

## Running coverage today

```bash
npm run test:coverage
```

Output:

- `coverage/index.html` — open in browser for the drill-down.
- `coverage/coverage-summary.json` — Istanbul-format summary (totals + per-file).
- `coverage/coverage-final.json` — per-file details.

Aggregated coverage is summed across the Vitest projects (`main`, `shared`, `renderer`, `core`, `cli`, `e2e-helpers`).

## Regenerating a workspace fixture

The fixtures are hand-written and versioned — they are not regenerated by the app. To modify one:

1. Edit the relevant files under `test/workspaces/<name>/` directly.
2. Keep request IDs (`# @id <uuid>`) stable. They are referenced from E2E specs by id, not by file path. Generate a new UUID only when adding a brand-new request: `node -e "console.log(require('crypto').randomUUID())"`.
3. Run the fixture round-trip test: `npm run test:main -- test-workspaces-roundtrip`. This parses every `.http` in the fixture tree and asserts it produces a valid request. If a fixture breaks the parser, the test fails before any E2E run.
4. Update this README if the fixture's purpose changed.

## Writing a new E2E spec

The E2E specs all follow the same shape. Drop a new file under `test/e2e/<name>.spec.ts` and use the helpers in `test/e2e/helpers/`:

```ts
import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  stubNativeDialogs,
  setRecentWorkspaces,
  type ElectronAppContext
} from './helpers/electron-app'

test.describe('my feature', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) await closeApp(ctx)
    ctx = null
  })

  test('does the thing', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window
    // … drive the renderer …
  })
})
```

### Pattern: ephemeral workspace per test

`launchApp()` always creates an isolated `--user-data-dir` in `os.tmpdir()`. When you pass `fixture: '<name>'`, the helper also copies `test/workspaces/<name>/` to a fresh tmpdir so the spec can mutate files without touching the versioned fixture. `closeApp(ctx)` tears down both tmpdirs (unless you pass `{ keepWorkspacePaths: true }` — see "lifecycle" below).

### Decision flow

| Want…                                   | Pass to `launchApp`                                | Notes                                                                                                                                |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Boot straight into a workspace          | `{ fixture: 'default', autoOpen: true }`           | App auto-opens the fixture via pre-seeded `last-workspace.json.path`.                                                                |
| Drive the welcome flow (click a recent) | `{ fixture: 'default' }`                           | `last-workspace.json.recent` is populated; `path` stays empty. The sidebar renders `WorkspaceCallToAction` until the spec clicks.    |
| Test the "create new workspace" path    | `{ freshWorkspace: true }` + `stubNativeDialogs()` | Helper creates an empty tmpdir; spec stubs the native dialogs to return that path. See `workspace-lifecycle.spec.ts` for the recipe. |
| Persist a workspace across a relaunch   | `{ keepWorkspacePaths: true }` on first `closeApp` | Then `launchApp` again and call `setRecentWorkspaces(ctx.userDataDir, [...])`. Don't forget to clean up manually in `afterEach`.     |

### Locale and the auto-update prompt

The helper pre-seeds `appsettings.json` with `language: 'en'` and `updates.autoCheckEnabled: false`. Always select by the **English** translation (or by class-agnostic accessible names that don't depend on the locale, like a tmpdir basename). If you need to write specs that match Spanish strings, pass `language: 'es'` and update the assertions.

### Native dialogs

Fetchpier uses `dialog.showOpenDialog` (folder picker) and `dialog.showMessageBox` (confirm "create new workspace"). Stub both with `stubNativeDialogs(ctx, { pickPath, confirm })` before triggering the action that fires them. The stub persists for the lifetime of `ctx.app`; call again after a relaunch.

### Selectors checklist

- **Sidebar quick actions** (`New Collection`, `New Request`, `Import schema`, `Workspace settings`, `Open or create workspace`) — use `getByRole('button', { name: 'New Collection' })`. The accessible name comes from the `title` attribute.
- **Request rows in the tree** — basename of the file with `.http` stripped. Tree rows are ARIA `treeitem`s (the container is `role="tree"`), not buttons: `getByRole('treeitem', { name: 'get-httpbin', exact: true })`.
- **Folder rows in the tree** — folder name as-is. Note: `exact: true` prevents the folder name from matching nested request names that include it.
- **Inline rename / new-item input** — match the placeholder: `getByPlaceholder('New Collection')` or `getByPlaceholder('new-request')`.
- **Send button** — `getByRole('button', { name: 'Send', exact: true })`. It flips to "Cancel" while a request is in flight.
- **Response status badge** — `getByText('200 OK', { exact: true })`.
- **Response sub-tabs (Body / Headers / Tests)** — plain `<button>`, not ARIA tabs: use `getByRole('button', { name: 'Tests', exact: true })`. The shadcn Tabs in the import modal DO use real `role="tab"`.
- **Modal selectors** — scope to `page.getByRole('dialog')` first; multiple buttons share names like `Close` between the dialog and the chrome.

### Network reach

Specs that hit `https://httpbin.org` should default to it but honor the `FETCHPIER_TEST_HTTPBIN_URL` env var — `copyWorkspaceFixture` rewrites `baseUrl` in every `environments/*/config.json` at copy time. If you add a new fixture environment that hits another host, document it in the fixture's section above.

### Performance budget

Smoke runs in <30 s (currently 2–6 s). UI specs typically run in 1–4 s each on warm Electron. If your spec exceeds 15 s, profile it — most slowness comes from real network calls or from waiting on timers that don't tick in headless Electron.
