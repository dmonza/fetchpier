import { describe, expect, it } from 'vitest'
import { certificateErrorText } from './certificate-error'

const t = (key: string, opts?: Record<string, unknown>): string =>
  opts ? `t:${key}:${JSON.stringify(opts)}` : `t:${key}`

const remote = (channel: string, inner: string): Error =>
  new Error(`Error invoking remote method '${channel}': ${inner}`)

describe('certificateErrorText (TLS-12)', () => {
  it.each([
    ['TLS_HOST_REQUIRED', 'certificates.errors.hostRequired'],
    ['TLS_HOST_INVALID', 'certificates.errors.invalidHost'],
    ['TLS_PORT_INVALID', 'certificates.errors.invalidPort'],
    ['TLS_FILES_REQUIRED', 'certificates.errors.fileRequired'],
    ['TLS_CERT_NOT_PEM', 'certificates.errors.certNotPem'],
    ['TLS_CERT_INVALID', 'certificates.errors.certInvalid'],
    ['TLS_KEY_NOT_PEM', 'certificates.errors.keyNotPem'],
    ['TLS_KEY_INVALID', 'certificates.errors.keyInvalid'],
    ['TLS_PFX_TRUNCATED', 'certificates.errors.pfxTruncated'],
    ['TLS_PFX_NOT_PKCS12', 'certificates.errors.pfxInvalid']
  ])('translates %s, whatever wraps it', (code, key) => {
    const err = remote('certificates:addCA', `TlsImportError: ${code}: some English reason`)
    expect(certificateErrorText(err, 'import', t)).toBe(`t:${key}`)
  })

  it('falls back to the action message without Electron prefix or error class', () => {
    const err = remote('certificates:remove', 'Error: EACCES: permission denied, rename')
    expect(certificateErrorText(err, 'remove', t)).toBe(
      't:certificates.errors.removeFailed:{"message":"EACCES: permission denied, rename"}'
    )
  })

  it.each(['import', 'save', 'remove', 'toggle'] as const)(
    'names the %s action in the fallback',
    (action) => {
      expect(certificateErrorText(new Error('disk full'), action, t)).toBe(
        `t:certificates.errors.${action}Failed:{"message":"disk full"}`
      )
    }
  )

  it('handles a rejection that is not an Error', () => {
    expect(certificateErrorText('boom', 'toggle', t)).toBe(
      't:certificates.errors.toggleFailed:{"message":"boom"}'
    )
  })

  it('ignores an unknown TLS_ token and uses the fallback', () => {
    expect(certificateErrorText(new Error('TLS_SOMETHING_NEW: x'), 'save', t)).toBe(
      't:certificates.errors.saveFailed:{"message":"TLS_SOMETHING_NEW: x"}'
    )
  })
})
