import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  copyWorkspaceFixture,
  removeWorkspaceFixture,
  type CopiedWorkspace,
  type WorkspaceFixtureName
} from './fixtures'
import { buildSeededSettings } from './settings-seed'
import type { Theme } from '../../../src/shared/types'

// Playwright runs from the repo root.
const REPO_ROOT = process.cwd()
const MAIN_ENTRY = resolve(REPO_ROOT, 'out', 'main', 'index.js')

/**
 * What every spec must pass to `electron.launch` as the app path. Electron
 * resolves the entry through this directory's package.json `main` field, and
 * — crucially — takes the app's *version* and app path from it, exactly as in
 * a packaged build. Pointing Electron at the bare entry file instead leaves it
 * without a package.json, so `app.getVersion()` falls back to reporting
 * Electron's own version.
 */
export const APP_LAUNCH_PATH = REPO_ROOT

/** The product version, i.e. what `app.getVersion()` reports. See `APP_LAUNCH_PATH`. */
export const APP_VERSION: string = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }
).version

export interface ElectronAppContext {
  app: ElectronApplication
  window: Page
  /**
   * Copied fixture, when `LaunchOptions.fixture` was provided. Null for
   * `freshWorkspace` runs.
   */
  workspace: CopiedWorkspace | null
  /**
   * Absolute path of an empty tmpdir prepared for "create new workspace" flows.
   * Null when `freshWorkspace` was not requested.
   */
  freshWorkspacePath: string | null
  /** Absolute path of the isolated `--user-data-dir`. */
  userDataDir: string
}

export type LaunchOptions = {
  /** Force a specific locale by pre-seeding appSettings.json. Defaults to 'en'. */
  language?: 'en' | 'es'
  /**
   * Seed `appsettings.json`'s `lastVersion`. Defaults to the current version so
   * the once-per-version About dialog stays closed and does not overlay the UI
   * a spec is driving. Pass a stale version (or `null`, i.e. a settings file
   * predating the field) to exercise the version-change flow.
   */
  lastVersion?: string | null
  /**
   * Seed the theme preference. Defaults to `'system'`, i.e. whatever the host
   * is. Pass `'light'` / `'dark'` to pin it regardless of the host's theme.
   */
  theme?: Theme
  /**
   * Override the seeded update preferences. Defaults to "auto-check off, just
   * checked", which keeps the update prompt from opening over a spec's UI.
   */
  updates?: { autoCheckEnabled: boolean; intervalDays: number; lastCheckAt: string | null }
  /** Extra args appended to the Electron command line. */
  extraArgs?: string[]
} & (
  | {
      /** Workspace fixture to copy and pre-seed in the recent list. */
      fixture: WorkspaceFixtureName
      /**
       * When true, also pre-seed `last-workspace.json` with `path` pointing at the
       * fixture so the app auto-opens it on boot. When false (default), only the
       * `recent` list is populated and the spec must drive the welcome UI.
       */
      autoOpen?: boolean
      freshWorkspace?: never
    }
  | {
      fixture?: never
      autoOpen?: never
      /**
       * Boot with NO existing workspace. The helper creates an empty tmpdir and
       * exposes it as `ctx.freshWorkspacePath`, but does not pre-seed the recent
       * list. Use this for specs that exercise the "create workspace" flow:
       * the spec must stub `dialog.showOpenDialog` to return that tmpdir, then
       * click the "Open or create workspace" button.
       */
      freshWorkspace: true
    }
)

function ensureBuilt(): void {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `[e2e] Electron bundle missing: ${MAIN_ENTRY}\n` +
        `Run \`npm run build\` before invoking the smoke / E2E suite.`
    )
  }
}

async function seedUserData(
  userDataDir: string,
  workspacePath: string | null,
  opts: {
    autoOpen: boolean
    language: 'en' | 'es'
    lastVersion: string | null
    updates: NonNullable<LaunchOptions['updates']>
    theme: Theme
  }
): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true })

  // last-workspace.json — pre-populate the recent list (and optionally auto-open).
  // Shape matches the WorkspaceStore in workspace.ipc.ts: `{ path, recent }`.
  // When workspacePath is null (fresh-workspace mode), both `path` and `recent`
  // start empty so the app boots into the "no workspace" state.
  await fs.writeFile(
    join(userDataDir, 'last-workspace.json'),
    JSON.stringify(
      workspacePath
        ? { path: opts.autoOpen ? workspacePath : '', recent: [workspacePath] }
        : { path: '', recent: [] },
      null,
      2
    ),
    'utf-8'
  )

  // appsettings.json — lock the locale, disable the auto-update prompt that
  // would otherwise pop up on a fresh install (lastCheckAt=null triggers it
  // immediately via shouldAutoOpenUpdates), and mark the current version as
  // already seen so the About dialog does not open over the UI under test.
  // The renderer reads this via `window.api.appSettings.get()` after i18next
  // boots in default 'en'.
  // Filename matches `src/main/ipc/appsettings.ipc.ts` (`appsettings.json`).
  //
  // The document is seeded COMPLETE — see `settings-seed.ts` for why a partial
  // one makes unrelated keys appear on disk mid-spec.
  await fs.writeFile(
    join(userDataDir, 'appsettings.json'),
    JSON.stringify(
      buildSeededSettings({
        language: opts.language,
        lastVersion: opts.lastVersion,
        updates: opts.updates,
        theme: opts.theme
      }),
      null,
      2
    ),
    'utf-8'
  )
}

export async function launchApp(options: LaunchOptions): Promise<ElectronAppContext> {
  ensureBuilt()

  let workspace: CopiedWorkspace | null = null
  let freshWorkspacePath: string | null = null
  if ('freshWorkspace' in options && options.freshWorkspace) {
    freshWorkspacePath = await fs.mkdtemp(join(tmpdir(), 'fp-e2e-newws-'))
  } else if ('fixture' in options && options.fixture) {
    workspace = await copyWorkspaceFixture(options.fixture)
  }

  const userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-e2e-userdata-'))
  await seedUserData(userDataDir, workspace?.path ?? null, {
    autoOpen: 'autoOpen' in options ? options.autoOpen === true : false,
    language: options.language ?? 'en',
    lastVersion: options.lastVersion === undefined ? APP_VERSION : options.lastVersion,
    theme: options.theme ?? 'system',
    updates: options.updates ?? {
      autoCheckEnabled: false,
      intervalDays: 30,
      lastCheckAt: new Date().toISOString()
    }
  })

  const app = await electron.launch({
    args: [
      APP_LAUNCH_PATH,
      `--user-data-dir=${userDataDir}`,
      // Disable GPU compositing in CI / sandboxed envs — Electron sometimes
      // hangs on GPU init in headless docker. Local runs ignore it cheaply.
      '--disable-gpu',
      ...(options.extraArgs ?? [])
    ],
    env: {
      ...process.env,
      // Reduce noise from the auto-updater check on boot.
      FETCHPIER_DISABLE_UPDATES: '1'
    }
  })

  const window = await app.firstWindow()
  // Wait until the renderer's React tree mounts. Both the welcome flow and
  // the auto-opened workspace render at least one button very early.
  await window.waitForLoadState('domcontentloaded')

  return { app, window, workspace, freshWorkspacePath, userDataDir }
}

export interface CloseAppOptions {
  /**
   * When true, leave the copied fixture / fresh-workspace tmpdir on disk so
   * a subsequent `launchApp` can re-open the same path. The userDataDir is
   * always removed regardless. The caller is then responsible for cleaning
   * up the preserved path (commonly via `fs.rm` in `afterEach`).
   */
  keepWorkspacePaths?: boolean
}

/**
 * Force the close-guard to flag the next close as confirmed, then close the
 * app. Without this, specs that leave dirty tabs (e.g. picking a binary file
 * marks the tab dirty) trigger the in-renderer UnsavedChangesModal and the
 * Playwright `app.close()` call hangs waiting for user input.
 *
 * The IPC handler `window:close-confirmed` sets the closingConfirmed flag and
 * then calls `mainWindow.close()`. Subsequent `app.close()` is therefore a
 * no-op against an already-closed window — the surrounding try/catch absorbs
 * any race where the renderer disappears mid-call.
 */
export async function closeApp(
  ctx: ElectronAppContext,
  options: CloseAppOptions = {}
): Promise<void> {
  try {
    await ctx.window
      .evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).api
        if (api?.window?.closeConfirmed) {
          await api.window.closeConfirmed()
        }
      })
      .catch(() => {
        // Renderer may already be torn down — fall through to app.close.
      })
    await ctx.app.close()
  } catch {
    // ignore — app may already be gone if the test crashed it.
  }
  const cleanups: Promise<unknown>[] = [fs.rm(ctx.userDataDir, { recursive: true, force: true })]
  if (!options.keepWorkspacePaths) {
    if (ctx.workspace) cleanups.push(removeWorkspaceFixture(ctx.workspace))
    if (ctx.freshWorkspacePath) {
      cleanups.push(fs.rm(ctx.freshWorkspacePath, { recursive: true, force: true }))
    }
  }
  await Promise.allSettled(cleanups)
}

/**
 * Replace `electron.dialog.showOpenDialog` and `showMessageBox` inside the
 * main process so a spec can drive flows that rely on native dialogs without
 * adding test-only code to the product. The stubs persist for the lifetime
 * of `ctx.app` — call again after a relaunch if needed.
 *
 * Pass `pickPath` for a single fixed reply, or `pickPaths` for a FIFO queue
 * that returns the next path on each successive call (drained queue → cancel).
 * Calling this helper again resets the queue.
 */
export async function stubNativeDialogs(
  ctx: ElectronAppContext,
  options: { pickPath?: string; pickPaths?: string[]; confirm?: boolean } = {}
): Promise<void> {
  const queue: string[] = options.pickPaths
    ? [...options.pickPaths]
    : options.pickPath
      ? [options.pickPath]
      : []
  const confirmResponse = options.confirm === false ? 1 : 0
  await ctx.app.evaluate(
    ({ dialog }, args) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any
      g.__fpDialogQueue = [...args.queue]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = dialog as any
      d.showOpenDialog = async (): Promise<{ canceled: boolean; filePaths: string[] }> => {
        const next = (g.__fpDialogQueue as string[]).shift()
        if (!next) return { canceled: true, filePaths: [] }
        return { canceled: false, filePaths: [next] }
      }
      d.showMessageBox = async (): Promise<{ response: number; checkboxChecked: boolean }> => ({
        response: args.confirmResponse,
        checkboxChecked: false
      })
    },
    { queue, confirmResponse }
  )
}

/**
 * Pre-seed the recent-workspace list inside an already-running user-data-dir
 * by editing `last-workspace.json` directly. Useful when a spec relaunches
 * the app and needs the second boot to see the same workspace as a recent.
 */
export async function setRecentWorkspaces(userDataDir: string, recent: string[]): Promise<void> {
  await fs.writeFile(
    join(userDataDir, 'last-workspace.json'),
    JSON.stringify({ path: '', recent }, null, 2),
    'utf-8'
  )
}
