import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Trash2, Clock, Loader2, ChevronRight, ChevronDown, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useWorkspaceStore } from '../../stores/workspace'
import { useHistoryExpansionStore } from '../../stores/historyExpansion'
import { useHistoryChipsStore } from '../../stores/historyChips'
import { useOpenTabChips } from './useOpenTabChips'
import { useMirroredChips } from './useMirroredChips'
import {
  hasHistoryRequestFilter,
  historyEntryMatcher,
  type HistoryRequestFilter
} from '../../../shared/lib/history-filter'
import { useToastStore } from '../../stores/toast'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '../ui/context-menu'
import type { ActivityPanelRowAction, HistoryEntryListItem } from '../../../shared/types'
import { runHistoryRowAction } from './history-row-actions'
import { parseActivityLog, type ActivityLogFile } from '../../../shared/lib/activity-log'
import { RunDetail } from './run-detail/RunDetail'
import { requestsRunDetailDescriptor } from './run-detail/domains/requests-descriptor'

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
  /**
   * 'popout' = rendered in the detached Activity window, which has no tab bar:
   * row actions run in the main window that owns it (ISS-0164), and the chips
   * are the main window's, toggled there (ISS-0073).
   */
  mode?: 'docked' | 'popout'
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
export function HistoryList({
  variant = 'panel',
  mode = 'docked'
}: HistoryListProps): React.JSX.Element {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const pushToast = useToastStore((s) => s.push)

  const expandedIds = useHistoryExpansionStore((s) => s.expandedIds)
  const cache = useHistoryExpansionStore((s) => s.cache)
  const fetchErrors = useHistoryExpansionStore((s) => s.fetchErrors)
  const toggleExpand = useHistoryExpansionStore((s) => s.toggle)
  const setParsed = useHistoryExpansionStore((s) => s.setParsed)
  const setExpansionError = useHistoryExpansionStore((s) => s.setError)
  const resetExpansion = useHistoryExpansionStore((s) => s.reset)

  const chips = useHistoryChipsStore((s) => s.chips)
  const toggleChip = useHistoryChipsStore((s) => s.toggleChip)

  // Docked, the chips follow this window's open tabs. In the popout (no tabs)
  // they are the main window's set, mirrored over IPC (ISS-0073).
  const ownChipsInSync = useOpenTabChips(mode === 'docked')
  const mirrorArrived = useMirroredChips(mode === 'popout')

  // The first listing waits until the chip set is complete — every tab's id
  // read and the chips mirroring them, or the main window's set received — so
  // it never lists by random ids or by no filter at all. Later, a tab opened
  // while the panel is shown only adds its chip once read.
  const chipSetComplete = mode === 'popout' ? mirrorArrived : ownChipsInSync
  const [chipsReady, setChipsReady] = useState(false)
  if (!chipsReady && chipSetComplete) setChipsReady(true)

  // A chip click: the popout's set belongs to the main window, which toggles
  // it and publishes the result back.
  const handleChipClick = useCallback(
    (requestId: string): void => {
      if (mode === 'docked') {
        toggleChip(requestId)
        return
      }
      window.api.activityPanel
        .toggleChipInOwner(requestId)
        .then((delivered) => {
          if (!delivered) console.error('[HistoryList] The main window did not take the chip')
        })
        .catch((err: unknown) =>
          console.error('[HistoryList] Failed to reach the main window:', err)
        )
    },
    [mode, toggleChip]
  )

  // The requests the user wants to see. Empty ⇒ show all (no filter).
  const checkedFilter = useMemo(() => {
    const requestIds: string[] = []
    const sourceFiles: string[] = []
    for (const c of chips) {
      if (!c.checked) continue
      requestIds.push(c.requestId)
      if (c.sourceFile !== undefined) sourceFiles.push(c.sourceFile)
    }
    return { requestIds, sourceFiles }
  }, [chips])
  const hasActiveFilter = hasHistoryRequestFilter(checkedFilter)
  // Stable primitive for the load effect and the page reset below ('' ⇒ no filter).
  const checkedKey = hasActiveFilter ? JSON.stringify(checkedFilter) : ''

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
    setChipsReady(false)
  }

  // A different chip selection is a different list: start again from the first page.
  const [prevCheckedKey, setPrevCheckedKey] = useState(checkedKey)
  if (prevCheckedKey !== checkedKey) {
    setPrevCheckedKey(checkedKey)
    setLoadedCount(PAGE_SIZE)
    setHasMore(true)
  }

  // Reset expansion state ONLY on a real workspace change. The initial mount
  // must not reset — otherwise it would wipe the expansion cache from another
  // open panel instance. The chips reset in `useOpenTabChips` (docked); the
  // popout's set is replaced by the main window's next one.
  const prevWorkspaceForResetRef = useRef(workspacePath)
  useEffect(() => {
    if (prevWorkspaceForResetRef.current === workspacePath) return
    prevWorkspaceForResetRef.current = workspacePath
    resetExpansion()
  }, [workspacePath, resetExpansion])

  // The IPC filters by the checked chips before its `limit`, so each page holds
  // only matching runs. Filtering here too keeps the rows right while a reload
  // for a new chip selection is still in flight.
  const visibleEntries = useMemo(() => {
    if (!hasActiveFilter) return entries
    return entries.filter(historyEntryMatcher(checkedFilter))
  }, [entries, hasActiveFilter, checkedFilter])

  useEffect(() => {
    if (!workspacePath || !chipsReady) return
    let cancelled = false
    void (async () => {
      setIsLoadingMore(true)
      try {
        const filter: HistoryRequestFilter = checkedKey ? JSON.parse(checkedKey) : {}
        const result = await window.api.history.list(
          checkedKey
            ? {
                requestIds: [...(filter.requestIds ?? [])],
                ...(filter.sourceFiles?.length ? { sourceFiles: [...filter.sourceFiles] } : {}),
                limit: loadedCount
              }
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
  }, [workspacePath, loadedCount, reloadVersion, checkedKey, chipsReady])

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

  /**
   * Row actions (Open, Raw .http, Repeat, Open source file) open tabs, so they
   * run in a window with a tab bar: here when docked; in the main window that
   * owns the popout when popped out (ISS-0164) — the popout's own tab store is
   * never shown. Failures are logged or toasted by the action itself.
   */
  const dispatchRowAction = useCallback(
    (action: ActivityPanelRowAction): void => {
      if (!workspacePath) return
      if (mode === 'popout') {
        window.api.activityPanel
          .openInOwner(action)
          .then((delivered) => {
            if (!delivered) console.error('[HistoryList] The main window did not take the action')
          })
          .catch((err: unknown) =>
            console.error('[HistoryList] Failed to reach the main window:', err)
          )
        return
      }
      void runHistoryRowAction(action, { workspacePath, t, pushToast })
    },
    [mode, workspacePath, t, pushToast]
  )

  const handleViewEntry = useCallback(
    (item: HistoryEntryListItem) => dispatchRowAction({ kind: 'view', entryId: item.id }),
    [dispatchRowAction]
  )

  const handleOpenRaw = useCallback(
    (item: HistoryEntryListItem) =>
      dispatchRowAction({
        kind: 'raw',
        entryId: item.id,
        method: item.request.method,
        url: item.request.url
      }),
    [dispatchRowAction]
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

  const handleRepeat = useCallback(
    (item: HistoryEntryListItem) => dispatchRowAction({ kind: 'repeat', entryId: item.id }),
    [dispatchRowAction]
  )

  const handleOpenSourceFile = useCallback(
    (relativePath: string) =>
      dispatchRowAction({ kind: 'open-source-file', sourceFile: relativePath }),
    [dispatchRowAction]
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

  if (isLoading || !chipsReady) {
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
          onClick={() => handleChipClick(chip.requestId)}
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
                          onOpenSourceFile={handleOpenSourceFile}
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
