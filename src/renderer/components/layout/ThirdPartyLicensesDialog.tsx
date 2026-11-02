import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { OPEN_ABOUT_EVENT, OPEN_THIRD_PARTY_LICENSES_EVENT } from '../../lib/events'
import { notifyFlowDialogClosed, notifyFlowDialogOpened } from '../../lib/startup-dialogs'

type LicensesState =
  { kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'error'; message: string }

export function ThirdPartyLicensesDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LicensesState>({ kind: 'loading' })

  useEffect(() => {
    const handler = (): void => {
      notifyFlowDialogOpened('thirdPartyLicenses')
      setOpen(true)
    }
    window.addEventListener(OPEN_THIRD_PARTY_LICENSES_EVENT, handler)
    return () => window.removeEventListener(OPEN_THIRD_PARTY_LICENSES_EVENT, handler)
  }, [])

  // This dialog belongs to the About flow: closing it ends the flow (and may
  // release a postponed update prompt), while "Back" hands off to the About.
  const handleOpenChange = useCallback((next: boolean): void => {
    setOpen(next)
    if (!next) notifyFlowDialogClosed('thirdPartyLicenses')
  }, [])

  const handleBack = useCallback((): void => {
    notifyFlowDialogOpened('about')
    notifyFlowDialogClosed('thirdPartyLicenses')
    setOpen(false)
    window.dispatchEvent(new CustomEvent(OPEN_ABOUT_EVENT))
  }, [])

  useEffect(() => {
    if (!open || state.kind !== 'loading') return
    let cancelled = false
    window.api.app
      .getThirdPartyLicenses()
      .then((text) => {
        if (!cancelled) setState({ kind: 'ready', text })
      })
      .catch((err) => {
        console.error(err)
        if (!cancelled) setState({ kind: 'error', message: t('about.thirdParty.loadError') })
      })
    return () => {
      cancelled = true
    }
  }, [open, state.kind, t])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{t('about.thirdParty.dialogTitle')}</DialogTitle>
          <p className="text-xs text-muted-foreground">{t('about.thirdParty.description')}</p>
        </DialogHeader>

        <div className="flex-1 overflow-hidden rounded-md border border-border bg-muted/40">
          {state.kind === 'error' ? (
            <div className="p-4 text-sm text-destructive">{state.message}</div>
          ) : state.kind === 'ready' ? (
            <pre className="h-full max-h-[70vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground">
              {state.text}
            </pre>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">{t('about.thirdParty.loading')}</div>
          )}
        </div>

        <div className="flex justify-start">
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline focus:outline-none"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
            {t('about.thirdParty.back')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
