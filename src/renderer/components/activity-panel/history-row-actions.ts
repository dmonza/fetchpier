import { useRequestStore } from '../../stores/request'
import type { ActivityPanelRowAction, HistoryEntry } from '../../../shared/types'
import { historyEntryFromRaw } from '../../../shared/lib/activity-log'
import { historyRepeatRequest, historyViewRequest } from './history-request'

/**
 * The History row actions — Open, Raw .http, Repeat, Open source file — run in
 * the window that has the tab bar. The docked list calls `runHistoryRowAction`
 * directly; the Activity popout forwards the action to the main window that
 * owns it (`activityPanel:openInOwner`), which runs it here through
 * `subscribeToForwardedRowActions` (`forwarded-row-actions.ts`, ISS-0164). One
 * code path, so both behave the same.
 */

export interface HistoryRowActionContext {
  /** The open workspace; every action is a no-op without one. */
  workspacePath: string | null
  t: (key: string, options?: Record<string, unknown>) => string
  pushToast: (message: string, options: { type: 'error' }) => void
}

/** Workspace-relative `@source-file` → absolute path on the current OS. */
function resolveSourceAbsPath(relativePath: string, workspacePath: string): string {
  const sep = workspacePath.includes('\\') ? '\\' : '/'
  return workspacePath + sep + relativePath.replace(/[/\\]/g, sep)
}

/** Read a run and rebuild its in-memory shape; `null` (logged) when it cannot. */
async function readEntry(entryId: string): Promise<HistoryEntry | null> {
  try {
    return historyEntryFromRaw(await window.api.history.get(entryId))
  } catch (err) {
    console.error('[HistoryList] Failed to reconstruct entry:', err)
    return null
  }
}

function openView(entry: HistoryEntry): void {
  const { method, url } = entry.request
  useRequestStore.getState().openTab({
    title: `${method} ${url.length > 40 ? url.slice(0, 40) + '…' : url}`,
    filePath: null,
    isDirty: false,
    isReadOnly: true,
    historyEntryId: entry.id,
    historyTimestamp: entry.timestamp,
    response: entry.response,
    isLoading: false,
    error: null,
    request: historyViewRequest(entry),
    scriptResults: entry.scriptResults
  })
}

function openRepeat(entry: HistoryEntry, workspacePath: string): void {
  const { openTab, tabs } = useRequestStore.getState()
  const absSourceFile = entry.sourceFile
    ? resolveSourceAbsPath(entry.sourceFile, workspacePath)
    : null
  if (absSourceFile && tabs.some((t) => t.filePath === absSourceFile)) {
    openTab({ filePath: absSourceFile })
    return
  }
  const { method, url } = entry.request
  openTab({
    title: `${method} ${url.slice(0, 30)}`,
    filePath: null,
    request: historyRepeatRequest(entry)
  })
}

async function openRaw(
  action: Extract<ActivityPanelRowAction, { kind: 'raw' }>,
  ctx: HistoryRowActionContext
): Promise<void> {
  const { url } = action
  const title = ctx.t('history.rawTabTitle', {
    method: action.method,
    url: url.length > 30 ? url.slice(0, 30) + '…' : url
  })
  try {
    const rawContent = await window.api.history.get(action.entryId)
    useRequestStore.getState().openTab({
      title,
      filePath: null,
      isDirty: false,
      isReadOnly: true,
      historyEntryId: `raw:${action.entryId}`,
      rawContent
    })
  } catch (err) {
    console.error('[HistoryList] Failed to read raw .http:', err)
  }
}

/**
 * Soft-fail on a missing source file (REQ-0069 §10 Q1): check it exists and
 * toast an error if it is gone; otherwise open it as a tab.
 */
async function openSourceFile(
  relativePath: string,
  workspacePath: string,
  ctx: HistoryRowActionContext
): Promise<void> {
  const abs = resolveSourceAbsPath(relativePath, workspacePath)
  const missing = (): void =>
    ctx.pushToast(ctx.t('history.expansion.errors.sourceFileMissing', { path: relativePath }), {
      type: 'error'
    })
  try {
    if (!(await window.api.filesystem.fileExists(abs))) return missing()
  } catch (err) {
    console.error('[HistoryList] fileExists failed:', err)
    return missing()
  }
  useRequestStore.getState().openTab({ filePath: abs })
}

/** Run a History row action in this window. Failures are logged or toasted. */
export async function runHistoryRowAction(
  action: ActivityPanelRowAction,
  ctx: HistoryRowActionContext
): Promise<void> {
  const { workspacePath } = ctx
  if (!workspacePath) return
  switch (action.kind) {
    case 'view': {
      const entry = await readEntry(action.entryId)
      if (entry) openView(entry)
      return
    }
    case 'repeat': {
      const entry = await readEntry(action.entryId)
      if (entry) openRepeat(entry, workspacePath)
      return
    }
    case 'raw':
      return openRaw(action, ctx)
    case 'open-source-file':
      return openSourceFile(action.sourceFile, workspacePath, ctx)
  }
}
