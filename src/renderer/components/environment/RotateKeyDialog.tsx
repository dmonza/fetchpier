import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { useSecretsStore } from '../../stores/secrets'
import { useToastStore } from '../../stores/toast'
import { SecretSetupDialog } from './SecretSetupDialog'

interface Props {
  onClose: () => void
  /** Called after a successful rotation, so the editor can reload environments. */
  onRotated: () => void
}

/**
 * REQ-0070 §6.7 — key rotation. The confirmation copy is contractual (CA-18):
 * it states that every teammate needs the new key, and that rotation does NOT
 * revoke prior holders — true revocation means rotating the provider credentials.
 */
export function RotateKeyDialog({ onClose, onRotated }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const rotate = useSecretsStore((s) => s.rotate)
  const pushToast = useToastStore((s) => s.push)
  const [busy, setBusy] = useState(false)
  const [rotated, setRotated] = useState<{ key: string; keyId: string } | null>(null)

  const handleRotate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await rotate()
      setRotated(result)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), { type: 'error' })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  if (rotated) {
    return (
      <SecretSetupDialog
        workspaceKey={rotated.key}
        keyId={rotated.keyId}
        variant="rotated"
        onAcknowledge={() => {
          onRotated()
          onClose()
        }}
      />
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-primary" />
            {t('secrets.rotate.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="space-y-2">
              <p>{t('secrets.rotate.warnTeammates')}</p>
              <p>{t('secrets.rotate.warnNoRevoke')}</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => handleRotate().catch(console.error)} disabled={busy}>
            {t('secrets.rotate.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
