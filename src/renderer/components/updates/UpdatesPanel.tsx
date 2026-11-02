import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'
import { OPEN_UPDATES_EVENT } from '../../lib/events'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { useAppSettingsStore } from '../../stores/appSettings'
import type { UpdateCheckErrorKind, UpdateCheckResult } from '../../../shared/types'
import { PRODUCT_RELEASES_URL } from '../../../shared/types'

type PanelState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; data: UpdateCheckResult }
  | { kind: 'update-available'; data: UpdateCheckResult }
  | { kind: 'error'; errorKind: UpdateCheckErrorKind }

export function UpdatesPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PanelState>({ kind: 'idle' })

  const setUpdates = useAppSettingsStore((s) => s.setUpdates)

  useEffect(() => {
    const handler = (): void => {
      setOpen(true)
      setState({ kind: 'idle' })
    }
    window.addEventListener(OPEN_UPDATES_EVENT, handler)
    return () => window.removeEventListener(OPEN_UPDATES_EVENT, handler)
  }, [])

  const handleCheck = useCallback(async () => {
    setState({ kind: 'checking' })
    try {
      const result = await window.api.updates.check()
      if (result.ok) {
        setState(
          result.data.isNewer
            ? { kind: 'update-available', data: result.data }
            : { kind: 'up-to-date', data: result.data }
        )
        await setUpdates({ lastCheckAt: result.data.fetchedAt })
      } else {
        setState({ kind: 'error', errorKind: result.errorKind })
      }
    } catch (err) {
      console.error('updates:check failed', err)
      setState({ kind: 'error', errorKind: 'network' })
    }
  }, [setUpdates])

  const handleOpenReleases = useCallback((): void => {
    window.api.app.openExternal(PRODUCT_RELEASES_URL)
  }, [])

  const checking = state.kind === 'checking'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('updates.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {state.kind === 'idle' && (
            <p className="text-sm text-muted-foreground">{t('updates.idleHint')}</p>
          )}

          {checking && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('updates.checking')}
            </p>
          )}

          {state.kind === 'up-to-date' && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" aria-hidden />
              <div className="flex flex-col gap-0.5 text-sm">
                <p className="font-medium text-foreground">{t('updates.upToDate')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('updates.currentVersion', { version: state.data.currentVersion })}
                </p>
              </div>
            </div>
          )}

          {state.kind === 'update-available' && (
            <div className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-3">
              <div className="flex items-start gap-2">
                <Download className="mt-0.5 h-4 w-4 text-primary" aria-hidden />
                <div className="flex flex-col gap-0.5 text-sm">
                  <p className="font-medium text-foreground">
                    {t('updates.updateAvailable', {
                      version: state.data.publishedVersion ?? '?'
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('updates.currentVersion', { version: state.data.currentVersion })}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleOpenReleases}
                className="self-start text-sm text-primary hover:underline focus:outline-none focus-visible:underline"
              >
                {t('updates.openReleases')}
              </button>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 text-destructive" aria-hidden />
              <p className="text-sm text-foreground">{t(`updates.errors.${state.errorKind}`)}</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button onClick={handleCheck} disabled={checking} size="sm" className="gap-2">
              {checking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
              {t('updates.check')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
