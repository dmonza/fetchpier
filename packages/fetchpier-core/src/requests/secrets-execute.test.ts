import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { createSecretMasker, mintExecutionNonce } from '../secrets/markers'
import type { HttpRequest } from '@shared/types'

let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
})

afterAll(async () => {
  await server.stop()
})

const SECRET = 'SEKRET-abc123-value'

function maskerFor(plaintext: Record<string, string>): ReturnType<typeof createSecretMasker> {
  return createSecretMasker({ nonce: mintExecutionNonce(), plaintextByName: plaintext })
}

describe('execute() — secret masking (REQ-0070 §6.6)', () => {
  it('sends plaintext on the wire but masks the snapshot and response echo', async () => {
    const endpoint = await server.forPost('/echo').thenJson(200, { echoed: SECRET })

    const masker = maskerFor({ apiToken: SECRET })
    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/echo`,
      headers: { 'X-Token': '{{apiToken}}', 'Content-Type': 'application/json' },
      body: '{"token":"{{apiToken}}"}',
      auth: { type: 'bearer', token: '{{apiToken}}' },
      variables: { ...masker.markerVariables }
    }

    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      secrets: masker
    })

    expect(result.error).toBeUndefined()

    // Wire received the decrypted value.
    const seen = await endpoint.getSeenRequests()
    expect(seen).toHaveLength(1)
    expect(seen[0].headers['x-token']).toBe(SECRET)
    expect(seen[0].headers['authorization']).toBe(`Bearer ${SECRET}`)
    expect(await seen[0].body.getText()).toContain(SECRET)

    // Snapshot (activity log / reporters) is masked — no plaintext.
    const snap = result.request!
    expect(snap.headers['X-Token']).toBe('{secret:apiToken}')
    expect(snap.headers['Authorization']).toBe('Bearer {secret:apiToken}')
    expect(snap.body).toBe('{"token":"{secret:apiToken}"}')
    expect(JSON.stringify(snap)).not.toContain(SECRET)
    expect(snap.secretsMasked).toContain('apiToken')

    // Response echo is masked best-effort.
    expect(result.response!.body).not.toContain(SECRET)
    expect(result.response!.body).toContain('{secret:apiToken}')
  })

  // REQ-0081: a secret in a structured query param resolves to plaintext on the
  // wire and is masked in the snapshot — a secret-in-query that would otherwise
  // travel literal and 401.
  it('resolves a secret in a structured query param: plaintext on the wire, masked snapshot', async () => {
    const endpoint = await server.forGet('/v1/forecast').thenReply(200, 'ok')
    const masker = maskerFor({ weatherKey: SECRET })
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/v1/forecast`,
      params: [
        { id: 'p0', key: 'city', value: 'berlin', enabled: true },
        { id: 'p1', key: 'apiKey', value: '{{weatherKey}}', enabled: true }
      ],
      headers: {},
      variables: { ...masker.markerVariables }
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: { ...DEFAULT_WORKSPACE_HTTP_SETTINGS, encodeUrl: true },
      secrets: masker
    })
    expect(result.error).toBeUndefined()

    // Wire carries the decrypted secret — no literal `{{…}}` (the 401 cause).
    const seen = await endpoint.getSeenRequests()
    expect(seen).toHaveLength(1)
    expect(seen[0].path).toBe(`/v1/forecast?city=berlin&apiKey=${encodeURIComponent(SECRET)}`)
    expect(seen[0].path).not.toContain('%7B%7B')

    // Snapshot masks the secret — no plaintext, no literal token.
    const snap = result.request!
    expect(snap.url).toContain('city=berlin')
    expect(snap.url).not.toContain(SECRET)
    expect(snap.url).not.toContain('{{weatherKey}}')
    // The mask stays legible in the snapshot — not percent-encoded.
    expect(snap.url).toContain('apiKey={secret:weatherKey}')
    expect(snap.url).not.toContain('%7Bsecret')
    expect(snap.secretsMasked).toContain('weatherKey')
  })

  it('Content-Length reflects the resolved value, not the marker', async () => {
    const endpoint = await server.forPost('/len').thenReply(200, 'ok')
    const masker = maskerFor({ apiToken: SECRET })
    const body = `{"token":"{{apiToken}}"}`
    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/len`,
      headers: { 'Content-Type': 'application/json' },
      body,
      variables: { ...masker.markerVariables }
    }
    await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      secrets: masker
    })
    const seen = await endpoint.getSeenRequests()
    const wireBody = (await seen[0].body.getText()) ?? ''
    // The wire body is post-resolution; its length matches the plaintext form.
    expect(wireBody).toBe(`{"token":"${SECRET}"}`)
    const cl = seen[0].headers['content-length']
    if (typeof cl === 'string') expect(Number(cl)).toBe(Buffer.byteLength(wireBody))
  })

  // CA-15: marker-shaped text authored by the user (foreign nonce) is inert.
  it('leaves foreign-nonce marker text verbatim on the wire and in logs', async () => {
    const endpoint = await server.forPost('/inert').thenReply(200, 'ok')
    const masker = maskerFor({ apiToken: SECRET })
    const foreign = '{$secret:apiToken:deadbeef}'
    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/inert`,
      headers: { 'Content-Type': 'text/plain' },
      body: foreign,
      variables: { ...masker.markerVariables }
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      secrets: masker
    })
    const seen = await endpoint.getSeenRequests()
    expect(await seen[0].body.getText()).toBe(foreign)
    expect(result.request!.body).toBe(foreign)
    expect(result.request!.secretsMasked).toBeUndefined()
  })

  // ENG-19: a pre-request script that copies a secret verbatim leaves no marker,
  // so only the value mask can catch it in the snapshot.
  describe('a secret copied verbatim by a pre-request script', () => {
    // A space and a slash: the URL copy is percent-encoded on assembly, so a mask
    // applied after encoding would miss it.
    const KEY = 'APIKEY secret/9999'

    it('is masked in the snapshot URL, header, and body, and reported in secretsMasked', async () => {
      const endpoint = await server.forPost('/copy').thenReply(200, 'ok')
      const masker = maskerFor({ apiKey: KEY })
      const req: HttpRequest = {
        method: 'POST',
        url: `${server.url}/copy`,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        variables: { ...masker.markerVariables },
        preRequestScript: [
          `const k = fp.environment.get('apiKey')`,
          `fp.request.url = fp.request.url + '?k=' + k`,
          `fp.request.headers.set('X-Api-Key', k)`,
          `fp.request.body = JSON.stringify({ password: k })`
        ].join('\n')
      }
      const result = await execute(req, {
        environmentId: null,
        workspaceSettings: { ...DEFAULT_WORKSPACE_HTTP_SETTINGS, encodeUrl: true },
        secrets: masker
      })
      expect(result.error).toBeUndefined()

      // The wire still carries the plaintext the script wrote.
      const seen = await endpoint.getSeenRequests()
      expect(seen[0].headers['x-api-key']).toBe(KEY)
      expect(await seen[0].body.getText()).toBe(JSON.stringify({ password: KEY }))
      expect(seen[0].path).toBe(`/copy?k=${encodeURIComponent(KEY)}`)

      const snap = result.request!
      expect(snap.url).toContain('k={secret:apiKey}')
      expect(snap.headers['X-Api-Key']).toBe('{secret:apiKey}')
      expect(snap.body).toBe('{"password":"{secret:apiKey}"}')
      const text = JSON.stringify(snap)
      expect(text).not.toContain(KEY)
      expect(text).not.toContain(encodeURIComponent(KEY))
      expect(snap.secretsMasked).toEqual(['apiKey'])
    })

    it('is masked in a multipart text part through a plain variable holding it', async () => {
      const ws = await fs.mkdtemp(join(tmpdir(), 'secrets-mp-'))
      try {
        const endpoint = await server.forPost('/mp').thenReply(200, 'ok')
        const masker = maskerFor({ apiKey: KEY })
        const req: HttpRequest = {
          method: 'POST',
          url: `${server.url}/mp`,
          headers: {},
          bodyType: 'multipart-form',
          variables: { copy: '', ...masker.markerVariables },
          multipartParts: [{ kind: 'text', id: 'mp-0', name: 'cred', value: 'key={{copy}}' }],
          preRequestScript: `fp.environment.set('copy', fp.environment.get('apiKey'))`
        }
        const result = await execute(req, {
          environmentId: null,
          workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
          workspacePath: ws,
          secrets: masker
        })
        expect(result.error).toBeUndefined()
        const seen = await endpoint.getSeenRequests()
        expect((await seen[0].body.getDecodedBuffer())!.toString('utf8')).toContain(`key=${KEY}`)

        const part = result.request!.multipartParts![0]
        expect(part.kind === 'text' && part.value).toBe('key={secret:apiKey}')
        expect(JSON.stringify(result.request)).not.toContain(KEY)
        expect(result.request!.secretsMasked).toEqual(['apiKey'])
      } finally {
        await fs.rm(ws, { recursive: true, force: true })
      }
    })

    it('is masked with no masker when the script writes it under a secret name', async () => {
      await server.forGet('/jwt').thenReply(200, 'ok')
      const JWT = 'eyJhbGciOiJIUzI1NiJ9.NEWTOKEN.sig'
      const req: HttpRequest = {
        method: 'GET',
        url: `${server.url}/jwt`,
        headers: { 'X-Plain': 'plain-value' },
        preRequestScript: [
          `fp.environment.set('accessToken', '${JWT}')`,
          `fp.request.headers.set('X-Auth', 'Bearer ' + fp.environment.get('accessToken'))`
        ].join('\n')
      }
      const result = await execute(req, {
        environmentId: null,
        workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
        secretNames: ['accessToken']
      })
      expect(result.error).toBeUndefined()
      const snap = result.request!
      expect(snap.headers['X-Auth']).toBe('Bearer {secret:accessToken}')
      // A plain value is never touched by the mask.
      expect(snap.headers['X-Plain']).toBe('plain-value')
      expect(JSON.stringify(snap)).not.toContain(JWT)
      expect(snap.secretsMasked).toEqual(['accessToken'])
    })
  })

  // ENG-40: the top-level error of a failed pre-request script is printed by the
  // CLI and written into every report, so it gets the same mask as scriptResults.
  it('masks a secret thrown by a pre-request script in result.error', async () => {
    const masker = maskerFor({ sa: SECRET })
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/never`,
      headers: { 'X-Sa': '{{sa}}' },
      variables: { ...masker.markerVariables },
      preRequestScript: [
        `fp.environment.set('fresh', 'FRESH-written-secret')`,
        `throw new Error('bad credential: ' + fp.environment.get('sa') + ' / ' + fp.environment.get('fresh'))`
      ].join('\n')
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      secrets: masker,
      secretNames: ['sa', 'fresh']
    })
    expect(result.notSent).toBe(true)
    expect(result.error).toBe(
      'Pre-request script failed: bad credential: {secret:sa} / {secret:fresh}'
    )
    expect(result.scriptResults?.preRequest?.error?.message).toBe(
      'bad credential: {secret:sa} / {secret:fresh}'
    )
  })

  // ENG-22: a pre-request script that refreshes a referenced secret must send
  // the new value on that same send, as a plain variable write already does.
  describe('a pre-request write to a referenced secret', () => {
    const OLD = 'OLD-token-1111'
    const NEW = 'NEW-token-2222'

    it('reaches the wire with the new value while the snapshot stays masked', async () => {
      const endpoint = await server.forGet('/refresh').thenReply(200, `echo ${NEW}`)
      const masker = maskerFor({ accessToken: OLD })
      const req: HttpRequest = {
        method: 'GET',
        url: `${server.url}/refresh`,
        headers: { Authorization: 'Bearer {{accessToken}}' },
        variables: { ...masker.markerVariables },
        preRequestScript: `fp.environment.set('accessToken', '${NEW}')`
      }
      const result = await execute(req, {
        environmentId: null,
        workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
        secrets: masker,
        secretNames: ['accessToken']
      })
      expect(result.error).toBeUndefined()

      const seen = await endpoint.getSeenRequests()
      expect(seen[0].headers['authorization']).toBe(`Bearer ${NEW}`)

      const snap = result.request!
      expect(snap.headers['Authorization']).toBe('Bearer {secret:accessToken}')
      expect(snap.secretsMasked).toEqual(['accessToken'])
      expect(JSON.stringify(snap)).not.toContain(NEW)
      expect(JSON.stringify(snap)).not.toContain(OLD)
      // The new plaintext is covered by the value mask too.
      expect(result.response!.body).toBe('echo {secret:accessToken}')
      expect(result.environmentChanges?.set.accessToken).toBe(NEW)
    })

    it('reports a removed referenced secret as unresolved and never sends the old value', async () => {
      const endpoint = await server.forGet('/removed').thenReply(200, 'ok')
      const masker = maskerFor({ accessToken: OLD })
      const req: HttpRequest = {
        method: 'GET',
        url: `${server.url}/removed`,
        headers: { Authorization: 'Bearer {{accessToken}}' },
        variables: { ...masker.markerVariables },
        preRequestScript: `fp.environment.remove('accessToken')`
      }
      const result = await execute(req, {
        environmentId: null,
        workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
        secrets: masker,
        secretNames: ['accessToken']
      })
      expect(result.error).toBeUndefined()

      const seen = await endpoint.getSeenRequests()
      expect(seen[0].headers['authorization']).toBe('Bearer {{accessToken}}')
      expect(result.warnings).toContainEqual({ code: 'UNRESOLVED_VARIABLE', name: 'accessToken' })
      expect(result.request!.headers['Authorization']).toBe('Bearer {{accessToken}}')
      expect(result.request!.secretsMasked).toBeUndefined()
    })
  })

  it('is byte-identical to no-secrets when no masker is passed', async () => {
    const endpoint = await server.forPost('/plain').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'POST',
      url: `${server.url}/plain`,
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}'
    }
    const result = await execute(req, {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS
    })
    expect(result.error).toBeUndefined()
    expect(result.request!.secretsMasked).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(await seen[0].body.getText()).toBe('{"a":1}')
  })
})
