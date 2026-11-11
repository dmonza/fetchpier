import { describe, expect, it } from 'vitest'
import { findings } from '@fetchpier/core'
import { FINDING_MESSAGES, findingMessage } from './findings-messages'

describe('CLI findings message table', () => {
  it.each(findings.FINDING_RULES.map((r) => r.id))(
    'has a title, rationale and reference for %s',
    (id) => {
      const m = FINDING_MESSAGES[id]
      expect(m?.title.trim()).toBeTruthy()
      expect(m?.rationale.trim()).toBeTruthy()
      expect(m?.reference.trim()).toBeTruthy()
    }
  )

  it('has no entry for a rule the catalog does not carry', () => {
    const ids = new Set(findings.FINDING_RULES.map((r) => r.id))
    expect(Object.keys(FINDING_MESSAGES).filter((id) => !ids.has(id))).toEqual([])
  })

  // Copy rule: no text states a verdict; the cookie attribute `Secure` is a name.
  it('states no verdict', () => {
    const offending = Object.entries(FINDING_MESSAGES).filter(([, m]) =>
      [m.title, m.rationale, m.reference].some(
        (s) => /\b(secure|safe|safely|passed)\b/.test(s) || /\bOK\b/.test(s)
      )
    )
    expect(offending).toEqual([])
  })

  it('cites current sources: RFC 9525, never the obsoleted RFC 6125', () => {
    expect(Object.values(FINDING_MESSAGES).filter((m) => /RFC 6125\b/.test(m.reference))).toEqual(
      []
    )
    expect(FINDING_MESSAGES['tls.verification-disabled'].reference).toContain('RFC 9525')
  })

  it('falls back to the rule id for an id it does not know', () => {
    expect(findingMessage('future.rule').title).toBe('future.rule')
  })
})
