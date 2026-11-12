import { lazy, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { SettingsDialogShell, SettingsTabPanel } from '../settings/SettingsDialogShell'
import { useWorkspaceSettingsStore } from '../../stores/workspaceSettings'
import { useWorkspaceStore } from '../../stores/workspace'
import { useToastStore } from '../../stores/toast'
import { CertificatesPanel } from '../settings/CertificatesPanel'
import { LazyBoundary } from '../ui/LazyBoundary'
import { useAppearanceStore } from '../../stores/appearance'
import { useThemeStore } from '../../stores/theme'
import {
  useWorkspaceSettingsDialogStore,
  type WorkspaceSettingsSection
} from '../../stores/workspaceSettingsDialog'
import { FindingsSettingsSection } from './FindingsSettingsSection'
import { DEFAULT_BINARY_FILE_LIMITS } from '../../../shared/types'

// The panel carries the palette generator; loading it on demand keeps the
// generator out of the interface's startup bundle.
const AppearancePanel = lazy(() => import('../settings/AppearancePanel'))

/**
 * Mounted only while the dialog is open: captures the workspace's palettes for
 * *Revert changes*, and on close saves any pending change, ends a preview and
 * drops the capture.
 */
function WorkspaceAppearanceSession(): null {
  useEffect(() => {
    useAppearanceStore.getState().beginSession(useThemeStore.getState().theme, 'workspace')
    return () => {
      useThemeStore.getState().setPreviewTheme(null)
      void useAppearanceStore.getState().endSession()
    }
  }, [])
  return null
}
import type { BinaryFileLimits, HttpVersion, WorkspaceHttpSettings } from '../../../shared/types'

const BYTES_PER_MB = 1024 * 1024
const bytesToMb = (b: number): number => Math.round((b / BYTES_PER_MB) * 10) / 10
const mbToBytes = (mb: number): number => Math.round(mb * BYTES_PER_MB)

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorkspaceSettingsDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const settings = useWorkspaceSettingsStore((s) => s.httpSettings)
  const update = useWorkspaceSettingsStore((s) => s.update)
  const resetToDefaults = useWorkspaceSettingsStore((s) => s.resetToDefaults)
  const [confirmReset, setConfirmReset] = useState(false)
  // Shared, so the response viewer's Security tab can open the dialog on a section.
  const tab = useWorkspaceSettingsDialogStore((s) => s.tab)
  const setTab = useWorkspaceSettingsDialogStore((s) => s.setTab)
  // A fresh dialog starts on HTTP, as it did when the section was local state:
  // the selection survives close/reopen, not a remount.
  useEffect(() => () => useWorkspaceSettingsDialogStore.getState().setTab('http'), [])

  const pushToast = useToastStore((s) => s.push)
  // A refused write (e.g. a settings.json that no longer parses) must reach the
  // user: the file was left as it was, so the change did not take effect. The
  // main-process text is English (and IPC-prefixed), so it stays in the log.
  const reportWriteFailure = (err: unknown): void => {
    console.error('[WorkspaceSettings] update failed:', err)
    pushToast(t('workspaceSettings.saveFailed'), { type: 'error' })
  }

  const set = <K extends keyof WorkspaceHttpSettings>(
    key: K,
    value: WorkspaceHttpSettings[K]
  ): void => {
    if (!workspacePath) return
    update({ [key]: value } as Partial<WorkspaceHttpSettings>).catch(reportWriteFailure)
  }

  const handleReset = (): void => {
    if (!workspacePath) return
    resetToDefaults().catch(reportWriteFailure)
    setConfirmReset(false)
  }

  const selectTab = (next: string): void => {
    if (next !== 'appearance') {
      // Leaving Appearance ends any preview and saves a pending change.
      useThemeStore.getState().setPreviewTheme(null)
      void useAppearanceStore.getState().flush()
    }
    setConfirmReset(false)
    setTab(next as WorkspaceSettingsSection)
  }

  return (
    <SettingsDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('workspaceSettings.title')}
      description={t('workspaceSettings.subtitle')}
      tabs={[
        { value: 'http', label: t('workspaceSettings.tabs.http') },
        { value: 'security', label: t('workspaceSettings.tabs.security') },
        { value: 'certificates', label: t('workspaceSettings.tabs.certificates') },
        { value: 'appearance', label: t('workspaceSettings.tabs.appearance') }
      ]}
      value={tab}
      onValueChange={selectTab}
      judging={tab === 'appearance'}
      footer={
        <>
          {tab === 'http' ? (
            confirmReset ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">{t('workspaceSettings.confirmReset')}</span>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  {t('workspaceSettings.cancel')}
                </Button>
                <Button size="sm" variant="destructive" onClick={handleReset}>
                  {t('workspaceSettings.resetFactory')}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmReset(true)}>
                {t('workspaceSettings.resetFactory')}
              </Button>
            )
          ) : (
            // The reset is for the HTTP settings only: offered beside them, nowhere else.
            <span />
          )}
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t('workspaceSettings.done')}
          </Button>
        </>
      }
    >
      <WorkspaceAppearanceSession />
      <SettingsTabPanel value="http">
        <TooltipProvider>
          <div className="flex flex-col gap-1 px-4 py-4">
            <Row
              label={t('request.settings.httpVersion')}
              hint={t('request.settings.hints.httpVersion')}
            >
              <Select
                value={settings.httpVersion}
                onValueChange={(v) => set('httpVersion', v as HttpVersion)}
              >
                <SelectTrigger size="sm" className="h-8 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {t('request.settings.httpVersionOptions.auto')}
                  </SelectItem>
                  <SelectItem value="http1">HTTP/1.1</SelectItem>
                  <SelectItem value="http2">HTTP/2</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <BoolRow
              label={t('request.settings.verifySsl')}
              hint={t('request.settings.hints.verifySsl')}
              value={settings.verifySsl}
              onChange={(v) => set('verifySsl', v)}
            />
            <BoolRow
              label={t('request.settings.followRedirects')}
              hint={t('request.settings.hints.followRedirects')}
              value={settings.followRedirects}
              onChange={(v) => set('followRedirects', v)}
            />
            <Row
              label={t('request.settings.maxRedirects')}
              hint={t('request.settings.hints.maxRedirects')}
            >
              <Input
                type="number"
                min={0}
                max={50}
                value={settings.maxRedirects}
                disabled={!settings.followRedirects}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (!Number.isFinite(n)) return
                  set('maxRedirects', Math.max(0, Math.min(50, Math.round(n))))
                }}
                className={cn('h-8 w-24', !settings.followRedirects && 'opacity-50')}
              />
            </Row>
            <BoolRow
              label={t('request.settings.followAuthorizationOnRedirect')}
              hint={t('request.settings.hints.followAuthorizationOnRedirect')}
              value={settings.followAuthorizationOnRedirect}
              onChange={(v) => set('followAuthorizationOnRedirect', v)}
              disabled={!settings.followRedirects}
            />
            <BoolRow
              label={t('request.settings.encodeUrl')}
              hint={t('request.settings.hints.encodeUrl')}
              value={settings.encodeUrl}
              onChange={(v) => set('encodeUrl', v)}
            />
            <BoolRow
              label={t('request.settings.disableCookieJar')}
              hint={t('request.settings.hints.disableCookieJar')}
              value={settings.disableCookieJar}
              onChange={(v) => set('disableCookieJar', v)}
            />
            <BinaryFileLimitsSection
              value={settings.binaryFileLimits ?? DEFAULT_BINARY_FILE_LIMITS}
              onChange={(next) => set('binaryFileLimits', next)}
            />
          </div>
        </TooltipProvider>
      </SettingsTabPanel>
      <SettingsTabPanel value="security">
        <FindingsSettingsSection
          value={settings.findings}
          onChange={(next) => set('findings', next)}
        />
      </SettingsTabPanel>
      <SettingsTabPanel value="certificates">
        <CertificatesPanel scope="workspace" />
      </SettingsTabPanel>
      <SettingsTabPanel value="appearance">
        <LazyBoundary>
          <AppearancePanel scope="workspace" />
        </LazyBoundary>
      </SettingsTabPanel>
    </SettingsDialogShell>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="text-xs font-medium">{label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-muted-foreground" tabIndex={-1}>
              <Info className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

function BoolRow({
  label,
  hint,
  value,
  onChange,
  disabled
}: {
  label: string
  hint: string
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
    </Row>
  )
}

function BinaryFileLimitsSection({
  value,
  onChange
}: {
  value: BinaryFileLimits
  onChange: (next: BinaryFileLimits) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Local UI state so the user can type values that are momentarily invalid
  // (e.g. warn=200 while block=100) without committing them.
  const [warnMb, setWarnMb] = useState<number>(bytesToMb(value.warnBytes))
  const [blockMb, setBlockMb] = useState<number>(bytesToMb(value.blockBytes))

  // Re-sync local state when the upstream value changes (e.g. external broadcast,
  // reset link). React's state-update reconciliation handles re-renders.
  const upstreamWarnMb = bytesToMb(value.warnBytes)
  const upstreamBlockMb = bytesToMb(value.blockBytes)
  if (Math.abs(warnMb - upstreamWarnMb) > 0.01 && warnMb !== upstreamWarnMb) {
    // Inline sync — fine because we guard with a tolerance check.
    setWarnMb(upstreamWarnMb)
  }
  if (Math.abs(blockMb - upstreamBlockMb) > 0.01 && blockMb !== upstreamBlockMb) {
    setBlockMb(upstreamBlockMb)
  }

  const negative = warnMb < 0 || blockMb < 0
  const inverted = !negative && warnMb > blockMb
  const invalid = negative || inverted

  const commit = (nextWarnMb: number, nextBlockMb: number): void => {
    if (nextWarnMb < 0 || nextBlockMb < 0) return
    if (nextWarnMb > nextBlockMb) return
    onChange({
      warnBytes: mbToBytes(nextWarnMb),
      blockBytes: mbToBytes(nextBlockMb)
    })
  }

  const handleReset = (): void => {
    setWarnMb(bytesToMb(DEFAULT_BINARY_FILE_LIMITS.warnBytes))
    setBlockMb(bytesToMb(DEFAULT_BINARY_FILE_LIMITS.blockBytes))
    onChange(DEFAULT_BINARY_FILE_LIMITS)
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold">
            {t('request.settings.binaryLimits.sectionTitle')}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t('request.settings.binaryLimits.sectionHint')}
          </p>
        </div>
      </div>
      <Row
        label={t('request.settings.binaryLimits.warnLabel')}
        hint={t('request.settings.binaryLimits.warnHint')}
      >
        <Input
          type="number"
          min={0}
          value={warnMb}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (!Number.isFinite(n)) return
            setWarnMb(n)
            commit(n, blockMb)
          }}
          className="h-8 w-24"
        />
      </Row>
      <Row
        label={t('request.settings.binaryLimits.blockLabel')}
        hint={t('request.settings.binaryLimits.blockHint')}
      >
        <Input
          type="number"
          min={0}
          value={blockMb}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (!Number.isFinite(n)) return
            setBlockMb(n)
            commit(warnMb, n)
          }}
          className="h-8 w-24"
        />
      </Row>
      {invalid && (
        <p className="mt-1 text-[11px] text-destructive" role="alert">
          {negative
            ? t('request.settings.binaryLimits.validationNegative')
            : t('request.settings.binaryLimits.validationWarnExceedsBlock')}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={handleReset}
          className="text-[11px] text-primary underline-offset-2 hover:underline"
        >
          {t('request.settings.binaryLimits.resetToGithubDefaults')}
        </button>
      </div>
    </div>
  )
}
