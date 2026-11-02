/**
 * REQ-0074/0076 — CLI parity for the local value layer. The CLI is READ-ONLY: it
 * merges `.state/localvalues.json` for resolution but never re-wraps or removes
 * orphans (CI must not mutate the working tree).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLocal, type Mockttp } from 'mockttp'
import { secrets } from '@fetchpier/core'
import { executeRun } from '../../src/commands/request/run'

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
  vi.restoreAllMocks()
  for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true })
})

const silentCtx = { write: () => {}, writeErr: () => {} }

function baseWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'fp-localvals-'))
  workspaces.push(ws)
  mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  writeFileSync(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  return ws
}

function writeEnv(
  ws: string,
  config: { variables?: Record<string, string>; secrets?: Record<string, string | null> }
): void {
  const dir = join(ws, 'environments', 'default')
  mkdirSync(dir, { recursive: true })
  // REQ-0076: one unified `variables` map (plain + secret-shaped values together).
  const variables = { ...(config.variables ?? {}), ...(config.secrets ?? {}) }
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ id: 'default', name: 'default', variables })
  )
}

function writeReq(ws: string, content: string): void {
  const dir = join(ws, 'requests')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'req.http'), content)
}

describe('CLI local value layer (REQ-0074)', () => {
  // CA-01: a plain local override wins over the shared value.
  it('uses a local plain override over the shared value', async () => {
    const endpoint = await server.forGet('/local').thenReply(200, 'ok')
    const ws = baseWorkspace()
    writeEnv(ws, { variables: { baseUrl: server.url, path: 'shared' } })
    await secrets.writeLocalValues(ws, 'default', { version: 1, variables: { path: 'local' } })
    writeReq(ws, 'GET {{baseUrl}}/{{path}}\n')

    const summary = await executeRun(
      { paths: ['requests/req.http'], workspace: ws },
      { cwd: ws, env: {} as NodeJS.ProcessEnv, reporterContext: silentCtx }
    )
    expect(summary.summary.requests.passed).toBe(1)
    expect(await endpoint.getSeenRequests()).toHaveLength(1)
  })

  // Operational check: a local-only plain variable needs no key.
  it('resolves a local-only variable with no workspace key', async () => {
    const endpoint = await server.forGet('/only').thenReply(200, 'ok')
    const ws = baseWorkspace()
    writeEnv(ws, { variables: { baseUrl: server.url } })
    await secrets.writeLocalValues(ws, 'default', { version: 1, variables: { seg: 'only' } })
    writeReq(ws, 'GET {{baseUrl}}/{{seg}}\n')

    const summary = await executeRun(
      { paths: ['requests/req.http'], workspace: ws },
      { cwd: ws, env: {} as NodeJS.ProcessEnv, reporterContext: silentCtx }
    )
    expect(summary.summary.requests.passed).toBe(1)
    expect(await endpoint.getSeenRequests()).toHaveLength(1)
  })

  // CA-07 (CLI): a stale-keyId encrypted override is an orphan — warn to stderr,
  // fall back to shared, leave the file unmodified, exit code unaffected.
  it('treats a stale-keyId secret override as a read-only orphan', async () => {
    const endpoint = await server.forGet('/me').thenJson(200, { ok: true })
    const ws = baseWorkspace()

    // Current workspace key K and its manifest.
    const k = await secrets.generateWorkspaceKey()
    const fpk = secrets.formatKey(k)
    writeFileSync(
      join(ws, '.fetchpier', 'secrets.json'),
      secrets.serializeManifest(await secrets.buildManifest(k))
    )
    const sharedEnc = await secrets.encryptValue(k, 'apiToken', 'SHARED-TOKEN')
    writeEnv(ws, { variables: { baseUrl: server.url }, secrets: { apiToken: sharedEnc } })

    // A local override encrypted under a DIFFERENT (absent) key — orphan.
    const k1 = await secrets.generateWorkspaceKey()
    const k1id = secrets.deriveKeyId(k1)
    const localEnc = await secrets.encryptValue(k1, 'apiToken', 'LOCAL-TOKEN')
    await secrets.writeLocalValues(ws, 'default', {
      version: 1,
      keyId: k1id,
      variables: { apiToken: localEnc }
    })

    writeReq(ws, 'GET {{baseUrl}}/me\nX-Token: {{apiToken}}\n')
    const valuesPath = secrets.localValuesPath(ws, 'default')
    const before = readFileSync(valuesPath, 'utf-8')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const summary = await executeRun(
      { paths: ['requests/req.http'], workspace: ws },
      {
        cwd: ws,
        env: { FETCHPIER_WORKSPACE_KEY: fpk } as NodeJS.ProcessEnv,
        reporterContext: silentCtx
      }
    )

    expect(summary.summary.requests.passed).toBe(1)
    // Fell back to the shared secret.
    const seen = await endpoint.getSeenRequests()
    expect(seen[0].headers['x-token']).toBe('SHARED-TOKEN')
    // The local file is untouched (no re-wrap, no cleanup).
    expect(readFileSync(valuesPath, 'utf-8')).toBe(before)
    // A warning went to stderr.
    expect(stderrSpy).toHaveBeenCalled()
    expect(String(stderrSpy.mock.calls[0][0])).toMatch(/apiToken/)
  })

  // CA-07 boundary: orphan falling back onto a shared `null` is the only fatal case.
  it('exits SECRETS_VALUE_UNSET when an orphan falls back onto a null shared secret', async () => {
    const ws = baseWorkspace()
    const k = await secrets.generateWorkspaceKey()
    const fpk = secrets.formatKey(k)
    writeFileSync(
      join(ws, '.fetchpier', 'secrets.json'),
      secrets.serializeManifest(await secrets.buildManifest(k))
    )
    writeEnv(ws, { variables: { baseUrl: server.url }, secrets: { apiToken: null } })

    const k1 = await secrets.generateWorkspaceKey()
    const localEnc = await secrets.encryptValue(k1, 'apiToken', 'LOCAL-TOKEN')
    await secrets.writeLocalValues(ws, 'default', {
      version: 1,
      keyId: secrets.deriveKeyId(k1),
      variables: { apiToken: localEnc }
    })
    writeReq(ws, 'GET {{baseUrl}}/me\nX-Token: {{apiToken}}\n')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(
      executeRun(
        { paths: ['requests/req.http'], workspace: ws },
        {
          cwd: ws,
          env: { FETCHPIER_WORKSPACE_KEY: fpk } as NodeJS.ProcessEnv,
          reporterContext: silentCtx
        }
      )
    ).rejects.toMatchObject({ code: 'SECRETS_VALUE_UNSET' })
  })
})
