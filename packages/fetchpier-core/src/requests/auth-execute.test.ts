import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { createSecretMasker, mintExecutionNonce } from '../secrets/markers'
import type { HttpRequest } from '@shared/types'

// Auth on the wire (AUTH-001..010). The sibling `auth.test.ts` exercises
// `applyAuth` in isolation with literal values and is correct; the defect this
// suite exists for is one of *composition order* between materializing the
// credential and resolving `{{variables}}`, which is only observable from
// `execute()` outward. Assertions read what the server actually received.
//
// Secret-in-bearer is already covered by `secrets-execute.test.ts`; only the
// two schemes whose materialization destroys a marker are re-covered here.

let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
})

afterAll(async () => {
  await server.stop()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const SECRET = 'SEKRET-abc123-value'

const baseOpts = {
  environmentId: null,
  workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS
}

/**
 * Decode a `Basic <base64>` header back to its `user:pass` form. The received
 * header type is the raw one (a repeated header arrives as an array), so it is
 * normalized here rather than at every call site.
 */
function decodeBasic(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '')
  return Buffer.from(raw.replace(/^Basic /, ''), 'base64').toString('utf-8')
}

describe('auth on the wire — variable interpolation', () => {
  // AUTH-001
  it('sends a Bearer token built from a variable resolved', async () => {
    const endpoint = await server.forGet('/bearer').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/bearer`,
      headers: {},
      auth: { type: 'bearer', token: '{{apiToken}}' },
      variables: { apiToken: 'abc123' }
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(seen).toHaveLength(1)
    expect(seen[0].headers['authorization']).toBe('Bearer abc123')
  })

  // AUTH-002
  it('sends a header-located API key with both name and value resolved', async () => {
    const endpoint = await server.forGet('/apikey-header').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/apikey-header`,
      headers: {},
      auth: {
        type: 'api-key',
        key: '{{keyName}}',
        value: '{{keyValue}}',
        location: 'header'
      },
      variables: { keyName: 'X-Api-Key', keyValue: 'xyz789' }
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(seen[0].headers['x-api-key']).toBe('xyz789')
  })

  // AUTH-003
  it('sends Basic credentials built from variables as base64 of the resolved pair', async () => {
    const endpoint = await server.forGet('/basic').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/basic`,
      headers: {},
      auth: { type: 'basic', username: '{{user}}', password: '{{pass}}' },
      variables: { user: 'admin', pass: 's3cret' }
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(decodeBasic(seen[0].headers['authorization'])).toBe('admin:s3cret')
  })

  // AUTH-004
  it('sends a query-located API key with its value resolved before encoding', async () => {
    const endpoint = await server.forGet('/apikey-query').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/apikey-query`,
      headers: {},
      auth: { type: 'api-key', key: 'apiKey', value: '{{secretKey}}', location: 'query' },
      variables: { secretKey: 'xyz789' }
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(new URL(seen[0].url).searchParams.get('apiKey')).toBe('xyz789')
    expect(seen[0].url).not.toContain('%7B%7B')
  })

  // AUTH-005 — regression guard for the half of the scheme space that already worked.
  it('leaves literal auth values untouched', async () => {
    const endpoint = await server.forGet('/literal').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/literal`,
      headers: {},
      auth: { type: 'basic', username: 'admin', password: 's3cret' }
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(decodeBasic(seen[0].headers['authorization'])).toBe('admin:s3cret')
  })

  // AUTH-006 — catches an implementation that only handles a whole-value reference.
  it('resolves a reference embedded in literal text within an auth field', async () => {
    const endpoint = await server.forGet('/mixed').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/mixed`,
      headers: {},
      auth: { type: 'basic', username: 'svc-{{tenant}}', password: '{{pass}}' },
      variables: { tenant: 'acme', pass: 'p@ss' }
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(decodeBasic(seen[0].headers['authorization'])).toBe('svc-acme:p@ss')
  })

  // AUTH-007
  it('reports an auth field referencing an undefined variable and still sends', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const endpoint = await server.forGet('/unresolved').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/unresolved`,
      headers: {},
      auth: { type: 'basic', username: 'admin', password: '{{missingToken}}' },
      variables: {}
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(seen).toHaveLength(1)
    expect(decodeBasic(seen[0].headers['authorization'])).toBe('admin:{{missingToken}}')
    expect(result.warnings).toContainEqual({ code: 'UNRESOLVED_VARIABLE', name: 'missingToken' })
  })

  // AUTH-008
  it('percent-encodes a resolved query-located API key value', async () => {
    const endpoint = await server.forGet('/apikey-encode').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/apikey-encode`,
      headers: {},
      auth: { type: 'api-key', key: 'apiKey', value: '{{rawKey}}', location: 'query' },
      variables: { rawKey: 'a b&c' }
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(new URL(seen[0].url).searchParams.get('apiKey')).toBe('a b&c')
  })
})

describe('auth on the wire — secret masking', () => {
  // AUTH-009 — a secret interpolates as a marker, and base64 would destroy it, so
  // the credential is materialized after the wire/log render.
  it('sends plaintext and masks the snapshot for a secret in Basic credentials', async () => {
    const endpoint = await server.forGet('/basic-secret').thenReply(200, 'ok')
    const masker = createSecretMasker({
      nonce: mintExecutionNonce(),
      plaintextByName: { dbPass: SECRET }
    })
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/basic-secret`,
      headers: {},
      auth: { type: 'basic', username: 'admin', password: '{{dbPass}}' },
      variables: { ...masker.markerVariables }
    }

    const result = await execute(req, { ...baseOpts, secrets: masker })

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(decodeBasic(seen[0].headers['authorization'])).toBe(`admin:${SECRET}`)

    const snap = result.request!
    expect(JSON.stringify(snap)).not.toContain(SECRET)
    // Legible, not buried inside base64.
    expect(JSON.stringify(snap)).toContain('{secret:dbPass}')
    expect(snap.secretsMasked).toContain('dbPass')
  })

  // AUTH-010 — same constraint, with percent-encoding as the destroying step.
  it('sends plaintext and masks the snapshot for a secret in a query-located API key', async () => {
    const endpoint = await server.forGet('/query-secret').thenReply(200, 'ok')
    const masker = createSecretMasker({
      nonce: mintExecutionNonce(),
      plaintextByName: { apiSecret: SECRET }
    })
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/query-secret`,
      headers: {},
      auth: { type: 'api-key', key: 'apiKey', value: '{{apiSecret}}', location: 'query' },
      variables: { ...masker.markerVariables }
    }

    const result = await execute(req, { ...baseOpts, secrets: masker })

    expect(result.error).toBeUndefined()
    const seen = await endpoint.getSeenRequests()
    expect(new URL(seen[0].url).searchParams.get('apiKey')).toBe(SECRET)

    const snap = result.request!
    expect(JSON.stringify(snap)).not.toContain(SECRET)
    expect(JSON.stringify(snap)).toContain('{secret:apiSecret}')
    expect(snap.secretsMasked).toContain('apiSecret')
  })
})

describe('auth on the wire — the snapshot reports what was sent', () => {
  // ENG-30: a case variant of the managed header (here written by a pre-request
  // script) is replaced on the wire; the snapshot must not keep it beside the
  // managed value.
  it('lists a script-written case variant of Authorization once, as sent', async () => {
    const endpoint = await server.forGet('/variant').thenReply(200, 'ok')
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/variant`,
      headers: {},
      auth: { type: 'bearer', token: 'abc' },
      preRequestScript: `fp.request.headers.set('authorization', 'Bearer from-script')`
    }

    const result = await execute(req, baseOpts)

    expect(result.error).toBeUndefined()
    expect((await endpoint.getSeenRequests())[0].headers.authorization).toBe('Bearer abc')
    const auths = Object.entries(result.request!.headers).filter(
      ([k]) => k.toLowerCase() === 'authorization'
    )
    expect(auths).toEqual([['Authorization', 'Bearer abc']])
  })
})
