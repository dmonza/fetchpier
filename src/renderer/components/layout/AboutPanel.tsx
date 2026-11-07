import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Info, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  OPEN_ABOUT_EVENT,
  OPEN_THIRD_PARTY_LICENSES_EVENT,
  OPEN_UPDATES_EVENT
} from '../../lib/events'
import {
  cancelPostponedUpdatesCheck,
  notifyFlowDialogClosed,
  notifyFlowDialogOpened
} from '../../lib/startup-dialogs'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import appIconDark from '../../assets/app-icon-dark.png'
import appIconLight from '../../assets/app-icon-light.png'
import { useAppSettingsStore } from '../../stores/appSettings'
import { useThemeStore } from '../../stores/theme'
import type { LicenseText } from '../../../shared/types'
import { PRODUCT_WEBSITE_URL } from '../../../shared/types'
import { IS_PUBLIC_BETA } from '../../../shared/constants'

type LicenseState = { kind: 'loading' } | { kind: 'ready'; text: LicenseText } | { kind: 'error' }

// ── Dialog (mounted at app root level, outside TitleBar) ─────────────────────

export function AboutDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState<string>('…')
  const [license, setLicense] = useState<LicenseState>({ kind: 'loading' })
  const stampLastVersion = useAppSettingsStore((s) => s.stampLastVersion)
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme)
  // The dark-background icon reads better on the light theme, and vice versa.
  const appIcon = resolvedTheme === 'dark' ? appIconLight : appIconDark

  useEffect(() => {
    const handler = (): void => {
      notifyFlowDialogOpened('about')
      setOpen(true)
    }
    window.addEventListener(OPEN_ABOUT_EVENT, handler)
    return () => window.removeEventListener(OPEN_ABOUT_EVENT, handler)
  }, [])

  // Stamping happens when the dialog is *shown*, not when it closes: a crash
  // with the About open must not make it reappear on every launch, and a
  // manual open on the current version writes nothing (`stampLastVersion`).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.api.app
      .getVersion()
      .then((v) => {
        if (cancelled) return
        setVersion(v)
        void stampLastVersion(v)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [open, stampLastVersion])

  // The packaged LICENSE is the single source of the copyright line and body.
  useEffect(() => {
    if (!open || license.kind !== 'loading') return
    let cancelled = false
    window.api.app
      .getLicense()
      .then((text) => {
        if (!cancelled) setLicense({ kind: 'ready', text })
      })
      .catch((err) => {
        console.error(err)
        if (!cancelled) setLicense({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [open, license.kind])

  const handleOpenChange = useCallback((next: boolean): void => {
    setOpen(next)
    if (!next) notifyFlowDialogClosed('about')
  }, [])

  const handleCheckUpdates = useCallback((): void => {
    // Reaching updates from here supersedes any prompt postponed at startup.
    cancelPostponedUpdatesCheck()
    notifyFlowDialogClosed('about')
    setOpen(false)
    window.dispatchEvent(new CustomEvent(OPEN_UPDATES_EVENT))
  }, [])

  const handleOpenThirdParty = useCallback((): void => {
    // Register the incoming dialog before the outgoing one leaves, so the
    // About flow is never momentarily empty (which would end it early).
    notifyFlowDialogOpened('thirdPartyLicenses')
    notifyFlowDialogClosed('about')
    setOpen(false)
    window.dispatchEvent(new CustomEvent(OPEN_THIRD_PARTY_LICENSES_EVENT))
  }, [])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle className="sr-only">{t('about.title')}</DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-6 py-2 sm:grid-cols-2 sm:gap-8">
          {/* ── Left: identity ─────────────────────────────────────────── */}
          <div className="flex flex-col items-center gap-4 text-center">
            <img src={appIcon} alt="Fetchpier" className="h-20 w-20 object-contain" />

            <div>
              <p className="text-lg font-semibold tracking-tight">{t('about.appName')}</p>
              <p className="text-sm text-muted-foreground">{t('about.version', { version })}</p>
            </div>

            {IS_PUBLIC_BETA && (
              <span
                className={cn(
                  'inline-flex items-center rounded-full border border-warning/50 bg-warning/10',
                  'px-2.5 py-0.5 text-[11px] font-medium text-warning-text'
                )}
              >
                {t('about.publicBeta.badge')}
              </span>
            )}

            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              {t('about.description')}
            </p>

            <div className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t border-border pt-3 text-left text-xs">
              <span className="text-muted-foreground">{t('about.author')}</span>
              <span className="text-foreground">Daniel Monza</span>
              <span className="text-muted-foreground">{t('about.website')}</span>
              <button
                type="button"
                onClick={() => window.api.app.openExternal(PRODUCT_WEBSITE_URL)}
                className="text-left font-mono text-primary hover:underline focus:outline-none"
              >
                fetchpier.com
              </button>
            </div>

            <button
              type="button"
              onClick={handleCheckUpdates}
              className="mt-auto inline-flex items-center gap-1.5 text-xs text-primary hover:underline focus:outline-none"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              {t('updates.openFromAbout')}
            </button>
          </div>

          {/* ── Right: everything about the licence ────────────────────── */}
          {/* The copyright heading and the body are the packaged LICENSE
              verbatim — canonical English, deliberately not translated. The
              heading is a copy of a line the body also contains, not a cut. */}
          <div className="flex min-h-0 flex-col items-start gap-2 text-left">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('about.license.title')}
            </p>
            {license.kind === 'loading' && (
              <p className="text-xs text-muted-foreground">{t('about.license.loading')}</p>
            )}
            {license.kind === 'error' && (
              <p className="text-xs text-destructive">{t('about.license.loadError')}</p>
            )}
            {license.kind === 'ready' && (
              <>
                {license.text.copyright && (
                  <p className="text-xs font-medium text-foreground">{license.text.copyright}</p>
                )}
                <pre className="min-h-40 w-full flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {license.text.body}
                </pre>
              </>
            )}

            <button
              type="button"
              onClick={handleOpenThirdParty}
              className="inline-flex items-center gap-1.5 pt-1 text-xs text-primary hover:underline focus:outline-none"
            >
              <FileText className="h-3 w-3" aria-hidden />
              {t('about.thirdParty.button')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Trigger button (mounted inside TitleBar) ──────────────────────────────────

export function AboutTrigger(): React.JSX.Element {
  const { t } = useTranslation()

  function handleClick(): void {
    window.dispatchEvent(new CustomEvent(OPEN_ABOUT_EVENT))
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t('about.title')}
      title={t('about.title')}
      className={cn(
        'titlebar-interactive flex h-full w-9 items-center justify-center',
        'text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
      )}
    >
      <Info className="h-4 w-4" />
    </button>
  )
}
