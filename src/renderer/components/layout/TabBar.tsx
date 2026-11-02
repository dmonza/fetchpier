import { useState } from 'react'
import { Plus, X, Lock, Pin, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useRequestStore } from '../../stores/request'
import { guardDiscard } from '../../stores/unsavedGuard'
import { useWorkspaceStore } from '../../stores/workspace'
import { closeOthersIds, closeAllIds, closeRightIds, closeLeftIds } from '../../lib/tab-order'
import { LanguageSelector } from '../LanguageSelector'
import { ThemeToggle } from '../ThemeToggle'
import { EnvironmentManager } from '../environment/EnvironmentManager'
import { SettingsPanel } from './SettingsPanel'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import type { Tab } from '../../../shared/types'

interface CloseConfirmProps {
  tab: Tab
  onConfirm: () => void
  onCancel: () => void
}

function CloseConfirmModal({ tab, onConfirm, onCancel }: CloseConfirmProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('closeConfirm.title')}</DialogTitle>
          <DialogDescription>{t('closeConfirm.message', { name: tab.title })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onCancel}
          >
            {t('closeConfirm.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-destructive px-3 py-1.5 text-xs text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onConfirm}
          >
            {t('closeConfirm.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TabBar(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useRequestStore((s) => s.tabs)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const activeTabId = useRequestStore((s) => s.activeTabId)
  const openTab = useRequestStore((s) => s.openTab)
  const closeTab = useRequestStore((s) => s.closeTab)
  const closeOtherTabs = useRequestStore((s) => s.closeOtherTabs)
  const closeAllTabs = useRequestStore((s) => s.closeAllTabs)
  const closeTabsToRight = useRequestStore((s) => s.closeTabsToRight)
  const closeTabsToLeft = useRequestStore((s) => s.closeTabsToLeft)
  const pinTab = useRequestStore((s) => s.pinTab)
  const unpinTab = useRequestStore((s) => s.unpinTab)
  const reorderTabs = useRequestStore((s) => s.reorderTabs)
  const setActiveTab = useRequestStore((s) => s.setActiveTab)
  const promoteTab = useRequestStore((s) => s.promoteTab)

  const [pendingClose, setPendingClose] = useState<Tab | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  const requestClose = (tab: Tab): void => {
    if (tab.isReadOnly) {
      closeTab(tab.id)
      return
    }
    const isUnsaved = tab.filePath === null && tab.request.url.trim().length > 0
    if (tab.isDirty || isUnsaved) {
      setPendingClose(tab)
    } else {
      closeTab(tab.id)
    }
  }

  const confirmClose = (): void => {
    if (pendingClose) {
      closeTab(pendingClose.id)
      setPendingClose(null)
    }
  }

  /** Guard the tabs in `ids` (the ones that will actually close), then run it. */
  const guardedClose = (ids: string[], run: () => void): void => {
    const idSet = new Set(ids)
    void guardDiscard(
      tabs.filter((x) => idSet.has(x.id)),
      async () => run()
    )
  }

  return (
    <>
      <div className="flex h-9 items-center border-b border-border bg-background shrink-0">
        {/* Tabs list */}
        <div className="flex flex-1 items-center overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const rightIds = closeRightIds(tabs, tab.id)
            const leftIds = closeLeftIds(tabs, tab.id)
            const otherIds = closeOthersIds(tabs, tab.id)
            return (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger asChild>
                  <div
                    role="tab"
                    tabIndex={0}
                    aria-selected={activeTabId === tab.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(tab.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => {
                      if (dragId && dragId !== tab.id) {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragId && dragId !== tab.id) {
                        // The store clamps a cross-boundary (pinned↔unpinned) drop.
                        reorderTabs(dragId, tab.id)
                      }
                      setDragId(null)
                    }}
                    onClick={() => setActiveTab(tab.id)}
                    onDoubleClick={() => promoteTab(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setActiveTab(tab.id)
                      } else if (
                        e.key === 'Delete' ||
                        (e.key === 'w' && (e.ctrlKey || e.metaKey))
                      ) {
                        e.preventDefault()
                        requestClose(tab)
                      }
                    }}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault()
                        requestClose(tab)
                      }
                    }}
                    className={cn(
                      'group flex h-9 min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      activeTabId === tab.id
                        ? 'relative z-10 -mb-px bg-background text-foreground font-semibold border-x border-border border-b-2 border-b-background'
                        : 'bg-surface-2 text-muted-foreground hover:bg-surface-3 border-x border-transparent',
                      dragId === tab.id && 'opacity-50'
                    )}
                  >
                    {/* Active accent — 2px indigo bar at the top edge (child element so it
                      doesn't depend on per-side border-color utilities) */}
                    {activeTabId === tab.id && (
                      <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary" />
                    )}
                    {/* Read-only indicator */}
                    {tab.isReadOnly && (
                      <Lock className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                    )}
                    {/* External-change conflict marker — distinct from the unsaved dot,
                      so a conflict is visible on the tab without opening it. */}
                    {!tab.isReadOnly && tab.conflict && (
                      <span title={t('tabs.conflict')} className="flex shrink-0">
                        <AlertTriangle
                          className="h-3 w-3 text-warning-text"
                          aria-label={t('tabs.conflict')}
                        />
                      </span>
                    )}
                    {/* Dirty indicator (suppressed while a conflict marker is shown) */}
                    {!tab.isReadOnly && tab.isDirty && !tab.conflict && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                    )}
                    {/* Preview (ephemeral) tabs render their title in italics (REQ-0085).
                      A file removed on disk shows struck-through in a warning colour
                      (REQ open-tab-file-reconciliation). */}
                    <span
                      className={cn(
                        'truncate',
                        tab.mode === 'preview' && 'italic',
                        tab.removedOnDisk && 'text-warning-text line-through'
                      )}
                      title={tab.removedOnDisk ? t('tabs.removedOnDisk') : undefined}
                    >
                      {tab.title}
                    </span>
                    {/* Close / pin affordance. A pinned tab keeps its pin glyph (no
                      hover-swap to a close button); clicking it unpins. Closing a
                      pinned tab stays possible via middle-click, Ctrl+W, or the menu. */}
                    <div className="ml-auto flex shrink-0 items-center">
                      {tab.mode === 'pinned' ? (
                        <button
                          type="button"
                          aria-label={t('tabs.contextMenu.unpin')}
                          title={t('tabs.contextMenu.unpin')}
                          onClick={(e) => {
                            e.stopPropagation()
                            unpinTab(tab.id)
                          }}
                          className="shrink-0 rounded p-0.5 text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <Pin className="h-3 w-3 fill-current" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label={t('tabs.close')}
                          onClick={(e) => {
                            e.stopPropagation()
                            requestClose(tab)
                          }}
                          className="shrink-0 rounded p-0.5 opacity-30 transition-opacity hover:bg-muted hover:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => requestClose(tab)}>
                    {t('tabs.contextMenu.close')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => guardedClose(rightIds, () => closeTabsToRight(tab.id))}
                    disabled={rightIds.length === 0}
                  >
                    {t('tabs.contextMenu.closeToRight')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => guardedClose(leftIds, () => closeTabsToLeft(tab.id))}
                    disabled={leftIds.length === 0}
                  >
                    {t('tabs.contextMenu.closeToLeft')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => guardedClose(otherIds, () => closeOtherTabs(tab.id))}
                    disabled={otherIds.length === 0}
                  >
                    {t('tabs.contextMenu.closeOthers')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => guardedClose(closeAllIds(tabs), () => closeAllTabs())}
                    disabled={closeAllIds(tabs).length === 0}
                  >
                    {t('tabs.contextMenu.closeAll')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => (tab.mode === 'pinned' ? unpinTab(tab.id) : pinTab(tab.id))}
                  >
                    {tab.mode === 'pinned'
                      ? t('tabs.contextMenu.unpin')
                      : t('tabs.contextMenu.pin')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}

          {/* New tab button */}
          <button
            onClick={() => openTab()}
            aria-label={t('tabs.new')}
            className="flex h-9 w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1 px-2 shrink-0">
          {workspacePath && <EnvironmentManager />}
          <LanguageSelector />
          <ThemeToggle />
          <SettingsPanel />
        </div>
      </div>

      {/* Close confirmation modal */}
      {pendingClose && (
        <CloseConfirmModal
          tab={pendingClose}
          onConfirm={confirmClose}
          onCancel={() => setPendingClose(null)}
        />
      )}
    </>
  )
}
