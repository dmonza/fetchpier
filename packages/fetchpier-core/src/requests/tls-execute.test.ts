/**
 * REQ-0089 — `execute()` ↔ TLS resolver contract.
 *
 * - CA-03: a contractual secret failure resolving the client-cert passphrase
 *   surfaces (rejects) before the handshake, rather than being swallowed.
 * - A non-contractual TLS glitch is swallowed (the send proceeds with no extra
 *   material) so a bad cert file never blocks an unrelated request.
 * - CA-10: a resolved passphrase plaintext never appears in the run snapshot /
 *   reporter-facing result (it is handshake-only, never a wire field).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { CoreError } from '../shared/context'
import type { HttpRequest } from '@shared/types'

let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
})

afterAll(async () => {
  await server.stop()
})

function getReq(): HttpRequest {
  return { method: 'GET', url: `${server.url}/ok`, headers: {}, variables: {} }
}

describe('execute() — TLS resolver error contract (REQ-0089)', () => {
  it('re-throws a contractual SECRETS_* error from the TLS resolver (CA-03)', async () => {
    await server.forGet('/ok').thenReply(200, 'ok')
    const resolveTls = vi.fn().mockRejectedValue(new CoreError('SECRETS_KEY_MISSING', 'locked'))
    await expect(
      execute(getReq(), {
        environmentId: null,
        workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
        resolveTls
      })
    ).rejects.toMatchObject({ code: 'SECRETS_KEY_MISSING' })
  })

  it('swallows a non-contractual TLS resolution glitch and still sends', async () => {
    await server.forGet('/ok').thenReply(200, 'ok')
    const resolveTls = vi.fn().mockRejectedValue(new Error('unreadable cert file'))
    const result = await execute(getReq(), {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      resolveTls
    })
    expect(result.error).toBeUndefined()
    expect(result.response?.status).toBe(200)
  })

  // ENG-09: the client sends a scheme-less URL over https, so TLS resolution,
  // proxy routing and the snapshot must see that same https URL.
  it.each([
    ['a literal host and port', 'localhost:1/health', {}],
    ['a variable base', '{{host}}/health', { host: 'localhost:1' }]
  ])(
    'gives the https URL actually used to TLS resolution and proxy routing for %s',
    async (_label, url, variables) => {
      const resolveTls = vi.fn().mockResolvedValue(undefined)
      const proxy = vi.fn().mockReturnValue(undefined)
      const result = await execute(
        { method: 'GET', url, headers: {}, variables },
        {
          environmentId: null,
          workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
          resolveTls,
          proxy
        }
      )
      // Nothing listens on port 1: the send fails, after routing was decided.
      expect(result.error).toBeDefined()
      expect(resolveTls.mock.calls[0][0]).toBe('https://localhost:1/health')
      expect(proxy).toHaveBeenCalledWith('https://localhost:1/health')
    }
  )

  it('keeps an explicit http scheme for TLS resolution and the snapshot', async () => {
    await server.forGet('/ok').thenReply(200, 'ok')
    const resolveTls = vi.fn().mockResolvedValue(undefined)
    const result = await execute(getReq(), {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      resolveTls
    })
    expect(resolveTls.mock.calls[0][0]).toBe(`${server.url}/ok`)
    expect(result.request?.url).toBe(`${server.url}/ok`)
  })

  it('never leaks the resolved passphrase plaintext into the result (CA-10)', async () => {
    await server.forGet('/ok').thenReply(200, 'ok')
    const PASSPHRASE = 'TOP-SECRET-PASSPHRASE-9f3a'
    // http endpoint ignores the passphrase at the transport level; what matters
    // is that it is never surfaced in the snapshot/result the reporters consume.
    const resolveTls = vi.fn().mockResolvedValue({ passphrase: PASSPHRASE })
    const result = await execute(getReq(), {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
      resolveTls
    })
    expect(result.error).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(PASSPHRASE)
  })
})
