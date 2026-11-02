import { useState } from 'react'
import { FolderOpen, FolderPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { useWorkspaceStore } from '../../stores/workspace'
import { useWorkspaceRequiredStore } from '../../stores/workspaceRequired'

/**
 * Offers to open or create a workspace when a save needs one, then runs the
 * save that was waiting. Cancelling leaves the tab exactly as it was — open and
 * unsaved — rather than discarding it.
 *
 * REQ Application menu coherence on macOS §6.11.
 */
export function WorkspaceRequiredModal(): React.JSX.Element | null {
  const { t } = useTranslation()
  const pending = useWorkspaceRequiredStore((s) => s.pending)
  const clear = useWorkspaceRequiredStore((s) => s.clear)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace)
  const [busy, setBusy] = useState(false)

  if (!pending) return null

  const establish = async (establishWorkspace: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await establishWorkspace()
      // The dialog can be dismissed without picking a folder; only continue if
      // a workspace actually ended up open.
      if (!useWorkspaceStore.getState().workspacePath) return
      const { onProceed } = pending
      clear()
      await onProceed()
    } catch (err) {
      console.error('[WorkspaceRequiredModal] failed to establish a workspace:', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) clear()
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('workspaceRequired.title')}</DialogTitle>
          <DialogDescription>{t('workspaceRequired.message')}</DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={clear}
            disabled={busy}
          >
            {t('workspaceRequired.cancel')}
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => void establish(createWorkspace)}
            disabled={busy}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t('workspaceRequired.create')}
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => void establish(openWorkspace)}
            disabled={busy}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t('workspaceRequired.open')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
