import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createPrivateKey } from 'node:crypto'
import { readPemCertFile, readPemKeyFile, readPfxFile, TlsImportError } from './import'

let tmpRoot: string

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'fp-tls-import-'))
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function writeFixture(name: string, content: string | Buffer): Promise<string> {
  const filePath = join(tmpRoot, name)
  await fs.writeFile(filePath, content)
  return filePath
}

/**
 * Build a syntactically valid PEM CERTIFICATE block from a static fixture
 * lifted from the Node test suite. Avoids running a full X.509 issuance in
 * unit tests while still parsing correctly through X509Certificate.
 */
const VALID_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUVKi9KIDClUiBgEMtq7msIVnZIPwwDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCVVMxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNDA5MTAxMjAwMDBaFw0zNDA5
MDgxMjAwMDBaMEUxCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDQOnZf3rZQqGAxBNTWnvMKjpKbsEzdAcr/iLQGfbpV
0lF3oVk46GLNwYltKjL2J19jD+y9pyfL+3SLBu5VxPfsftFt7olwfpL/ZTrAcCxe
EJqd6gJnZ+B+rqJsXJp89dBPRX/MmnFCmJJSGwZGFsP4ZIA+ZNlWoyAGGwOq8L3y
GZNTV3hsfdLqvKLfQ3iIxJypzG8aD0/5zULRH1JCXFXrhPRPDdwIIJqyEgrV+SCo
GFCv9j6BcyqyrUw2OvojfRyIWPRyEemX+1/JC6S0bGRoSUOgZQClUH6RKAcGypXl
QnpD1MIQ4DEsfSb1qLO5b/F6cTatNYrR/8wOdJI9d4OXAgMBAAGjUzBRMB0GA1Ud
DgQWBBSxRENuU8VeAEEnSEjcyfwTo3hPDDAfBgNVHSMEGDAWgBSxRENuU8VeAEEn
SEjcyfwTo3hPDDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCV
8w65EVbE3DM3sQDxIBz+9bvW9Q8aafIuylgGsvkLhX2nL15rEH4O8L48n3CnSqUg
3StupGn8RcVk3eW4yX67ny6Tm0FsNAFTKqIIHTtHrJjQ1HZ5zo7ZJjlh1IJtxe4r
ZN6gXmJxnxROZqkqLB8m4u3wYwUykG+8h2sB8a/8MzcZW1ImOOH7AbWccGYBbqjK
1IhrSb5RNz0kVxlYqaApjMz1pbtPRPbZOrtb1OkX8s1Q3LpQNlVKlsx7gT/UWdYj
W3vjsfdwiW+rJ5KKWXk1n5q9KOyo0e6gKwMOl3xPMrxlbsR6T0BAg9bDP9CXspGd
H3SVPtKvUjQfytV5gz29
-----END CERTIFICATE-----
`

function generatePemKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  return privateKey
}

describe('readPemCertFile', () => {
  it('accepts a valid single-cert PEM file', async () => {
    const p = await writeFixture('valid.pem', VALID_PEM_CERT)
    const result = await readPemCertFile(p)
    expect(result.certCount).toBe(1)
    expect(result.content.length).toBeGreaterThan(0)
  })

  it('accepts a PEM bundle with multiple certificates', async () => {
    const p = await writeFixture('bundle.pem', VALID_PEM_CERT + VALID_PEM_CERT)
    const result = await readPemCertFile(p)
    expect(result.certCount).toBe(2)
  })

  it('rejects a file with no PEM CERTIFICATE block', async () => {
    const p = await writeFixture('garbage.pem', 'not a cert\n')
    await expect(readPemCertFile(p)).rejects.toBeInstanceOf(TlsImportError)
    // TLS-12: a stable code, led by its token so it survives the IPC wrapping.
    await expect(readPemCertFile(p)).rejects.toMatchObject({
      code: 'TLS_CERT_NOT_PEM',
      message: expect.stringMatching(/^TLS_CERT_NOT_PEM: /)
    })
  })

  it('rejects a file with malformed PEM data inside the block', async () => {
    const malformed = '-----BEGIN CERTIFICATE-----\nnot-base64-at-all\n-----END CERTIFICATE-----\n'
    const p = await writeFixture('malformed.pem', malformed)
    await expect(readPemCertFile(p)).rejects.toBeInstanceOf(TlsImportError)
    await expect(readPemCertFile(p)).rejects.toMatchObject({ code: 'TLS_CERT_INVALID' })
  })
})

describe('readPemKeyFile', () => {
  it('accepts an unencrypted PKCS#8 private key', async () => {
    const p = await writeFixture('valid.key', generatePemKey())
    const result = await readPemKeyFile(p)
    expect(result.content.length).toBeGreaterThan(0)
  })

  it('rejects a file with no PRIVATE KEY block', async () => {
    const p = await writeFixture('garbage.key', 'definitely not a key')
    await expect(readPemKeyFile(p)).rejects.toBeInstanceOf(TlsImportError)
    await expect(readPemKeyFile(p)).rejects.toMatchObject({ code: 'TLS_KEY_NOT_PEM' })
  })

  it('rejects an unencrypted key block that does not parse (TLS-12 code)', async () => {
    const p = await writeFixture(
      'broken.key',
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'
    )
    await expect(readPemKeyFile(p)).rejects.toMatchObject({ code: 'TLS_KEY_INVALID' })
  })

  it('accepts a passphrase-protected key without trying the passphrase', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'topsecret'
      }
    })
    const p = await writeFixture('encrypted.key', privateKey)
    const result = await readPemKeyFile(p)
    expect(result.content.length).toBeGreaterThan(0)
  })
})

describe('readPfxFile', () => {
  it('accepts a file beginning with a DER SEQUENCE tag', async () => {
    const buf = Buffer.concat([Buffer.from([0x30, 0x82, 0x01, 0x00]), Buffer.alloc(252)])
    const p = await writeFixture('fake.pfx', buf)
    const result = await readPfxFile(p)
    expect(result.content.length).toBeGreaterThan(0)
  })

  it('rejects an empty file', async () => {
    const p = await writeFixture('empty.pfx', Buffer.alloc(0))
    await expect(readPfxFile(p)).rejects.toBeInstanceOf(TlsImportError)
    await expect(readPfxFile(p)).rejects.toMatchObject({ code: 'TLS_PFX_TRUNCATED' })
  })

  it('rejects a file that does not start with 0x30', async () => {
    const p = await writeFixture('badmagic.pfx', Buffer.from([0xff, 0xff, 0xff]))
    await expect(readPfxFile(p)).rejects.toBeInstanceOf(TlsImportError)
    await expect(readPfxFile(p)).rejects.toMatchObject({ code: 'TLS_PFX_NOT_PKCS12' })
  })
})

describe('createPrivateKey integration (sanity)', () => {
  it('encrypted key parsing without passphrase throws an OpenSSL error', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'x'
      }
    })
    let caught: Error | undefined
    try {
      createPrivateKey({ key: privateKey, format: 'pem' })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    const code = (caught as NodeJS.ErrnoException).code ?? ''
    expect(
      /passphrase|encrypted|bad decrypt|interrupted or cancelled/i.test(caught!.message) ||
        code.startsWith('ERR_OSSL_')
    ).toBe(true)
  })
})
