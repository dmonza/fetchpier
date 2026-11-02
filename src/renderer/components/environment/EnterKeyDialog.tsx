import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useSecretsStore } from '../../stores/secrets'

interface Props {
  expectedKeyId?: string
  onClose: () => void
  onUnlocked: () => void
}

/**
 * REQ-0070 §6.3 — enter-key dialog. Validates the pasted `FPK1-…` key against
 * the workspace challenge; an invalid key reports the expected keyId.
 */
export function EnterKeyDialog({ expectedKeyId, onClose, onUnlocked }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const enterKey = useSecretsStore((s) => s.enterKey)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (): Promise<void> => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await enterKey(value.trim())
      if (result.ok) {
        onUnlocked()
        return
      }
      setError(
        result.reason === 'invalid-format'
          ? t('secrets.enterKey.invalidFormat')
          : t('secrets.enterKey.wrongKey', { keyId: result.keyId ?? expectedKeyId ?? '' })
      )
    } catch {
      setError(t('secrets.enterKey.failed'))
    } finally {
      setBusy(false)
    }
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
            <Lock className="h-4 w-4 text-primary" />
            {t('secrets.enterKey.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">{t('secrets.enterKey.intro')}</p>
          {expectedKeyId && (
            <p className="text-[11px] text-muted-foreground">
              {t('secrets.keyIdLabel', { keyId: expectedKeyId })}
            </p>
          )}
          <Input
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit().catch(console.error)
            }}
            placeholder={t('secrets.enterKey.placeholder')}
            className="font-mono text-xs"
            spellCheck={false}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!value.trim() || busy}
            onClick={() => handleSubmit().catch(console.error)}
          >
            {t('secrets.enterKey.unlock')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
