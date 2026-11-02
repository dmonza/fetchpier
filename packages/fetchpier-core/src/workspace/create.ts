import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceState } from '@shared/types'
import { CoreError } from '../shared/context'
import { ENVIRONMENTS_DIR, createEnvironmentFile, listEnvironmentFolders } from './environments'
import { atomicWriteFile } from './atomic-write'

/** App-state directory inside a workspace (`.git/`-style). */
const FETCHPIER_DIR = '.fetchpier'
/** Per-user workspace state — gitignored by the `.state/` pattern below. */
const WORKSPACE_STATE_REL = join(FETCHPIER_DIR, '.state', 'workspace-state.json')

/**
 * Default patterns written to the workspace `.gitignore` **only when the file
 * does not exist**. Existing `.gitignore` files are owned by the user and never
 * modified — see {@link ensureGitignore}. `**` wildcards cover all current and
 * future top-level artefacts (`requests/`, `environments/<id>/`, future
 * `mocks/`, ...); `.env` is the workspace-local dotenv from REQ-0067.
 *
 * `.fetchpier/` is deliberately NOT in this list: it holds workspace-scoped
 * configuration the team shares (HTTP defaults, TLS material) — like `.vscode/`
 * or `.github/`, it is part of the workspace and is normally committed.
 */
const DEFAULT_GITIGNORE_PATTERNS = ['**/.state/', '**/.runs/', '.env'] as const

/** Display name of the seeded environment. Derives to the folder `default`. */
const DEFAULT_ENVIRONMENT_NAME = 'Default'
/** Folder the seeded environment occupies — the handle `--env` matches. */
const DEFAULT_ENVIRONMENT_FOLDER = 'default'
/**
 * Starter variable of the seeded environment. An obvious placeholder meant to be
 * edited: it exists so the first `{{baseUrl}}` a user types resolves against
 * something instead of rendering as a missing variable.
 */
const DEFAULT_ENVIRONMENT_VARIABLES: Record<string, string> = { baseUrl: 'https://example.com' }

export interface CreateWorkspaceOptions {
  /**
   * Also seed the `Default` environment (`environments/default/config.json`)
   * **and the workspace state that selects it** — see
   * {@link seedDefaultEnvironment} for the content and skip rules.
   *
   * Set by the CLI's `fp init` (always) and by the desktop **only when the folder
   * was not already a workspace** (REQ-0121 §6.2): every desktop path that merely
   * *opens* a workspace re-runs `createWorkspace` defensively, and seeding there
   * would resurrect an environment the user deliberately deleted.
   */
  seedDefaultEnvironment?: boolean
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

/**
 * Owner-respecting `.gitignore` seeder (REQ-0067 §6.5). If the file does not
 * exist, it is created with {@link DEFAULT_GITIGNORE_PATTERNS}. If it exists
 * — even empty — the file is never modified: its existence is the user's flag
 * that they own the contents.
 *
 * Returns `true` iff the file was just generated.
 */
async function ensureGitignore(gitignorePath: string): Promise<boolean> {
  if (await exists(gitignorePath)) return false
  const initial = DEFAULT_GITIGNORE_PATTERNS.join('\n') + '\n'
  await atomicWriteFile(gitignorePath, initial)
  return true
}

/**
 * Seed the `Default` environment, unless one already occupies its folder name
 * (REQ-0121 §6.3).
 *
 * The occupancy check is **case-insensitive and runs over the folder listing**,
 * not a stat of `environments/default/config.json`. On a case-sensitive
 * filesystem a hand-created `environments/Default/` would slip past a path check
 * and then be rejected by `createEnvironmentFile`'s own uniqueness rule as a
 * naming conflict — which, thrown from here, would abort workspace creation
 * outright. Skipping is the correct outcome: the environment the user already has
 * is the one they want.
 *
 * The seed is the single owner of that file for both adapters, and it goes
 * through `createEnvironmentFile` rather than writing JSON by hand, so the
 * identifier is opaque and generated like every other environment's.
 */
async function seedDefaultEnvironment(workspacePath: string): Promise<void> {
  const folders = await listEnvironmentFolders(workspacePath)
  const taken = folders.some((f) => f.toLowerCase() === DEFAULT_ENVIRONMENT_FOLDER)
  if (taken) return
  const env = await createEnvironmentFile(workspacePath, DEFAULT_ENVIRONMENT_NAME, {
    ...DEFAULT_ENVIRONMENT_VARIABLES
  })
  await seedWorkspaceState(workspacePath, env.id)
}

/**
 * Record the freshly-seeded environment as the active selection, so the file
 * says what the UI shows from the very first open (REQ-0121 §6.4).
 *
 * Without this the selection is only *derived*: the desktop's environment store
 * falls back to the first environment in the list, which leaves
 * `workspace-state.json` unwritten (nothing schedules a write until the user
 * explicitly picks an environment or opens a tab). Two consequences, both fixed
 * by seeding it here — the file is absent where the product documents it as the
 * record of the selection, and once a second environment exists the "active" one
 * is decided by folder ordering rather than by intent.
 *
 * Only the identifier is seeded. The session is written empty because a
 * just-created workspace has no tabs, which is exactly what the desktop's
 * reader coerces a missing session to.
 *
 * Never overwrites an existing file, and never fails workspace creation: the
 * state is a convenience, and a workspace without it still opens (the reader
 * treats an absent file as "no saved selection").
 */
async function seedWorkspaceState(workspacePath: string, environmentId: string): Promise<void> {
  const statePath = join(workspacePath, WORKSPACE_STATE_REL)
  if (await exists(statePath)) return
  const state: WorkspaceState = {
    schemaVersion: 1,
    activeEnvironmentId: environmentId,
    session: { tabs: [], activeTabIndex: -1 }
  }
  try {
    await atomicWriteFile(statePath, JSON.stringify(state, null, 2))
  } catch {
    // Best-effort: the selection re-derives on load, so a failure here costs a
    // preference, not the workspace.
  }
}

export interface CreateWorkspaceResult {
  /**
   * `true` iff `createWorkspace` just generated `.gitignore` (the file did not
   * exist on entry). The desktop uses this to surface a toast on workspace
   * open; the CLI ignores it.
   */
  gitignoreCreated: boolean
}

/**
 * Initialize a Fetchpier workspace at `workspacePath`. Idempotent for the
 * directory layout and the `.fetchpier/settings.json` seed (existing files are
 * left untouched). The `.gitignore` is owner-respecting: it is generated with
 * the default seed when the file does not exist, and never modified when it
 * does — see {@link ensureGitignore}.
 *
 * Creates:
 * - `.fetchpier/settings.json` (`{ version: 1 }`)
 * - `environments/`
 * - `requests/.runs/`
 * - `requests/.files/` (binary body attachments — workspace-portable, NOT gitignored)
 * - `.gitignore` with `**`/`.state/`, `**`/`.runs/`, `.env` — only when absent
 * - optionally `environments/default/config.json` plus a
 *   `.fetchpier/.state/workspace-state.json` selecting it (when
 *   `seedDefaultEnvironment`)
 *
 * This is the single source of truth for workspace layout, shared by the desktop
 * adapter and the CLI so the two never drift — including the default-environment
 * seed, which no adapter writes on its own (REQ-0121 §5.5).
 */
export async function createWorkspace(
  workspacePath: string,
  options: CreateWorkspaceOptions = {}
): Promise<CreateWorkspaceResult> {
  // Guard against pointing at an existing non-directory (a file).
  if (await exists(workspacePath)) {
    const stat = await fs.stat(workspacePath)
    if (!stat.isDirectory()) {
      throw new CoreError(
        'WORKSPACE_INVALID',
        `Workspace path is not a directory: ${workspacePath}`
      )
    }
  }

  const fetchpierDir = join(workspacePath, FETCHPIER_DIR)
  await fs.mkdir(fetchpierDir, { recursive: true })
  await fs.mkdir(join(workspacePath, ENVIRONMENTS_DIR), { recursive: true })
  await fs.mkdir(join(workspacePath, 'requests', '.runs'), { recursive: true })
  await fs.mkdir(join(workspacePath, 'requests', '.files'), { recursive: true })

  const settingsPath = join(fetchpierDir, 'settings.json')
  if (!(await exists(settingsPath))) {
    await atomicWriteFile(settingsPath, JSON.stringify({ version: 1 }, null, 2))
  }

  const gitignorePath = join(workspacePath, '.gitignore')
  const gitignoreCreated = await ensureGitignore(gitignorePath)

  if (options.seedDefaultEnvironment) {
    await seedDefaultEnvironment(workspacePath)
  }

  return { gitignoreCreated }
}
