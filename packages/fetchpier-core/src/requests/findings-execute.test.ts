import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getLocal, type Mockttp } from 'mockttp'

// CA-23: a defect inside the evaluation must never cost the send its result.
vi.mock('../findings/evaluate', () => ({
  evaluateFindings: () => {
    throw new Error('rule exploded')
  }
}))

import { execute } from './execute'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'

let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
  await server.forGet('/ok').thenReply(200, 'fine', { 'content-type': 'text/plain' })
})

afterAll(async () => {
  await server.stop()
})

describe('findings evaluation failure is contained', () => {
  it('keeps the response and marks the evaluation as failed, with an advisory', async () => {
    const result = await execute(
      { method: 'GET', url: server.urlFor('/ok'), headers: {} },
      {
        environmentId: null,
        workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS,
        evaluateFindings: true
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.response?.status).toBe(200)
    expect(result.response?.body).toBe('fine')
    expect(result.findings).toEqual({ status: 'failed' })
    expect(result.warnings).toContainEqual({ code: 'FINDINGS_EVALUATION_FAILED' })
  })

  it('is not attempted when the adapter does not ask for it', async () => {
    const result = await execute(
      { method: 'GET', url: server.urlFor('/ok'), headers: {} },
      { environmentId: null, workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS }
    )
    expect(result.findings).toBeUndefined()
    expect(result.warnings ?? []).not.toContainEqual({ code: 'FINDINGS_EVALUATION_FAILED' })
  })
})
