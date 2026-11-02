import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useNameAvailability } from '../../hooks/useNameAvailability'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import type { WorkspaceTree } from '../../../shared/types'

interface FolderEntry {
  path: string
  label: string
  depth: number
}

function collectFolders(nodes: WorkspaceTree[], result: FolderEntry[], depth = 0): void {
  for (const node of nodes) {
    if (node.type === 'folder') {
      result.push({ path: node.path, label: node.name, depth })
      if (node.children) collectFolders(node.children, result, depth + 1)
    }
  }
}

interface SaveRequestDialogProps {
  /** Absolute path of the workspace (used to load the tree via IPC). */
  workspacePath: string
  /** Absolute path of the user-tree root (`<workspace>/requests/`). */
  requestsRoot: string
  onConfirm: (name: string, folderPath: string) => void
  onCancel: () => void
}

export function SaveRequestDialog({
  workspacePath,
  requestsRoot,
  onConfirm,
  onCancel
}: SaveRequestDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [folders, setFolders] = useState<FolderEntry[]>([])
  const [selectedFolder, setSelectedFolder] = useState<string>(requestsRoot)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    window.api.filesystem
      .readTree()
      .then((loaded) => {
        const entries: FolderEntry[] = [
          { path: requestsRoot, label: t('collection.moveTo.root'), depth: 0 }
        ]
        collectFolders(loaded, entries)
        setFolders(entries)
      })
      .catch(console.error)
  }, [workspacePath, requestsRoot, t])

  // A taken name (any casing, uniform across requests/collections) would be
  // overwritten by this save, so the boundary rejects it — flag it inline
  // first. The verdict comes from the core over IPC (REQ case-insensitive
  // tree name uniqueness): the dialog computes no name rule.
  const trimmed = name.trim()
  const availability = useNameAvailability(
    trimmed.length > 0 ? { kind: 'entry', parentPath: selectedFolder, name: trimmed } : null
  )
  const hasConflict = availability === 'taken'

  const handleConfirm = (): void => {
    if (!trimmed || hasConflict) return
    onConfirm(trimmed, selectedFolder)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') handleConfirm()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('saveRequest.title')}</DialogTitle>
        </DialogHeader>

        <div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('saveRequest.namePlaceholder')}
            aria-invalid={hasConflict}
            className={cn(
              'w-full rounded border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring',
              hasConflict
                ? 'border-destructive focus:border-destructive'
                : 'border-border-default focus:border-primary'
            )}
          />
          {hasConflict && (
            <p className="mt-1 text-[11px] text-destructive" role="alert">
              {t('collection.nameConflict')}
            </p>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs text-muted-foreground">{t('saveRequest.folderLabel')}</p>
          <div className="max-h-36 overflow-y-auto rounded border bg-surface-2 p-1">
            {folders.map((f) => (
              <button
                key={f.path}
                type="button"
                className={cn(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  selectedFolder === f.path
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent hover:text-accent-foreground'
                )}
                style={{ paddingLeft: `${f.depth * 12 + 8}px` }}
                onClick={() => setSelectedFolder(f.path)}
              >
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{f.label}</span>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onCancel}
          >
            {t('saveRequest.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            disabled={!trimmed || hasConflict}
            onClick={handleConfirm}
          >
            {t('saveRequest.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
