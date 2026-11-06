/**
 * REQ-0089 — CLI workspace TLS parity.
 *
 * The runner composes workspace TLS material through the same core resolver the
 * desktop uses, keyed off the workspace path, and resolves a client-cert
 * passphrase that references a secret — lazily, under the injected workspace key.
 *
 * - A secret referenced *only* by the passphrase is decrypted when a matching
 *   workspace cert is selected; with no key the run fails SECRETS_KEY_MISSING
 *   before the handshake (CA-09 no-key branch).
 * - Laziness: a run whose request does not select a client cert needs no key.
 * - The removed `--cacert` flag is rejected as an unknown option (CA-11).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { Command } from 'commander'
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp'
import { secrets } from '@fetchpier/core'
import { executeRun } from '../../src/commands/request/run'
import { addRunOptions } from '../../src/commands/run-options'
import { EXIT } from '../../src/exit-codes'

let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
})

afterAll(async () => {
  await server.stop()
})

const workspaces: string[] = []
afterEach(() => {
  for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true })
})

const silentCtx = { write: () => {}, writeErr: () => {} }

/**
 * Workspace with a `localhost` PFX client certificate whose passphrase references
 * the secret `cert_pass`. The secret is encrypted under a fresh key whose `FPK1-`
 * form is returned for `FETCHPIER_WORKSPACE_KEY`.
 */
async function makeTlsWorkspace(): Promise<{ ws: string; fpk: string }> {
  const ws = mkdtempSync(join(tmpdir(), 'fp-cli-tls-'))
  workspaces.push(ws)
  mkdirSync(join(ws, '.fetchpier', 'certs'), { recursive: true })

  const key = await secrets.generateWorkspaceKey()
  const fpk = secrets.formatKey(key)
  const manifest = await secrets.buildManifest(key)
  writeFileSync(join(ws, '.fetchpier', 'secrets.json'), secrets.serializeManifest(manifest))
  const encPass = await secrets.encryptValue(key, 'cert_pass', 'pfx-passphrase')

  writeFileSync(
    join(ws, '.fetchpier', 'settings.json'),
    JSON.stringify({
      version: 1,
      http: {
        tls: {
          caCertificates: [],
          clientCertificates: [
            {
              id: 'cc-1',
              host: 'localhost',
              port: null,
              type: 'pfx',
              pfxFile: 'client-1234.pfx',
              passphrase: '{{cert_pass}}',
              disabled: false
            }
          ]
        }
      }
    })
  )
  writeFileSync(join(ws, '.fetchpier', 'certs', 'client-1234.pfx'), 'PFXBYTES')

  const envDir = join(ws, 'environments', 'default')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(
    join(envDir, 'config.json'),
    JSON.stringify({
      id: 'default',
      name: 'default',
      variables: { baseUrl: server.url, cert_pass: encPass }
    })
  )

  const reqDir = join(ws, 'requests')
  mkdirSync(reqDir, { recursive: true })
  // https → matches the localhost cert → the passphrase secret must resolve.
  // Port 1 is unreachable, but the secret gate runs before the handshake.
  writeFileSync(join(reqDir, 'secure.http'), 'GET https://localhost:1/secure\n')
  // http → no client-cert match → resolver needs no key (lazy).
  writeFileSync(join(reqDir, 'plain.http'), 'GET {{baseUrl}}/plain\n')

  return { ws, fpk }
}

describe('CLI workspace TLS parity (REQ-0089)', () => {
  it('fails with SECRETS_KEY_MISSING when a secret passphrase is selected and no key is injected', async () => {
    const { ws } = await makeTlsWorkspace()
    await expect(
      executeRun(
        { paths: ['requests/secure.http'], workspace: ws, timeoutMs: 2000 },
        { cwd: ws, env: {} as NodeJS.ProcessEnv, reporterContext: silentCtx }
      )
    ).rejects.toMatchObject({ code: 'SECRETS_KEY_MISSING' })
  })

  it('needs no key when the request selects no client certificate (lazy)', async () => {
    await server.forGet('/plain').thenReply(200, 'ok')
    const { ws } = await makeTlsWorkspace()
    const summary = await executeRun(
      { paths: ['requests/plain.http'], workspace: ws },
      { cwd: ws, env: {} as NodeJS.ProcessEnv, reporterContext: silentCtx }
    )
    expect(summary.summary.requests.passed).toBe(1)
  })

  // With the key injected, the secret passphrase decrypts past the contractual
  // gate (so NO SECRETS_KEY_MISSING) — the full handshake against a real mutual-TLS
  // endpoint is the manual check (REQ §12); byte-level material correctness is
  // covered in @fetchpier/core's resolve.test.ts.
  it('decrypts the passphrase with the injected key (no SECRETS_KEY_MISSING)', async () => {
    const { ws, fpk } = await makeTlsWorkspace()
    let thrown: unknown
    try {
      await executeRun(
        { paths: ['requests/secure.http'], workspace: ws, timeoutMs: 2000 },
        {
          cwd: ws,
          env: { FETCHPIER_WORKSPACE_KEY: fpk } as NodeJS.ProcessEnv,
          reporterContext: silentCtx
        }
      )
    } catch (err) {
      thrown = err
    }
    // The send to :1 fails (a transport error), but the secret gate was passed:
    // the failure is never the contractual key-missing signal.
    expect((thrown as { code?: string } | undefined)?.code).not.toBe('SECRETS_KEY_MISSING')
  })
})

// ── `--tls-config` (CLI-121..123) ───────────────────────────────────────────

/**
 * A real mutual-TLS server: it asks every client for a certificate, accepts any,
 * and records the common name presented on each request's connection. The
 * runner does not verify it (`insecure`): selection does not depend on
 * verification.
 */
interface MtlsServer {
  url: string
  seen: (string | null)[]
  close: () => Promise<void>
}

async function startMtlsServer(): Promise<MtlsServer> {
  const identity = await generateCACertificate({ subject: { commonName: 'localhost' } })
  const seen: (string | null)[] = []
  const srv = https.createServer(
    { ...identity, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      const cn = (req.socket as TLSSocket).getPeerCertificate()?.subject?.CN
      seen.push(typeof cn === 'string' ? cn : null)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }
  )
  await new Promise<void>((resolve) => srv.listen(0, resolve))
  return {
    url: `https://localhost:${(srv.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections()
        srv.close(() => resolve())
      })
  }
}

describe('--tls-config: certificates that are not shared with the workspace', () => {
  let mtls: MtlsServer
  let workspaceId: { key: string; cert: string }
  let runId: { key: string; cert: string }

  beforeAll(async () => {
    ;[mtls, workspaceId, runId] = await Promise.all([
      startMtlsServer(),
      generateCACertificate({ subject: { commonName: 'workspace-identity' } }),
      generateCACertificate({ subject: { commonName: 'run-identity' } })
    ])
  }, 60_000)

  afterAll(async () => {
    await mtls.close()
  })

  afterEach(() => {
    mtls.seen.length = 0
  })

  const pem = (id: string, host = 'localhost') => ({
    id,
    host,
    port: null,
    type: 'pem' as const,
    certFile: `${id}.crt`,
    keyFile: `${id}.key`,
    passphrase: null,
    disabled: false
  })

  /** A workspace whose one request goes to the mutual-TLS server. */
  function makeWorkspace(withOwnCert: boolean): string {
    const ws = mkdtempSync(join(tmpdir(), 'fp-cli-tls-config-'))
    workspaces.push(ws)
    mkdirSync(join(ws, '.fetchpier', 'certs'), { recursive: true })
    writeFileSync(
      join(ws, '.fetchpier', 'settings.json'),
      JSON.stringify({
        version: 1,
        http: {
          tls: { caCertificates: [], clientCertificates: withOwnCert ? [pem('shared')] : [] }
        }
      })
    )
    writeFileSync(join(ws, '.fetchpier', 'certs', 'shared.crt'), workspaceId.cert)
    writeFileSync(join(ws, '.fetchpier', 'certs', 'shared.key'), workspaceId.key)
    const envDir = join(ws, 'environments', 'default')
    mkdirSync(envDir, { recursive: true })
    writeFileSync(
      join(envDir, 'config.json'),
      JSON.stringify({ id: 'default', name: 'default', variables: {} })
    )
    mkdirSync(join(ws, 'requests'), { recursive: true })
    writeFileSync(join(ws, 'requests', 'who.http'), `GET ${mtls.url}/who\n`)
    return ws
  }

  /** A folder outside the workspace: the run's own TLS file and its certificate. */
  function makeRunConfig(content?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'fp-cli-run-tls-'))
    workspaces.push(dir)
    writeFileSync(join(dir, 'mine.crt'), runId.cert)
    writeFileSync(join(dir, 'mine.key'), runId.key)
    const file = join(dir, 'tls.json')
    writeFileSync(file, content ?? JSON.stringify({ clientCertificates: [pem('mine')] }))
    return file
  }

  const run = (ws: string, extra: { tlsConfig?: string } = {}, env: NodeJS.ProcessEnv = {}) =>
    executeRun(
      { paths: ['requests/who.http'], workspace: ws, insecure: true, ...extra },
      { cwd: ws, env, reporterContext: silentCtx }
    )

  it('CLI-121 presents the --tls-config certificate, over the workspace’s for the same host', async () => {
    const ws = makeWorkspace(true)

    await run(ws)
    await run(ws, { tlsConfig: makeRunConfig() })

    expect(mtls.seen).toEqual(['workspace-identity', 'run-identity'])
  })

  it('CLI-122 reads the same file from FETCHPIER_TLS_CONFIG', async () => {
    const ws = makeWorkspace(false)

    const summary = await run(ws, {}, { FETCHPIER_TLS_CONFIG: makeRunConfig() })

    expect(summary.summary.requests.passed).toBe(1)
    expect(mtls.seen).toEqual(['run-identity'])
  })

  it('CLI-123 stops the run before anything is sent when the file is unusable', async () => {
    const ws = makeWorkspace(false)

    await expect(run(ws, { tlsConfig: makeRunConfig('{ not json') })).rejects.toMatchObject({
      exitCode: EXIT.USAGE
    })
    expect(mtls.seen).toEqual([])
  })
})

describe('removed --cacert flag (CA-11)', () => {
  it('is no longer a known option', () => {
    // `exitOverride()` stops Commander from killing the process, but it still
    // writes `error: unknown option '--cacert'` to stderr. In a gate log that
    // line reads as a failure in a test that is in fact asserting the rejection,
    // so silence the writer — the thrown error is what this test checks.
    const cmd = addRunOptions(new Command('run'))
      .exitOverride()
      .configureOutput({ writeErr: () => {} })
    expect(() => cmd.parse(['--cacert', '/some/ca.pem'], { from: 'user' })).toThrowError(
      expect.objectContaining({ code: 'commander.unknownOption' })
    )
  })
})
