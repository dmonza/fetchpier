import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
