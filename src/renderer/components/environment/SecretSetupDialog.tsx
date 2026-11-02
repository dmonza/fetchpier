import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, KeyRound, ShieldAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { useToastStore } from '../../stores/toast'

interface Props {
  /** The `FPK1-…` key to display exactly once. */
  workspaceKey: string
  keyId: string
  /** Title/intro variant: first-time setup vs. post-rotation. */
  variant: 'setup' | 'rotated'
  onAcknowledge: () => void
}

/**
 * REQ-0070 §6.2 — the ONLY surface that ever displays the workspace key. Shown
 * once at creation (or after rotation). A forced "I saved it" acknowledgment
 * guards against losing the key (Fetchpier cannot recover it).
 */
export function SecretSetupDialog({
  workspaceKey,
  keyId,
  variant,
  onAcknowledge
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const pushToast = useToastStore((s) => s.push)
  const [acknowledged, setAcknowledged] = useState(false)

  const handleCopy = (): void => {
    navigator.clipboard.writeText(workspaceKey).then(
      () => pushToast(t('secrets.setup.copied'), { type: 'success' }),
      () => pushToast(t('secrets.setup.copyFailed'), { type: 'error' })
    )
  }

  return (
    <Dialog
      open
      onOpenChange={() => {
        /* modal: dismissal only via acknowledge */
      }}
    >
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            {variant === 'setup' ? t('secrets.setup.title') : t('secrets.rotate.doneTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">{t('secrets.setup.intro')}</p>

          <div className="rounded-md border border-border bg-surface-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <code className="break-all font-mono text-xs text-foreground">{workspaceKey}</code>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 gap-1 text-xs"
                onClick={handleCopy}
              >
                <Copy className="h-3.5 w-3.5" />
                {t('secrets.setup.copy')}
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t('secrets.keyIdLabel', { keyId })}
            </p>
          </div>

          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>{t('secrets.setup.warning')}</span>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {t('secrets.setup.acknowledge')}
          </label>
        </div>

        <DialogFooter>
          <Button disabled={!acknowledged} onClick={onAcknowledge}>
            {t('secrets.setup.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
