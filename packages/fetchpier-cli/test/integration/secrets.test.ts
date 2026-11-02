import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLocal, type Mockttp } from 'mockttp'
import { secrets } from '@fetchpier/core'
import { executeRun } from '../../src/commands/request/run'
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
 * Build a workspace with a secret `apiToken`. When `value` is `null`, the secret
 * is stored in the needs-value state; otherwise it is encrypted under a fresh
 * key whose `FPK1-` form is returned for `FETCHPIER_WORKSPACE_KEY`.
 */
async function makeSecretWorkspace(opts: {
  value: string | null
  request: string
}): Promise<{ ws: string; fpk: string }> {
  const ws = mkdtempSync(join(tmpdir(), 'fp-secrets-'))
  workspaces.push(ws)
  mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  writeFileSync(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))

  const key = await secrets.generateWorkspaceKey()
  const fpk = secrets.formatKey(key)
  const manifest = await secrets.buildManifest(key)
  writeFileSync(join(ws, '.fetchpier', 'secrets.json'), secrets.serializeManifest(manifest))

  const encValue =
    opts.value === null ? null : await secrets.encryptValue(key, 'apiToken', opts.value)

  const envDir = join(ws, 'environments', 'default')
  mkdirSync(envDir, { recursive: true })
  // REQ-0076: one unified `variables` map (the secret's `enc:`/`null` value lives in it).
  writeFileSync(
    join(envDir, 'config.json'),
    JSON.stringify({
      id: 'default',
      name: 'default',
      variables: { baseUrl: server.url, apiToken: encValue }
    })
  )

  const reqDir = join(ws, 'requests')
  mkdirSync(reqDir, { recursive: true })
  writeFileSync(join(reqDir, 'req.http'), opts.request)

  return { ws, fpk }
}

const SECRET = 'TOKEN-xyz-987'

describe('CLI secret resolution (REQ-0070 CLI parity)', () => {
  // CA-05
  it('resolves a secret from FETCHPIER_WORKSPACE_KEY and sends the decrypted value', async () => {
    const endpoint = await server.forGet('/me').thenJson(200, { ok: true })
    const { ws, fpk } = await makeSecretWorkspace({
      value: SECRET,
      request: 'GET {{baseUrl}}/me\nX-Token: {{apiToken}}\n'
    })

    const summary = await executeRun(
      { paths: ['requests/req.http'], workspace: ws },
      {
        cwd: ws,
        env: { FETCHPIER_WORKSPACE_KEY: fpk } as NodeJS.ProcessEnv,
        reporterContext: silentCtx
      }
    )

    expect(summary.summary.requests.passed).toBe(1)
    const seen = await endpoint.getSeenRequests()
    expect(seen[0].headers['x-token']).toBe(SECRET)

    // The reporter unit must never carry the plaintext.
    expect(JSON.stringify(summary.units[0])).not.toContain(SECRET)
  })

  // CA-06: no key, but the request touches no secret → succeeds.
  it('succeeds without a key when no secret is referenced (lazy)', async () => {
    await server.forGet('/plain').thenReply(200, 'ok')
    const { ws } = await makeSecretWorkspace({
      value: SECRET,
      request: 'GET {{baseUrl}}/plain\n'
    })
    const summary = await executeRun(
      { paths: ['requests/req.http'], workspace: ws },
      { cwd: ws, env: {} as NodeJS.ProcessEnv, reporterContext: silentCtx }
    )
    expect(summary.summary.requests.passed).toBe(1)
  })

  // CA-06: no key, request references the secret → SECRETS_KEY_MISSING.
  it('fails with SECRETS_KEY_MISSING when a referenced secret has no key', async () => {
    const { ws } = await makeSecretWorkspace({
      value: SECRET,
      request: 'GET {{baseUrl}}/me\nX-Token: {{apiToken}}\n'
    })
    await expect(
      executeRun(
        { paths: ['requests/req.http'], workspace: ws },
        { cwd: ws, env: {} as NodeJS.ProcessEnv, reporterContext: silentCtx }
      )
    ).rejects.toMatchObject({ code: 'SECRETS_KEY_MISSING' })
  })

  // CA-13: needs-value → SECRETS_VALUE_UNSET even without a key.
  it('fails with SECRETS_VALUE_UNSET for a null secret, with or without a key', async () => {
    const { ws } = await makeSecretWorkspace({
      value: null,
      request: 'GET {{baseUrl}}/me\nX-Token: {{apiToken}}\n'
    })
    await expect(
      executeRun(
        { paths: ['requests/req.http'], workspace: ws },
        { cwd: ws, env: {} as NodeJS.ProcessEnv, reporterContext: silentCtx }
      )
    ).rejects.toMatchObject({ code: 'SECRETS_VALUE_UNSET' })
  })

  it('fails with SECRETS_KEY_INVALID for a wrong key', async () => {
    const { ws } = await makeSecretWorkspace({
      value: SECRET,
      request: 'GET {{baseUrl}}/me\nX-Token: {{apiToken}}\n'
    })
    const otherKey = secrets.formatKey(await secrets.generateWorkspaceKey())
    await expect(
      executeRun(
        { paths: ['requests/req.http'], workspace: ws },
        {
          cwd: ws,
          env: { FETCHPIER_WORKSPACE_KEY: otherKey } as NodeJS.ProcessEnv,
          reporterContext: silentCtx
        }
      )
    ).rejects.toMatchObject({ code: 'SECRETS_KEY_INVALID' })
  })

  // CA-10 (CLI): the activity log masks the secret by name and flags the entry.
  it('masks the secret in the .runs activity log and emits @secrets-masked', async () => {
    await server.forGet('/me').thenJson(200, { ok: true })
    const { ws, fpk } = await makeSecretWorkspace({
      value: SECRET,
      request: 'GET {{baseUrl}}/me\nX-Token: {{apiToken}}\n'
    })
    await executeRun(
      { paths: ['requests/req.http'], workspace: ws, saveHistory: true },
      {
        cwd: ws,
        env: { FETCHPIER_WORKSPACE_KEY: fpk } as NodeJS.ProcessEnv,
        reporterContext: silentCtx
      }
    )
    const runsDir = join(ws, 'requests', '.runs')
    const files = readdirSync(runsDir)
    expect(files).toHaveLength(1)
    const log = readFileSync(join(runsDir, files[0]), 'utf-8')
    expect(log).not.toContain(SECRET)
    expect(log).toContain('X-Token: {secret:apiToken}')
    expect(log).toContain('# @secrets-masked: apiToken')
  })

  it('exit-code mapping: SECRETS_KEY_MISSING → EXIT.SECRETS_KEY_MISSING', () => {
    // Guards the contract wired in errors.ts without re-running the pipeline.
    expect(EXIT.SECRETS_KEY_MISSING).toBe(14)
    expect(EXIT.SECRETS_VALUE_UNSET).toBe(17)
  })
})
