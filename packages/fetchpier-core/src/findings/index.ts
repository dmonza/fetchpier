// Passive security findings: the evaluator plus the shared catalog and settings
// resolver, re-exported so the command line reaches all of it through core.
export { evaluateFindings } from './evaluate'
export type { FindingsExchange } from './types'
export {
  DEFAULT_CERT_EXPIRY_WARN_DAYS,
  FINDING_CATEGORIES,
  FINDING_RULES,
  FINDING_SEVERITIES,
  findingRule,
  findingsSettingsWarnings,
  resolveFindingsSettings,
  severityRank
} from '@shared/lib/findings'
export type { FindingRuleMeta, ResolvedFindingsSettings } from '@shared/lib/findings'
