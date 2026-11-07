import { isAbsolute, join, relative, sep } from 'node:path'
import { workspace } from '@fetchpier/core'
import type {
  TabMode,
  WorkspaceSessionTab,
  WorkspaceState,
  WorkspaceStateView
} from '../../shared/types'
import { resolveInsideWorkspace } from '../fs/safe-path'

/**
 * Per-user, workspace-level state: the open-tab session plus workspace
 * preferences (currently the active-environment selection). Persisted to
 * `<workspace>/.fetchpier/.state/workspace-state.json`.
 *
 * Mirrors the `ui-state-store` / `tree-state-store` pattern: a singleton bound
 * to one workspace, debounced async writes, atomic `.tmp` → rename, and a
 * synchronous flush for `before-quit`. The in-memory model holds
 * **workspace-relative** `/`-paths (the on-disk form); {@link getView} converts
 * them to absolute for the renderer. The reader reconciles on load — entries
 * with an unknown `kind`, an unsafe path, or a missing backing file are dropped
 * — and a cleanup write is scheduled so the file self-heals.
 */

const STATE_FILE_REL = join('.fetchpier', '.state', 'workspace-state.json')
const SCHEMA_VERSION = 1 as const
const DEBOUNCE_MS = 200
const REQUEST_KIND = 'request'

interface SessionModel {
  tabs: WorkspaceSessionTab[] // path: workspace-relative, '/'-normalized
  activeTabIndex: number
}

interface StateModel {
  activeEnvironmentId: string | null
  session: SessionModel
  /**
   * The workspace's palette block **exactly as read from disk** (`undefined`
   * when the file has none). Never interpreted here — consumers normalize it —
   * and written back verbatim, so session writes keep it and a block this
   * version does not understand survives. Replaced only by
   * {@link setWorkspaceAppearance}.
   */
  appearanceRaw?: unknown
}

interface ActiveState {
  workspacePath: string
  model: StateModel
  writeTimer: ReturnType<typeof setTimeout> | null
  pendingWrite: boolean
}

let active: ActiveState | null = null

function defaultModel(): StateModel {
  return { activeEnvironmentId: null, session: { tabs: [], activeTabIndex: -1 } }
}

/** A candidate tab parsed from disk, before async path-safety / existence checks. */
interface RawTab {
  kind: string
  path: string
  mode: TabMode
}

interface SanitizedFile {
  activeEnvironmentId: string | null
  rawTabs: RawTab[]
  activeTabIndex: number
  appearanceRaw?: unknown
}

/** Coerce arbitrary JSON into the known fields, tolerating anything unexpected. */
function sanitizeFile(raw: unknown): SanitizedFile {
  const empty: SanitizedFile = { activeEnvironmentId: null, rawTabs: [], activeTabIndex: -1 }
  if (!raw || typeof raw !== 'object') return empty
  const obj = raw as Record<string, unknown>
  const appearanceRaw = 'appearancePalettes' in obj ? obj.appearancePalettes : undefined

  const activeEnvironmentId =
    typeof obj.activeEnvironmentId === 'string' ? obj.activeEnvironmentId : null

  const session =
    obj.session && typeof obj.session === 'object' ? (obj.session as Record<string, unknown>) : {}

  const rawTabs: RawTab[] = []
  if (Array.isArray(session.tabs)) {
    for (const entry of session.tabs) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (typeof e.kind !== 'string' || typeof e.path !== 'string') continue
      // A missing/unknown mode means permanent. Back-compat: the legacy REQ-0085
      // `preview: true` boolean is read as the `'preview'` mode.
      const mode: TabMode =
        e.mode === 'preview' || e.mode === 'pinned'
          ? e.mode
          : e.preview === true
            ? 'preview'
            : 'permanent'
      rawTabs.push({ kind: e.kind, path: e.path.replace(/\\/g, '/').trim(), mode })
    }
  }

  const activeTabIndex =
    typeof session.activeTabIndex === 'number' && Number.isInteger(session.activeTabIndex)
      ? session.activeTabIndex
      : -1

  return { activeEnvironmentId, rawTabs, activeTabIndex, appearanceRaw }
}

/**
 * Reconcile the parsed session against the workspace: keep only `"request"`
 * tabs whose path is inside the workspace and whose backing file exists. The
 * active tab is preserved by identity when it survives, otherwise the index is
 * clamped into the restorable range (or `-1` if nothing is restorable).
 */
async function reconcileSession(
  handle: workspace.Workspace,
  file: SanitizedFile
): Promise<SessionModel> {
  const restorable: WorkspaceSessionTab[] = []
  let newActiveIndex = -1

  for (let i = 0; i < file.rawTabs.length; i++) {
    const t = file.rawTabs[i]
    if (t.kind !== REQUEST_KIND) continue
    // `fileExists` returns false for an unsafe path too, so this drops both
    // out-of-workspace entries and missing backing files.
    if (!(await handle.fileExists(t.path))) continue

    const newIdx = restorable.length
    restorable.push({
      kind: REQUEST_KIND,
      path: t.path,
      ...(t.mode !== 'permanent' ? { mode: t.mode } : {})
    })
    if (i === file.activeTabIndex) newActiveIndex = newIdx
  }

  // Active entry didn't survive (dropped or out of range): clamp to the last
  // restorable tab when the original index pointed at something, else none.
  if (newActiveIndex === -1 && restorable.length > 0 && file.activeTabIndex >= 0) {
    newActiveIndex = Math.min(file.activeTabIndex, restorable.length - 1)
  }

  return { tabs: restorable, activeTabIndex: newActiveIndex }
}

async function readFromDisk(workspacePath: string): Promise<{
  model: StateModel
  dropped: boolean
}> {
  const handle = workspace.openWorkspace(workspacePath)
  let parsed: unknown
  try {
    const raw = await handle.readTextFile(STATE_FILE_REL)
    parsed = JSON.parse(raw)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[workspace-state] failed to read ${STATE_FILE_REL}:`, err)
    }
    return { model: defaultModel(), dropped: false }
  }

  const file = sanitizeFile(parsed)
  const session = await reconcileSession(handle, file)
  const dropped =
    session.tabs.length !== file.rawTabs.length || session.activeTabIndex !== file.activeTabIndex
  return {
    model: {
      activeEnvironmentId: file.activeEnvironmentId,
      session,
      ...(file.appearanceRaw !== undefined ? { appearanceRaw: file.appearanceRaw } : {})
    },
    dropped
  }
}

/**
 * Load the persisted workspace state into memory, reconciling the session
 * against the current workspace. Switching to a different workspace first
 * flushes and detaches the previous one. If reconciliation dropped anything, a
 * cleanup write is scheduled so the file reflects the restorable set.
 */
export async function loadFromWorkspace(workspacePath: string): Promise<void> {
  if (active && active.workspacePath !== workspacePath) {
    flushSync()
    active = null
  }

  const { model, dropped } = await readFromDisk(workspacePath)
  active = { workspacePath, model, writeTimer: null, pendingWrite: false }
  if (dropped) scheduleWrite()
}

/** Flush any pending write synchronously and detach from the workspace. */
export function clearWorkspace(): void {
  flushSync()
  active = null
}

/**
 * The reconciled state for the renderer: tab paths are absolute. Reads from the
 * in-memory model only (the disk read happened in {@link loadFromWorkspace}).
 */
export function getView(): WorkspaceStateView {
  if (!active) return { activeEnvironmentId: null, session: { tabs: [], activeTabIndex: -1 } }
  const { workspacePath, model } = active
  const tabs: WorkspaceSessionTab[] = []
  for (const t of model.session.tabs) {
    try {
      tabs.push({
        kind: t.kind,
        path: resolveInsideWorkspace(workspacePath, t.path),
        ...(t.mode ? { mode: t.mode } : {})
      })
    } catch {
      // Should not happen (paths were validated on load), but stay defensive.
    }
  }
  let activeTabIndex = model.session.activeTabIndex
  if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1
  if (tabs.length === 0) activeTabIndex = -1
  return { activeEnvironmentId: model.activeEnvironmentId, session: { tabs, activeTabIndex } }
}

/** Convert an absolute path to a workspace-relative `/`-path, or `null` if outside. */
function toRelative(workspacePath: string, absPath: string): string | null {
  const rel = relative(workspacePath, absPath).split(sep).join('/')
  if (rel.length === 0 || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return null
  try {
    resolveInsideWorkspace(workspacePath, rel)
  } catch {
    return null
  }
  return rel
}

/**
 * Replace the persisted session. `tabs[].path` are absolute (renderer form);
 * entries outside the workspace are dropped. The write is debounced.
 */
export function setSession(tabs: WorkspaceSessionTab[], activeTabIndex: number): void {
  if (!active) return
  const { workspacePath } = active
  const relTabs: WorkspaceSessionTab[] = []
  let newActiveIndex = -1

  if (Array.isArray(tabs)) {
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i]
      if (!t || t.kind !== REQUEST_KIND || typeof t.path !== 'string') continue
      const rel = toRelative(workspacePath, t.path)
      if (rel === null) continue
      const newIdx = relTabs.length
      relTabs.push({ kind: REQUEST_KIND, path: rel, ...(t.mode ? { mode: t.mode } : {}) })
      if (i === activeTabIndex) newActiveIndex = newIdx
    }
  }
  if (
    newActiveIndex === -1 &&
    relTabs.length > 0 &&
    typeof activeTabIndex === 'number' &&
    activeTabIndex >= 0
  ) {
    newActiveIndex = Math.min(activeTabIndex, relTabs.length - 1)
  }

  active.model.session = { tabs: relTabs, activeTabIndex: newActiveIndex }
  scheduleWrite()
}

/** Update the active-environment selection. The write is debounced. */
export function setActiveEnvironment(id: string | null): void {
  if (!active) return
  active.model.activeEnvironmentId = typeof id === 'string' ? id : null
  scheduleWrite()
}

function serialize(model: StateModel): string {
  const out: WorkspaceState = {
    schemaVersion: SCHEMA_VERSION,
    activeEnvironmentId: model.activeEnvironmentId,
    session: model.session,
    ...(model.appearanceRaw !== undefined ? { appearancePalettes: model.appearanceRaw } : {})
  }
  return JSON.stringify(out, null, 2)
}

/** Whether a workspace is bound (its personal state is loaded). */
export function hasActiveWorkspace(): boolean {
  return active !== null
}

/** The workspace's palette block as read from disk; `undefined` when absent or no workspace is open. */
export function getWorkspaceAppearanceRaw(): unknown {
  return active?.model.appearanceRaw
}

/**
 * Replace the workspace's palette block and write the whole state **now** (not
 * debounced), so a failure reaches the caller instead of only the log. On
 * failure the previous block stays in force in memory and on disk. Rejects when
 * no workspace is open.
 */
export async function setWorkspaceAppearance(block: unknown): Promise<void> {
  if (!active) throw new Error('No workspace is open')
  const target = active
  const previous = target.model.appearanceRaw
  target.model.appearanceRaw = block
  // This write carries everything pending, so a scheduled one is redundant.
  if (target.writeTimer) {
    clearTimeout(target.writeTimer)
    target.writeTimer = null
  }
  const hadPending = target.pendingWrite
  target.pendingWrite = false
  try {
    await workspace
      .openWorkspace(target.workspacePath)
      .atomicWrite(STATE_FILE_REL, serialize(target.model))
  } catch (err) {
    target.model.appearanceRaw = previous
    if (hadPending && active === target) scheduleWrite()
    throw err
  }
}

function scheduleWrite(): void {
  if (!active) return
  active.pendingWrite = true
  if (active.writeTimer) clearTimeout(active.writeTimer)
  active.writeTimer = setTimeout(() => {
    void flushAsync()
  }, DEBOUNCE_MS)
}

async function flushAsync(): Promise<void> {
  if (!active) return
  const { workspacePath, model } = active
  active.writeTimer = null
  active.pendingWrite = false
  try {
    await workspace.openWorkspace(workspacePath).atomicWrite(STATE_FILE_REL, serialize(model))
  } catch (err) {
    console.error('[workspace-state] failed to flush:', err)
  }
}

/**
 * Synchronously write any pending state to disk. Safe to call from
 * `before-quit` — uses the handle's synchronous atomic write so the OS
 * guarantees the bytes are flushed before the process exits.
 */
export function flushSync(): void {
  if (!active) return
  if (active.writeTimer) {
    clearTimeout(active.writeTimer)
    active.writeTimer = null
  }
  if (!active.pendingWrite) return
  active.pendingWrite = false

  try {
    workspace
      .openWorkspace(active.workspacePath)
      .atomicWriteSync(STATE_FILE_REL, serialize(active.model))
  } catch (err) {
    console.error('[workspace-state] failed to flushSync:', err)
  }
}

/** Test-only hook. Resets the in-memory singleton without touching disk. */
export function _resetForTests(): void {
  if (active?.writeTimer) clearTimeout(active.writeTimer)
  active = null
}
