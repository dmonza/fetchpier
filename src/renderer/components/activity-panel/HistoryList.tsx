import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Trash2, Clock, Loader2, ChevronRight, ChevronDown, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useWorkspaceStore } from '../../stores/workspace'
import { useRequestStore } from '../../stores/request'
import { useHistoryExpansionStore } from '../../stores/historyExpansion'
import { useHistoryChipsStore } from '../../stores/historyChips'
import { useToastStore } from '../../stores/toast'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '../ui/context-menu'
import type { HistoryEntry, HistoryEntryListItem } from '../../../shared/types'
import { historyRepeatRequest, historyViewRequest } from './history-request'
import {
  historyEntryFromRaw,
  parseActivityLog,
  type ActivityLogFile
} from '../../../shared/lib/activity-log'
import { RunDetail } from './run-detail/RunDetail'
import { requestsRunDetailDescriptor } from './run-detail/domains/requests-descriptor'

/**
 * Build a display label for a request chip. Uses the file basename when the
 * request lives at the requests root; otherwise prefixes with the immediate
 * parent folder so two files with the same basename (e.g. two
 * `transcription.http` in different folders) get visually distinct chips.
 */
function deriveChipLabel(absFilePath: string, workspacePath: string | null): string {
  const sepCandidates = /[/\\]/
  let rel = absFilePath
  if (workspacePath && absFilePath.startsWith(workspacePath)) {
    rel = absFilePath.slice(workspacePath.length).replace(/^[/\\]+/, '')
  }
  // Strip the "requests/" prefix (common to every request file) and the .http suffix.
  rel = rel.replace(/^requests[/\\]/i, '').replace(/\.http$/i, '')
  const parts = rel.split(sepCandidates).filter(Boolean)
  if (parts.length === 0) return absFilePath
  if (parts.length === 1) return parts[0]!
  // Show parent/basename when nested — keeps the chip compact but disambiguates.
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-method-get/15 text-method-get',
  POST: 'bg-method-post/15 text-method-post',
  PUT: 'bg-method-put/15 text-method-put',
  PATCH: 'bg-method-patch/15 text-method-patch',
  DELETE: 'bg-method-delete/15 text-method-delete',
  HEAD: 'bg-method-head/15 text-method-head',
  OPTIONS: 'bg-method-options/15 text-method-options'
}

function getStatusColor(status: number): string {
  if (status >= 500) return 'text-danger-text'
  if (status >= 400) return 'text-warning-text'
  if (status === 304) return 'text-info-text opacity-70'
  if (status >= 300) return 'text-info-text'
  if (status === 202 || status === 204) return 'text-success-text opacity-70'
  if (status >= 200) return 'text-success-text'
  return 'text-muted-foreground'
}

interface HistoryListProps {
  /**
   * 'sidebar' = narrow column (legacy look used by the old sidebar History tab).
   * 'panel' = wider activity-panel layout — same data, more horizontal real estate.
   */
  variant?: 'sidebar' | 'panel'
}

/**
 * Shared list of history entries. Filters to the checked request chips,
 * reloads on `history:changed`, and routes interactions through the
 * request store (open / repeat / raw / delete).
 *
 * REQ-0069: each row toggles inline expansion on click. On first expand the
 * full `.http` is fetched, parsed, and rendered as a `<RunDetail/>` below the
 * row. Multiple rows may be expanded simultaneously; expansion state is
 * per-session (resets on workspace change, never persisted).
 */
export function HistoryList({ variant = 'panel' }: HistoryListProps): React.JSX.Element {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const openTab = useRequestStore((s) => s.openTab)
  const pushToast = useToastStore((s) => s.push)

  const expandedIds = useHistoryExpansionStore((s) => s.expandedIds)
  const cache = useHistoryExpansionStore((s) => s.cache)
  const fetchErrors = useHistoryExpansionStore((s) => s.fetchErrors)
  const toggleExpand = useHistoryExpansionStore((s) => s.toggle)
  const setParsed = useHistoryExpansionStore((s) => s.setParsed)
  const setExpansionError = useHistoryExpansionStore((s) => s.setError)
  const resetExpansion = useHistoryExpansionStore((s) => s.reset)

  const allTabs = useRequestStore((s) => s.tabs)
  const chips = useHistoryChipsStore((s) => s.chips)
  const syncChips = useHistoryChipsStore((s) => s.syncChips)
  const toggleChip = useHistoryChipsStore((s) => s.toggleChip)
  const resetChips = useHistoryChipsStore((s) => s.reset)

  // Mirror the open editor tabs into the chip set. Tabs without a `filePath`
  // (untitled), read-only history views, or raw `.http` views are excluded —
  // they'd be unhelpful labels with no source identity. Each render syncs:
  // new tabs add chips (checked by default), closed tabs remove their chip,
  // existing chips keep their checked state.
  useEffect(() => {
    const openChips = allTabs
      .filter((t) => t.requestId && t.filePath && !t.isReadOnly && t.rawContent === undefined)
      .map((t) => ({
        requestId: t.requestId,
        label: deriveChipLabel(t.filePath!, workspacePath)
      }))
    syncChips(openChips)
  }, [allTabs, workspacePath, syncChips])

  // The set of requestIds the user wants to see. Empty ⇒ show all (no filter).
  const checkedRequestIds = useMemo(() => {
    const out = new Set<string>()
    for (const c of chips) if (c.checked) out.add(c.requestId)
    return out
  }, [chips])
  const hasActiveFilter = checkedRequestIds.size > 0
  // Stable primitive for the load effect and the page reset below ('' ⇒ no filter).
  const checkedKey = [...checkedRequestIds].join('\n')

  const PAGE_SIZE = 50
  const [entries, setEntries] = useState<HistoryEntryListItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadedCount, setLoadedCount] = useState(PAGE_SIZE)
  const [hasMore, setHasMore] = useState(true)
  const [reloadVersion, setReloadVersion] = useState(0)

  const [prevWorkspacePath, setPrevWorkspacePath] = useState(workspacePath)
  if (prevWorkspacePath !== workspacePath) {
    setPrevWorkspacePath(workspacePath)
    setEntries([])
    setLoadedCount(PAGE_SIZE)
    setHasMore(true)
    setIsLoading(Boolean(workspacePath))
  }

  // A different chip selection is a different list: start again from the first page.
  const [prevCheckedKey, setPrevCheckedKey] = useState(checkedKey)
  if (prevCheckedKey !== checkedKey) {
    setPrevCheckedKey(checkedKey)
    setLoadedCount(PAGE_SIZE)
    setHasMore(true)
  }

  // Reset expansion + chip state ONLY on a real workspace change. The initial
  // mount must not reset — otherwise it would wipe chips populated by the
  // sync-with-open-tabs effect (or wipe expansion cache from another open
  // panel instance).
  const prevWorkspaceForResetRef = useRef(workspacePath)
  useEffect(() => {
    if (prevWorkspaceForResetRef.current === workspacePath) return
    prevWorkspaceForResetRef.current = workspacePath
    resetExpansion()
    resetChips()
  }, [workspacePath, resetExpansion, resetChips])

  // The IPC filters by the checked chips before its `limit`, so each page holds
  // only matching runs. Filtering here too keeps the rows right while a reload
  // for a new chip selection is still in flight.
  const visibleEntries = useMemo(() => {
    if (!hasActiveFilter) return entries
    return entries.filter((e) => e.requestId !== undefined && checkedRequestIds.has(e.requestId))
  }, [entries, hasActiveFilter, checkedRequestIds])

  useEffect(() => {
    if (!workspacePath) return
    let cancelled = false
    void (async () => {
      setIsLoadingMore(true)
      try {
        const result = await window.api.history.list(
          checkedKey
            ? { requestIds: checkedKey.split('\n'), limit: loadedCount }
            : { limit: loadedCount }
        )
        if (cancelled) return
        setEntries(result)
        // If the IPC returned fewer than we asked for, there's nothing more on
        // disk. (When equal, there might be — keep `hasMore` true.)
        setHasMore(result.length >= loadedCount)
      } catch (err) {
        console.error('[HistoryList] Failed to load history:', err)
      } finally {
        if (!cancelled) {
          setIsLoading(false)
          setIsLoadingMore(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspacePath, loadedCount, reloadVersion, checkedKey])

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!hasMore || isLoadingMore) return
      const el = e.currentTarget
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
        setLoadedCount((c) => c + PAGE_SIZE)
      }
    },
    [hasMore, isLoadingMore]
  )

  // Main broadcasts `history:changed` to every window after a run is saved,
  // deleted, cleared or relinked — so a popped-out panel converges too.
  useEffect(() => window.api.history.onChanged(() => setReloadVersion((v) => v + 1)), [])

  const handleClear = useCallback(async () => {
    if (!workspacePath) return
    if (!window.confirm(t('history.clearConfirm'))) return
    try {
      await window.api.history.clear()
      setEntries([])
      resetExpansion()
    } catch (err) {
      console.error('[HistoryList] Failed to clear history:', err)
    }
  }, [workspacePath, t, resetExpansion])

  const openViewForEntry = useCallback(
    (entry: HistoryEntry) => {
      const { method, url } = entry.request
      const title = `${method} ${url.length > 40 ? url.slice(0, 40) + '…' : url}`
      openTab({
        title,
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
    },
    [openTab]
  )

  /**
   * Read the raw `.http` of the entry, rebuild the in-memory shape, and call
   * `consume`. Errors are logged; callers fail open (no toast — keeps the
   * activity-panel cheap; the next refresh will retry implicitly).
   */
  const withReconstructedEntry = useCallback(
    async (item: HistoryEntryListItem, consume: (full: HistoryEntry) => void): Promise<void> => {
      if (!workspacePath) return
      try {
        const raw = await window.api.history.get(item.id)
        consume(historyEntryFromRaw(raw))
      } catch (err) {
        console.error('[HistoryList] Failed to reconstruct entry:', err)
      }
    },
    [workspacePath]
  )

  const handleViewEntry = useCallback(
    (item: HistoryEntryListItem) => {
      void withReconstructedEntry(item, openViewForEntry)
    },
    [openViewForEntry, withReconstructedEntry]
  )

  const handleOpenRaw = useCallback(
    async (item: HistoryEntryListItem) => {
      if (!workspacePath) return
      const url = item.request.url
      const title = t('history.rawTabTitle', {
        method: item.request.method,
        url: url.length > 30 ? url.slice(0, 30) + '…' : url
      })
      try {
        const rawContent = await window.api.history.get(item.id)
        openTab({
          title,
          filePath: null,
          isDirty: false,
          isReadOnly: true,
          historyEntryId: `raw:${item.id}`,
          rawContent
        })
      } catch (err) {
        console.error('[HistoryList] Failed to read raw .http:', err)
      }
    },
    [workspacePath, openTab, t]
  )

  const handleDeleteEntry = useCallback(
    async (item: HistoryEntryListItem) => {
      if (!workspacePath) return
      try {
        await window.api.history.delete(item.id)
        setEntries((prev) => prev.filter((e) => e.id !== item.id))
      } catch (err) {
        console.error('[HistoryList] Failed to delete entry:', err)
      }
    },
    [workspacePath]
  )

  const repeatFromEntry = useCallback(
    (entry: HistoryEntry) => {
      const { method, url } = entry.request
      const absSourceFile =
        entry.sourceFile && workspacePath
          ? (() => {
              const sep = workspacePath.includes('\\') ? '\\' : '/'
              const rel = entry.sourceFile!.replace(/[/\\]/g, sep)
              return workspacePath + sep + rel
            })()
          : (entry.sourceFile ?? null)
      const existing = absSourceFile
        ? useRequestStore.getState().tabs.find((t) => t.filePath === absSourceFile)
        : undefined
      if (existing) {
        openTab({ filePath: absSourceFile ?? undefined })
        return
      }
      openTab({
        title: `${method} ${url.slice(0, 30)}`,
        filePath: null,
        request: historyRepeatRequest(entry)
      })
    },
    [workspacePath, openTab]
  )

  const handleRepeat = useCallback(
    (item: HistoryEntryListItem) => {
      void withReconstructedEntry(item, repeatFromEntry)
    },
    [repeatFromEntry, withReconstructedEntry]
  )

  /**
   * Workspace-relative `@source-file` → absolute path on the current OS.
   * Mirrors the join used by Repeat (HistoryList legacy logic).
   */
  const resolveSourceAbsPath = useCallback(
    (relativePath: string): string | null => {
      if (!workspacePath) return null
      const sep = workspacePath.includes('\\') ? '\\' : '/'
      const rel = relativePath.replace(/[/\\]/g, sep)
      return workspacePath + sep + rel
    },
    [workspacePath]
  )

  /**
   * Q1 (REQ-0069 §10): soft-fail on missing source file. Pre-check existence
   * via `filesystem:fileExists` and toast an error if it's gone; otherwise
   * open the source `.http` as a tab — same mechanism Repeat uses.
   */
  const handleOpenSourceFile = useCallback(
    async (relativePath: string) => {
      const abs = resolveSourceAbsPath(relativePath)
      if (!abs) return
      try {
        const exists = await window.api.filesystem.fileExists(abs)
        if (!exists) {
          pushToast(t('history.expansion.errors.sourceFileMissing', { path: relativePath }), {
            type: 'error'
          })
          return
        }
      } catch (err) {
        console.error('[HistoryList] fileExists failed:', err)
        pushToast(t('history.expansion.errors.sourceFileMissing', { path: relativePath }), {
          type: 'error'
        })
        return
      }
      openTab({ filePath: abs })
    },
    [resolveSourceAbsPath, openTab, pushToast, t]
  )

  /**
   * Lazy-load + cache for an expanded row. Called from a `useEffect` keyed on
   * `expandedIds × cache × fetchErrors` so we only fetch the first time and
   * never refetch on cache hit (CA-03).
   */
  const fetchAndParseEntry = useCallback(
    async (id: string) => {
      if (!workspacePath) return
      try {
        const raw = await window.api.history.get(id)
        const file: ActivityLogFile = parseActivityLog(raw)
        setParsed(id, file)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setExpansionError(id, message)
        console.error('[HistoryList] Failed to fetch/parse entry:', err)
      }
    },
    [workspacePath, setParsed, setExpansionError]
  )

  const handleToggleRow = useCallback(
    (id: string) => {
      toggleExpand(id)
    },
    [toggleExpand]
  )

  const handleRetryFetch = useCallback(
    (id: string) => {
      useHistoryExpansionStore.getState().clearError(id)
      void fetchAndParseEntry(id)
    },
    [fetchAndParseEntry]
  )

  // Fire lazy fetches for newly-expanded rows whose content is not yet cached
  // and not currently in error. This effect is the single fetch driver — it
  // guarantees CA-03 (one fetch per row) because the dependencies (cache,
  // fetchErrors) update once the fetch resolves and the loop won't re-fire.
  useEffect(() => {
    for (const id of expandedIds) {
      if (!cache.has(id) && !fetchErrors.has(id)) {
        void fetchAndParseEntry(id)
      }
    }
  }, [expandedIds, cache, fetchErrors, fetchAndParseEntry])

  if (!workspacePath) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center">
        <p className="text-xs text-muted-foreground">{t('history.noWorkspace')}</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const isPanel = variant === 'panel'

  const chipsBar = chips.length > 0 && (
    <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
      {chips.map((chip) => (
        <button
          key={chip.requestId}
          type="button"
          onClick={() => toggleChip(chip.requestId)}
          aria-pressed={chip.checked}
          title={chip.checked ? t('history.chips.uncheck') : t('history.chips.check')}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors',
            chip.checked
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground opacity-70 hover:opacity-100'
          )}
        >
          <span
            className={cn(
              'flex h-3 w-3 items-center justify-center rounded-sm border',
              chip.checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
            )}
          >
            {chip.checked && <Check className="h-2.5 w-2.5" />}
          </span>
          <span className="max-w-[24ch] truncate">{chip.label}</span>
        </button>
      ))}
    </div>
  )

  if (visibleEntries.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        {chipsBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-muted-foreground">
          <Clock className="h-5 w-5" />
          <p className="text-xs">
            {hasActiveFilter ? t('history.emptyForFile') : t('history.empty')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {chipsBar}
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="truncate text-[11px] text-muted-foreground">
          {!hasActiveFilter && t('history.allEntries')}
        </span>
        <button
          onClick={handleClear}
          title={t('history.clear')}
          className="ml-2 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {visibleEntries.map((entry) => {
          const isExpanded = expandedIds.has(entry.id)
          const parsedFile = cache.get(entry.id)
          const fetchErr = fetchErrors.get(entry.id)
          return (
            <ContextMenu key={entry.id}>
              <ContextMenuTrigger asChild>
                <div className="border-b border-border">
                  <div
                    className="group cursor-pointer px-2 py-1.5 hover:bg-accent"
                    onClick={() => handleToggleRow(entry.id)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-muted-foreground">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1 py-px text-[10px] font-semibold',
                          METHOD_COLORS[entry.request.method] ?? 'bg-muted text-muted-foreground'
                        )}
                      >
                        {entry.request.method}
                      </span>
                      <span
                        className={cn('text-xs font-medium', getStatusColor(entry.response.status))}
                      >
                        {entry.response.status}
                      </span>
                      {isPanel && (
                        <span
                          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                          title={entry.request.url}
                        >
                          {entry.request.url}
                        </span>
                      )}
                      {entry.durationMs !== undefined && (
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                          {t('history.expansion.metadata.durationMs', { ms: entry.durationMs })}
                        </span>
                      )}
                      <span
                        className={cn(
                          'shrink-0 text-[10px] text-muted-foreground',
                          entry.durationMs === undefined && 'ml-auto'
                        )}
                      >
                        {formatTimestamp(entry.timestamp)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRepeat(entry)
                        }}
                        title={t('history.repeat')}
                        className="hidden shrink-0 rounded p-0.5 hover:bg-accent group-hover:block"
                      >
                        <RefreshCw className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </div>

                    {!isPanel && (
                      <p
                        className="truncate text-[11px] text-muted-foreground"
                        title={entry.request.url}
                      >
                        {entry.request.url}
                      </p>
                    )}
                  </div>

                  {isExpanded && (
                    <>
                      {fetchErr && (
                        <div className="border-t border-border bg-muted/30 px-3 py-2 text-[11px]">
                          <p className="text-danger-text">
                            {t('history.expansion.errors.fetchFailed')}
                          </p>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRetryFetch(entry.id)
                            }}
                            className="mt-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          >
                            {t('history.expansion.errors.retry')}
                          </button>
                        </div>
                      )}
                      {!fetchErr && !parsedFile && (
                        <div className="flex items-center justify-center border-t border-border bg-muted/30 px-3 py-2">
                          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        </div>
                      )}
                      {parsedFile && (
                        <RunDetail
                          file={parsedFile}
                          descriptor={requestsRunDetailDescriptor}
                          onOpenSourceFile={(p) => {
                            void handleOpenSourceFile(p)
                          }}
                        />
                      )}
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => handleViewEntry(entry)}>
                  {t('history.contextMenu.open')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleOpenRaw(entry)}>
                  {t('history.contextMenu.raw')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => handleDeleteEntry(entry).catch(console.error)}
                >
                  {t('history.contextMenu.delete')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
        {isLoadingMore && visibleEntries.length > 0 && (
          <div className="flex items-center justify-center py-2">
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  )
}
