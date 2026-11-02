/**
 * REQ-0070 §9.2 — guards the `FPK1-` secret-scanner rule: the regex users add to
 * gitleaks/trufflehog to catch a leaked workspace key. Keep this regex identical
 * to any published copy of the rule.
 */
import { describe, expect, it } from 'vitest'
import { formatKey, generateWorkspaceKey } from './index'

// Mirror of the documented regex `(?i)FPK1(?:-?[0-9A-Za-z]{7}){8}` (the `i` flag here
// is the JS equivalent of the inline `(?i)` used by gitleaks/trufflehog).
const SCANNER_REGEX = /FPK1(?:-?[0-9A-Za-z]{7}){8}/i

describe('FPK1 leak-scanner regex', () => {
  it('matches a freshly formatted key', async () => {
    const key = formatKey(await generateWorkspaceKey())
    expect(SCANNER_REGEX.test(key)).toBe(true)
  })

  it('matches case and hyphen variants', async () => {
    const key = formatKey(await generateWorkspaceKey())
    expect(SCANNER_REGEX.test(key.toLowerCase())).toBe(true)
    expect(SCANNER_REGEX.test(key.replace(/-/g, ''))).toBe(true)
  })

  it('does NOT match the log mask or the live marker', () => {
    expect(SCANNER_REGEX.test('{secret:apiToken}')).toBe(false)
    expect(SCANNER_REGEX.test('{$secret:apiToken:deadbeef}')).toBe(false)
  })

  it('does NOT match unrelated text', () => {
    expect(SCANNER_REGEX.test('the quick brown fox FPK')).toBe(false)
    expect(SCANNER_REGEX.test('enc:v1:abcdef')).toBe(false)
  })
})
