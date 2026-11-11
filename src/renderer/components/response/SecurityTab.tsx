import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { FINDING_SEVERITIES } from '../../../shared/lib/findings'
import type { Finding, FindingSeverity, FindingsEvaluation } from '../../../shared/types'

/** Badge tone of the Security tab, from the most severe non-info finding. */
export type SecurityBadgeTone = 'danger' | 'warning' | 'neutral'

/**
 * The Security tab's badge: the count of findings other than `info`, toned by the
 * highest severity present. `null` when there is nothing to count — an
 * info-only result lights nothing, so version banners alone never mark a send.
 */
export function securityBadge(
  findings: FindingsEvaluation | undefined
): { count: number; tone: SecurityBadgeTone } | null {
  if (findings?.status !== 'evaluated') return null
  const counted = findings.items.filter((f) => f.severity !== 'info')
  if (counted.length === 0) return null
  const tone: SecurityBadgeTone = counted.some((f) => f.severity === 'high')
    ? 'danger'
    : counted.some((f) => f.severity === 'medium')
      ? 'warning'
      : 'neutral'
  return { count: counted.length, tone }
}

/** Severity chip colours — semantic tokens only; never a success hue. */
const CHIP: Record<FindingSeverity, string> = {
  high: 'bg-danger/15 text-danger-text',
  medium: 'bg-warning/20 text-warning-text',
  low: 'bg-muted text-muted-foreground',
  info: 'bg-info/15 text-info-text'
}

function SeverityChip({ severity }: { severity: FindingSeverity }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold uppercase leading-none',
        CHIP[severity]
      )}
    >
      {t(`findings.severity.${severity}`)}
    </span>
  )
}

function FindingRow({ finding }: { finding: Finding }): React.JSX.Element {
  const { t } = useTranslation()
  const evidence = Object.entries(finding.evidence)
  return (
    <li data-finding={finding.ruleId} className="flex gap-2 border-b border-border px-3 py-2">
      <SeverityChip severity={finding.severity} />
      <div className="min-w-0 flex-1 space-y-0.5 text-xs">
        <p className="font-medium text-foreground">{t(`findings.rules.${finding.ruleId}.title`)}</p>
        {evidence.length > 0 && (
          <p className="flex flex-wrap gap-x-3 text-muted-foreground">
            {evidence.map(([key, value]) => (
              <span key={key}>
                {t(`findings.evidence.${key}`)}:{' '}
                <code className="font-mono text-foreground">{value}</code>
              </span>
            ))}
          </p>
        )}
        <p className="text-muted-foreground">{t(`findings.rules.${finding.ruleId}.rationale`)}</p>
        <p className="text-[11px] text-muted-foreground">
          {t('response.security.reference')}: {t(`findings.rules.${finding.ruleId}.reference`)}
        </p>
      </div>
    </li>
  )
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

export interface SecurityTabProps {
  /** Findings of the last send, when it was evaluated. */
  findings?: FindingsEvaluation
  /** Whether the workspace evaluates findings (`http.findings.enabled`). */
  enabled: boolean
  /** The send's failure reason, when it ended without a response. */
  error: string | null
  onOpenSettings: () => void
  /** The viewer's usual placeholder, shown before anything was sent. */
  emptyState: React.ReactNode
}

/**
 * The response viewer's Security panel. Reports what the passive rules found in
 * the exchange the send already performed — and, when nothing fired, says only
 * that: never "secure", "safe" or "passed".
 */
export function SecurityTab({
  findings,
  enabled,
  error,
  onOpenSettings,
  emptyState
}: SecurityTabProps): React.JSX.Element {
  const { t } = useTranslation()

  if (!enabled) {
    return (
      <Centered>
        <span>{t('response.security.turnedOff')}</span>
        <Button size="sm" variant="outline" onClick={onOpenSettings}>
          {t('response.security.openSettings')}
        </Button>
      </Centered>
    )
  }
  if (findings?.status === 'failed') {
    return <Centered>{t('response.security.evaluationFailed')}</Centered>
  }
  if (!findings) {
    return error ? <Centered>{t('response.security.noResponse')}</Centered> : <>{emptyState}</>
  }

  const groups = FINDING_SEVERITIES.map((severity) => ({
    severity,
    items: findings.items.filter((f) => f.severity === severity)
  })).filter((g) => g.items.length > 0 || (g.severity === 'info' && findings.tls === 'unavailable'))

  return (
    <div className="h-full overflow-auto">
      <h2 className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
        {t('response.security.heading')}
      </h2>
      {findings.items.length === 0 && (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {t('response.security.noFindings', { n: findings.rulesApplied })}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.severity} data-severity-group={group.severity}>
          <h3 className="bg-surface-2 px-3 py-1 text-[11px] font-semibold text-muted-foreground">
            {t(`findings.severityGroup.${group.severity}`, { count: group.items.length })}
          </h3>
          <ul>
            {group.items.map((f, i) => (
              <FindingRow key={`${f.ruleId}-${i}`} finding={f} />
            ))}
            {group.severity === 'info' && findings.tls === 'unavailable' && (
              <li className="flex gap-2 border-b border-border px-3 py-2 text-xs">
                <SeverityChip severity="info" />
                <span className="text-foreground">{t('response.security.tlsUnavailable')}</span>
              </li>
            )}
          </ul>
        </section>
      ))}
    </div>
  )
}
