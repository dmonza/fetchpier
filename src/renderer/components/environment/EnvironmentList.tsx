import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownAZ, ArrowDownZA, Plus, Search, X } from 'lucide-react'
import type { Environment } from '../../../shared/types'
import { firstFreeEnvCopyName } from '../../../shared/lib/env-folder-name'
import { buildEnvironmentListView, type EnvironmentSortMode } from '../../lib/environment-list-view'
import { cn } from '../../lib/utils'
import { blurLandsInPopupMenu } from '../sidebar/rename-blur'
import { Button } from '../ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

/**
 * The environment-management panel's left-hand list.
 *
 * Row operations are reached the same way the collection tree reaches them —
 * right-click — so keyboard dismissal, focus return and stacking behave
 * identically. Both buttons select the row: opening a menu on an environment
 * whose variables you cannot see is a dead end, so right-click loads it for
 * editing on the way to the menu. Selecting is never *activating* — which
 * environment the next request resolves against is the dropdown's business, not
 * this panel's. The rows carry **no icon in any state**: the hover trash
 * affordance is gone and nothing replaced it.
 *
 * Rename edits the row in place; duplicate opens a *new* row below the source
 * (which stays visible), so it reads as "a new sibling is being created" rather
 * than as a rename. Neither writes anything until the name is confirmed.
 *
 * A toolbar above the rows searches and orders them (A → Z by default, Z → A on
 * request). Both are view state of this panel's session — nothing is written and
 * no environment moves on disk. The model behind it is
 * `renderer/lib/environment-list-view.ts`, which the environment dropdown sorts
 * with too, so the two lists read the same way.
 */
export interface EnvironmentListProps {
  environments: Environment[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Rejects with a token-carrying error when the name is empty or taken. */
  onRename: (envId: string, newName: string) => Promise<unknown>
  /** Rejects with a token-carrying error when the name is empty or taken. */
  onDuplicate: (sourceEnvId: string, newName: string) => Promise<unknown>
  onDelete: (envId: string) => Promise<unknown>
  /** Rejects with a token-carrying error when the name is empty or taken. */
  onCreate: (name: string) => Promise<unknown>
  /**
   * Raised whenever an inline rename/duplicate editor opens or closes.
   *
   * The panel that hosts this list is itself a dialog, and Radix dismisses a
   * dialog from a **capture-phase** `document` listener — which runs before any
   * handler on the input, so the input cannot contain its own Escape. The host
   * uses this to suppress dismissal for the keystroke that closes the editor.
   */
  onInlineEditorOpenChange?: (open: boolean) => void
}

/** The order control's two states, in the order they are offered. */
const SORT_MODES: { mode: EnvironmentSortMode; Icon: typeof ArrowDownAZ; labelKey: string }[] = [
  { mode: 'asc', Icon: ArrowDownAZ, labelKey: 'environment.sort.asc' },
  { mode: 'desc', Icon: ArrowDownZA, labelKey: 'environment.sort.desc' }
]

/** Which inline editor is open, if any. */
type InlineEdit =
  | { kind: 'rename'; envId: string; initial: string }
  | { kind: 'duplicate'; envId: string; initial: string }

/**
 * Map a business-layer rejection onto the message shown where the user is
 * standing. The tokens are the contractual ones raised by the environments
 * domain; anything else falls back to a generic failure.
 */
function errorKeyFor(err: unknown): { key: string; name?: string } {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('ENVIRONMENT_NAME_EMPTY')) {
    return { key: 'environment.errors.nameEmpty' }
  }
  if (msg.includes('ENVIRONMENT_NAME_CONFLICT')) {
    // The token carries `… used by environment "<name>"`.
    const occupant = /environment "([^"]*)"/.exec(msg)?.[1]
    return { key: 'environment.errors.folderConflict', name: occupant }
  }
  if (msg.includes('ENVIRONMENT_NOT_FOUND')) {
    return { key: 'environment.errors.notFound' }
  }
  return { key: 'environment.errors.operationFailed' }
}

interface InlineNameInputProps {
  initialValue: string
  /** Kept mounted with the typed text when the commit is rejected (§6.3). */
  onCommit: (value: string) => void
  onCancel: () => void
  error: string | null
}

/**
 * The inline name editor. Same contract as the collection tree's: focused and
 * selected on open, Enter commits, Escape discards, blur commits, an empty value
 * discards. `handled` guards the blur-after-Enter double fire.
 */
function InlineNameInput({
  initialValue,
  onCommit,
  onCancel,
  error
}: InlineNameInputProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const handledRef = useRef(false)
  /**
   * Blur-commits only after the opening menu's focus teardown has settled. Radix
   * pulls focus off this input while its menu closes; that blur is the menu
   * leaving, not the user, and committing on it would create an environment the
   * user never confirmed.
   */
  const armedRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    // The context menu that opened this input tears its own focus down right
    // after this effect; re-grab focus once that has finished. Mirrors the
    // collection tree's inline input.
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      armedRef.current = true
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // A rejected commit re-opens the gate so the corrected name can be submitted.
  useEffect(() => {
    if (error) handledRef.current = false
  }, [error])

  const commit = (): void => {
    if (handledRef.current) return
    handledRef.current = true
    const trimmed = value.trim()
    if (!trimmed) {
      onCancel()
      return
    }
    onCommit(trimmed)
  }

  return (
    <div className="px-2 py-1">
      <input
        ref={inputRef}
        data-env-inline
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== 'Escape') return
          e.preventDefault()
          // The panel this list lives in is itself a dialog, and Radix dismisses
          // a dialog from a document-level Escape listener. Both keys are fully
          // consumed here so abandoning a rename does not also tear the whole
          // environment editor down.
          e.stopPropagation()
          e.nativeEvent.stopImmediatePropagation()
          if (e.key === 'Enter') {
            commit()
            return
          }
          handledRef.current = true
          onCancel()
        }}
        onBlur={(e) => {
          if (!armedRef.current) return
          // Focus moving into a popup menu (the global text context menu) is not
          // the user leaving the field — focus returns when the menu closes.
          if (blurLandsInPopupMenu(e.relatedTarget)) return
          commit()
        }}
        className={cn(
          'h-7 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring',
          error ? 'border-destructive' : 'border-border-default'
        )}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function EnvironmentList({
  environments,
  selectedId,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
  onCreate,
  onInlineEditorOpenChange
}: EnvironmentListProps): React.JSX.Element {
  const { t } = useTranslation()
  const [edit, setEdit] = useState<InlineEdit | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<EnvironmentSortMode>('asc')

  const takenFolders = new Set(environments.map((e) => e.folder))

  // The row holding an open editor is kept visible whatever the query says: it
  // carries text the user typed and, after a rejection, the error explaining it.
  const visible = useMemo(
    () => buildEnvironmentListView(environments, { query, sort: sortMode, keepId: edit?.envId }),
    [environments, query, sortMode, edit?.envId]
  )

  const openEdit = (next: InlineEdit): void => {
    setEditError(null)
    setEdit(next)
    onInlineEditorOpenChange?.(true)
  }

  const closeEdit = (): void => {
    setEdit(null)
    setEditError(null)
    onInlineEditorOpenChange?.(false)
  }

  /**
   * Run a naming gesture. On rejection the inline field stays open with the text
   * the user typed, so they correct rather than retype (§6.3).
   */
  const runNaming = (
    op: () => Promise<unknown>,
    onReject: (message: string) => void,
    onResolve: () => void
  ): void => {
    op()
      .then(onResolve)
      .catch((err: unknown) => {
        const { key, name } = errorKeyFor(err)
        onReject(name ? t(key, { name }) : t(key))
      })
  }

  const handleRenameStart = (env: Environment): void => {
    openEdit({ kind: 'rename', envId: env.id, initial: env.name })
  }

  const handleDuplicateStart = (env: Environment): void => {
    openEdit({
      kind: 'duplicate',
      envId: env.id,
      // The first free `<name>-copy` — a name that commits cleanly instead of
      // colliding with a copy that already exists.
      initial: firstFreeEnvCopyName(env.name, takenFolders)
    })
  }

  const handleInlineCommit = (value: string): void => {
    if (!edit) return
    const op =
      edit.kind === 'rename'
        ? () => onRename(edit.envId, value)
        : () => onDuplicate(edit.envId, value)
    runNaming(op, setEditError, closeEdit)
  }

  const handleCreate = (): void => {
    const trimmed = newName.trim()
    if (!trimmed) return
    setCreateError(null)
    runNaming(
      () => onCreate(trimmed),
      setCreateError,
      () => setNewName('')
    )
  }

  const handleDeleteConfirm = (): void => {
    const target = deleteTarget
    if (!target) return
    setDeleteTarget(null)
    void onDelete(target.id)
  }

  return (
    <>
      <div className="flex w-48 flex-col border-r border-border bg-surface-2">
        {/* Search + order, on one line. View state only — see the file docblock. */}
        <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              data-env-search
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('environment.search')}
              aria-label={t('environment.search')}
              className="h-7 w-full min-w-0 rounded border border-border-default bg-background pl-7 pr-6 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('environment.searchClear')}
                className="absolute right-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div
            className="flex shrink-0 items-center gap-0.5"
            role="group"
            aria-label={t('environment.sort.label')}
          >
            {SORT_MODES.map(({ mode, Icon, labelKey }) => (
              <button
                key={mode}
                type="button"
                data-env-sort={mode}
                aria-pressed={sortMode === mode}
                title={t(labelKey)}
                aria-label={t(labelKey)}
                onClick={() => setSortMode(mode)}
                className={cn(
                  'flex h-7 w-6 items-center justify-center rounded focus:outline-none focus:ring-1 focus:ring-ring',
                  sortMode === mode
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('environment.noMatches')}</p>
          )}
          {visible.map((env) => (
            <div key={env.id}>
              {edit?.kind === 'rename' && edit.envId === env.id ? (
                <InlineNameInput
                  initialValue={edit.initial}
                  onCommit={handleInlineCommit}
                  onCancel={closeEdit}
                  error={editError}
                />
              ) : (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div
                      data-env-row
                      role="button"
                      tabIndex={0}
                      className={cn(
                        'flex cursor-pointer items-center px-3 py-2 text-xs',
                        selectedId === env.id
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground hover:bg-muted'
                      )}
                      onClick={() => onSelect(env.id)}
                      // Both buttons select. Radix's `asChild` composes this with
                      // the trigger's own handler, so the menu still opens.
                      onContextMenu={() => onSelect(env.id)}
                    >
                      <span className="truncate">{env.name}</span>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
                    <ContextMenuItem onClick={() => handleRenameStart(env)}>
                      {t('environment.contextMenu.rename')}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleDuplicateStart(env)}>
                      {t('environment.contextMenu.duplicate')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setDeleteTarget(env)}
                    >
                      {t('environment.contextMenu.delete')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )}

              {edit?.kind === 'duplicate' && edit.envId === env.id && (
                <InlineNameInput
                  initialValue={edit.initial}
                  onCommit={handleInlineCommit}
                  onCancel={closeEdit}
                  error={editError}
                />
              )}
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-border p-2">
          <div className="flex gap-1">
            <input
              type="text"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value)
                setCreateError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
              placeholder={t('environment.newNamePlaceholder')}
              className={cn(
                'h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring',
                createError ? 'border-destructive' : 'border-border-default'
              )}
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-default bg-background text-muted-foreground hover:text-foreground disabled:opacity-40"
              aria-label={t('environment.new')}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {createError && <p className="mt-1 text-xs text-destructive">{createError}</p>}
        </div>
      </div>

      {/* Deleting destroys the machine-local cookie jar and value overrides,
          which have no other copy — a consequence that needs more room than the
          inline strip this replaces afforded. */}
      {deleteTarget && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
        >
          <DialogContent className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle>{t('environment.delete')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {t('environment.deleteConfirm', { name: deleteTarget.name })}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                {t('collection.delete.cancel')}
              </Button>
              <Button variant="destructive" onClick={handleDeleteConfirm}>
                {t('collection.delete.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
