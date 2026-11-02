import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderPlus,
  FilePlus,
  FileDown,
  FolderOpen,
  Clock,
  Settings,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  X
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { CollectionTree } from '../sidebar/CollectionTree'
import { useWorkspaceStore } from '../../stores/workspace'
import { useRequestStore } from '../../stores/request'
import { guardDiscard } from '../../stores/unsavedGuard'
import { useEnvironmentStore } from '../../stores/environment'
import { useSchemaImportStore } from '../../stores/schemaImport'
import { useTreeSelectionStore, resolveTargetFolder } from '../../stores/treeSelection'
import { useTreeStateStore } from '../../stores/treeState'
import { WorkspaceSettingsDialog } from '../workspace/WorkspaceSettingsDialog'

interface WorkspaceHeaderProps {
  workspacePath: string | null
  recentWorkspaces: string[]
  isLoading: boolean
  onOpen: () => Promise<void>
  onOpenRecent: (path: string) => Promise<void>
  onClose: () => void
  onOpenSettings: () => void
}

function WorkspaceHeader({
  workspacePath,
  recentWorkspaces,
  isLoading,
  onOpen,
  onOpenRecent,
  onClose,
  onOpenSettings
}: WorkspaceHeaderProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const workspaceName = workspacePath ? (workspacePath.split(/[/\\]/).pop() ?? workspacePath) : null

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleOpenRecent = async (path: string): Promise<void> => {
    setOpen(false)
    await onOpenRecent(path)
  }

  // Recent workspaces excluding the currently open one
  const otherRecent = recentWorkspaces.filter((p) => p !== workspacePath)

  return (
    <div ref={containerRef} className="relative shrink-0">
      <div className="flex h-9 items-center gap-1 border-b border-border px-2">
        {/* Workspace name / selector trigger */}
        <button
          disabled={isLoading}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-xs transition-colors',
            'hover:bg-accent hover:text-accent-foreground disabled:opacity-50',
            workspaceName ? 'text-foreground font-medium' : 'text-muted-foreground'
          )}
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180'
            )}
          />
          <span className="truncate">{workspaceName ?? t('sidebar.noWorkspace')}</span>
        </button>

        {/* Workspace settings dialog trigger */}
        <button
          aria-label={t('sidebar.workspaceSettings')}
          title={t('sidebar.workspaceSettings')}
          disabled={!workspacePath}
          onClick={onOpenSettings}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>

        {/* Open / create workspace */}
        <button
          disabled={isLoading}
          title={t('sidebar.openOrCreateWorkspace')}
          onClick={() => onOpen().catch(console.error)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Dropdown: close option + recent workspaces */}
      {open && workspacePath && (
        <div className="absolute left-0 right-0 top-full z-50 border-b border-border bg-sidebar shadow-md">
          <button
            onClick={() => {
              setOpen(false)
              onClose()
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-3 w-3 shrink-0" />
            {t('sidebar.closeWorkspace')}
          </button>
          {otherRecent.length > 0 && (
            <>
              <div className="mx-3 my-1 border-t border-border" />
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <Clock className="h-3 w-3" />
                {t('sidebar.recent')}
              </div>
              {otherRecent.map((wp) => {
                const name = wp.split(/[/\\]/).pop() ?? wp
                return (
                  <button
                    key={wp}
                    disabled={isLoading}
                    onClick={() => handleOpenRecent(wp).catch(console.error)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  >
                    <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{name}</span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface WorkspaceCallToActionProps {
  isLoading: boolean
  recentWorkspaces: string[]
  onOpen: () => Promise<void>
  onCreate: () => Promise<void>
  onOpenRecent: (path: string) => Promise<void>
}

function WorkspaceCallToAction({
  isLoading,
  recentWorkspaces,
  onOpen,
  onOpenRecent
}: Omit<WorkspaceCallToActionProps, 'onCreate'>): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-3 p-3">
      <button
        disabled={isLoading}
        onClick={() => onOpen().catch(console.error)}
        className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-left text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
      >
        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{t('sidebar.openOrCreate')}</span>
      </button>

      {recentWorkspaces.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {t('sidebar.recent')}
          </div>
          {recentWorkspaces.map((wp) => {
            const name = wp.split(/[/\\]/).pop() ?? wp
            return (
              <button
                key={wp}
                disabled={isLoading}
                onClick={() => onOpenRecent(wp).catch(console.error)}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50 transition-colors"
              >
                <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const requestsRoot = useWorkspaceStore((s) => s.requestsRoot)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)
  const openRecentWorkspace = useWorkspaceStore((s) => s.openRecentWorkspace)
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace)
  const isLoading = useWorkspaceStore((s) => s.isLoading)
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces)

  // REQ-0095: opening/closing a workspace replaces the whole tab set, so guard
  // unsaved edits first. guardDiscard runs the action immediately when nothing is
  // dirty, otherwise prompts and runs it on save/discard (cancel aborts).
  const guardedOpen = (): Promise<void> =>
    guardDiscard(useRequestStore.getState().tabs, () => openWorkspace())
  const guardedOpenRecent = (path: string): Promise<void> =>
    guardDiscard(useRequestStore.getState().tabs, () => openRecentWorkspace(path))
  const guardedClose = (): void => {
    void guardDiscard(useRequestStore.getState().tabs, async () => closeWorkspace())
  }

  const [pendingRootCreate, setPendingRootCreate] = useState<'collection' | 'request' | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const handleNewCollection = (): void => {
    setPendingRootCreate('collection')
  }

  const handleNewRequest = (): void => {
    setPendingRootCreate('request')
  }

  const handleImportSchema = (): void => {
    if (!workspacePath || !requestsRoot) return
    const { selectedPath, selectedType } = useTreeSelectionStore.getState()
    // Import into the folder the user is positioned on (or the parent of the
    // selected request); fall back to the user-tree root. Never the workspace
    // meta-root — schemas should not become siblings of `environments/`.
    const targetFolder = resolveTargetFolder(requestsRoot, selectedPath, selectedType)
    const targetLabel =
      (targetFolder === requestsRoot ? workspacePath : targetFolder).split(/[/\\]/).pop() ??
      targetFolder
    const envState = useEnvironmentStore.getState()
    const activeEnvId = envState.activeEnvironmentId
    const activeEnvName =
      activeEnvId === null
        ? null
        : (envState.environments.find((e) => e.id === activeEnvId)?.name ?? null)
    useSchemaImportStore.getState().open({
      targetFolder,
      targetLabel,
      activeEnvId,
      activeEnvName
    })
  }

  // Listen to app-level events (e.g. from the native menu)
  useEffect(() => {
    const onNewCollection = (): void => handleNewCollection()
    window.addEventListener('app:newCollection', onNewCollection)
    return () => window.removeEventListener('app:newCollection', onNewCollection)
  }, [])

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* Workspace selector header */}
      <WorkspaceHeader
        workspacePath={workspacePath}
        recentWorkspaces={recentWorkspaces}
        isLoading={isLoading}
        onOpen={guardedOpen}
        onOpenRecent={guardedOpenRecent}
        onClose={guardedClose}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <WorkspaceSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Collections header + quick actions (only when a workspace is open) */}
      <div
        className={cn(
          'flex h-9 shrink-0 items-center border-b border-border',
          !workspacePath && 'hidden'
        )}
      >
        <span className="flex-1 self-stretch px-3 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">
          {t('sidebar.tabCollections')}
        </span>

        {workspacePath && (
          <div className="flex shrink-0 items-center gap-0.5 pr-1">
            <button
              title={t('sidebar.newCollection')}
              onClick={handleNewCollection}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
            <button
              title={t('sidebar.newRequest')}
              onClick={handleNewRequest}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <FilePlus className="h-3.5 w-3.5" />
            </button>
            <button
              title={t('sidebar.importSchema')}
              onClick={handleImportSchema}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <FileDown className="h-3.5 w-3.5" />
            </button>
            <button
              title={t('sidebar.expandAll')}
              onClick={() => useTreeStateStore.getState().expandAll()}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </button>
            <button
              title={t('sidebar.collapseAll')}
              onClick={() => useTreeStateStore.getState().collapseAll()}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Panel content */}
      {!workspacePath ? (
        <WorkspaceCallToAction
          isLoading={isLoading}
          recentWorkspaces={recentWorkspaces}
          onOpen={guardedOpen}
          onOpenRecent={guardedOpenRecent}
        />
      ) : (
        <CollectionTree
          pendingRootCreate={pendingRootCreate}
          onClearRootCreate={() => setPendingRootCreate(null)}
        />
      )}
    </div>
  )
}
