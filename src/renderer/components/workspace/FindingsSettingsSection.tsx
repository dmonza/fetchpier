import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { Switch } from '../ui/switch'
import { Input } from '../ui/input'
import {
  FINDING_CATEGORIES,
  FINDING_RULES,
  resolveFindingsSettings
} from '../../../shared/lib/findings'
import type { FindingSeverity, FindingsSettings } from '../../../shared/types'

const CHIP: Record<FindingSeverity, string> = {
  high: 'bg-danger/15 text-danger-text',
  medium: 'bg-warning/20 text-warning-text',
  low: 'bg-muted text-muted-foreground',
  info: 'bg-info/15 text-info-text'
}

interface Props {
  /** `http.findings` as stored (may be absent, or hold a hand edit). */
  value: FindingsSettings | undefined
  /** The whole block to save. Fields this section does not edit are carried over. */
  onChange: (next: FindingsSettings) => void
}

/** The ids of a stored `disabledRules`, strings only, in their order. */
function storedIds(value: FindingsSettings | undefined): string[] {
  return Array.isArray(value?.disabledRules)
    ? value.disabledRules.filter((id): id is string => typeof id === 'string')
    : []
}

/**
 * Workspace Settings → Security: findings on or off (the desktop's automatic
 * evaluation), the rules by category with their severity, and the certificate
 * expiry window. A rule id this version does not know is listed as ignored and
 * kept on save — it may belong to a newer version a teammate uses.
 */
export function FindingsSettingsSection({ value, onChange }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const resolved = resolveFindingsSettings(value)
  const ids = storedIds(value)
  const [expiryText, setExpiryText] = useState(String(resolved.certExpiryWarnDays))
  const expiryValid = /^\d+$/.test(expiryText.trim())

  const save = (patch: Partial<FindingsSettings>): void => onChange({ ...(value ?? {}), ...patch })

  const toggleRule = (id: string, enabled: boolean): void => {
    const next = enabled ? ids.filter((x) => x !== id) : ids.includes(id) ? ids : [...ids, id]
    save({ disabledRules: next })
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="text-[11px] text-muted-foreground">{t('workspaceSettings.findings.intro')}</p>

      <div data-findings-enabled className="flex items-center gap-3 border-b border-border pb-2">
        <span className="flex-1 text-xs font-medium">
          {t('workspaceSettings.findings.enabled')}
        </span>
        <Switch checked={resolved.enabled} onCheckedChange={(v) => save({ enabled: v })} />
      </div>

      <div className="flex items-center gap-3 border-b border-border pb-2">
        <span className="flex-1 text-xs font-medium">
          {t('workspaceSettings.findings.expiryLabel')}
        </span>
        <Input
          data-expiry
          type="number"
          min={0}
          step={1}
          value={expiryText}
          onChange={(e) => {
            const text = e.target.value
            setExpiryText(text)
            if (/^\d+$/.test(text.trim())) save({ certExpiryWarnDays: Number(text.trim()) })
          }}
          className="h-8 w-24"
        />
      </div>
      {!expiryValid && (
        <p role="alert" className="-mt-2 text-[11px] text-destructive">
          {t('workspaceSettings.findings.expiryInvalid')}
        </p>
      )}

      {FINDING_CATEGORIES.map((category) => (
        <section key={category} data-category={category}>
          <h3 className="mb-1 text-xs font-semibold">{t(`findings.category.${category}`)}</h3>
          <ul>
            {FINDING_RULES.filter((r) => r.category === category).map((rule) => (
              <li
                key={rule.id}
                data-rule={rule.id}
                className="flex items-center gap-2 border-b border-border py-1.5 last:border-b-0"
              >
                <span
                  className={cn(
                    'inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold uppercase leading-none',
                    CHIP[rule.severity]
                  )}
                >
                  {t(`findings.severity.${rule.severity}`)}
                </span>
                <span className="min-w-0 flex-1 text-xs">
                  {t(`findings.rules.${rule.id}.title`)}
                </span>
                <Switch
                  aria-label={t(`findings.rules.${rule.id}.title`)}
                  checked={!resolved.disabledRules.has(rule.id)}
                  onCheckedChange={(v) => toggleRule(rule.id, v)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {resolved.unknownRules.length > 0 && (
        <div data-unknown-rules className="rounded border border-border p-2 text-[11px]">
          <p className="mb-1 text-muted-foreground">
            {t('workspaceSettings.findings.unknownRules')}
          </p>
          <ul className="space-y-0.5">
            {resolved.unknownRules.map((id) => (
              <li key={id}>
                <code className="font-mono">{id}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {resolved.invalidFields.length > 0 && (
        <div data-invalid-fields className="rounded border border-border p-2 text-[11px]">
          <p className="mb-1 text-muted-foreground">
            {t('workspaceSettings.findings.invalidFields')}
          </p>
          <ul className="space-y-0.5">
            {resolved.invalidFields.map((field) => (
              <li key={field}>
                <code className="font-mono">{field}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
