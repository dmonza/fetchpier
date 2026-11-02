import { describe, it, expect } from 'vitest'
import { keyDeleteToken, isKeyDeleteBlocked, canConfirmKeyDelete } from './key-delete-guard'

// REQ write-safety / CA-05 + CA-06 — the guarded key-delete decision.

describe('keyDeleteToken', () => {
  it('is the workspace name when the key has a hint', () => {
    expect(keyDeleteToken({ workspaceHint: 'acme-api', keyId: 'abcd1234abcd1234' })).toBe(
      'acme-api'
    )
  })
  it('falls back to the key id when there is no hint', () => {
    expect(keyDeleteToken({ keyId: 'abcd1234abcd1234' })).toBe('abcd1234abcd1234')
    expect(keyDeleteToken({ workspaceHint: '  ', keyId: 'abcd1234abcd1234' })).toBe(
      'abcd1234abcd1234'
    )
  })
})

describe('isKeyDeleteBlocked (CA-05)', () => {
  it('blocks when a known workspace references the key', () => {
    expect(isKeyDeleteBlocked(['acme-api'])).toBe(true)
  })
  it('does not block on an empty or absent reference', () => {
    expect(isKeyDeleteBlocked([])).toBe(false)
    expect(isKeyDeleteBlocked(undefined)).toBe(false)
  })
})

describe('canConfirmKeyDelete (CA-06)', () => {
  const token = 'acme-api'
  it('enables delete only when the typed name matches the token exactly', () => {
    expect(canConfirmKeyDelete('acme-api', token)).toBe(true)
    expect(canConfirmKeyDelete('  acme-api  ', token)).toBe(true) // trimmed
  })
  it('keeps delete disabled for an empty or wrong name', () => {
    expect(canConfirmKeyDelete('', token)).toBe(false)
    expect(canConfirmKeyDelete('acme', token)).toBe(false)
    expect(canConfirmKeyDelete('ACME-API', token)).toBe(false) // case-sensitive
  })
})
