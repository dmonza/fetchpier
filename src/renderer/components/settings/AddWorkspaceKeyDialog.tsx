import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useSecretsStore } from '../../stores/secrets'
import { formatRelative } from '../../lib/relative-time'
import type { WorkspaceKeyMetadata } from '../../../shared/types'

interface Props {
  onClose: () => void
}

/**
 * REQ-0073 §6.3 — proactively add a pasted `FPK1-…` key (e.g. received from a
 * teammate before cloning). Structure-only (CRC) validation; on a same-id /
 * different-key conflict it proposes replacement inline, showing the existing
 * entry's hint and last use. The pasted key lives only in this component's
 * local state and the IPC argument — never in the store.
 */
export function AddWorkspaceKeyDialog({ onClose }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const addKey = useSecretsStore((s) => s.addKey)
  const [value, setValue] = useState('')
  const [hint, setHint] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<WorkspaceKeyMetadata | null>(null)

  const submit = async (replace: boolean): Promise<void> => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await addKey(value.trim(), hint.trim() || undefined, replace)
      switch (result.status) {
        case 'invalid-format':
          setError(t('workspaceKeys.add.invalidFormat'))
          break
        case 'conflict':
          setConflict(result.existing)
          break
        default:
          onClose()
      }
    } catch {
      setError(t('workspaceKeys.add.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (conflict) {
    const existingHint = conflict.workspaceHint || t('workspaceKeys.unnamed')
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
              <ShieldAlert className="h-4 w-4 text-warning" />
              {t('workspaceKeys.add.conflictTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              {t('workspaceKeys.add.conflictBody', {
                hint: existingHint,
                lastUsed: formatRelative(conflict.lastUsedAt, i18n.language)
              })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t('workspaceKeys.add.keepExisting')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => submit(true).catch(console.error)}
              disabled={busy}
            >
              {t('workspaceKeys.add.replace')}
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
            <KeyRound className="h-4 w-4 text-primary" />
            {t('workspaceKeys.add.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">{t('workspaceKeys.add.intro')}</p>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('workspaceKeys.add.keyLabel')}
            </label>
            <Input
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              placeholder={t('workspaceKeys.add.keyPlaceholder')}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('workspaceKeys.add.hintLabel')}
            </label>
            <Input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder={t('workspaceKeys.add.hintPlaceholder')}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!value.trim() || busy}
            onClick={() => submit(false).catch(console.error)}
          >
            {t('workspaceKeys.add.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
