import { useState } from 'react'
import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { serializeTab } from '../../lib/tab-dirty'
import { withWorkspace } from '../../stores/workspaceRequired'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import type { Tab } from '../../../shared/types'

interface UnsavedChangesModalProps {
  tabs: Tab[]
  workspacePath: string | null
  /**
   * Runs after the user chooses Save or Discard (REQ-0095). Defaults to
   * confirming a window close; other guards inject their own follow-up (switch
   * workspace, close tabs, etc.). Always invoked *after* the save loop so an
   * untitled tab is written into the still-active (outgoing) workspace first.
   */
  onProceed?: () => Promise<void>
  onClose: () => void
}

export function UnsavedChangesModal({
  tabs,
  workspacePath,
  onProceed,
  onClose
}: UnsavedChangesModalProps): React.JSX.Element {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const proceed = onProceed ?? ((): Promise<void> => window.api.window.closeConfirmed())

  const writeAllAndProceed = async (): Promise<void> => {
    let untitledCounter = 1
    for (const tab of tabs) {
      const content = serializeTab(tab)
      if (tab.filePath) {
        await window.api.filesystem.writeFile(tab.filePath, content)
      } else {
        const { filePath } = await window.api.filesystem.findAvailableUntitledPath(untitledCounter)
        untitledCounter++
        await window.api.filesystem.writeFile(filePath, content)
      }
    }
    await proceed()
    onClose()
  }

  const handleSaveAndClose = async (): Promise<void> => {
    setSaving(true)
    try {
      // REQ menu coherence §6.11: an untitled tab used to be dropped here
      // without a word when no workspace was open — the user pressed "save"
      // and lost the content. Ask for a workspace instead, and only proceed
      // once there is somewhere to write.
      const hasUntitled = tabs.some((tab) => !tab.filePath)
      if (hasUntitled && !workspacePath) {
        setSaving(false)
        void withWorkspace(writeAllAndProceed)
        return
      }
      await writeAllAndProceed()
    } catch (err) {
      console.error('[UnsavedChangesModal] Failed to save:', err)
      setSaving(false)
    }
  }

  const handleCloseWithoutSaving = async (): Promise<void> => {
    await proceed()
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('closeGuard.title')}</DialogTitle>
          <DialogDescription>{t('closeGuard.message')}</DialogDescription>
        </DialogHeader>

        <ul className="max-h-48 overflow-auto rounded border border-border bg-surface-2 px-3 py-2 space-y-1">
          {tabs.map((tab) => (
            <li key={tab.id} className="flex items-center gap-2 text-xs">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-foreground">{tab.title}</span>
              {!tab.filePath && !workspacePath && (
                <span className="shrink-0 italic text-muted-foreground">
                  {t('closeGuard.unsavedLabel')}
                </span>
              )}
            </li>
          ))}
        </ul>

        <DialogFooter>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onClose}
            disabled={saving}
          >
            {t('closeGuard.cancel')}
          </button>
          <button
            type="button"
            className={cn(
              'rounded px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'border border-border'
            )}
            onClick={handleCloseWithoutSaving}
            disabled={saving}
          >
            {t('closeGuard.closeWithoutSaving')}
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={handleSaveAndClose}
            disabled={saving}
          >
            {t('closeGuard.saveAndClose')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
