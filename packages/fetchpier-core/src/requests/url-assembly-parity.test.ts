import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { parseHttpFile } from './parser'
import { splitFormBody, splitUrlAndParams } from '@shared/lib/query-string'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { createSecretMasker, mintExecutionNonce } from '../secrets/markers'
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

  // ENG-23: the script reads and edits the full template URL on both surfaces,
  // and a URL it changed is split again, so both shapes put the same URL on the wire.
  describe('pre-request script and the URL', () => {
    const authored = '{{b}}/users?page=2&q=a%20b'
    const shapes = (path: string, preRequestScript: string): HttpRequest[] => {
      const variables = { b: `${server.url}${path}` }
      const cli: HttpRequest = {
        ...parseHttpFile(`GET ${authored}\n`).requests[0],
        variables,
        preRequestScript
      }
      const { baseUrl, params } = splitUrlAndParams(authored)
      const desktop: HttpRequest = {
        method: 'GET',
        url: baseUrl,
        // A disabled row never reaches the script nor the wire.
        params: [...params, { id: 'off', key: 'off', value: '1', enabled: false }],
        headers: {},
        variables,
        preRequestScript
      }
      return [cli, desktop]
    }

    it('reads the same template URL, query included, in both shapes; an untouched URL is sent as before', async () => {
      const endpoint = await server.forGet('/read/users').thenReply(200, 'ok')
      for (const req of shapes('/read', 'fp.environment.set("seen", fp.request.url)')) {
        const postResponseScript = 'fp.environment.set("post", fp.request.url)'
        const res = await execute({ ...req, postResponseScript }, opts())
        expect(res.environmentChanges?.set).toMatchObject({ seen: authored, post: authored })
      }
      const seen = await endpoint.getSeenRequests()
      expect(seen.map((r) => r.path)).toEqual([
        '/read/users?page=2&q=a%20b',
        '/read/users?page=2&q=a%20b'
      ])
    })

    it('sends a query the script appended after the existing one, identically', async () => {
      const endpoint = await server.forGet('/append/users').thenReply(200, 'ok')
      for (const req of shapes('/append', 'fp.request.url = fp.request.url + "&extra={{x}}"')) {
        await execute({ ...req, variables: { ...req.variables, x: 'p&q' } }, opts())
      }
      const seen = await endpoint.getSeenRequests()
      const expected = '/append/users?page=2&q=a%20b&extra=p%26q'
      expect(seen.map((r) => r.path)).toEqual([expected, expected])
    })

    it('replaces the query with the one a script wrote, split and encoded, identically', async () => {
      const endpoint = await server.forGet('/replace/other').thenReply(200, 'ok')
      for (const req of shapes('/replace', 'fp.request.url = "{{b}}/other?x=a b"')) {
        const res = await execute(req, opts())
        expect(res.error).toBeUndefined()
      }
      const seen = await endpoint.getSeenRequests()
      expect(seen.map((r) => r.path)).toEqual(['/replace/other?x=a%20b', '/replace/other?x=a%20b'])
    })
  })
})

/**
 * The same adapter parity for an x-www-form-urlencoded body. The desktop hands the
 * core structured `formFields` (split on load); the CLI parser hands it the raw
 * body. The core splits a raw form body with the same decoder, so both put the
 * same bytes on the wire.
 */
describe('form body — adapter parity', () => {
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }

  const fileFor = (path: string, body: string): string =>
    `POST ${server.url}${path}\nContent-Type: application/x-www-form-urlencoded\n\n${body}\n`

  it('the CLI shape (raw body) and the desktop shape (fields) send the same bytes', async () => {
    const endpoint = await server.forPost('/form-parity').thenReply(200, 'ok')
    const body = 'grant_type=client_credentials&scope=openid+profile&pw={{pw}}'
    const variables = { pw: 'a&b=c' }

    const cliReq: HttpRequest = {
      ...parseHttpFile(fileFor('/form-parity', body)).requests[0],
      variables
    }
    expect(cliReq.formFields).toBeUndefined()
    const desktopReq: HttpRequest = {
      method: 'POST',
      url: `${server.url}/form-parity`,
      headers: FORM,
      body: undefined,
      bodyType: 'x-www-form-urlencoded',
      formFields: splitFormBody(body),
      variables
    }

    const cliRes = await execute(cliReq, opts())
    const desktopRes = await execute(desktopReq, opts())

    const expected = 'grant_type=client_credentials&scope=openid%20profile&pw=a%26b%3Dc'
    const seen = await endpoint.getSeenRequests()
    expect(await seen[0].body.getText()).toBe(expected)
    expect(await seen[1].body.getText()).toBe(expected)
    expect(cliRes.request?.body).toBe(expected)
    expect(desktopRes.request?.body).toBe(expected)
  })

  it('a secret in a raw form body (CLI shape) is encoded on the wire and legible in the snapshot', async () => {
    const endpoint = await server.forPost('/form-secret').thenReply(200, 'ok')
    const masker = createSecretMasker({
      nonce: mintExecutionNonce(),
      plaintextByName: { pw: 'p+w&x' }
    })
    const req = parseHttpFile(fileFor('/form-secret', 'user=ana&pw={{pw}}')).requests[0]

    const res = await execute(
      { ...req, variables: { ...masker.markerVariables } },
      { ...opts(), secrets: masker }
    )

    const seen = await endpoint.getSeenRequests()
    expect(await seen[0].body.getText()).toBe('user=ana&pw=p%2Bw%26x')
    expect(res.request?.body).toBe('user=ana&pw={secret:pw}')
    expect(res.request?.secretsMasked).toContain('pw')
  })

  it('a raw body under another Content-Type is sent as written', async () => {
    const endpoint = await server.forPost('/form-raw').thenReply(200, 'ok')
    const req = parseHttpFile(
      `POST ${server.url}/form-raw\nContent-Type: text/plain\n\na=1&b=x+y {{v}}\n`
    ).requests[0]

    await execute({ ...req, variables: { v: 'p&q' } }, opts())

    const seen = await endpoint.getSeenRequests()
    expect(await seen[0].body.getText()).toBe('a=1&b=x+y p&q')
  })

  describe('pre-request script and the form body', () => {
    const desktopForm = (path: string, preRequestScript: string): HttpRequest => ({
      method: 'POST',
      url: `${server.url}${path}`,
      headers: FORM,
      body: undefined,
      bodyType: 'x-www-form-urlencoded',
      formFields: [
        { id: 'f-0', key: 'a', value: '1', enabled: true },
        { id: 'f-1', key: 'note', value: 'x y', enabled: true },
        { id: 'f-2', key: 'off', value: 'z', enabled: false },
        { id: 'f-3', key: 't', value: '{{t}}', enabled: true }
      ],
      variables: { t: 'T&U', sig: 'p+q' },
      preRequestScript
    })

    it('reads the encoded form template of the enabled fields (desktop shape); the fields are sent unchanged', async () => {
      const endpoint = await server.forPost('/form-read').thenReply(200, 'ok')

      const res = await execute(
        desktopForm('/form-read', 'fp.environment.set("seen", fp.request.body)'),
        opts()
      )

      expect(res.environmentChanges?.set.seen).toBe('a=1&note=x%20y&t={{t}}')
      const seen = await endpoint.getSeenRequests()
      expect(await seen[0].body.getText()).toBe('a=1&note=x%20y&t=T%26U')
    })

    it('sends the body the script wrote, through the form path (desktop shape)', async () => {
      const endpoint = await server.forPost('/form-write').thenReply(200, 'ok')

      const res = await execute(
        desktopForm('/form-write', 'fp.request.body = fp.request.body + "&sig={{sig}}"'),
        opts()
      )

      const expected = 'a=1&note=x%20y&t=T%26U&sig=p%2Bq'
      const seen = await endpoint.getSeenRequests()
      expect(await seen[0].body.getText()).toBe(expected)
      expect(res.request?.body).toBe(expected)
    })

    it('reads the raw body on the CLI shape', async () => {
      const endpoint = await server.forPost('/form-cli-read').thenReply(200, 'ok')
      const req = parseHttpFile(fileFor('/form-cli-read', 'a=1&scope=x+y')).requests[0]

      const res = await execute(
        { ...req, preRequestScript: 'fp.environment.set("seen", fp.request.body)' },
        opts()
      )

      expect(res.environmentChanges?.set.seen).toBe('a=1&scope=x+y')
      const seen = await endpoint.getSeenRequests()
      expect(await seen[0].body.getText()).toBe('a=1&scope=x%20y')
    })
  })
})
