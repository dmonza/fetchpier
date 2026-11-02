import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { execute } from './execute'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import type { HttpRequest } from '@shared/types'

// PIPE-006 — a send that cannot connect reports why.
//
// This runs against a real closed socket rather than a mocked rejection on
// purpose. The failure that motivated it only exists because of how the
// runtime reports a host whose addresses ALL refuse: it aggregates the
// per-address causes and leaves its own message empty. A mocked transport would
// assert our belief about that shape; only a real connection attempt asserts
// the shape itself. The sibling `describe-error.test.ts` pins the composition
// rules in isolation, so this suite asserts the outcome, not the wording.

/** A port nothing is listening on: bound to learn a free one, then released. */
let closedPort: number

beforeAll(async () => {
  closedPort = await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not acquire a port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
})

afterAll(() => {
  // Nothing to tear down: the probe server released the port in beforeAll.
})

function requestTo(url: string): HttpRequest {
  return {
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body: '{"probe":true}',
    bodyType: 'raw',
    variables: {}
  } as HttpRequest
}

describe('a send that never reaches its server', () => {
  it('reports no response and a reason naming the refusal (localhost)', async () => {
    const result = await execute(requestTo(`http://localhost:${closedPort}/api/v1/probe`), {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS
    })

    expect(result.response).toBeUndefined()
    expect(result.error).toBeTruthy()
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('reports a reason for a single-address host too', async () => {
    const result = await execute(requestTo(`http://127.0.0.1:${closedPort}/api/v1/probe`), {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS
    })

    expect(result.response).toBeUndefined()
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('still reports the settings it resolved for the send', async () => {
    // The pipeline computes the outcome *before* the send precisely so a
    // failure does not discard it. A failed send is the one you most want to
    // inspect, so what it resolved must survive.
    const result = await execute(requestTo(`http://localhost:${closedPort}/probe`), {
      environmentId: null,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS
    })

    expect(result.resolvedSettings).toBeDefined()
  })
})
