import { describe, expect, it } from 'vitest'
import type { HttpRequest } from '@shared/types'
import { collectReferencedVariableNames, resolveSecrets } from './resolver'
import { decryptValue, encryptValue, generateWorkspaceKey } from './crypto'

describe('collectReferencedVariableNames', () => {
  it('collects refs across url, query params, headers, body, form, multipart, and auth', () => {
    const request: HttpRequest = {
      method: 'POST',
      url: '{{baseUrl}}/x',
      params: [{ id: 'q0', key: '{{qk}}', value: '{{qv}}', enabled: true }],
      headers: { 'X-{{hk}}': '{{hv}}' },
      body: '{"a":"{{bodyVar}}"}',
      formFields: [{ id: '1', key: '{{fk}}', value: '{{fv}}', enabled: true }],
      multipartParts: [{ kind: 'text', id: 'm0', name: '{{mpName}}', value: '{{mpVal}}' }],
      auth: { type: 'bearer', token: '{{apiToken}}' }
    }
    const names = collectReferencedVariableNames(request)
    expect([...names].sort()).toEqual(
      [
        'apiToken',
        'baseUrl',
        'bodyVar',
        'fk',
        'fv',
        'hk',
        'hv',
        'mpName',
        'mpVal',
        'qk',
        'qv'
      ].sort()
    )
  })

  // REQ-0081 regression: a secret referenced ONLY in a structured query param
  // must be detected. Before the fix the desktop passed the query in `params`
  // (not `url`), so the masker never seeded the marker and the `{{secret}}` token
  // traveled literally — surfacing percent-encoded on the wire (a 401).
  it('detects a variable referenced only in a structured query param', () => {
    const names = collectReferencedVariableNames({
      method: 'GET',
      url: 'https://api.example.test/v1/forecast',
      params: [
        { id: 'p0', key: 'city', value: '{{cityName}}', enabled: true },
        { id: 'p1', key: 'apiKey', value: '{{weatherKey}}', enabled: true }
      ],
      headers: {}
    })
    expect(names.has('weatherKey')).toBe(true)
    expect(names.has('cityName')).toBe(true)
  })

  it('collects basic and api-key auth value fields', () => {
    const basic = collectReferencedVariableNames({
      method: 'GET',
      url: '/',
      headers: {},
      auth: { type: 'basic', username: '{{u}}', password: '{{p}}' }
    })
    expect([...basic].sort()).toEqual(['p', 'u'])
    const apiKey = collectReferencedVariableNames({
      method: 'GET',
      url: '/',
      headers: {},
      auth: { type: 'api-key', key: '{{k}}', value: '{{v}}', location: 'header' }
    })
    expect([...apiKey].sort()).toEqual(['k', 'v'])
  })
})

describe('resolveSecrets', () => {
  async function makeEnv(): Promise<{
    key: Uint8Array
    secretsMap: Record<string, string | null>
  }> {
    const key = await generateWorkspaceKey()
    const secretsMap: Record<string, string | null> = {
      apiToken: await encryptValue(key, 'apiToken', 'TOKEN-VALUE'),
      missing: null
    }
    return { key, secretsMap }
  }

  const decryptWith = (key: Uint8Array) => (name: string, enc: string) =>
    decryptValue(key, name, enc)

  it('resolves only referenced secrets (lazy)', async () => {
    const { key, secretsMap } = await makeEnv()
    const out = await resolveSecrets({
      environmentId: 'dev',
      secretsMap,
      neededNames: ['apiToken', 'somePlainVar'],
      hasKey: true,
      decrypt: decryptWith(key)
    })
    expect(out).toEqual({ apiToken: 'TOKEN-VALUE' })
  })

  it('does not require a key when no secret is referenced (CA-06 lazy)', async () => {
    const { key, secretsMap } = await makeEnv()
    const out = await resolveSecrets({
      environmentId: 'dev',
      secretsMap,
      neededNames: ['onlyPlain'],
      hasKey: false,
      decrypt: decryptWith(key)
    })
    expect(out).toEqual({})
  })

  // CA-13: needs-value (null) → UNSET, even without a key, highest precedence.
  it('throws SECRETS_VALUE_UNSET for a referenced null secret, without a key', async () => {
    const { key, secretsMap } = await makeEnv()
    await expect(
      resolveSecrets({
        environmentId: 'dev',
        secretsMap,
        neededNames: ['missing'],
        hasKey: false,
        decrypt: decryptWith(key)
      })
    ).rejects.toMatchObject({ code: 'SECRETS_VALUE_UNSET' })
  })

  it('throws SECRETS_KEY_MISSING for a referenced secret with no key', async () => {
    const { key, secretsMap } = await makeEnv()
    await expect(
      resolveSecrets({
        environmentId: 'dev',
        secretsMap,
        neededNames: ['apiToken'],
        hasKey: false,
        decrypt: decryptWith(key)
      })
    ).rejects.toMatchObject({ code: 'SECRETS_KEY_MISSING' })
  })

  it('throws SECRETS_VALUE_CORRUPT naming env + variable on wrong key', async () => {
    const { secretsMap } = await makeEnv()
    const wrongKey = await generateWorkspaceKey()
    await expect(
      resolveSecrets({
        environmentId: 'prod',
        secretsMap,
        neededNames: ['apiToken'],
        hasKey: true,
        decrypt: decryptWith(wrongKey)
      })
    ).rejects.toMatchObject({
      code: 'SECRETS_VALUE_CORRUPT',
      details: { environmentId: 'prod', variable: 'apiToken' }
    })
  })

  it('throws SECRETS_VALUE_CORRUPT for a non-enc value (foreign folder copy)', async () => {
    const { key } = await makeEnv()
    await expect(
      resolveSecrets({
        environmentId: 'dev',
        secretsMap: { apiToken: 'plain-not-encrypted' },
        neededNames: ['apiToken'],
        hasKey: true,
        decrypt: decryptWith(key)
      })
    ).rejects.toMatchObject({ code: 'SECRETS_VALUE_CORRUPT' })
  })
})
