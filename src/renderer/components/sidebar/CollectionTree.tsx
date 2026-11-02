import { useEffect, useState, useRef, createContext, useContext, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, FolderOpen, FileText, FlaskConical, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  INSTANCE_SUFFIX,
  instanceDisplayName,
  instanceFileName,
  isInstanceFileName,
  isValidInstanceName
} from '../../../shared/lib/request-instances'
import { useWorkspaceStore } from '../../stores/workspace'
import { useRequestStore } from '../../stores/request'
import { tabsAffectedBy } from './tabs-affected'
import { resolveRenameBlur } from './rename-blur'
import { flattenVisible, resolveTreeKey, typeAheadMatch } from './tree-nav'
import { beginRepoint, endRepoint } from '../../lib/repoint-guard'
import { collectAllPaths } from '../../lib/tree-paths'
import { useEnvironmentStore } from '../../stores/environment'
import { useSchemaImportStore } from '../../stores/schemaImport'
import { useTreeSelectionStore, resolveTargetFolder } from '../../stores/treeSelection'
import { useTreeStateStore } from '../../stores/treeState'
import { useToastStore } from '../../stores/toast'
import { firstFreeCopyName, siblingsOf } from '../../lib/name-conflict'
import { useNameAvailability } from '../../hooks/useNameAvailability'
import {
  TREE_INDENT_PX,
  classifyDrop,
  clearDragSource,
  getDragSource,
  guideLeftPx,
  rowPaddingLeftPx,
  setDragSource
} from './tree-dnd'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '../ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import type { NameCheckInput, WorkspaceTree } from '../../../shared/types'

/** Hold a drag over a collapsed folder this long to expand it in place. */
const AUTO_EXPAND_DELAY_MS = 600

/** Absolute paths of every folder node in the tree (used to reconcile expansion state). */
function collectFolderPaths(nodes: WorkspaceTree[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'folder') {
      acc.push(node.path)
      if (node.children) collectFolderPaths(node.children, acc)
    }
  }
  return acc
}

/** Absolute paths of requests that have instance children (expandable like folders). */
function collectExpandableRequestPaths(nodes: WorkspaceTree[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'request' && (node.children?.length ?? 0) > 0) {
      acc.push(node.path)
    } else if (node.type === 'folder' && node.children) {
      collectExpandableRequestPaths(node.children, acc)
    }
  }
  return acc
}

function findNode(nodes: WorkspaceTree[], path: string): WorkspaceTree | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findNode(node.children, path)
      if (found) return found
    }
  }
  return null
}

/** Open tabs the request store currently holds that are affected by `node`. */
function affectedTabs(node: WorkspaceTree): ReturnType<typeof useRequestStore.getState>['tabs'] {
  return tabsAffectedBy(useRequestStore.getState().tabs, node)
}

/**
 * Old→new path mapping for every open tab affected by an in-app rename/move of
 * `node` (REQ open-tab-file-reconciliation): the node itself, instance siblings
 * (from the cascade result), and any child under a moved folder (prefix swap,
 * suffix kept verbatim incl. its leading separator → Windows-safe).
 */
function repointMappings(
  node: WorkspaceTree,
  newPath: string,
  instances: { from: string; to: string }[]
): { oldPath: string; newPath: string }[] {
  const instanceMap = new Map(instances.map((i) => [i.from, i.to]))
  return affectedTabs(node).map((tab) => {
    const fp = tab.filePath as string
    if (fp === node.path) return { oldPath: fp, newPath }
    const moved = instanceMap.get(fp)
    if (moved !== undefined) return { oldPath: fp, newPath: moved }
    return { oldPath: fp, newPath: newPath + fp.slice(node.path.length) }
  })
}

/**
 * Re-point the tabs affected by an in-app rename/move synchronously and register
 * the paths with the repoint guard so the watcher's async tree broadcast can't
 * mis-flag them as removed. Returns a cleanup that lifts the guard once the
 * handler's remaining work (history relinking) has settled.
 */
function followInApp(
  node: WorkspaceTree,
  newPath: string,
  instances: { from: string; to: string }[]
): () => void {
  const mappings = repointMappings(node, newPath, instances)
  if (mappings.length === 0) return () => {}
  const guarded = mappings.flatMap((m) => [m.oldPath, m.newPath])
  beginRepoint(guarded)
  useRequestStore.getState().repointTabs(mappings)
  return () => endRepoint(guarded)
}

// ── Tree context ───────────────────────────────────────────────────────────

interface TreeActions {
  onFileClick: (node: WorkspaceTree) => void
  onFileDoubleClick: (node: WorkspaceTree) => void
  onRenameStart: (node: WorkspaceTree) => void
  onDeleteRequest: (node: WorkspaceTree) => void
  onDuplicate: (node: WorkspaceTree) => void
  onMoveRequest: (node: WorkspaceTree) => void
  onCreateIn: (parentPath: string, type: 'collection' | 'request') => void
  onCreateInstance: (node: WorkspaceTree) => void
  onImportSchemaHere: (node: WorkspaceTree) => void
  onReveal: (node: WorkspaceTree) => void
  onCopyPath: (node: WorkspaceTree) => void
  onCopyRelativePath: (node: WorkspaceTree) => void
  renamingPath: string | null
  onRenameSubmit: (node: WorkspaceTree, newName: string) => void
  onRenameCancel: () => void
  pendingCreate: { type: 'collection' | 'request'; parentPath: string } | null
  onCreateSubmit: (name: string) => void
  onCreateCancel: () => void
  creatingInstancePath: string | null
  onCreateInstanceSubmit: (parentNode: WorkspaceTree, instanceName: string) => void
  onCreateInstanceCancel: () => void
  /** Instance whose row currently hosts the duplicate name input. */
  duplicatingInstancePath: string | null
  onDuplicateInstance: (node: WorkspaceTree) => void
  onDuplicateInstanceSubmit: (sourceNode: WorkspaceTree, instanceName: string) => void
  onDuplicateInstanceCancel: () => void
  onDrop: (sourcePath: string, targetFolder: string) => void
  /** Instance display-names that are siblings of `node` (for duplicate pre-fill). */
  getInstanceSiblingNames: (node: WorkspaceTree, parentStem?: string) => Set<string>
}

/** The folder containing `path` (plain string trim — works for `/` and `\`). */
function parentDirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : path
}

const TreeContext = createContext<TreeActions | null>(null)

function useTree(): TreeActions {
  const ctx = useContext(TreeContext)
  if (!ctx) throw new Error('useTree must be used within TreeContext')
  return ctx
}

// ── Inline input ───────────────────────────────────────────────────────────

interface InlineInputProps {
  initialValue?: string
  placeholder?: string
  depth?: number
  icon?: React.ReactNode
  /**
   * Builds the core availability-check input for the typed name (REQ
   * case-insensitive tree name uniqueness): the verdict comes from the core
   * over IPC — the renderer computes no name rule. When the verdict is
   * `taken` the input shows a conflict state and blocks submit; the boundary
   * rejects it anyway (REQ write-safety), but this surfaces the collision
   * before any write is attempted. Omit to skip inline validation.
   */
  checkInput?: (typedName: string) => NameCheckInput
  onSubmit: (value: string) => void
  onCancel: () => void
}

function InlineInput({
  initialValue = '',
  placeholder,
  depth = 0,
  icon,
  checkInput,
  onSubmit,
  onCancel
}: InlineInputProps): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const handledRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    // When this input opens from a context menu (create/duplicate), Radix's
    // close-time focus teardown runs right after this effect and blurs the
    // input, leaving it floating un-dismissable. Re-grab focus on the next
    // frame, once that teardown has finished. This pairs with the tree menus'
    // `onCloseAutoFocus={preventDefault}` (which stops Radix restoring focus to
    // the trigger) — both are needed: preventDefault removes the competitor, the
    // rAF re-focus survives the teardown blur. (rename replaces the trigger, so
    // it never blurs — the re-focus is a harmless no-op there.)
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  const trimmed = value.trim()
  // An unchanged name is a no-op submit — never checked (the core excludes the
  // element itself anyway; this just avoids the round-trip).
  const availability = useNameAvailability(
    checkInput && trimmed.length > 0 && trimmed !== initialValue ? checkInput(trimmed) : null
  )
  const hasConflict = availability === 'taken'

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (hasConflict) return // keep editing; never submit a colliding name
      handledRef.current = true
      onSubmit(value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handledRef.current = true
      onCancel()
    }
  }

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>): void => {
    if (handledRef.current) return // Enter/Escape already resolved the edit
    // VSCode-style: clicking away commits the change. Focus moving into the text
    // context menu is ignored (the edit survives; focus returns on close); a
    // blank or conflicting name can't be committed → discard.
    switch (
      resolveRenameBlur({
        relatedTarget: e.relatedTarget,
        isEmpty: trimmed.length === 0,
        hasConflict
      })
    ) {
      case 'commit':
        onSubmit(value)
        break
      case 'cancel':
        onCancel()
        break
      // 'ignore' → leave the edit open
    }
  }

  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded px-1 py-0.5"
        style={{ paddingLeft: `${rowPaddingLeftPx(depth)}px` }}
      >
        {/* Chevron-width spacer so the icon/input align with sibling rows. */}
        <span aria-hidden className="w-3.5 shrink-0" />
        {icon}
        <input
          ref={inputRef}
          className={cn(
            'h-5 flex-1 rounded border bg-background px-1 text-xs focus:outline-none',
            hasConflict ? 'border-destructive' : 'border-ring'
          )}
          value={value}
          placeholder={placeholder}
          aria-invalid={hasConflict}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
        />
      </div>
      {hasConflict && (
        <div
          className="px-1 text-[10px] text-destructive"
          style={{ paddingLeft: `${rowPaddingLeftPx(depth) + 14}px` }}
          role="alert"
        >
          {t('collection.nameConflict')}
        </div>
      )}
    </div>
  )
}

// ── Pending create input ───────────────────────────────────────────────────

function PendingCreateInput({ depth }: { depth: number }): React.JSX.Element {
  const { t } = useTranslation()
  const { pendingCreate, onCreateSubmit, onCreateCancel } = useTree()

  if (!pendingCreate) return <></>

  const icon =
    pendingCreate.type === 'collection' ? (
      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    )

  const placeholder =
    pendingCreate.type === 'collection'
      ? t('collection.newCollectionName')
      : t('collection.newRequestName')

  return (
    <InlineInput
      placeholder={placeholder}
      depth={depth}
      icon={icon}
      checkInput={(n) => ({ kind: 'entry', parentPath: pendingCreate.parentPath, name: n })}
      onSubmit={onCreateSubmit}
      onCancel={onCreateCancel}
    />
  )
}

// ── Shared "reveal / copy path" context-menu items ─────────────────────────

/** Reveal-in-file-manager + copy-path items, shared by every node context menu. */
function PathMenuItems({ node }: { node: WorkspaceTree }): React.JSX.Element {
  const { t } = useTranslation()
  const { onReveal, onCopyPath, onCopyRelativePath } = useTree()
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onReveal(node)}>
        {t('collection.contextMenu.reveal')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyPath(node)}>
        {t('collection.contextMenu.copyPath')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyRelativePath(node)}>
        {t('collection.contextMenu.copyRelativePath')}
      </ContextMenuItem>
    </>
  )
}

// ── Tree node ──────────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: WorkspaceTree
  depth: number
  /** Parent request's stem, supplied when rendering an instance child. */
  parentStem?: string
}

function TreeNode({ node, depth, parentStem }: TreeNodeProps): React.JSX.Element {
  const { t } = useTranslation()
  const {
    onFileClick,
    onFileDoubleClick,
    onRenameStart,
    onDeleteRequest,
    onDuplicate,
    onMoveRequest,
    onCreateIn,
    onCreateInstance,
    onImportSchemaHere,
    renamingPath,
    onRenameSubmit,
    onRenameCancel,
    pendingCreate,
    creatingInstancePath,
    onCreateInstanceSubmit,
    onCreateInstanceCancel,
    duplicatingInstancePath,
    onDuplicateInstance,
    onDuplicateInstanceSubmit,
    onDuplicateInstanceCancel,
    onDrop,
    getInstanceSiblingNames
  } = useTree()

  const activeFilePath = useRequestStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.filePath ?? null
  )
  const selectedPath = useTreeSelectionStore((s) => s.selectedPath)
  const focusedPath = useTreeSelectionStore((s) => s.focusedPath)
  const isFocused = focusedPath === node.path

  // A request with instance children is expandable just like a folder.
  const isInstance = node.kind === 'instance'
  const hasInstances = node.kind === 'request' && (node.children?.length ?? 0) > 0
  const isExpandable = node.type === 'folder' || hasInstances

  // Folder / instance-parent expansion is persisted per-workspace in
  // `tree-state.json`. Subscribe to the boolean for this node so only nodes
  // whose state flips re-render.
  const isOpen = useTreeStateStore((s) => (isExpandable ? s.isExpanded(node.path) : true))
  const setIsOpen = useCallback(
    (open: boolean) => useTreeStateStore.getState().setExpanded(node.path, open),
    [node.path]
  )
  const [isDragOver, setIsDragOver] = useState(false)

  const isRenaming = renamingPath === node.path
  const isCreatingHere = node.type === 'folder' && pendingCreate?.parentPath === node.path
  const isActiveFile = node.type === 'file' && activeFilePath === node.path
  const isSelectedFolder = node.type === 'folder' && selectedPath === node.path

  // ── Drag & drop handlers ─────────────────────────────────────────────────
  //
  // Folder wrappers nest, so `dragover`/`drop` must stop propagating: the
  // innermost folder under the pointer is the only drop target. Without this
  // a single drop used to fire one `fs:move` per ancestor (racing renames).

  const expandTimerRef = useRef<number | null>(null)

  const cancelExpandTimer = useCallback((): void => {
    if (expandTimerRef.current !== null) {
      window.clearTimeout(expandTimerRef.current)
      expandTimerRef.current = null
    }
  }, [])

  useEffect(() => cancelExpandTimer, [cancelExpandTimer])

  const handleDragStart = (e: React.DragEvent): void => {
    e.stopPropagation()
    e.dataTransfer.setData('text/plain', node.path)
    e.dataTransfer.effectAllowed = 'move'
    // Mirrored in module state: dataTransfer payloads are unreadable during
    // `dragover`, and the verdict must be known before the drop happens.
    setDragSource(node.path)
  }

  const handleDragEnd = (): void => {
    clearDragSource()
  }

  const handleDragOver = (e: React.DragEvent): void => {
    if (node.type !== 'folder') return
    e.stopPropagation()
    if (classifyDrop(getDragSource(), node.path) !== 'move') {
      // Not calling preventDefault() keeps the no-drop cursor and suppresses
      // the `drop` event entirely (self/descendant targets, same-folder drops).
      setIsDragOver(false)
      cancelExpandTimer()
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
    if (!isOpen && expandTimerRef.current === null) {
      expandTimerRef.current = window.setTimeout(() => {
        expandTimerRef.current = null
        setIsOpen(true)
      }, AUTO_EXPAND_DELAY_MS)
    }
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    // `dragleave` also fires when crossing into a child; only react when the
    // pointer truly left this folder's subtree.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setIsDragOver(false)
    cancelExpandTimer()
  }

  const handleDrop = (e: React.DragEvent): void => {
    if (node.type !== 'folder') return
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    cancelExpandTimer()
    const sourcePath = e.dataTransfer.getData('text/plain') || getDragSource()
    clearDragSource()
    if (sourcePath && classifyDrop(sourcePath, node.path) === 'move') {
      onDrop(sourcePath, node.path)
    }
  }

  // ── Instance (instance) node ───────────────────────────────────────────────

  if (node.type === 'file' && isInstance) {
    const displayName = instanceDisplayName(node.name, new Set(parentStem ? [parentStem] : []))

    if (isRenaming) {
      return (
        <InlineInput
          initialValue={displayName}
          depth={depth}
          icon={<FlaskConical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          checkInput={(n) => ({
            kind: 'entry',
            parentPath: parentDirOf(node.path),
            name: parentStem ? instanceFileName(parentStem, n) : `${n}${INSTANCE_SUFFIX}`,
            selfPath: node.path
          })}
          onSubmit={(val) => {
            const trimmed = val.trim()
            if (!isValidInstanceName(trimmed)) {
              onRenameCancel()
              return
            }
            const fullName = parentStem
              ? instanceFileName(parentStem, trimmed)
              : `${trimmed}${INSTANCE_SUFFIX}`
            onRenameSubmit(node, fullName)
          }}
          onCancel={onRenameCancel}
        />
      )
    }

    // Duplicate renders the name input as a *new row directly below the source*
    // (which stays visible), pre-filled `<name>-copy` and selected. Rendering it
    // over the source's own row read as a rename; a distinct row makes clear a
    // new sibling is being created. Committing writes that sibling.
    return (
      <>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              role="treeitem"
              aria-selected={isFocused}
              tabIndex={isFocused ? 0 : -1}
              data-tree-focused={isFocused ? 'true' : undefined}
              className={cn(
                'relative flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isActiveFile
                  ? 'font-medium text-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground'
              )}
              style={{
                paddingLeft: `${rowPaddingLeftPx(depth)}px`,
                backgroundColor: isActiveFile ? 'var(--primary-tint)' : undefined
              }}
              onClick={() => {
                useTreeSelectionStore.getState().setSelected(node.path, 'file')
                onFileClick(node)
              }}
              onDoubleClick={() => onFileDoubleClick(node)}
              title={node.path}
            >
              {isActiveFile && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0.5 left-0 w-0.5 rounded-full bg-primary"
                />
              )}
              <span aria-hidden className="w-3.5 shrink-0" />
              <FlaskConical
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  isActiveFile ? 'text-primary' : 'text-muted-foreground'
                )}
              />
              <span className="truncate italic">{displayName}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
            <ContextMenuItem onClick={() => onRenameStart(node)}>
              {t('collection.contextMenu.rename')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onDuplicateInstance(node)}>
              {t('collection.contextMenu.duplicate')}
            </ContextMenuItem>
            <PathMenuItems node={node} />
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDeleteRequest(node)}
            >
              {t('collection.contextMenu.delete')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {duplicatingInstancePath === node.path && (
          <InlineInput
            initialValue={firstFreeCopyName(displayName, getInstanceSiblingNames(node, parentStem))}
            placeholder={t('collection.createInstance.placeholder')}
            depth={depth}
            icon={<FlaskConical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            checkInput={(n) => ({ kind: 'instance', parentPath: node.path, instanceName: n })}
            onSubmit={(val) => onDuplicateInstanceSubmit(node, val)}
            onCancel={onDuplicateInstanceCancel}
          />
        )}
      </>
    )
  }

  // ── Request (file) node ───────────────────────────────────────────────────

  if (node.type === 'file') {
    if (isRenaming) {
      return (
        <InlineInput
          initialValue={node.name.replace(/\.http$/, '')}
          depth={depth}
          icon={<FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          checkInput={(n) => ({
            kind: 'entry',
            parentPath: parentDirOf(node.path),
            name: n,
            selfPath: node.path
          })}
          onSubmit={(val) => onRenameSubmit(node, val)}
          onCancel={onRenameCancel}
        />
      )
    }

    const stem = node.name.replace(/\.http$/, '')

    return (
      <>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              role="treeitem"
              aria-selected={isFocused}
              aria-expanded={isExpandable ? isOpen : undefined}
              tabIndex={isFocused ? 0 : -1}
              data-tree-focused={isFocused ? 'true' : undefined}
              draggable
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              className={cn(
                'relative flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isActiveFile
                  ? 'font-medium text-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground'
              )}
              style={{
                paddingLeft: `${rowPaddingLeftPx(depth)}px`,
                backgroundColor: isActiveFile ? 'var(--primary-tint)' : undefined
              }}
              onClick={() => {
                useTreeSelectionStore.getState().setSelected(node.path, 'file')
                onFileClick(node)
              }}
              onDoubleClick={() => onFileDoubleClick(node)}
              title={node.path}
            >
              {isActiveFile && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0.5 left-0 w-0.5 rounded-full bg-primary"
                />
              )}
              {/* Expand chevron when the request has instances; otherwise a
                  chevron-width spacer so labels align with sibling folders. */}
              {hasInstances ? (
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
                    isOpen && 'rotate-90'
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsOpen(!isOpen)
                  }}
                />
              ) : (
                <span aria-hidden className="w-3.5 shrink-0" />
              )}
              <FileText
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  isActiveFile ? 'text-primary' : 'text-muted-foreground'
                )}
              />
              <span className="truncate">{stem}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
            <ContextMenuItem onClick={() => onCreateInstance(node)}>
              {t('collection.contextMenu.createInstance')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onRenameStart(node)}>
              {t('collection.contextMenu.rename')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onDuplicate(node)}>
              {t('collection.contextMenu.duplicate')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onMoveRequest(node)}>
              {t('collection.contextMenu.moveTo')}
            </ContextMenuItem>
            <PathMenuItems node={node} />
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDeleteRequest(node)}
            >
              {t('collection.contextMenu.delete')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {(isOpen || creatingInstancePath === node.path) && (
          <div className="relative">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-border/50"
              style={{ left: `${guideLeftPx(depth)}px` }}
            />
            {creatingInstancePath === node.path && (
              <InlineInput
                placeholder={t('collection.createInstance.placeholder')}
                depth={depth + 1}
                icon={<FlaskConical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                checkInput={(n) => ({ kind: 'instance', parentPath: node.path, instanceName: n })}
                onSubmit={(val) => onCreateInstanceSubmit(node, val)}
                onCancel={onCreateInstanceCancel}
              />
            )}
            {isOpen &&
              node.children?.map((child) => (
                <TreeNode key={child.path} node={child} depth={depth + 1} parentStem={stem} />
              ))}
          </div>
        )}
      </>
    )
  }

  // ── Folder node ──────────────────────────────────────────────────────────

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(isDragOver && 'rounded ring-1 ring-primary ring-inset')}
    >
      {isRenaming ? (
        <InlineInput
          initialValue={node.name}
          depth={depth}
          icon={<Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          checkInput={(n) => ({
            kind: 'entry',
            parentPath: parentDirOf(node.path),
            name: n,
            selfPath: node.path
          })}
          onSubmit={(val) => onRenameSubmit(node, val)}
          onCancel={onRenameCancel}
        />
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              role="treeitem"
              aria-selected={isFocused}
              aria-expanded={isOpen}
              tabIndex={isFocused ? 0 : -1}
              data-tree-focused={isFocused ? 'true' : undefined}
              draggable
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isSelectedFolder
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground'
              )}
              style={{ paddingLeft: `${rowPaddingLeftPx(depth)}px` }}
              onClick={() => {
                useTreeSelectionStore.getState().setSelected(node.path, 'folder')
                setIsOpen(!isOpen)
              }}
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
                  isOpen && 'rotate-90'
                )}
              />
              {isOpen ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
            <ContextMenuItem
              onClick={() => {
                setIsOpen(true)
                onCreateIn(node.path, 'request')
              }}
            >
              {t('collection.contextMenu.newRequest')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                setIsOpen(true)
                onCreateIn(node.path, 'collection')
              }}
            >
              {t('collection.contextMenu.newCollection')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onImportSchemaHere(node)}>
              {t('collection.contextMenu.importSchemaHere')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onRenameStart(node)}>
              {t('collection.contextMenu.rename')}
            </ContextMenuItem>
            <PathMenuItems node={node} />
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDeleteRequest(node)}
            >
              {t('collection.contextMenu.delete')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      {isOpen && (
        <div className="relative">
          {/* Indent guide: one continuous line per expanded folder, centered
              under this folder's chevron column. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-border/50"
            style={{ left: `${guideLeftPx(depth)}px` }}
          />
          {node.children?.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
          {isCreatingHere && <PendingCreateInput depth={depth + 1} />}
        </div>
      )}
    </div>
  )
}

// ── Delete confirmation modal ──────────────────────────────────────────────

interface DeleteModalProps {
  node: WorkspaceTree
  historyCount: number
  onConfirm: (alsoDeleteHistory: boolean) => void
  onCancel: () => void
}

function DeleteModal({
  node,
  historyCount,
  onConfirm,
  onCancel
}: DeleteModalProps): React.JSX.Element {
  const { t } = useTranslation()
  const message =
    node.type === 'folder'
      ? t('collection.delete.confirmFolder', { name: node.name })
      : t('collection.delete.confirmFile', { name: node.name })
  const instanceCount = node.kind === 'request' ? (node.children?.length ?? 0) : 0

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('collection.delete.title')}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
          {instanceCount > 0 && (
            <DialogDescription>
              {t('collection.delete.instancesWarning', {
                count: instanceCount
              })}
            </DialogDescription>
          )}
          {historyCount > 0 && (
            <DialogDescription>
              {t('collection.delete.historyWarning', { count: historyCount })}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onCancel}
          >
            {t('collection.delete.cancel')}
          </button>
          {historyCount > 0 && (
            <button
              type="button"
              className="rounded border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onConfirm(false)}
            >
              {t('collection.delete.confirm')}
            </button>
          )}
          <button
            type="button"
            className="rounded bg-destructive px-3 py-1.5 text-xs text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => onConfirm(historyCount > 0)}
          >
            {historyCount > 0
              ? t('collection.delete.confirmWithHistory')
              : t('collection.delete.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Move to modal ──────────────────────────────────────────────────────────

interface MoveToModalProps {
  rootPath: string
  tree: WorkspaceTree[]
  excludePath: string
  onConfirm: (targetFolder: string) => void
  onCancel: () => void
}

function collectFolders(
  nodes: WorkspaceTree[],
  excludePath: string,
  result: { path: string; label: string; depth: number }[],
  depth = 0
): void {
  for (const node of nodes) {
    if (node.type === 'folder' && node.path !== excludePath) {
      result.push({ path: node.path, label: node.name, depth })
      if (node.children) {
        collectFolders(node.children, excludePath, result, depth + 1)
      }
    }
  }
}

function MoveToModal({
  rootPath,
  tree,
  excludePath,
  onConfirm,
  onCancel
}: MoveToModalProps): React.JSX.Element {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string>(rootPath)

  const folders: { path: string; label: string; depth: number }[] = [
    { path: rootPath, label: t('collection.moveTo.root'), depth: 0 }
  ]
  collectFolders(tree, excludePath, folders)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('collection.moveTo.title')}</DialogTitle>
        </DialogHeader>
        <div className="max-h-48 overflow-y-auto rounded border bg-surface-2 p-1">
          {folders.map((f) => (
            <button
              key={f.path}
              type="button"
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                selected === f.path
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground'
              )}
              style={{ paddingLeft: `${f.depth * TREE_INDENT_PX + 8}px` }}
              onClick={() => setSelected(f.path)}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{f.label}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onCancel}
          >
            {t('collection.moveTo.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => onConfirm(selected)}
          >
            {t('collection.moveTo.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── CollectionTree ─────────────────────────────────────────────────────────

export interface CollectionTreeProps {
  /** When non-null, opens the create-at-root flow for the given type. The parent owns the state. */
  pendingRootCreate?: 'collection' | 'request' | null
  /** Called when the create-at-root flow is dismissed (submitted or cancelled). */
  onClearRootCreate?: () => void
}

export function CollectionTree({
  pendingRootCreate,
  onClearRootCreate
}: CollectionTreeProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  // `requestsRoot` = `<workspace>/requests/`. The user-file tree lives here;
  // workspacePath itself also contains `.fetchpier/`, `environments/`, etc.
  const requestsRoot = useWorkspaceStore((s) => s.requestsRoot)
  const openTab = useRequestStore((s) => s.openTab)
  const openPreviewTab = useRequestStore((s) => s.openPreviewTab)
  const promoteTab = useRequestStore((s) => s.promoteTab)
  const closeTab = useRequestStore((s) => s.closeTab)
  const setActiveTab = useRequestStore((s) => s.setActiveTab)

  const [tree, setTree] = useState<WorkspaceTree[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Reset tree synchronously when workspace changes — avoids flashing stale
  // entries before the watcher re-populates. Using the "prev-prop" pattern so
  // there's no extra effect just for state cleanup.
  const [prevWorkspacePath, setPrevWorkspacePath] = useState(workspacePath)
  if (prevWorkspacePath !== workspacePath) {
    setPrevWorkspacePath(workspacePath)
    setTree([])
    setIsLoading(Boolean(workspacePath))
    useTreeSelectionStore.getState().clear()
  }

  const [isRootDragOver, setIsRootDragOver] = useState(false)

  // ── CRUD state ──────────────────────────────────────────────────────────
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [deletingNode, setDeletingNode] = useState<WorkspaceTree | null>(null)
  const [deletingHistoryCount, setDeletingHistoryCount] = useState(0)
  const [movingNode, setMovingNode] = useState<WorkspaceTree | null>(null)
  const [creatingInstancePath, setCreatingInstancePath] = useState<string | null>(null)
  const [duplicatingInstancePath, setDuplicatingInstancePath] = useState<string | null>(null)
  const [internalPendingCreate, setInternalPendingCreate] = useState<{
    type: 'collection' | 'request'
    parentPath: string
  } | null>(null)

  const selectedPath = useTreeSelectionStore((s) => s.selectedPath)
  const selectedType = useTreeSelectionStore((s) => s.selectedType)
  const focusedPath = useTreeSelectionStore((s) => s.focusedPath)

  // Roving-focus plumbing: the scroll container is the keyboard host; a type-ahead
  // buffer accumulates printable keystrokes within a short window.
  const containerRef = useRef<HTMLDivElement>(null)
  const typeAheadRef = useRef<{ prefix: string; timer: number | null }>({
    prefix: '',
    timer: null
  })

  // Effective create state: internal flows (right-click → "Create here") take
  // precedence; otherwise the toolbar trigger creates inside the selected folder
  // (or the parent of the selected request), falling back to the requests root.
  const pendingCreate = useMemo(
    () =>
      internalPendingCreate ??
      (pendingRootCreate && requestsRoot
        ? {
            type: pendingRootCreate,
            parentPath: resolveTargetFolder(requestsRoot, selectedPath, selectedType)
          }
        : null),
    [internalPendingCreate, pendingRootCreate, requestsRoot, selectedPath, selectedType]
  )

  const clearPendingCreate = useCallback((): void => {
    setInternalPendingCreate(null)
    onClearRootCreate?.()
  }, [onClearRootCreate])

  // ── Load tree ───────────────────────────────────────────────────────────
  // `isLoading` is set to `true` synchronously in the workspace-path transition
  // above; the effect only owns the actual IO + the watcher subscription.
  useEffect(() => {
    if (!workspacePath) return

    let cancelled = false

    const applyTree = (next: WorkspaceTree[]): void => {
      setTree(next)
      // Seed (first run) or prune stale entries against folders + instance parents.
      useTreeStateStore
        .getState()
        .reconcile(collectFolderPaths(next), collectExpandableRequestPaths(next))
      // Drop a selection whose node is gone (external delete, move, rename) so it
      // can't drive create/import into a path that no longer exists.
      useTreeSelectionStore.getState().reconcile(collectAllPaths(next))
    }

    const load = async (): Promise<void> => {
      try {
        const result = await window.api.filesystem.readTree()
        if (!cancelled) applyTree(result)
      } catch (err) {
        console.error('[CollectionTree] Failed to read tree:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()

    const unsubscribe = window.api.filesystem.onChange((updatedTree) => {
      if (!cancelled) applyTree(updatedTree)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [workspacePath])

  // ── Handlers ────────────────────────────────────────────────────────────

  // REQ-0085: a single click opens the request in the ephemeral preview slot.
  const handleFileClick = useCallback(
    (node: WorkspaceTree): void => {
      openPreviewTab({
        title: node.name.replace(/\.http$/, ''),
        filePath: node.path
      })
    },
    [openPreviewTab]
  )

  // REQ-0085: a double click opens (or promotes) the request to a permanent tab.
  // The preceding single click already created the preview, so this promotes it;
  // the openTab fallback covers any path with no tab yet.
  const handleFileDoubleClick = useCallback(
    (node: WorkspaceTree): void => {
      const existing = useRequestStore.getState().tabs.find((t) => t.filePath === node.path)
      if (existing) {
        promoteTab(existing.id)
        setActiveTab(existing.id)
        return
      }
      openTab({ title: node.name.replace(/\.http$/, ''), filePath: node.path })
    },
    [openTab, promoteTab, setActiveTab]
  )

  const handleRenameStart = useCallback((node: WorkspaceTree): void => {
    setRenamingPath(node.path)
  }, [])

  const handleRenameCancel = useCallback((): void => {
    setRenamingPath(null)
  }, [])

  /** Close the open tab backing `filePath`, if any. */
  const closeTabForPath = useCallback(
    (filePath: string): void => {
      const existing = useRequestStore.getState().tabs.find((tab) => tab.filePath === filePath)
      if (existing) closeTab(existing.id)
    },
    [closeTab]
  )

  /** Normalise an absolute path to a workspace-relative forward-slash path. */
  const toRelPath = useCallback(
    (absPath: string): string => {
      if (!workspacePath) return absPath.replace(/\\/g, '/')
      if (absPath.startsWith(workspacePath)) {
        return absPath
          .slice(workspacePath.length)
          .replace(/^[/\\]/, '')
          .replace(/\\/g, '/')
      }
      return absPath.replace(/\\/g, '/')
    },
    [workspacePath]
  )

  const handleRenameSubmit = useCallback(
    async (node: WorkspaceTree, newName: string): Promise<void> => {
      const trimmed = newName.trim()
      const finalName =
        node.type === 'file' && trimmed && !trimmed.endsWith('.http') ? `${trimmed}.http` : trimmed

      setRenamingPath(null)

      if (!finalName || finalName === node.name) return

      // REQ open-tab-file-reconciliation: the open tab FOLLOWS an in-app rename —
      // re-point it (keeping unsaved edits), no prompt, no close.
      try {
        const { newPath, instances } = await window.api.filesystem.rename(node.path, finalName)
        // Re-point synchronously, before the history awaits, so the watcher's async
        // broadcast resolves to a no-op for these tabs (never a removed-on-disk flag).
        const lift = followInApp(node, newPath, instances)
        try {
          // Keep history entries linked to the renamed file/folder (+ instances).
          if (workspacePath) {
            await window.api.history.updateSourceFile(
              toRelPath(node.path),
              toRelPath(newPath),
              node.type === 'folder'
            )
            for (const { from, to } of instances) {
              await window.api.history
                .updateSourceFile(toRelPath(from), toRelPath(to), false)
                .catch(console.error)
            }
          }
        } finally {
          lift()
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('REQUEST_NAME_CONFLICT') || msg.includes('COLLECTION_NAME_CONFLICT')) {
          useToastStore.getState().push(
            t('collection.errors.nameConflict', {
              name: finalName.replace(/\.http$/, '')
            }),
            { type: 'error' }
          )
        } else {
          console.error('[CollectionTree] Failed to rename:', err)
        }
      }
    },
    [workspacePath, toRelPath, t]
  )

  const handleDeleteRequest = useCallback(
    async (node: WorkspaceTree): Promise<void> => {
      setDeletingNode(node)
      if (workspacePath) {
        try {
          const count = await window.api.history.countForPath(
            toRelPath(node.path),
            node.type === 'folder'
          )
          setDeletingHistoryCount(count)
        } catch {
          setDeletingHistoryCount(0)
        }
      } else {
        setDeletingHistoryCount(0)
      }
    },
    [workspacePath, toRelPath]
  )

  const handleDeleteConfirm = useCallback(
    async (alsoDeleteHistory: boolean): Promise<void> => {
      if (!deletingNode) return
      const node = deletingNode
      setDeletingNode(null)
      setDeletingHistoryCount(0)
      try {
        const { deletedInstances } = await window.api.filesystem.delete(node.path)
        // Don't let a selection pointing at the deleted node (or inside it) drive
        // the next create/import into a path that will be recreated on disk.
        useTreeSelectionStore.getState().clearIfWithin(node.path)
        if (alsoDeleteHistory && workspacePath) {
          await window.api.history
            .deleteForPath(toRelPath(node.path), node.type === 'folder')
            .catch(console.error)
          for (const instancePath of deletedInstances) {
            await window.api.history
              .deleteForPath(toRelPath(instancePath), false)
              .catch(console.error)
          }
        }
        // REQ open-tab-file-reconciliation: an in-app delete CLOSES every affected
        // open tab — the file itself, instance siblings, AND the children of a
        // deleted folder (previously left stale, which a later save resurrected).
        const closed = new Set<string>()
        for (const tab of affectedTabs(node)) {
          closeTab(tab.id)
          if (tab.filePath) closed.add(tab.filePath)
        }
        // Cover any instance the cascade reported that had no open tab matched
        // above (defensive; affectedTabs already matches instance siblings).
        for (const instancePath of deletedInstances) {
          if (!closed.has(instancePath)) closeTabForPath(instancePath)
        }
      } catch (err) {
        console.error('[CollectionTree] Failed to delete:', err)
      }
    },
    [deletingNode, closeTab, closeTabForPath, workspacePath, toRelPath]
  )

  const handleDuplicate = useCallback(
    async (node: WorkspaceTree): Promise<void> => {
      try {
        await window.api.filesystem.duplicate(node.path)
      } catch (err) {
        // A failed duplicate used to be console-only: no new node, no reason.
        console.error('[CollectionTree] Failed to duplicate:', err)
        useToastStore.getState().push(t('collection.errors.duplicate'), { type: 'error' })
      }
    },
    [t]
  )

  const handleMoveRequest = useCallback((node: WorkspaceTree): void => {
    setMovingNode(node)
  }, [])

  /** Map an `fs:move` rejection to a user-facing message via its MOVE_* token. */
  const describeMoveError = useCallback(
    (err: unknown, sourcePath: string): string => {
      const name = (sourcePath.split(/[\\/]/).pop() ?? sourcePath).replace(/\.http$/, '')
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('MOVE_CONFLICT')) return t('collection.errors.moveConflict', { name })
      if (msg.includes('MOVE_INTO_SELF')) return t('collection.errors.moveIntoItself')
      return t('collection.errors.move')
    },
    [t]
  )

  const handleMoveConfirm = useCallback(
    async (targetFolder: string): Promise<void> => {
      if (!movingNode) return
      const node = movingNode
      setMovingNode(null)
      // REQ open-tab-file-reconciliation: the open tab(s) FOLLOW an in-app move.
      try {
        const { newPath, instances } = await window.api.filesystem.move(node.path, targetFolder)
        const lift = followInApp(node, newPath, instances)
        try {
          // Keep history entries linked after the move (+ instances).
          if (workspacePath) {
            await window.api.history.updateSourceFile(
              toRelPath(node.path),
              toRelPath(newPath),
              node.type === 'folder'
            )
            for (const { from, to } of instances) {
              await window.api.history
                .updateSourceFile(toRelPath(from), toRelPath(to), false)
                .catch(console.error)
            }
          }
        } finally {
          lift()
        }
      } catch (err) {
        console.error('[CollectionTree] Failed to move:', err)
        useToastStore.getState().push(describeMoveError(err, node.path), { type: 'error' })
      }
    },
    [movingNode, workspacePath, toRelPath, describeMoveError]
  )

  const handleCreateIn = useCallback((parentPath: string, type: 'collection' | 'request'): void => {
    setInternalPendingCreate({ type, parentPath })
  }, [])

  const handleCreateSubmit = useCallback(
    async (name: string): Promise<void> => {
      if (!pendingCreate) return
      const trimmed = name.trim()
      const saved = pendingCreate
      clearPendingCreate()
      if (!trimmed) return

      try {
        if (saved.type === 'collection') {
          await window.api.filesystem.createCollection(saved.parentPath, trimmed)
        } else {
          const filePath = await window.api.filesystem.createRequest(saved.parentPath, trimmed)
          openTab({ title: trimmed.replace(/\.http$/, ''), filePath })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('REQUEST_NAME_CONFLICT') || msg.includes('COLLECTION_NAME_CONFLICT')) {
          useToastStore.getState().push(t('collection.errors.nameConflict', { name: trimmed }), {
            type: 'error'
          })
        } else {
          console.error('[CollectionTree] Failed to create:', err)
        }
      }
    },
    [pendingCreate, openTab, clearPendingCreate, t]
  )

  const handleCreateCancel = useCallback((): void => {
    clearPendingCreate()
  }, [clearPendingCreate])

  // ── Create instance ────────────────────────────────────────────────────────

  const handleCreateInstance = useCallback((node: WorkspaceTree): void => {
    // Expand the parent so the inline input (and the new instance) is visible.
    useTreeStateStore.getState().setExpanded(node.path, true)
    setCreatingInstancePath(node.path)
  }, [])

  const handleCreateInstanceCancel = useCallback((): void => {
    setCreatingInstancePath(null)
  }, [])

  const handleCreateInstanceSubmit = useCallback(
    async (parentNode: WorkspaceTree, instanceName: string): Promise<void> => {
      const trimmed = instanceName.trim()
      setCreatingInstancePath(null)
      if (!trimmed) return
      if (!isValidInstanceName(trimmed)) {
        useToastStore.getState().push(t('collection.errors.invalidInstanceName'), { type: 'error' })
        return
      }
      try {
        const filePath = await window.api.filesystem.createInstance(parentNode.path, trimmed)
        useTreeStateStore.getState().setExpanded(parentNode.path, true)
        openTab({ title: trimmed, filePath })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('INSTANCE_NAME_CONFLICT')) {
          useToastStore
            .getState()
            .push(t('collection.errors.instanceConflict', { name: trimmed }), {
              type: 'error'
            })
        } else if (msg.includes('INVALID_INSTANCE_NAME')) {
          useToastStore.getState().push(t('collection.errors.invalidInstanceName'), {
            type: 'error'
          })
        } else {
          console.error('[CollectionTree] Failed to create instance:', err)
          useToastStore.getState().push(t('collection.errors.createInstance'), { type: 'error' })
        }
      }
    },
    [openTab, t]
  )

  // ── Duplicate instance ─────────────────────────────────────────────────────

  const handleDuplicateInstance = useCallback((node: WorkspaceTree): void => {
    setDuplicatingInstancePath(node.path)
  }, [])

  const handleDuplicateInstanceCancel = useCallback((): void => {
    setDuplicatingInstancePath(null)
  }, [])

  const handleDuplicateInstanceSubmit = useCallback(
    async (sourceNode: WorkspaceTree, instanceName: string): Promise<void> => {
      const trimmed = instanceName.trim()
      setDuplicatingInstancePath(null)
      if (!trimmed) return // blank = discard, same as every inline input
      if (!isValidInstanceName(trimmed)) {
        useToastStore.getState().push(t('collection.errors.invalidInstanceName'), { type: 'error' })
        return
      }
      try {
        const filePath = await window.api.filesystem.duplicateInstance(sourceNode.path, trimmed)
        // The parent is already expanded — the source row could not have been
        // right-clicked otherwise — so the copy lands visible beside it.
        openTab({ title: trimmed, filePath })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('INSTANCE_NAME_CONFLICT')) {
          useToastStore
            .getState()
            .push(t('collection.errors.instanceConflict', { name: trimmed }), {
              type: 'error'
            })
        } else if (msg.includes('INVALID_INSTANCE_NAME')) {
          useToastStore.getState().push(t('collection.errors.invalidInstanceName'), {
            type: 'error'
          })
        } else {
          console.error('[CollectionTree] Failed to duplicate instance:', err)
          useToastStore.getState().push(t('collection.errors.duplicate'), { type: 'error' })
        }
      }
    },
    [openTab, t]
  )

  const handleImportSchemaHere = useCallback((node: WorkspaceTree): void => {
    const envState = useEnvironmentStore.getState()
    const activeEnvId = envState.activeEnvironmentId
    const activeEnvName =
      activeEnvId === null
        ? null
        : (envState.environments.find((e) => e.id === activeEnvId)?.name ?? null)
    useSchemaImportStore.getState().open({
      targetFolder: node.path,
      targetLabel: node.name,
      activeEnvId,
      activeEnvName
    })
  }, [])

  // ── Reveal in OS + copy path ────────────────────────────────────────────────

  const handleReveal = useCallback(
    (node: WorkspaceTree): void => {
      window.api.shell.revealPath(node.path).catch((err) => {
        console.error('[CollectionTree] Failed to reveal:', err)
        useToastStore.getState().push(t('collection.errors.reveal'), { type: 'error' })
      })
    },
    [t]
  )

  const handleCopyPath = useCallback((node: WorkspaceTree): void => {
    void navigator.clipboard.writeText(node.path).catch(console.error)
  }, [])

  const handleCopyRelativePath = useCallback(
    (node: WorkspaceTree): void => {
      void navigator.clipboard.writeText(toRelPath(node.path)).catch(console.error)
    },
    [toRelPath]
  )

  const handleDropOnNode = useCallback(
    async (sourcePath: string, targetFolder: string): Promise<void> => {
      // REQ open-tab-file-reconciliation: a drag-and-drop move makes the open
      // tab(s) FOLLOW the file (incl. instances), just like "Move to…".
      const sourceNode = findNode(tree, sourcePath)
      try {
        const { newPath, instances } = await window.api.filesystem.move(sourcePath, targetFolder)
        const lift = sourceNode ? followInApp(sourceNode, newPath, instances) : () => {}
        try {
          // Keep history entries linked after the move (parity with Move to…)
          if (workspacePath) {
            await window.api.history.updateSourceFile(
              toRelPath(sourcePath),
              toRelPath(newPath),
              sourceNode?.type === 'folder'
            )
            for (const { from, to } of instances) {
              await window.api.history
                .updateSourceFile(toRelPath(from), toRelPath(to), false)
                .catch(console.error)
            }
          }
        } finally {
          lift()
        }
      } catch (err) {
        console.error('[CollectionTree] Failed to drop-move:', err)
        useToastStore.getState().push(describeMoveError(err, sourcePath), { type: 'error' })
      }
    },
    [workspacePath, toRelPath, tree, describeMoveError]
  )

  // Inline name-conflict verdicts come from the core over IPC (InlineInput's
  // `checkInput` + `useNameAvailability`) — the renderer computes no name rule
  // (REQ case-insensitive tree name uniqueness). Only the duplicate pre-fill
  // below still derives display names from the tree (a suggestion, not a verdict).

  const getInstanceSiblingNames = useCallback(
    (node: WorkspaceTree, parentStem?: string): Set<string> => {
      // Siblings of a grouped instance are its parent request's children; of an
      // orphan, the top-level nodes. Both bind to the same stem, so a single-stem
      // set drives the display-name derivation.
      const stems = new Set(parentStem ? [parentStem] : [])
      return new Set(
        siblingsOf(tree, node)
          .filter((s) => s.path !== node.path && isInstanceFileName(s.name))
          .map((s) => instanceDisplayName(s.name, stems))
      )
    },
    [tree]
  )

  // ── Keyboard navigation (roving focus + type-ahead) ─────────────────────────

  // Move DOM focus to the keyboard-focused row, but only when the tree already
  // holds focus — never steal focus from the editor on a background tree update.
  useEffect(() => {
    if (!focusedPath) return
    const container = containerRef.current
    if (!container || !container.contains(document.activeElement)) return
    const el = container.querySelector('[data-tree-focused="true"]') as HTMLElement | null
    if (el) {
      el.focus()
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedPath, tree])

  const handleTreeKeyDown = (e: React.KeyboardEvent): void => {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    // An inline rename/create/duplicate input owns the keyboard while it is open.
    if (renamingPath || pendingCreate || creatingInstancePath || duplicatingInstancePath) return
    // Tab-switch / global chords are not tree navigation.
    if (e.ctrlKey || e.metaKey || e.altKey) return

    const visible = flattenVisible(tree, (p) => useTreeStateStore.getState().isExpanded(p))
    if (visible.length === 0) return
    const focused = useTreeSelectionStore.getState().focusedPath

    // Type-ahead: a single printable character jumps to the next matching node.
    if (e.key.length === 1) {
      e.preventDefault()
      const ta = typeAheadRef.current
      if (ta.timer !== null) window.clearTimeout(ta.timer)
      ta.prefix = ta.prefix === e.key ? e.key : ta.prefix + e.key
      ta.timer = window.setTimeout(() => {
        ta.prefix = ''
        ta.timer = null
      }, 600)
      const match = typeAheadMatch(visible, focused, ta.prefix)
      if (match) useTreeSelectionStore.getState().setFocused(match)
      return
    }

    const intent = resolveTreeKey(visible, focused, e.key)
    if (!intent) return
    e.preventDefault()
    switch (intent.type) {
      case 'focus':
        useTreeSelectionStore.getState().setFocused(intent.path)
        break
      case 'setExpanded':
        useTreeStateStore.getState().setExpanded(intent.path, intent.open)
        break
      case 'open': {
        const node = findNode(tree, intent.path)
        if (node) handleFileClick(node)
        break
      }
      case 'rename':
        setRenamingPath(intent.path)
        break
      case 'delete': {
        const node = findNode(tree, intent.path)
        if (node) void handleDeleteRequest(node)
        break
      }
    }
  }

  // ── Context value ────────────────────────────────────────────────────────

  const actions: TreeActions = {
    onFileClick: handleFileClick,
    onFileDoubleClick: handleFileDoubleClick,
    onRenameStart: handleRenameStart,
    onDeleteRequest: handleDeleteRequest,
    onDuplicate: handleDuplicate,
    onMoveRequest: handleMoveRequest,
    onCreateIn: handleCreateIn,
    onCreateInstance: handleCreateInstance,
    onImportSchemaHere: handleImportSchemaHere,
    onReveal: handleReveal,
    onCopyPath: handleCopyPath,
    onCopyRelativePath: handleCopyRelativePath,
    renamingPath,
    onRenameSubmit: handleRenameSubmit,
    onRenameCancel: handleRenameCancel,
    pendingCreate,
    onCreateSubmit: handleCreateSubmit,
    onCreateCancel: handleCreateCancel,
    creatingInstancePath,
    onCreateInstanceSubmit: handleCreateInstanceSubmit,
    onCreateInstanceCancel: handleCreateInstanceCancel,
    duplicatingInstancePath,
    onDuplicateInstance: handleDuplicateInstance,
    onDuplicateInstanceSubmit: handleDuplicateInstanceSubmit,
    onDuplicateInstanceCancel: handleDuplicateInstanceCancel,
    onDrop: handleDropOnNode,
    getInstanceSiblingNames
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const isCreatingAtRoot = pendingCreate?.parentPath === requestsRoot

  // Folder nodes stop dragover/drop propagation, so these only see drags over
  // root-level files and the empty area below the tree — i.e. "drop at root".
  const handleRootDragOver = (e: React.DragEvent): void => {
    if (!requestsRoot) return
    if (classifyDrop(getDragSource(), requestsRoot) !== 'move') {
      setIsRootDragOver(false)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsRootDragOver(true)
  }

  const handleRootDragLeave = (e: React.DragEvent): void => {
    // Only clear if leaving the root container entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsRootDragOver(false)
    }
  }

  const handleRootDrop = (e: React.DragEvent): void => {
    if (!requestsRoot) return
    e.preventDefault()
    setIsRootDragOver(false)
    const sourcePath = e.dataTransfer.getData('text/plain') || getDragSource()
    clearDragSource()
    if (sourcePath && classifyDrop(sourcePath, requestsRoot) === 'move') {
      handleDropOnNode(sourcePath, requestsRoot).catch(console.error)
    }
  }

  return (
    <TreeContext.Provider value={actions}>
      <div
        ref={containerRef}
        role="tree"
        aria-label={t('sidebar.tabCollections')}
        // Single tab stop: the container until a row takes focus, then the focused
        // row (roving tabindex). focus:outline-none — the row's own ring is the cue.
        tabIndex={focusedPath ? -1 : 0}
        onKeyDown={handleTreeKeyDown}
        className={cn(
          'flex-1 overflow-y-auto p-1 focus:outline-none',
          isRootDragOver && 'ring-1 ring-inset ring-primary rounded'
        )}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        {tree.length === 0 && !isCreatingAtRoot && (
          <div className="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center text-muted-foreground">
            <p className="text-xs">{t('sidebar.noFiles')}</p>
          </div>
        )}
        {tree.map((node) => (
          <TreeNode key={node.path} node={node} depth={0} />
        ))}
        {isCreatingAtRoot && <PendingCreateInput depth={0} />}
      </div>

      {deletingNode && (
        <DeleteModal
          node={deletingNode}
          historyCount={deletingHistoryCount}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeletingNode(null)}
        />
      )}

      {movingNode && requestsRoot && (
        <MoveToModal
          rootPath={requestsRoot}
          tree={tree}
          excludePath={movingNode.path}
          onConfirm={handleMoveConfirm}
          onCancel={() => setMovingNode(null)}
        />
      )}
    </TreeContext.Provider>
  )
}
