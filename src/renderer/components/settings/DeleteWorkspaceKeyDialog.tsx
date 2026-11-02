import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, AlertTriangle, Copy, Check } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { useSecretsStore } from '../../stores/secrets'
import { keyDeleteToken, isKeyDeleteBlocked, canConfirmKeyDelete } from '../../lib/key-delete-guard'
import type { WorkspaceKeyMetadata } from '../../../shared/types'

interface Props {
  entry: WorkspaceKeyMetadata
  /** Locally-known workspaces that reference this key (positive reference → blocked). */
  usedBy?: string[]
  onClose: () => void
}

/**
 * REQ write-safety §6.4 — guarded key deletion, superseding the prior "calm,
 * recoverable" confirmation. Two modes:
 *
 * - **Blocked**: a positive local reference exists → deletion is refused with
 *   guidance to remove the dependent secrets first (no typed path is offered).
 * - **Typed confirmation**: otherwise, the dialog states the unrecoverable
 *   consequence, shows the workspace name (the key's hint, or its id as a
 *   fallback) as selectable/copyable text, and enables Delete only once the user
 *   types that exact token.
 */
export function DeleteWorkspaceKeyDialog({ entry, usedBy, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const deleteKey = useSecretsStore((s) => s.deleteKey)
  const [busy, setBusy] = useState(false)
  const [typed, setTyped] = useState('')
  const [copied, setCopied] = useState(false)

  const blocked = isKeyDeleteBlocked(usedBy)
  // The token to type: the workspace name when known, else the key id.
  const token = keyDeleteToken(entry)
  const label = entry.workspaceHint || t('workspaceKeys.unnamed')
  const canDelete = !busy && canConfirmKeyDelete(typed, token)

  const handleDelete = async (): Promise<void> => {
    if (!canDelete) return
    setBusy(true)
    try {
      await deleteKey(entry.keyId)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = (): void => {
    navigator.clipboard?.writeText(token).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => {}
    )
  }

  if (blocked) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              {t('workspaceKeys.delete.blocked.title')}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('workspaceKeys.delete.blocked.body', { names: usedBy!.join(', ') })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('workspaceKeys.delete.blocked.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            {t('workspaceKeys.delete.title', { name: label })}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-destructive">{t('workspaceKeys.delete.consequence')}</p>
        <p className="text-sm text-muted-foreground">{t('workspaceKeys.delete.typePrompt')}</p>

        <div className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('workspaceKeys.delete.tokenLabel')}
          </span>
          <div className="flex items-center gap-2 rounded border border-border-default bg-surface-2 px-2 py-1.5">
            {/* Selectable/copyable so the user can copy the exact name to type. */}
            <code className="flex-1 select-all break-all font-mono text-xs text-foreground">
              {token}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? t('workspaceKeys.delete.copied') : t('workspaceKeys.delete.copy')}
            </button>
          </div>
        </div>

        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={t('workspaceKeys.delete.inputPlaceholder')}
          autoFocus
          className="w-full rounded border border-border-default bg-background px-2 py-1.5 text-xs outline-none focus:border-destructive focus-visible:ring-1 focus-visible:ring-ring"
        />

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => handleDelete().catch(console.error)}
            disabled={!canDelete}
          >
            {t('workspaceKeys.delete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
