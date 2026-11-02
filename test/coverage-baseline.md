# Coverage baseline

> Frozen snapshot of `npm run test:coverage`.
>
> - **Captured:** 2026-08-05
> - **Commit:** uncommitted
> - **Tooling:** Vitest 4.1.6 + `@vitest/coverage-v8@4.1.6` (V8 provider)
> - **Machine-readable sidecar:** [`coverage-baseline.json`](./coverage-baseline.json)

This file is the authoritative reference for the regression gate in `scripts/post-req.mjs`
(step 6). The gate fails a run when any project metric falls more than **0.5 percentage
points** below the recorded figure. Any change that legitimately lowers coverage must update
both this file and the JSON sidecar in the same commit, with rationale.

## 2026-08-05 — re-capture after the reference went stale

The figures below had not moved since **2026-05-22** while the suite kept growing. The gate
was therefore comparing a tree covered at 67.87 % against a 45.00 % mark, and only fired below
44.50 % — a margin of 23.37 pp. In practical terms roughly a third of every covered line could
have been deleted without turning the gate red, which left the non-regression invariant
formally in force and materially empty for everything written after May.

**No test was added or removed for this change.** The numbers were already true; they had
simply never been recorded. `main` and `renderer` move the most, which is where the testing
effort of the last two and a half months went.

Captured from **two consecutive runs that agreed to within 0.02 pp**, so the recorded figures
are not a single lucky sample and the 0.5 pp tolerance comfortably absorbs the observed
run-to-run noise.

| Project    | Lines (was → now)   | Branches | Functions | Statements |
| ---------- | ------------------- | -------- | --------- | ---------- |
| `core`     | 72.11 → **86.75 %** | 72.40 %  | 87.41 %   | 84.00 %    |
| `cli`      | 83.50 → **87.64 %** | 79.93 %  | 76.84 %   | 85.49 %    |
| `main`     | 16.17 → **62.55 %** | 54.65 %  | 49.51 %   | 59.93 %    |
| `shared`   | 78.99 → **98.72 %** | 91.18 %  | 100.00 %  | 97.31 %    |
| `renderer` | 18.42 → **47.37 %** | 40.47 %  | 44.46 %   | 46.47 %    |
| **Total**  | 45.00 → **67.87 %** | 58.22 %  | 59.48 %   | 65.87 %    |

The gate's red path was exercised once before recording these, by inflating a figure above
reality and confirming the run reported the regression — a reference that cannot detect a drop
would be the same defect wearing a newer date.

The `expectedZeroCoverageFiles` list in the sidecar was regenerated at the same time. Its
previous form claimed whole directories were uncovered (`src/renderer/components/**`) that
now are covered in part. No script reads that field; it exists so a reader does not mistake a
deliberate gap for a regression.

---

## Historical record (pre-2026-08-05)

Everything below describes the reference as it stood before the re-capture and is kept as a
record of how it got there.

## Phase history

| Phase | Lines       | Branches    | Functions   | Statements  | Tests                                   | Note                                              |
| ----- | ----------- | ----------- | ----------- | ----------- | --------------------------------------- | ------------------------------------------------- |
| 1     | 35.50 %     | 31.99 %     | 24.48 %     | 34.31 %     | 463 / 31 files                          | initial baseline                                  |
| 2     | (unchanged) | —           | —           | —           | 499 / 32 files                          | +36 fixture round-trip tests                      |
| 3     | **39.62 %** | **36.67 %** | **29.39 %** | **38.91 %** | **734 / 38 files**                      | +235 unit tests                                   |
| core  | **40.18 %** | **37.14 %** | **30.10 %** | **39.35 %** | unchanged (tests moved with their code) | business layer extracted to `@fetchpier/core`     |
| cli   | **45.00 %** | **42.17 %** | **34.01 %** | **43.93 %** | +88 cli tests                           | `@fetchpier/cli` package added (the `fp` command) |

## Per-project totals (current — after the CLI package)

| Project    | Lines       | Branches | Functions | Statements |
| ---------- | ----------- | -------- | --------- | ---------- |
| `core`     | **72.11 %** | 60.80 %  | 73.68 %   | 69.53 %    |
| `cli`      | **84.09 %** | 76.72 %  | 65.79 %   | 81.57 %    |
| `main`     | **16.17 %** | 22.96 %  | 13.15 %   | 16.14 %    |
| `shared`   | **78.99 %** | 67.80 %  | 81.82 %   | 80.00 %    |
| `renderer` | **18.42 %** | 15.62 %  | 13.60 %   | 18.04 %    |
| **Total**  | **45.00 %** | 42.17 %  | 34.01 %   | 43.93 %    |

> Baseline gate values for `cli` are floored slightly below the measured numbers
> (statements 81 / branches 76 / functions 65 / lines 83.5) to absorb minor noise
> within the 0.5 pp tolerance.

### CLI package — `@fetchpier/cli`

The new `cli` project lands well-tested: unit tests for context resolution,
error→exit-code mapping, output formatters, and the CLI reporter (contractual
snapshots); integration tests driving `executeRun` against a `mockttp` server;
reporter tests for JSON/JUnit/HTML; and spawn-based exit-code tests against the
built binary. This lifts the total across every metric. The binary entry
(`fp.ts`) and the SIGINT signal module (`runtime-signal.ts`) are exercised only
through spawned child processes, which V8 coverage does not attribute to the
parent run — they read as 0 % by design.

### Business layer extraction (recalibration)

The extraction moved the business layer (`http`/requests, `scripting`, `tls`, `schema`, `cookies`, `history`, workspace settings) from `src/main` into the new `@fetchpier/core` package, **together with its tests**. Consequences for the baseline:

- **`main` drops from 56.70 % → 16.17 % lines.** This is not lost coverage: the well-tested domain code left `src/main`. What remains there is Electron-bound adapters (IPC handlers, windows, menu, watcher) plus thin re-export shims — code that was already at/near 0 % and is exercised via E2E, not Vitest. The drop is the denominator shrinking to mostly-untestable-by-unit code.
- **`core` enters at 72.11 % lines / 60.80 % branches** — the migrated suites land here.
- **`shared` ticks up** (78.99 % lines) because `@shared/lib/http-serializer` is now exercised through more core paths.
- **Total is essentially unchanged** (39.62 % → 40.18 % lines): the same tests cover the same code, just grouped under a different project.

## Phase 3 gains (per file)

| File                                       | Before lines | After lines  | After branches | Notes                                                   |
| ------------------------------------------ | ------------ | ------------ | -------------- | ------------------------------------------------------- |
| `src/main/state/active-workspace.ts`       | 16.66 %      | **100.00 %** | 100.00 %       | quick-win unit tests                                    |
| `src/main/fs/safe-path.ts`                 | 53.33 %      | **100.00 %** | 92.85 %        | quick-win unit tests                                    |
| `src/main/schema/example-generator.ts`     | 53.33 %      | **100.00 %** | 98.33 %        | quick-win unit tests                                    |
| `src/main/http/cookie-jar.ts`              | 81.28 %      | **99.41 %**  | 91.59 %        | RFC 6265 §5.2 edges + 1 bug fix surfaced                |
| `src/main/scripting/fp-sandbox.ts`         | 66.24 %      | **91.71 %**  | 88.76 %        | FORBIDDEN_GLOBALS, 5 s timeout, console/safeClone paths |
| `src/main/http/client.ts`                  | 60.63 %      | **70.21 %**  | 68.42 %        | proxy + TLS + redirect interceptor composition          |
| `src/main/schema/importers/openapi.ts`     | 76.19 %      | 78.30 %      | 61.06 %        | malformed cases                                         |
| `src/main/schema/importers/postman.ts`     | 78.15 %      | 79.41 %      | 62.80 %        | malformed cases                                         |
| `src/main/schema/importers/graphql.ts`     | 78.57 %      | 83.03 %      | 74.72 %        | malformed cases                                         |
| `src/renderer/stores/request.ts`           | 0.00 %       | **100.00 %** | 89.28 %        | tabs / dirty / cache (window.api mocked)                |
| `src/renderer/stores/workspaceSettings.ts` | 0.00 %       | **100.00 %** | 100.00 %       | applyExternal no-rewrite                                |
| `src/renderer/stores/cookies.ts`           | 0.00 %       | **100.00 %** | 83.33 %        | cookies:changed subscription                            |

Project-level shifts driven by the table above:

- **`main`** lines +4.40 pp (52.30 → 56.70). Branches +7.23 pp (48.07 → 55.30). Functions +5.26 pp (46.79 → 52.05).
- **`renderer`** lines +3.96 pp (13.71 → 17.67) from the three Zustand-store tests.
- **`shared`** unchanged at 72.64 % lines — already healthy, not a Phase 3 target.

## Policy

| Tier                             | Rule                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Minimum**                      | No metric may drop more than 0.5 pp below the "current" table above.                                                                                                                                                                                                                           |
| **Aspirational (main + shared)** | 80 % lines, 70 % branches. Non-blocking until it is promoted to a gate. `main` is now 23 pp from the line target and 15 pp from the branch target — Phase 3 closed the easy gaps; the remainder is in IPC handlers and `tls/store.ts` which need Electron-bound integration tests, not Vitest. |
| **Renderer**                     | No minimum. Renderer is intended to be exercised by Playwright UI tests (Phases 4–5), not unit tests, except for the three Zustand stores in the Phase 3 table, which now sit at 100 % lines.                                                                                                  |

## Files at 0 % — expected, not debt

These files exist but cannot be exercised by Vitest alone: they require the running Electron app (IPC handlers, window lifecycle, menu wiring, watcher, etc.). They will be covered indirectly by the Playwright smoke + UI suites in Phases 4 and 5.

**Main process — Electron-bound:**

- `src/main/index.ts`, `src/main/menu.ts`, `src/main/watcher.ts`
- `src/main/window/create-main-window.ts`
- `src/main/ipc/*.ipc.ts` (every IPC handler — they require `ipcMain` and the live process boundary)
- `src/main/tls/paths.ts`, `src/main/tls/store.ts` (adapters that inject `app.getPath('userData')` + app settings into `@fetchpier/core`)
- Re-export shims left in `src/main` for backward-compat imports: `config/defaults.ts`, `config/workspace-settings-store.ts`, `environment.ts`, `http/variables.ts`, `http/cookie-jar.ts`, `scripting/script-runner.ts` (the real, tested code lives in `@fetchpier/core`)

> Note: the schema importers, the `fp` sandbox, the HTTP client, the cookie jar, and the rest of the business layer are no longer under `src/main` — they live in `packages/fetchpier-core/src/**` and are covered by the `core` Vitest project.

**Renderer — UI / DOM-bound (Phase 5 targets):**

- All `src/renderer/components/**/*.tsx`
- `src/renderer/stores/{appSettings,certificates,display,environment,schemaImport,theme,workspace}.ts` (thin wrappers without the subtle bookkeeping that warranted unit tests for the three §4.3.6 stores)
- `src/renderer/hooks/useIpc.ts`, `src/renderer/hooks/useKeyboardShortcuts.ts`
- `src/renderer/i18n/index.ts`
- `src/renderer/App.tsx`, `src/renderer/main.tsx`
- `src/renderer/lib/path.ts` _(untracked at capture time)_

**CLI — exercised only via spawned child processes:**

- `packages/fetchpier-cli/src/fp.ts` (binary entry: commander wiring + SIGINT/SIGTERM)
- `packages/fetchpier-cli/src/runtime-signal.ts` (the abort-signal holder the binary sets)

## Bug fix surfaced by Phase 3

While covering the cookie-jar edges, two assertions failed because `writeJar()` left the on-disk file in place when the in-memory jar became empty. `remove()` was already calling `clear()` on the same condition, so the inconsistency only affected `captureFromResponse()` when a `Set-Cookie` expired the last cookie. The one-line fix lives in `src/main/http/cookie-jar.ts` (the empty-jar branch now `fs.unlink()`s the stale file).

## Regenerating this baseline

```bash
npm run test:coverage
node scripts/compute-coverage-summary.mjs > coverage/per-project.json
```

Open `coverage/per-project.json` and copy the relevant values into both:

1. `test/coverage-baseline.json` (sidecar consumed by the gate).
2. The "Per-project totals" table in this file.

Commit both edits together with a message explaining the move (`baseline raised`, `regression accepted with rationale`, etc.). Never edit one without the other.
