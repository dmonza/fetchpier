type Translate = (key: string, opts?: Record<string, unknown>) => string

/** What the user was doing when the certificate operation failed. */
export type CertificateAction = 'import' | 'save' | 'remove' | 'toggle'

/**
 * The reason codes the certificate store throws. The code leads the error
 * message (only the message crosses IPC), so it is matched as a token.
 */
const CODE_KEYS: Record<string, string> = {
  TLS_HOST_REQUIRED: 'certificates.errors.hostRequired',
  TLS_HOST_INVALID: 'certificates.errors.invalidHost',
  TLS_PORT_INVALID: 'certificates.errors.invalidPort',
  TLS_FILES_REQUIRED: 'certificates.errors.fileRequired',
  TLS_CERT_NOT_PEM: 'certificates.errors.certNotPem',
  TLS_CERT_INVALID: 'certificates.errors.certInvalid',
  TLS_KEY_NOT_PEM: 'certificates.errors.keyNotPem',
  TLS_KEY_INVALID: 'certificates.errors.keyInvalid',
  TLS_PFX_TRUNCATED: 'certificates.errors.pfxTruncated',
  TLS_PFX_NOT_PKCS12: 'certificates.errors.pfxInvalid'
}

/** Electron's `Error invoking remote method '<channel>': ` and the error class. */
const REMOTE_PREFIX = /^Error invoking remote method '[^']*': /
const CLASS_PREFIX = /^[A-Za-z]*Error: /

/**
 * The text shown for a failed certificate operation: the translated reason for
 * a known code, otherwise the action's translated failure with the bare message
 * (never Electron's IPC prefix or the error class).
 */
export function certificateErrorText(
  err: unknown,
  action: CertificateAction,
  t: Translate
): string {
  const msg = err instanceof Error ? err.message : String(err)
  for (const token of msg.match(/\bTLS_[A-Z0-9_]+\b/g) ?? []) {
    const key = CODE_KEYS[token]
    if (key) return t(key)
  }
  const message = msg.replace(REMOTE_PREFIX, '').replace(CLASS_PREFIX, '')
  return t(`certificates.errors.${action}Failed`, { message })
}
