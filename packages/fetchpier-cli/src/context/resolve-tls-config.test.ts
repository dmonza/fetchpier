import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTlsConfig } from './resolve-tls-config'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

/**
 * Security finding P1-1 — the `--tls-config` / `FETCHPIER_TLS_CONFIG` file: TLS
 * material for one run, in the workspace's `tls` block format, with its files
 * next to it. The file may carry a literal passphrase, so no error ever quotes
 * its content.
 */

const PASSPHRASE = 'literal-pass-77c1'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fp-tls-config-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, content: unknown): string => {
  const path = join(dir, name)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

const cert = (over: Record<string, unknown> = {}) => ({
  host: 'api.example.com',
  type: 'pem',
  certFile: 'client.crt',
  keyFile: 'client.key',
  ...over
})

/** Run the resolver expecting a usage error; return its message. */
async function usageError(input: Parameters<typeof resolveTlsConfig>[0]): Promise<string> {
  try {
    await resolveTlsConfig(input)
  } catch (err) {
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(EXIT.USAGE)
    return (err as CliError).message
  }
  throw new Error('expected a usage error')
}

describe('resolveTlsConfig', () => {
  it('returns nothing when neither the flag nor the variable is set', async () => {
    expect(await resolveTlsConfig({ env: {}, cwd: dir })).toBeUndefined()
  })

  it('reads the file the variable names, and lets the flag win over it', async () => {
    const fromEnv = write('env.json', { clientCertificates: [cert({ host: 'env.example.com' })] })
    const fromFlag = write('flag.json', {
      clientCertificates: [cert({ host: 'flag.example.com' })]
    })

    const viaEnv = await resolveTlsConfig({ env: { FETCHPIER_TLS_CONFIG: fromEnv }, cwd: dir })
    expect(viaEnv?.settings.clientCertificates[0].host).toBe('env.example.com')

    const both = await resolveTlsConfig({
      flag: fromFlag,
      env: { FETCHPIER_TLS_CONFIG: fromEnv },
      cwd: dir
    })
    expect(both?.settings.clientCertificates[0].host).toBe('flag.example.com')
  })

  it('resolves a relative path against the working directory; files live next to the file', async () => {
    mkdirSync(join(dir, 'local-tls'))
    writeFileSync(
      join(dir, 'local-tls', 'tls.json'),
      JSON.stringify({ clientCertificates: [cert()] })
    )

    const resolved = await resolveTlsConfig({ flag: 'local-tls/tls.json', env: {}, cwd: dir })

    expect(resolved?.certsDir).toBe(join(dir, 'local-tls'))
  })

  it('fills the fields the workspace format requires and a hand-written file may omit', async () => {
    const path = write('tls.json', { clientCertificates: [cert()] })

    const resolved = await resolveTlsConfig({ flag: path, env: {}, cwd: dir })

    expect(resolved?.settings).toEqual({
      caCertificates: [],
      clientCertificates: [
        {
          id: 'run-client-1',
          host: 'api.example.com',
          port: null,
          type: 'pem',
          certFile: 'client.crt',
          keyFile: 'client.key',
          passphrase: null,
          disabled: false
        }
      ]
    })
  })

  it('keeps what the file states, CAs included', async () => {
    const path = write('tls.json', {
      clientCertificates: [
        cert({
          id: 'mine',
          port: 8443,
          type: 'pfx',
          pfxFile: 'id.pfx',
          passphrase: '{{p}}',
          disabled: true
        })
      ],
      caCertificates: [{ id: 'corp', file: 'corp.pem' }]
    })

    const resolved = await resolveTlsConfig({ flag: path, env: {}, cwd: dir })

    expect(resolved?.settings.clientCertificates[0]).toMatchObject({
      id: 'mine',
      port: 8443,
      type: 'pfx',
      pfxFile: 'id.pfx',
      passphrase: '{{p}}',
      disabled: true
    })
    expect(resolved?.settings.caCertificates).toEqual([{ id: 'corp', file: 'corp.pem' }])
  })

  it('names the source and the path when the file does not exist', async () => {
    const missing = join(dir, 'nope.json')
    expect(await usageError({ flag: missing, env: {}, cwd: dir })).toContain('--tls-config')
    const viaEnv = await usageError({ env: { FETCHPIER_TLS_CONFIG: missing }, cwd: dir })
    expect(viaEnv).toContain('FETCHPIER_TLS_CONFIG')
    expect(viaEnv).toContain(missing)
  })

  it('never quotes the file when it is not valid JSON', async () => {
    // The parser's own message quotes the text around the error — here, a
    // literal passphrase.
    const path = write('tls.json', `{ "clientCertificates": [ { "passphrase": ${PASSPHRASE} } ] }`)

    const message = await usageError({ flag: path, env: {}, cwd: dir })

    expect(message).toContain('not valid JSON')
    expect(message).not.toContain(PASSPHRASE)
  })

  it.each([
    ['not an object', []],
    ['a list that is not a list', { clientCertificates: {} }],
    ['an entry without a host', { clientCertificates: [cert({ host: '' })] }],
    ['an unknown certificate type', { clientCertificates: [cert({ type: 'jks' })] }],
    ['a port that is not a port', { clientCertificates: [cert({ port: 'any' })] }],
    ['a PEM entry without its key file', { clientCertificates: [cert({ keyFile: undefined })] }],
    ['a PFX entry without its file', { clientCertificates: [cert({ type: 'pfx' })] }],
    ['a passphrase that is not text', { clientCertificates: [cert({ passphrase: 42 })] }],
    ['a file name that is a path', { clientCertificates: [cert({ certFile: '../client.crt' })] }],
    ['a CA without its file', { caCertificates: [{ id: 'corp' }] }]
  ])('refuses %s, without quoting the file', async (_case, content) => {
    const path = write('tls.json', {
      ...(content as object),
      ...(Array.isArray(content) ? {} : { note: PASSPHRASE })
    })
    const message = await usageError({
      flag: Array.isArray(content) ? write('list.json', content) : path,
      env: {},
      cwd: dir
    })
    expect(message).toContain('--tls-config')
    expect(message).not.toContain(PASSPHRASE)
  })
})
