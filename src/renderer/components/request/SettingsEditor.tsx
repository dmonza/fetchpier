import { useTranslation } from 'react-i18next'
import { Info, RotateCcw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Switch } from '../ui/switch'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { useWorkspaceSettingsStore } from '../../stores/workspaceSettings'
import { ClientCertificatePreview } from './ClientCertificatePreview'
import type {
  HttpVersion,
  RequestSettings,
  SettingValue,
  WorkspaceHttpSettings
} from '../../../shared/types'

type FieldKey = keyof RequestSettings & keyof WorkspaceHttpSettings

interface Props {
  settings: RequestSettings
  onChange: (next: RequestSettings) => void
  readOnly?: boolean
  /** Current URL of the request — used to preview which client cert will be sent. */
  url?: string
}

function isOverridden<T>(v: SettingValue<T> | undefined): v is { inherit: false; value: T } {
  return !!v && v.inherit === false
}

function effectiveValue<K extends FieldKey>(
  settings: RequestSettings,
  workspace: WorkspaceHttpSettings,
  key: K
): WorkspaceHttpSettings[K] {
  const v = settings[key] as SettingValue<WorkspaceHttpSettings[K]> | undefined
  if (isOverridden(v)) return v.value
  return workspace[key]
}

export function SettingsEditor({ settings, onChange, readOnly, url }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const workspace = useWorkspaceSettingsStore((s) => s.httpSettings)

  const setField = <K extends FieldKey>(
    key: K,
    value: WorkspaceHttpSettings[K] | undefined
  ): void => {
    if (readOnly) return
    const next: RequestSettings = { ...settings }
    if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(next as any)[key] = { inherit: true }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(next as any)[key] = { inherit: false, value }
    }
    onChange(next)
  }

  const reset = (key: FieldKey): void => {
    if (readOnly) return
    const next: RequestSettings = { ...settings }
    delete next[key]
    onChange(next)
  }

  const followRedirectsEffective = effectiveValue(settings, workspace, 'followRedirects')

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-2 p-3">
        <SettingRow
          label={t('request.settings.httpVersion')}
          hint={t('request.settings.hints.httpVersion')}
          overridden={isOverridden(settings.httpVersion)}
          onReset={() => reset('httpVersion')}
          readOnly={readOnly}
        >
          <Select
            value={effectiveValue(settings, workspace, 'httpVersion')}
            onValueChange={(v) => setField('httpVersion', v as HttpVersion)}
            disabled={readOnly}
          >
            <SelectTrigger
              size="sm"
              className={cn(
                'h-8 w-40 text-xs',
                !isOverridden(settings.httpVersion) && 'text-muted-foreground'
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('request.settings.httpVersionOptions.auto')}</SelectItem>
              <SelectItem value="http1">HTTP/1.1</SelectItem>
              <SelectItem value="http2">HTTP/2</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <BooleanRow
          settings={settings}
          workspace={workspace}
          fieldKey="verifySsl"
          label={t('request.settings.verifySsl')}
          hint={t('request.settings.hints.verifySsl')}
          onSet={(v) => setField('verifySsl', v)}
          onReset={() => reset('verifySsl')}
          readOnly={readOnly}
        />

        <BooleanRow
          settings={settings}
          workspace={workspace}
          fieldKey="followRedirects"
          label={t('request.settings.followRedirects')}
          hint={t('request.settings.hints.followRedirects')}
          onSet={(v) => setField('followRedirects', v)}
          onReset={() => reset('followRedirects')}
          readOnly={readOnly}
        />

        <SettingRow
          label={t('request.settings.maxRedirects')}
          hint={t('request.settings.hints.maxRedirects')}
          overridden={isOverridden(settings.maxRedirects)}
          onReset={() => reset('maxRedirects')}
          readOnly={readOnly || !followRedirectsEffective}
        >
          <Input
            type="number"
            min={0}
            max={50}
            value={effectiveValue(settings, workspace, 'maxRedirects')}
            disabled={readOnly || !followRedirectsEffective}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (!Number.isFinite(n)) return
              setField('maxRedirects', Math.max(0, Math.min(50, Math.round(n))))
            }}
            className={cn(
              'h-8 w-24',
              !isOverridden(settings.maxRedirects) && 'text-muted-foreground'
            )}
          />
        </SettingRow>

        <BooleanRow
          settings={settings}
          workspace={workspace}
          fieldKey="followAuthorizationOnRedirect"
          label={t('request.settings.followAuthorizationOnRedirect')}
          hint={t('request.settings.hints.followAuthorizationOnRedirect')}
          onSet={(v) => setField('followAuthorizationOnRedirect', v)}
          onReset={() => reset('followAuthorizationOnRedirect')}
          readOnly={readOnly || !followRedirectsEffective}
        />

        <BooleanRow
          settings={settings}
          workspace={workspace}
          fieldKey="encodeUrl"
          label={t('request.settings.encodeUrl')}
          hint={t('request.settings.hints.encodeUrl')}
          onSet={(v) => setField('encodeUrl', v)}
          onReset={() => reset('encodeUrl')}
          readOnly={readOnly}
        />

        <BooleanRow
          settings={settings}
          workspace={workspace}
          fieldKey="disableCookieJar"
          label={t('request.settings.disableCookieJar')}
          hint={t('request.settings.hints.disableCookieJar')}
          onSet={(v) => setField('disableCookieJar', v)}
          onReset={() => reset('disableCookieJar')}
          readOnly={readOnly}
        />

        <ClientCertificatePreview url={url ?? ''} />
      </div>
    </TooltipProvider>
  )
}

interface SettingRowProps {
  label: string
  hint: string
  overridden: boolean
  onReset: () => void
  readOnly?: boolean
  children: React.ReactNode
}

function SettingRow({
  label,
  hint,
  overridden,
  onReset,
  readOnly,
  children
}: SettingRowProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              tabIndex={-1}
            >
              <Info className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
        <Badge variant={overridden ? 'outline' : 'muted'} className="ml-1">
          {overridden ? t('request.settings.overridden') : t('request.settings.defaultWorkspace')}
        </Badge>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {overridden && !readOnly && (
          <button
            type="button"
            title={t('request.settings.resetToDefault')}
            onClick={onReset}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

interface BooleanRowProps {
  settings: RequestSettings
  workspace: WorkspaceHttpSettings
  fieldKey:
    | 'verifySsl'
    | 'followRedirects'
    | 'followAuthorizationOnRedirect'
    | 'encodeUrl'
    | 'disableCookieJar'
  label: string
  hint: string
  onSet: (v: boolean) => void
  onReset: () => void
  readOnly?: boolean
}

function BooleanRow({
  settings,
  workspace,
  fieldKey,
  label,
  hint,
  onSet,
  onReset,
  readOnly
}: BooleanRowProps): React.JSX.Element {
  const v = settings[fieldKey] as SettingValue<boolean> | undefined
  const overridden = isOverridden(v)
  const effective = overridden ? v.value : workspace[fieldKey]
  return (
    <SettingRow
      label={label}
      hint={hint}
      overridden={overridden}
      onReset={onReset}
      readOnly={readOnly}
    >
      <Switch
        checked={effective}
        onCheckedChange={onSet}
        disabled={readOnly}
        className={cn(!overridden && 'opacity-70')}
      />
    </SettingRow>
  )
}
