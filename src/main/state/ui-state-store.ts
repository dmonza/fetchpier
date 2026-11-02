import { join } from 'node:path'
import { workspace } from '@fetchpier/core'
import type {
  RequestEditorTab,
  RequestUiState,
  RequestUiStateMap,
  ResponseViewerTab,
  ScriptPhase
} from '../../shared/types'

const UI_STATE_FILE_REL = join('requests', '.state', 'ui-state.json')
const DEBOUNCE_MS = 200

const VALID_REQ_TABS: ReadonlySet<RequestEditorTab> = new Set<RequestEditorTab>([
  'params',
  'headers',
  'body',
  'auth',
  'scripts',
  'settings'
])

const VALID_RESPONSE_TABS: ReadonlySet<ResponseViewerTab> = new Set<ResponseViewerTab>([
  'body',
  'headers',
  'tests'
])

const VALID_SCRIPT_PHASES: ReadonlySet<ScriptPhase> = new Set<ScriptPhase>(['pre', 'post'])

interface ActiveState {
  workspacePath: string
  map: RequestUiStateMap
  writeTimer: ReturnType<typeof setTimeout> | null
  pendingWrite: boolean
}

let active: ActiveState | null = null

function sanitizeEntry(raw: unknown, requestId: string): RequestUiState | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const result: RequestUiState = {}

  if (entry.activeReqTab !== undefined) {
    const v = entry.activeReqTab
    if (typeof v === 'string' && VALID_REQ_TABS.has(v as RequestEditorTab)) {
      result.activeReqTab = v as RequestEditorTab
    } else {
      console.warn(`[ui-state] dropping invalid activeReqTab for ${requestId}: ${String(v)}`)
    }
  }

  if (entry.activeResponseTab !== undefined) {
    const v = entry.activeResponseTab
    if (typeof v === 'string' && VALID_RESPONSE_TABS.has(v as ResponseViewerTab)) {
      result.activeResponseTab = v as ResponseViewerTab
    } else {
      console.warn(`[ui-state] dropping invalid activeResponseTab for ${requestId}: ${String(v)}`)
    }
  }

  if (entry.activeScriptPhase !== undefined) {
    const v = entry.activeScriptPhase
    if (typeof v === 'string' && VALID_SCRIPT_PHASES.has(v as ScriptPhase)) {
      result.activeScriptPhase = v as ScriptPhase
    } else {
      console.warn(`[ui-state] dropping invalid activeScriptPhase for ${requestId}: ${String(v)}`)
    }
  }

  return Object.keys(result).length === 0 ? null : result
}

function sanitizeMap(raw: unknown): RequestUiStateMap {
  if (!raw || typeof raw !== 'object') return {}
  const map: RequestUiStateMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) continue
    const cleaned = sanitizeEntry(value, key)
    if (cleaned !== null) map[key] = cleaned
  }
  return map
}

async function readFromDisk(workspacePath: string): Promise<RequestUiStateMap> {
  try {
    const raw = await workspace.openWorkspace(workspacePath).readTextFile(UI_STATE_FILE_REL)
    return sanitizeMap(JSON.parse(raw) as unknown)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    console.warn(`[ui-state] failed to read ${UI_STATE_FILE_REL}:`, err)
    return {}
  }
}

/**
 * Load the persisted UI state for a workspace into the in-memory map. Also
 * garbage-collects entries whose UUID is no longer present in the workspace's
 * `.http` files. If anything is dropped, schedules a write so the file reflects
 * the GC. Calling this with a different `workspacePath` than the currently
 * active one will first `flushSync` and clear the previous workspace's state.
 */
export async function loadFromWorkspace(workspacePath: string): Promise<void> {
  if (active && active.workspacePath !== workspacePath) {
    flushSync()
    active = null
  }

  const map = await readFromDisk(workspacePath)
  const knownIds = await workspace.openWorkspace(workspacePath).tree.collectRequestIds()

  let gcCount = 0
  for (const key of Object.keys(map)) {
    if (!knownIds.has(key)) {
      delete map[key]
      gcCount++
    }
  }

  active = {
    workspacePath,
    map,
    writeTimer: null,
    pendingWrite: false
  }

  if (gcCount > 0) {
    scheduleWrite()
  }
}

/** Flush any pending write synchronously and detach from the workspace. */
export function clearWorkspace(): void {
  flushSync()
  active = null
}

export function getForRequest(requestId: string): RequestUiState | null {
  if (!active) return null
  return active.map[requestId] ?? null
}

export function getAll(): RequestUiStateMap {
  if (!active) return {}
  return { ...active.map }
}

/**
 * Merge `partial` into the entry for `requestId`. Invalid fields are dropped
 * with a warning. Returns the merged entry. Writes are debounced.
 */
export function setForRequest(requestId: string, partial: RequestUiState): RequestUiState {
  if (!active) return partial
  if (typeof requestId !== 'string' || requestId.length === 0) return partial

  const cleaned = sanitizeEntry(partial, requestId)
  const current = active.map[requestId] ?? {}
  const merged: RequestUiState = { ...current, ...(cleaned ?? {}) }

  if (Object.keys(merged).length === 0) {
    delete active.map[requestId]
  } else {
    active.map[requestId] = merged
  }

  scheduleWrite()
  return merged
}

export function deleteForRequest(requestId: string): void {
  if (!active) return
  if (Object.prototype.hasOwnProperty.call(active.map, requestId)) {
    delete active.map[requestId]
    scheduleWrite()
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
  const { workspacePath, map } = active
  active.writeTimer = null
  active.pendingWrite = false
  try {
    await workspace
      .openWorkspace(workspacePath)
      .atomicWrite(UI_STATE_FILE_REL, JSON.stringify(map, null, 2))
  } catch (err) {
    console.error('[ui-state] failed to flush:', err)
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
      .atomicWriteSync(UI_STATE_FILE_REL, JSON.stringify(active.map, null, 2))
  } catch (err) {
    console.error('[ui-state] failed to flushSync:', err)
  }
}

/** Test-only hook. Resets the in-memory singleton without touching disk. */
export function _resetForTests(): void {
  if (active?.writeTimer) clearTimeout(active.writeTimer)
  active = null
}
