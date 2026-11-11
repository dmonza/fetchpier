import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CERT_EXPIRY_WARN_DAYS,
  FINDING_CATEGORIES,
  FINDING_RULES,
  FINDING_SEVERITIES,
  findingRule,
  findingsSettingsWarnings,
  resolveFindingsSettings,
  severityRank
} from './findings'

describe('finding rule catalog', () => {
  it('holds the 25 rules of the catalog, each id unique', () => {
    expect(FINDING_RULES).toHaveLength(25)
    expect(new Set(FINDING_RULES.map((r) => r.id)).size).toBe(25)
  })

  it('does not carry the SameSite=None rule, which duplicates the cookie advisory', () => {
    expect(findingRule('cookies.samesite-none-insecure')).toBeUndefined()
  })

  it('prefixes every id with its category and uses only known severities', () => {
    for (const rule of FINDING_RULES) {
      expect(FINDING_CATEGORIES).toContain(rule.category)
      expect(FINDING_SEVERITIES).toContain(rule.severity)
      expect(rule.id.startsWith(`${rule.category}.`)).toBe(true)
    }
  })

  it.each([
    ['transport.plaintext', 'medium'],
    ['transport.plaintext-credentials', 'high'],
    ['tls.verification-disabled', 'medium'],
    ['tls.untrusted-certificate', 'high'],
    ['tls.legacy-protocol', 'high'],
    ['tls.non-aead-cipher', 'medium'],
    ['tls.certificate-expired', 'high'],
    ['tls.certificate-expiring', 'medium'],
    ['tls.weak-key', 'medium'],
    ['headers.hsts-missing', 'medium'],
    ['headers.hsts-short-max-age', 'low'],
    ['headers.nosniff-missing', 'low'],
    ['headers.csp-missing', 'low'],
    ['headers.frame-protection-missing', 'low'],
    ['headers.cors-wildcard-credentials', 'medium'],
    ['headers.cors-reflected-origin', 'medium'],
    ['headers.version-disclosure', 'info'],
    ['cookies.missing-secure', 'medium'],
    ['cookies.missing-httponly', 'low'],
    ['auth.credentials-in-query', 'medium'],
    ['cache.sensitive-cacheable', 'low'],
    ['transport.https-downgrade', 'high'],
    ['tls.no-forward-secrecy', 'medium'],
    ['cache.set-cookie-cacheable', 'medium'],
    ['headers.cors-null-origin', 'medium']
  ])('%s is %s', (id, severity) => {
    expect(findingRule(id)?.severity).toBe(severity)
  })

  it('ranks severities high → info', () => {
    expect([...FINDING_SEVERITIES].sort((a, b) => severityRank(a) - severityRank(b))).toEqual([
      'high',
      'medium',
      'low',
      'info'
    ])
  })
})

describe('resolveFindingsSettings', () => {
  const defaults = {
    enabled: true,
    certExpiryWarnDays: DEFAULT_CERT_EXPIRY_WARN_DAYS,
    unknownRules: [],
    invalidFields: []
  }

  it('applies every default when the block is absent', () => {
    const r = resolveFindingsSettings(undefined)
    expect(r).toMatchObject(defaults)
    expect([...r.disabledRules]).toEqual([])
    expect(DEFAULT_CERT_EXPIRY_WARN_DAYS).toBe(30)
  })

  it('reads a valid block as written', () => {
    const r = resolveFindingsSettings({
      enabled: false,
      disabledRules: ['headers.version-disclosure'],
      certExpiryWarnDays: 7
    })
    expect(r.enabled).toBe(false)
    expect([...r.disabledRules]).toEqual(['headers.version-disclosure'])
    expect(r.certExpiryWarnDays).toBe(7)
    expect(r.invalidFields).toEqual([])
  })

  it('ignores an unknown rule id and reports it once, in order', () => {
    const r = resolveFindingsSettings({
      disabledRules: ['no.such-rule', 'headers.csp-missing', 'no.such-rule', 'other.unknown']
    })
    expect([...r.disabledRules]).toEqual(['headers.csp-missing'])
    expect(r.unknownRules).toEqual(['no.such-rule', 'other.unknown'])
  })

  it.each([
    [0, 0],
    [1, 1],
    [365, 365]
  ])('accepts certExpiryWarnDays %s', (value, expected) => {
    expect(resolveFindingsSettings({ certExpiryWarnDays: value }).certExpiryWarnDays).toBe(expected)
  })

  it.each([[-1], [1.5], ['30'], [Number.NaN], [null], [Infinity]])(
    'falls back to 30 for certExpiryWarnDays %s and reports the field',
    (value) => {
      const r = resolveFindingsSettings({ certExpiryWarnDays: value })
      expect(r.certExpiryWarnDays).toBe(30)
      expect(r.invalidFields).toEqual(['certExpiryWarnDays'])
    }
  )

  it.each([['yes'], [1], [null]])('defaults enabled for a non-boolean %s and reports it', (v) => {
    const r = resolveFindingsSettings({ enabled: v })
    expect(r.enabled).toBe(true)
    expect(r.invalidFields).toEqual(['enabled'])
  })

  it('reports a non-array disabledRules and keeps none', () => {
    const r = resolveFindingsSettings({ disabledRules: 'headers.csp-missing' })
    expect([...r.disabledRules]).toEqual([])
    expect(r.invalidFields).toEqual(['disabledRules'])
  })

  it('drops non-string entries of disabledRules, keeps the valid ones and reports the field once', () => {
    const r = resolveFindingsSettings({ disabledRules: [1, 'headers.csp-missing', null] })
    expect([...r.disabledRules]).toEqual(['headers.csp-missing'])
    expect(r.invalidFields).toEqual(['disabledRules'])
  })

  it.each([['on'], [[]], [42]])('treats a non-object block %s as defaults and reports it', (v) => {
    const r = resolveFindingsSettings(v)
    expect(r).toMatchObject({ ...defaults, invalidFields: ['findings'] })
  })
})

describe('findingsSettingsWarnings', () => {
  it('turns unknown ids and invalid fields into advisories, names only', () => {
    const r = resolveFindingsSettings({ disabledRules: ['no.such-rule'], certExpiryWarnDays: -2 })
    expect(findingsSettingsWarnings(r)).toEqual([
      { code: 'FINDINGS_RULE_UNKNOWN', ruleId: 'no.such-rule' },
      { code: 'FINDINGS_SETTING_INVALID', field: 'certExpiryWarnDays' }
    ])
  })

  it('is empty for a valid configuration', () => {
    expect(findingsSettingsWarnings(resolveFindingsSettings({ enabled: true }))).toEqual([])
  })
})
