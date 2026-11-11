// Passive security findings — the rule catalog and the settings resolver.
//
// One definition for every consumer: the core evaluator, the command line (via
// core's re-export) and the renderer (Workspace Settings, the Security tab).
// Metadata only: each surface maps a rule id to its own human text, so nothing
// here is localized.

import type {
  ExecutionWarning,
  FindingCategory,
  FindingSeverity,
  FindingsSettingInvalidWarning
} from '../types'

export interface FindingRuleMeta {
  /** Stable id, `<category>.<name>`. */
  id: string
  category: FindingCategory
  severity: FindingSeverity
}

/** The catalog, in display order (by category, then as specified). */
export const FINDING_RULES: readonly FindingRuleMeta[] = Object.freeze([
  { id: 'transport.plaintext', category: 'transport', severity: 'medium' },
  { id: 'transport.plaintext-credentials', category: 'transport', severity: 'high' },
  { id: 'transport.https-downgrade', category: 'transport', severity: 'high' },
  { id: 'tls.verification-disabled', category: 'tls', severity: 'medium' },
  { id: 'tls.untrusted-certificate', category: 'tls', severity: 'high' },
  { id: 'tls.legacy-protocol', category: 'tls', severity: 'high' },
  { id: 'tls.non-aead-cipher', category: 'tls', severity: 'medium' },
  { id: 'tls.no-forward-secrecy', category: 'tls', severity: 'medium' },
  { id: 'tls.certificate-expired', category: 'tls', severity: 'high' },
  { id: 'tls.certificate-expiring', category: 'tls', severity: 'medium' },
  { id: 'tls.weak-key', category: 'tls', severity: 'medium' },
  { id: 'headers.hsts-missing', category: 'headers', severity: 'medium' },
  { id: 'headers.hsts-short-max-age', category: 'headers', severity: 'low' },
  { id: 'headers.nosniff-missing', category: 'headers', severity: 'low' },
  { id: 'headers.csp-missing', category: 'headers', severity: 'low' },
  { id: 'headers.frame-protection-missing', category: 'headers', severity: 'low' },
  { id: 'headers.cors-wildcard-credentials', category: 'headers', severity: 'medium' },
  { id: 'headers.cors-reflected-origin', category: 'headers', severity: 'medium' },
  { id: 'headers.cors-null-origin', category: 'headers', severity: 'medium' },
  { id: 'headers.version-disclosure', category: 'headers', severity: 'info' },
  { id: 'cookies.missing-secure', category: 'cookies', severity: 'medium' },
  { id: 'cookies.missing-httponly', category: 'cookies', severity: 'low' },
  { id: 'auth.credentials-in-query', category: 'auth', severity: 'medium' },
  { id: 'cache.sensitive-cacheable', category: 'cache', severity: 'low' },
  { id: 'cache.set-cookie-cacheable', category: 'cache', severity: 'medium' }
] satisfies FindingRuleMeta[])

export const FINDING_CATEGORIES: readonly FindingCategory[] = Object.freeze([
  'transport',
  'tls',
  'headers',
  'cookies',
  'auth',
  'cache'
] satisfies FindingCategory[])

/** Most severe first. */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = Object.freeze([
  'high',
  'medium',
  'low',
  'info'
] satisfies FindingSeverity[])

const RULES_BY_ID: ReadonlyMap<string, FindingRuleMeta> = new Map(
  FINDING_RULES.map((r) => [r.id, r])
)

/** The rule with this id, or `undefined` when this version does not know it. */
export function findingRule(id: string): FindingRuleMeta | undefined {
  return RULES_BY_ID.get(id)
}

/** 0 for `high` … 3 for `info` — sort ascending for most severe first. */
export function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.indexOf(severity)
}

export const DEFAULT_CERT_EXPIRY_WARN_DAYS = 30

type InvalidField = FindingsSettingInvalidWarning['field']

/** `http.findings` with every default applied, plus what could not be used. */
export interface ResolvedFindingsSettings {
  /** The desktop's automatic evaluation. The command line ignores it. */
  enabled: boolean
  /** Known rule ids to skip. */
  disabledRules: ReadonlySet<string>
  certExpiryWarnDays: number
  /** Ids in `disabledRules` this version does not know, in order, once each. */
  unknownRules: string[]
  /** Fields whose value was unusable (their default applied), in order, once each. */
  invalidFields: InvalidField[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Interpret a stored `http.findings` block. Never throws: an unusable value takes
 * its default and is reported in `invalidFields`, an unknown rule id is ignored
 * and reported in `unknownRules`. A hand edit can never break a send or a run.
 */
export function resolveFindingsSettings(raw: unknown): ResolvedFindingsSettings {
  const invalidFields: InvalidField[] = []
  const unknownRules: string[] = []
  const disabled = new Set<string>()
  let enabled = true
  let certExpiryWarnDays = DEFAULT_CERT_EXPIRY_WARN_DAYS

  if (raw !== undefined && !isPlainObject(raw)) {
    invalidFields.push('findings')
    return { enabled, disabledRules: disabled, certExpiryWarnDays, unknownRules, invalidFields }
  }
  const block = raw ?? {}

  if ('enabled' in block && block.enabled !== undefined) {
    if (typeof block.enabled === 'boolean') enabled = block.enabled
    else invalidFields.push('enabled')
  }

  if ('disabledRules' in block && block.disabledRules !== undefined) {
    if (!Array.isArray(block.disabledRules)) {
      invalidFields.push('disabledRules')
    } else {
      let sawInvalidEntry = false
      for (const entry of block.disabledRules as unknown[]) {
        if (typeof entry !== 'string') {
          sawInvalidEntry = true
          continue
        }
        if (RULES_BY_ID.has(entry)) disabled.add(entry)
        else if (!unknownRules.includes(entry)) unknownRules.push(entry)
      }
      if (sawInvalidEntry) invalidFields.push('disabledRules')
    }
  }

  if ('certExpiryWarnDays' in block && block.certExpiryWarnDays !== undefined) {
    const v = block.certExpiryWarnDays
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) certExpiryWarnDays = v
    else invalidFields.push('certExpiryWarnDays')
  }

  return { enabled, disabledRules: disabled, certExpiryWarnDays, unknownRules, invalidFields }
}

/** The advisories a resolved configuration warrants: names only, never values. */
export function findingsSettingsWarnings(resolved: ResolvedFindingsSettings): ExecutionWarning[] {
  return [
    ...resolved.unknownRules.map((ruleId): ExecutionWarning => ({
      code: 'FINDINGS_RULE_UNKNOWN',
      ruleId
    })),
    ...resolved.invalidFields.map((field): ExecutionWarning => ({
      code: 'FINDINGS_SETTING_INVALID',
      field
    }))
  ]
}
