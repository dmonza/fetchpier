/**
 * Investigation guard: a secret referenced ONLY in a structured query param must
 * reach the wire as PLAINTEXT through the full desktop path — the real
 * `buildSendMasker` (encrypted workspace + key) feeding `requests.execute`. The
 * activity-log snapshot stays masked (`{secret:<name>}`, unencoded), but the bytes
 * the server receives must be the decrypted value.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLocal, type Mockttp } from 'mockttp'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet',
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^sealed:/, '')
  },
  systemPreferences: { canPromptTouchID: () => false, promptTouchID: async () => undefined }
}))

import * as service from './service'
import { buildSendMasker } from './service'
import { lockAll } from './unlock-state'
import { requests } from '@fetchpier/core'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../config/defaults'
import type { HttpRequest } from '../../shared/types'

let server: Mockttp
let ws: string

const PLAIN_CITY = 'berlin'
const SECRET_VALUE = 'test-fake-secret-9XYZ'

beforeAll(async () => {
  server = getLocal()
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-qps-ud-'))
  lockAll()
  ws = await fs.mkdtemp(join(tmpdir(), 'fp-qps-'))
  await fs.mkdir(join(ws, '.fetchpier'), { recursive: true })
  await fs.writeFile(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  const envDir = join(ws, 'environments', 'dev')
  await fs.mkdir(envDir, { recursive: true })
  await fs.writeFile(
    join(envDir, 'config.json'),
    JSON.stringify({
      id: 'dev',
      name: 'dev',
      variables: { city: PLAIN_CITY, weatherKey: SECRET_VALUE }
    })
  )
})
afterEach(async () => {
  lockAll()
  await fs.rm(userDataDir, { recursive: true, force: true })
  await fs.rm(ws, { recursive: true, force: true })
})

describe('secret in a query param — full desktop masker path', () => {
  it('sends the DECRYPTED secret on the wire; masks only the snapshot', async () => {
    // Mark weatherKey as a secret (encrypted in place).
    await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'weatherKey', SECRET_VALUE)

    const endpoint = await server.forGet('/v1/forecast').thenReply(200, 'ok')

    // The desktop hands the core a base URL + structured params (tokens verbatim).
    const request: HttpRequest = {
      method: 'GET',
      url: `${server.url}/v1/forecast`,
      params: [
        { id: 'p0', key: 'city', value: '{{city}}', enabled: true },
        { id: 'p1', key: 'apiKey', value: '{{weatherKey}}', enabled: true }
      ],
      headers: {},
      // The plain env var is seeded by the adapter; the secret marker is added below.
      variables: { city: PLAIN_CITY }
    }

    const masker = await buildSendMasker(ws, 'dev', request)
    expect(masker, 'buildSendMasker must detect the secret in the query param').toBeDefined()

    const seeded: HttpRequest = {
      ...request,
      variables: { ...(request.variables ?? {}), ...masker!.markerVariables }
    }

    const result = await requests.execute(seeded, {
      environmentId: 'dev',
      workspaceSettings: { ...DEFAULT_WORKSPACE_HTTP_SETTINGS, encodeUrl: true },
      secrets: masker
    })

    expect(result.error).toBeUndefined()

    // THE WIRE: the server must receive the decrypted secret, not the marker,
    // not the `{secret:…}` mask, not an empty value.
    const seen = await endpoint.getSeenRequests()
    expect(seen).toHaveLength(1)
    expect(seen[0].path).toBe(`/v1/forecast?city=${PLAIN_CITY}&apiKey=${SECRET_VALUE}`)
    expect(seen[0].path).not.toContain('%7Bsecret')
    expect(seen[0].path).not.toContain('%7B%7B')
    expect(seen[0].path).not.toContain('$secret')

    // THE SNAPSHOT (activity log / history): masked and legible (the mask is NOT
    // percent-encoded), never the plaintext.
    expect(result.request!.url).toContain('apiKey={secret:weatherKey}')
    expect(result.request!.url).not.toContain('%7Bsecret')
    expect(result.request!.url).not.toContain(SECRET_VALUE)
    expect(result.request!.secretsMasked).toContain('weatherKey')
  })
})
