import { beforeAll, describe, expect, it } from 'vitest'
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { generateCACertificate } from 'mockttp'
import { connectionFactsOf, keyInfoOf } from './connection-facts'

let leafDer: Buffer
let leafValidTo: Date

beforeAll(async () => {
  const { cert } = await generateCACertificate({ subject: { commonName: 'localhost' } })
  const x509 = new X509Certificate(cert)
  leafDer = x509.raw
  leafValidTo = new Date(x509.validTo)
}, 60_000)

/** A stand-in for the transport's TLS socket, exposing what the runtime reports. */
function tlsSocket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    remoteAddress: '127.0.0.1',
    authorized: true,
    authorizationError: null,
    getProtocol: () => 'TLSv1.3',
    getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384', standardName: 'TLS_AES_256_GCM_SHA384' }),
    getPeerCertificate: () => ({ raw: leafDer }),
    ...over
  }
}

describe('keyInfoOf', () => {
  it.each([
    ['rsa', { modulusLength: 1024 }, { keyType: 'rsa', bits: 1024 }],
    ['rsa', { modulusLength: 2048 }, { keyType: 'rsa', bits: 2048 }],
    ['dsa', { modulusLength: 2048, divisorLength: 224 }, { keyType: 'dsa', bits: 2048 }]
  ] as const)('reads %s %o', (type, details, expected) => {
    const { publicKey } = generateKeyPairSync(type as 'rsa', details as { modulusLength: number })
    expect(keyInfoOf(publicKey)).toEqual(expected)
  })

  it.each([
    ['prime256v1', 256],
    ['secp384r1', 384],
    ['secp224r1', 224]
  ])('reads an EC key on %s as %i bits', (namedCurve, bits) => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve })
    expect(keyInfoOf(publicKey)).toEqual({ keyType: 'ec', bits })
  })

  it('reads an Ed25519 key without a size (the weak-key rule never applies to it)', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    expect(keyInfoOf(publicKey)).toEqual({ keyType: 'ed25519' })
  })

  it('reports RSA-PSS as rsa', () => {
    const { publicKey } = generateKeyPairSync('rsa-pss', { modulusLength: 2048 })
    expect(keyInfoOf(publicKey)).toEqual({ keyType: 'rsa', bits: 2048 })
  })
})

describe('connectionFactsOf', () => {
  it('reads protocol, cipher, verdict, leaf validity and key from a TLS socket', () => {
    const facts = connectionFactsOf(tlsSocket())
    expect(facts.remoteAddress).toBe('127.0.0.1')
    expect(facts.tls).toEqual({
      protocol: 'TLSv1.3',
      cipher: 'TLS_AES_256_GCM_SHA384',
      authorized: true,
      certificate: { validTo: leafValidTo, keyType: 'rsa', bits: 2048 }
    })
  })

  it('keeps the authorization error code, whether reported as a string or an error', () => {
    expect(
      connectionFactsOf(
        tlsSocket({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
      ).tls?.authorizationError
    ).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
    const err = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })
    expect(
      connectionFactsOf(tlsSocket({ authorized: false, authorizationError: err })).tls
        ?.authorizationError
    ).toBe('CERT_HAS_EXPIRED')
  })

  it('falls back to the cipher name when no standard name is reported', () => {
    const facts = connectionFactsOf(tlsSocket({ getCipher: () => ({ name: 'AES128-SHA' }) }))
    expect(facts.tls?.cipher).toBe('AES128-SHA')
  })

  it.each([
    ['no protocol', { getProtocol: () => null }],
    ['no cipher', { getCipher: () => undefined }],
    ['no peer certificate (resumed session)', { getPeerCertificate: () => ({}) }],
    ['an unparseable certificate', { getPeerCertificate: () => ({ raw: Buffer.from('nope') }) }],
    [
      'a throwing accessor',
      {
        getProtocol: () => {
          throw new Error('socket gone')
        }
      }
    ]
  ])('reports no TLS facts at all for %s, never partial ones', (_label, over) => {
    const facts = connectionFactsOf(tlsSocket(over))
    expect(facts.tls).toBeUndefined()
    expect(facts.remoteAddress).toBe('127.0.0.1')
  })

  it('reads only the remote address of a plain socket', () => {
    expect(connectionFactsOf({ remoteAddress: '::1' })).toEqual({ remoteAddress: '::1' })
  })

  it('reports nothing for a socket with no address yet', () => {
    expect(connectionFactsOf({})).toEqual({})
  })
})
