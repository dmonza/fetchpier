import { useState, useEffect } from 'react'
import { Settings, Minus, Plus, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useDisplayStore } from '../../stores/display'
import { useAppSettingsStore } from '../../stores/appSettings'
import { OPEN_SETTINGS_EVENT } from '../../lib/events'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { CertificatesPanel } from '../settings/CertificatesPanel'
import { WorkspaceKeysPanel } from '../settings/WorkspaceKeysPanel'
import { VariableHighlightInput } from '../ui/VariableHighlightInput'
import type { ProxyConfig } from '../../../shared/types'

type Tab = 'general' | 'proxy' | 'updates' | 'certificates' | 'workspaceKeys'

const MIN_INTERVAL_DAYS = 1
const MAX_INTERVAL_DAYS = 365

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_INTERVAL_DAYS
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, Math.round(raw)))
}

// ── Tab: General ───────────────────────────────────────────────────────────────

function GeneralTab(): React.JSX.Element {
  const { t } = useTranslation()
  const zoomFactor = useDisplayStore((s) => s.zoomFactor)
  const zoomIn = useDisplayStore((s) => s.zoomIn)
  const zoomOut = useDisplayStore((s) => s.zoomOut)
  const resetZoom = useDisplayStore((s) => s.resetZoom)

  const [timeoutValue, setTimeoutValue] = useState<number>(30)

  useEffect(() => {
    window.api.appSettings.get().then((s) => setTimeoutValue(s.requestTimeoutSeconds))
  }, [])

  const zoomPercent = Math.round(zoomFactor * 100)
  const isZoomed = zoomPercent !== 100

  function handleTimeoutChange(raw: string): void {
    const parsed = parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < 1) return
    const clamped = Math.min(parsed, 3600)
    setTimeoutValue(clamped)
    window.api.appSettings.set({ requestTimeoutSeconds: clamped })
  }

  return (
    <div className="px-4 py-4 space-y-5">
      <div>
        <p className="mb-3 text-xs font-medium text-muted-foreground">{t('settings.zoom.label')}</p>
        <div className="flex items-center gap-1.5">
          <button
            onClick={zoomOut}
            title={t('settings.zoom.out')}
            className="flex h-7 w-7 items-center justify-center rounded border border-border-default bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Minus className="h-3 w-3" />
          </button>

          <button
            onClick={isZoomed ? resetZoom : undefined}
            title={isZoomed ? t('statusBar.zoom.resetTooltip') : t('statusBar.zoom.tooltip')}
            className={cn(
              'flex h-7 flex-1 items-center justify-center rounded border border-border-default bg-background text-xs tabular-nums',
              isZoomed
                ? 'cursor-pointer text-primary hover:bg-accent'
                : 'cursor-default text-muted-foreground'
            )}
          >
            {t('statusBar.zoom.label', { percent: zoomPercent })}
          </button>

          <button
            onClick={zoomIn}
            title={t('settings.zoom.in')}
            className="flex h-7 w-7 items-center justify-center rounded border border-border-default bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
          </button>

          <button
            onClick={resetZoom}
            title={t('settings.zoom.reset')}
            disabled={!isZoomed}
            className="flex h-7 w-7 items-center justify-center rounded border border-border-default bg-background text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t('settings.requestTimeout.label')}
        </p>
        <input
          type="number"
          min={1}
          max={3600}
          value={timeoutValue}
          onChange={(e) => handleTimeoutChange(e.target.value)}
          className="h-7 w-20 rounded border border-border-default bg-background px-2 text-xs tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <span className="text-xs text-muted-foreground">{t('settings.requestTimeout.unit')}</span>
      </div>
    </div>
  )
}

// ── Tab: Proxy ─────────────────────────────────────────────────────────────────

function ProxyTab(): React.JSX.Element {
  const { t } = useTranslation()
  const [proxy, setProxy] = useState<ProxyConfig>({
    enabled: false,
    url: '',
    username: '',
    password: ''
  })
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.appSettings.get().then((s) => {
      setProxy(s.proxy)
      setLoaded(true)
    })
  }, [])

  function update(patch: Partial<ProxyConfig>): void {
    const next = { ...proxy, ...patch }
    setProxy(next)
    window.api.appSettings.set({ proxy: next })
  }

  const disabled = !proxy.enabled

  return (
    <div className="px-4 py-4 space-y-4">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={proxy.enabled}
          disabled={!loaded}
          onChange={(e) => update({ enabled: e.target.checked })}
          className="h-4 w-4 accent-primary"
        />
        <span className="text-xs font-medium text-foreground">{t('settings.proxy.enable')}</span>
      </label>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
          {t('settings.proxy.url')}
        </label>
        <input
          type="text"
          value={proxy.url}
          disabled={disabled}
          placeholder={t('settings.proxy.urlPlaceholder')}
          onChange={(e) => update({ url: e.target.value })}
          className="h-7 w-full rounded border border-border-default bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
          {t('settings.proxy.username')}
        </label>
        <input
          type="text"
          value={proxy.username}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => update({ username: e.target.value })}
          className="h-7 w-full rounded border border-border-default bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
          {t('settings.proxy.password')}
        </label>
        <VariableHighlightInput
          secret
          value={proxy.password}
          disabled={disabled}
          autoComplete="new-password"
          onChange={(e) => update({ password: e.target.value })}
          className="h-7 w-full rounded border border-border-default bg-background focus-within:ring-1 focus-within:ring-primary"
          inputClassName="px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </div>
  )
}

// ── Tab: Updates ───────────────────────────────────────────────────────────────

function UpdatesTab(): React.JSX.Element {
  const { t } = useTranslation()
  const updates = useAppSettingsStore((s) => s.updates)
  const setUpdates = useAppSettingsStore((s) => s.setUpdates)

  const [intervalDraft, setIntervalDraft] = useState<string | null>(null)
  const intervalInput = intervalDraft ?? String(updates.intervalDays)

  function handleToggle(next: boolean): void {
    void setUpdates({ autoCheckEnabled: next })
  }

  function handleIntervalBlur(): void {
    if (intervalDraft === null) return
    const clamped = clampInterval(parseInt(intervalDraft, 10))
    setIntervalDraft(null)
    if (clamped !== updates.intervalDays) {
      void setUpdates({ intervalDays: clamped })
    }
  }

  return (
    <div className="px-4 py-4 space-y-4">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={updates.autoCheckEnabled}
          onChange={(e) => handleToggle(e.target.checked)}
          className="h-4 w-4 accent-primary"
        />
        <span className="text-xs font-medium text-foreground">
          {t('settings.updates.autoCheck')}
        </span>
      </label>

      <div className="flex items-center gap-2">
        <label
          htmlFor="settings-updates-interval"
          className={cn(
            'text-xs font-medium text-muted-foreground',
            !updates.autoCheckEnabled && 'opacity-50'
          )}
        >
          {t('settings.updates.intervalDays')}
        </label>
        <input
          id="settings-updates-interval"
          type="number"
          min={MIN_INTERVAL_DAYS}
          max={MAX_INTERVAL_DAYS}
          value={intervalInput}
          disabled={!updates.autoCheckEnabled}
          onChange={(e) => setIntervalDraft(e.target.value)}
          onBlur={handleIntervalBlur}
          className="h-7 w-20 rounded border border-border-default bg-background px-2 text-xs tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span className="text-xs text-muted-foreground">{t('settings.updates.daysUnit')}</span>
      </div>
    </div>
  )
}

// ── Modal ──────────────────────────────────────────────────────────────────────

function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('general')
  const loadUpdates = useAppSettingsStore((s) => s.loadUpdates)
  const isLoaded = useAppSettingsStore((s) => s.isLoaded)

  useEffect(() => {
    if (!isLoaded) {
      void loadUpdates()
    }
  }, [isLoaded, loadUpdates])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: t('settings.tabs.general') },
    { id: 'proxy', label: t('settings.tabs.proxy') },
    { id: 'updates', label: t('settings.tabs.updates') },
    { id: 'certificates', label: t('settings.tabs.certificates') },
    { id: 'workspaceKeys', label: t('settings.tabs.workspaceKeys') }
  ]

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-[36rem] gap-0 p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>{t('settings.title')}</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex border-b border-border px-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'mr-4 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                activeTab === tab.id
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="min-h-[20rem] max-h-[36rem] overflow-y-auto">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'proxy' && <ProxyTab />}
          {activeTab === 'updates' && <UpdatesTab />}
          {activeTab === 'certificates' && <CertificatesPanel scope="app" />}
          {activeTab === 'workspaceKeys' && <WorkspaceKeysPanel />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SettingsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = (): void => setOpen(true)
    window.addEventListener(OPEN_SETTINGS_EVENT, handler)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler)
  }, [])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={t('settings.title')}
        title={t('settings.title')}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          open && 'bg-accent text-foreground'
        )}
      >
        <Settings className="h-4 w-4" />
      </button>

      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  )
}
