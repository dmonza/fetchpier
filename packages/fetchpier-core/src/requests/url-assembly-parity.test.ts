import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { parseHttpFile } from './parser'
import { splitUrlAndParams } from '@shared/lib/query-string'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import type { HttpRequest } from '@shared/types'

/**
 * REQ-0081 §6.3 — adapter parity. The desktop hands the core a base URL + a
 * structured query; the CLI parser hands it a flat URL. Both must converge on the
 * same core assembly and emit a byte-identical outgoing URL for identical input.
 */
let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
})

afterAll(async () => {
  await server.stop()
})

const opts = (encodeUrl = true) => ({
  environmentId: null,
  workspaceSettings: { ...DEFAULT_WORKSPACE_HTTP_SETTINGS, encodeUrl }
})

describe('URL assembly — adapter parity (REQ-0081 CA-01/CA-02)', () => {
  it('desktop (structured params) and CLI (flat URL) emit byte-identical URLs', async () => {
    await server.forGet('/token').thenReply(200, 'ok')

    const fullUrl = `${server.url}/token?clientId={{clientId}}&scope={{scope}}`
    const variables = { clientId: 'XYZ', scope: 'a b' }

    // CLI shape: the parser emits a flat URL; the core splits it.
    const cliReq: HttpRequest = { ...parseHttpFile(`GET ${fullUrl}\n`).requests[0], variables }
    expect(cliReq.params).toBeUndefined()

    // Desktop shape: base URL + structured query (as the editor load produces).
    const { baseUrl, params } = splitUrlAndParams(fullUrl)
    const desktopReq: HttpRequest = {
      method: 'GET',
      url: baseUrl,
      params,
      headers: {},
      variables
    }

    const cliRes = await execute(cliReq, opts())
    const desktopRes = await execute(desktopReq, opts())

    const expected = `${server.url}/token?clientId=XYZ&scope=a%20b`
    // CA-02: byte-identical recorded outgoing URL across both adapters.
    expect(cliRes.request?.url).toBe(expected)
    expect(desktopRes.request?.url).toBe(expected)
    // CA-01: tokens resolved end-to-end; no literal {{…}} reaches the wire.
    expect(desktopRes.request?.url).not.toContain('{{')
  })

  it('CA-01: query-parameter variables resolve on the desktop send path', async () => {
    const endpoint = await server.forGet('/auth').thenReply(200, 'ok')

    const desktopRes = await execute(
      {
        method: 'GET',
        url: `${server.url}/auth`,
        params: [
          { id: 'p0', key: 'apiKey', value: '{{apiKey}}', enabled: true },
          { id: 'p1', key: 'region', value: '{{region}}', enabled: true }
        ],
        headers: {},
        variables: { apiKey: 'id-123', region: 's-456' }
      },
      opts()
    )

    expect(desktopRes.request?.url).toBe(`${server.url}/auth?apiKey=id-123&region=s-456`)
    const reqs = await endpoint.getSeenRequests()
    expect(reqs).toHaveLength(1)
    expect(reqs[0].path).toBe('/auth?apiKey=id-123&region=s-456')
    expect(reqs[0].path).not.toContain('%7B%7B')
  })

  // REQ-0086 — a malformed query key on the flat-URL (CLI) path is contained:
  // the run proceeds, the key is sent literally, and a warning is returned.
  it('REQ-0086 CA-03/CA-07: a malformed key is sent literally and reported', async () => {
    const endpoint = await server.forGet('/mal').thenReply(200, 'ok')
    const flat = `${server.url}/mal?%E0=v&ok=1`
    const cliReq: HttpRequest = { ...parseHttpFile(`GET ${flat}\n`).requests[0] }
    expect(cliReq.params).toBeUndefined()

    const res = await execute(cliReq, opts())

    // CA-07: the run was not aborted by the malformed key; a warning is surfaced.
    expect(res.response?.status).toBe(200)
    expect(res.warnings).toEqual([{ code: 'MALFORMED_QUERY_ENCODING', rawKey: '%E0', index: 0 }])
    // CA-03: the literal raw key reaches the wire (not double-encoded to %25E0).
    expect(res.request?.url).toBe(`${server.url}/mal?%E0=v&ok=1`)
    expect(res.request?.url).not.toContain('%25E0')
    const reqs = await endpoint.getSeenRequests()
    expect(reqs[0].path).toContain('%E0=v')
  })

  // REQ-0124: a value-less parameter must survive both adapter shapes identically
  // — it is the whole point of the change that the wire URL matches what was typed.
  it('REQ-0124: a value-less parameter reaches the wire without `=`, identically from both adapters', async () => {
    await server.forGet('/orders.aspx').thenReply(200, 'ok')

    const fullUrl = `${server.url}/orders.aspx?wsdl`

    const cliReq: HttpRequest = parseHttpFile(`GET ${fullUrl}
`).requests[0]
    expect(cliReq.params).toBeUndefined()

    const { baseUrl, params } = splitUrlAndParams(fullUrl)
    expect(params[0].valueless).toBe(true)
    const desktopReq: HttpRequest = { method: 'GET', url: baseUrl, params, headers: {} }

    const cliRes = await execute(cliReq, opts())
    const desktopRes = await execute(desktopReq, opts())

    const expected = `${server.url}/orders.aspx?wsdl`
    expect(cliRes.request?.url).toBe(expected)
    expect(desktopRes.request?.url).toBe(expected)
    // The defect being fixed: neither adapter may append an `=`.
    expect(desktopRes.request?.url).not.toContain('wsdl=')
  })

  it('CA-08: a disabled query parameter is dropped from the outgoing URL', async () => {
    const endpoint = await server.forGet('/list').thenReply(200, 'ok')

    await execute(
      {
        method: 'GET',
        url: `${server.url}/list`,
        params: [
          { id: 'p0', key: 'a', value: '1', enabled: true },
          { id: 'p1', key: 'b', value: '2', enabled: false }
        ],
        headers: {}
      },
      opts()
    )

    const reqs = await endpoint.getSeenRequests()
    expect(reqs[0].path).toBe('/list?a=1')
  })
})
