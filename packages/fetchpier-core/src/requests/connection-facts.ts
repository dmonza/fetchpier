// What one connection says about itself, read from the socket the transport
// opened. Observation only: nothing here writes to the socket or opens another
// one (the passive-findings zero-egress invariant).

import { X509Certificate, type KeyObject } from 'node:crypto'

/** The leaf certificate's validity and key, as presented on the connection. */
export interface CertificateFacts {
  validTo: Date
  /** `rsa` (RSA-PSS included), `dsa`, `ec`, `ed25519`, `ed448`, … */
  keyType: string
  /** Key size in bits; absent for key types where size is not meaningful (Ed25519). */
  bits?: number
}

/**
 * TLS facts of one connection. All-or-nothing: protocol, cipher and the leaf
 * certificate must all be readable, otherwise no TLS facts are reported and the
 * evaluation states "TLS details not available" rather than infer anything.
 */
export interface TlsFacts {
  /** `TLSv1.3`, `TLSv1.2`, `TLSv1.1`, `TLSv1`, `SSLv3`. */
  protocol: string
  /** IANA standard name when the runtime reports one, else its own name. */
  cipher: string
  authorized: boolean
  /** The authorization error code (`DEPTH_ZERO_SELF_SIGNED_CERT`, `CERT_HAS_EXPIRED`, …). */
  authorizationError?: string
  certificate: CertificateFacts
}

export interface ConnectionFacts {
  remoteAddress?: string
  /** Present only for a TLS connection whose facts were fully readable. */
  tls?: TlsFacts
}

/** Bits of the named curves a server certificate realistically uses. */
const CURVE_BITS: Readonly<Record<string, number>> = {
  prime192v1: 192,
  secp192r1: 192,
  secp224r1: 224,
  prime256v1: 256,
  secp256r1: 256,
  secp256k1: 256,
  secp384r1: 384,
  secp521r1: 521,
  brainpoolP256r1: 256,
  brainpoolP384r1: 384,
  brainpoolP512r1: 512
}

/** Key type and size of a public key. */
export function keyInfoOf(key: KeyObject): { keyType: string; bits?: number } {
  const raw = key.asymmetricKeyType ?? 'unknown'
  const keyType = raw === 'rsa-pss' ? 'rsa' : raw
  const details = key.asymmetricKeyDetails ?? {}
  if ((keyType === 'rsa' || keyType === 'dsa') && typeof details.modulusLength === 'number') {
    return { keyType, bits: details.modulusLength }
  }
  if (keyType === 'ec' && typeof details.namedCurve === 'string') {
    const bits = CURVE_BITS[details.namedCurve]
    return bits !== undefined ? { keyType, bits } : { keyType }
  }
  return { keyType }
}

interface TlsSocketLike {
  remoteAddress?: unknown
  authorized?: unknown
  authorizationError?: unknown
  getProtocol?: () => unknown
  getCipher?: () => unknown
  getPeerCertificate?: (detailed?: boolean) => unknown
}

function authorizationCode(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object') {
    const code = (value as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return undefined
}

function readTls(socket: TlsSocketLike): TlsFacts | undefined {
  const protocol = socket.getProtocol?.()
  if (typeof protocol !== 'string' || !protocol) return undefined

  const cipherInfo = socket.getCipher?.() as { name?: unknown; standardName?: unknown } | undefined
  const cipher =
    typeof cipherInfo?.standardName === 'string' && cipherInfo.standardName
      ? cipherInfo.standardName
      : typeof cipherInfo?.name === 'string'
        ? cipherInfo.name
        : ''
  if (!cipher) return undefined

  // The leaf only: the chain is not needed, and a resumed session may report an
  // empty object — no certificate facts means no TLS facts.
  const peer = socket.getPeerCertificate?.(false) as { raw?: unknown } | undefined
  if (!peer || !Buffer.isBuffer(peer.raw) || peer.raw.length === 0) return undefined
  const x509 = new X509Certificate(peer.raw)
  const validTo = new Date(x509.validTo)
  if (Number.isNaN(validTo.getTime())) return undefined

  const authorized = socket.authorized === true
  const error = authorized ? undefined : authorizationCode(socket.authorizationError)
  return {
    protocol,
    cipher,
    authorized,
    ...(error ? { authorizationError: error } : {}),
    certificate: { validTo, ...keyInfoOf(x509.publicKey) }
  }
}

/**
 * Facts of the connection behind `socket`. Never throws: anything that cannot be
 * read is simply not reported (a socket that went away, a certificate the runtime
 * cannot parse), which the evaluation turns into "not available".
 */
export function connectionFactsOf(socket: unknown): ConnectionFacts {
  if (!socket || typeof socket !== 'object') return {}
  const s = socket as TlsSocketLike
  const facts: ConnectionFacts = {}
  try {
    if (typeof s.remoteAddress === 'string' && s.remoteAddress)
      facts.remoteAddress = s.remoteAddress
  } catch {
    // An accessor on a destroyed socket: no address.
  }
  if (typeof s.getProtocol === 'function') {
    try {
      const tls = readTls(s)
      if (tls) facts.tls = tls
    } catch {
      // Unreadable TLS facts are reported as unavailable, never guessed.
    }
  }
  return facts
}
