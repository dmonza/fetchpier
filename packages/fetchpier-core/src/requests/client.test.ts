import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock undici before importing client ──────────────────────────────────────
const mockRequest = vi.fn()
const mockDestroy = vi.fn().mockResolvedValue(undefined)
const agentConstructorCalls: unknown[] = []
const proxyAgentConstructorCalls: unknown[] = []
let lastComposedInterceptor: ((d: unknown) => unknown) | null = null
// REQ-0115: the client now composes a CHAIN (cookies inside, redirect outside),
// and real  accepts either a list or varargs. The mock mirrors that so
// the ordering the per-hop jar depends on is assertable.
let lastComposedChain: ((d: unknown) => unknown)[] = []

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()

  class MockAgent {
    constructor(opts?: unknown) {
      agentConstructorCalls.push(opts)
    }
    compose(...args: unknown[]) {
      const chain = (Array.isArray(args[0]) ? args[0] : args) as ((d: unknown) => unknown)[]
      lastComposedChain = chain
      lastComposedInterceptor = chain[chain.length - 1] ?? null
      return this
    }
    request(opts: unknown) {
      return mockRequest(opts)
    }
    destroy() {
      return mockDestroy()
    }
  }

  class MockProxyAgent {
    constructor(opts?: unknown) {
      proxyAgentConstructorCalls.push(opts)
    }
    compose(...args: unknown[]) {
      const chain = (Array.isArray(args[0]) ? args[0] : args) as ((d: unknown) => unknown)[]
      lastComposedChain = chain
      lastComposedInterceptor = chain[chain.length - 1] ?? null
      return this
    }
    request(opts: unknown) {
      return mockRequest(opts)
    }
    destroy() {
      return mockDestroy()
    }
  }

  return {
    ...actual,
    Agent: MockAgent,
    ProxyAgent: MockProxyAgent
  }
})

import { sendRequest, sendRequestWithRaw } from './client'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import type { WorkspaceHttpSettings } from '@shared/types'
import { CoreError } from '../shared/context'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBodyStream(body: string | Buffer) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body
  return {
    text: async () => buf.toString('utf-8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
}

function makeResponse(
  statusCode: number,
  headers: Record<string, string | string[]>,
  bodyText: string | Buffer
) {
  return { statusCode, headers, body: makeBodyStream(bodyText) }
}

beforeEach(() => {
  vi.clearAllMocks()
  agentConstructorCalls.length = 0
  proxyAgentConstructorCalls.length = 0
  lastComposedInterceptor = null
})

function settingsWith(overrides: Partial<WorkspaceHttpSettings>): WorkspaceHttpSettings {
  return { ...DEFAULT_WORKSPACE_HTTP_SETTINGS, ...overrides }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sendRequest', () => {
  it('returns a structured HttpResponse for a 200 GET', async () => {
    mockRequest.mockResolvedValueOnce(
      makeResponse(200, { 'content-type': 'application/json' }, '{"id":1}')
    )

    const result = await sendRequest({ method: 'GET', url: 'https://example.com/api', headers: {} })

    expect(result.status).toBe(200)
    expect(result.statusText).toBe('OK')
    expect(result.body).toBe('{"id":1}')
    expect(result.headers['content-type']).toBe('application/json')
    expect(result.sizeBytes).toBe(Buffer.byteLength('{"id":1}', 'utf-8'))
    expect(result.timingMs).toBeGreaterThanOrEqual(0)
  })

  it('returns the correct statusText for known status codes', async () => {
    for (const [code, text] of [
      [201, 'Created'],
      [404, 'Not Found'],
      [500, 'Internal Server Error'],
      // ENG-17: standard codes the client once lacked.
      [203, 'Non-Authoritative Information'],
      [206, 'Partial Content'],
      [303, 'See Other'],
      [412, 'Precondition Failed'],
      [415, 'Unsupported Media Type'],
      [451, 'Unavailable For Legal Reasons'],
      [501, 'Not Implemented'],
      [505, 'HTTP Version Not Supported']
    ] as const) {
      mockRequest.mockResolvedValueOnce(makeResponse(code, {}, ''))
      const result = await sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
      expect(result.statusText).toBe(text)
    }
  })

  it('falls back to the numeric code string for unknown status codes', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(999, {}, ''))
    const result = await sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    expect(result.statusText).toBe('999')
  })

  it('forwards request method, headers and body to undici', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))

    await sendRequest({
      method: 'POST',
      url: 'https://example.com/data',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: '{}'
    })

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          authorization: 'Bearer tok'
        }),
        body: '{}'
      })
    )
  })

  it('joins multi-value headers into a single comma-separated string', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, { 'set-cookie': ['a=1', 'b=2'] }, ''))

    const result = await sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    expect(result.headers['set-cookie']).toBe('a=1, b=2')
  })

  it('passes the AbortSignal to undici', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))

    const controller = new AbortController()
    await sendRequest(
      { method: 'GET', url: 'https://example.com', headers: {} },
      { signal: controller.signal }
    )

    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
  })

  // ENG-01 / ENG-03: "cancelled" is a fact of the signal, not of the error type.
  it('does not report an abort-typed error as a cancellation when nothing aborted', async () => {
    const { errors } = await import('undici')
    mockRequest.mockRejectedValueOnce(new errors.RequestAbortedError())

    const failure = sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    await expect(failure).rejects.toThrow('Request aborted')
    await expect(failure).rejects.not.toThrow('Request cancelled')
  })

  it.each([
    [407, 'Proxy refused the tunnel (407 Proxy Authentication Required)'],
    [403, 'Proxy refused the tunnel (403 Forbidden)'],
    [502, 'Proxy refused the tunnel (502 Bad Gateway)'],
    [599, 'Proxy refused the tunnel (599)']
  ])('names a proxy that answers the tunnel with %d', async (status, message) => {
    const { errors } = await import('undici')
    const refusal = new errors.RequestAbortedError(
      `Proxy response (${status}) !== 200 when HTTP Tunneling`
    )
    mockRequest.mockRejectedValueOnce(refusal)

    const failure = sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    await expect(failure).rejects.toThrow(message)
    await expect(failure).rejects.toMatchObject({ cause: refusal })
  })

  it.each([
    ['the runtime abort error', () => new DOMException('This operation was aborted', 'AbortError')],
    ['a proxy refusal that raced the abort', () => new Error('Proxy response (407) !== 200')],
    ['any other failure', () => new Error('socket hang up')]
  ])('reports a user abort as "Request cancelled" whatever undici raised (%s)', async (_, make) => {
    const controller = new AbortController()
    controller.abort()
    const raised = make()
    mockRequest.mockRejectedValueOnce(raised)

    const failure = sendRequest(
      { method: 'GET', url: 'https://example.com', headers: {} },
      { signal: controller.signal }
    )
    await expect(failure).rejects.toThrow(/^Request cancelled$/)
    await expect(failure).rejects.toMatchObject({ cause: raised })
  })

  it('re-throws generic errors from undici', async () => {
    const original = new Error('ECONNREFUSED')
    mockRequest.mockRejectedValueOnce(original)

    // Identity, not just the text: an error that already says something is
    // handed on untouched, so nothing downstream sees a rewritten failure.
    await expect(
      sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    ).rejects.toBe(original)
  })

  // The failure raised when every address of a multi-address host is refused
  // carries its detail in `errors` and leaves its own message empty. This
  // operation is part of the package's published surface, so it owes a
  // described failure to anyone who calls it directly — not just to the
  // pipeline that wraps it.
  it('describes an aggregated failure whose own message is empty', async () => {
    mockRequest.mockRejectedValueOnce(
      new AggregateError(
        [
          new Error('connect ECONNREFUSED ::1:8082'),
          new Error('connect ECONNREFUSED 127.0.0.1:8082')
        ],
        ''
      )
    )

    await expect(
      sendRequest({ method: 'POST', url: 'http://localhost:8082/x', headers: {} })
    ).rejects.toThrow('connect ECONNREFUSED ::1:8082; connect ECONNREFUSED 127.0.0.1:8082')
  })

  it('keeps the original failure as the cause when it describes one', async () => {
    const aggregated = new AggregateError([new Error('connect ECONNREFUSED ::1:8082')], '')
    mockRequest.mockRejectedValueOnce(aggregated)

    await expect(
      sendRequest({ method: 'GET', url: 'http://localhost:8082', headers: {} })
    ).rejects.toMatchObject({ cause: aggregated })
  })

  // The pipeline re-throws a CoreError by identity to keep a contractual
  // failure fatal. Wrapping one here would erase its code and silently
  // downgrade it into an ordinary failed request.
  it('never wraps a CoreError, even one carrying no message', async () => {
    const coreError = new CoreError('MULTIPART_FILE_MISSING', '')
    mockRequest.mockRejectedValueOnce(coreError)

    await expect(
      sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    ).rejects.toBe(coreError)
  })

  it('calculates sizeBytes based on UTF-8 byte length', async () => {
    const emoji = '😀' // 4 bytes in UTF-8
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, emoji))

    const result = await sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    expect(result.sizeBytes).toBe(4)
  })

  // ENG-05: the size is the byte count of the body as read, not the length of
  // its lossy UTF-8 text (every invalid byte would count as a 3-byte U+FFFD).
  it.each([
    ['binary bytes', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x90])],
    ['Latin-1 text', Buffer.from('café ñandú', 'latin1')],
    ['a lone UTF-8 lead byte at the end', Buffer.from([0x61, 0x62, 0xe2])]
  ])('reports the true byte count for %s', async (_label, bytes) => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, { 'content-type': 'image/png' }, bytes))

    const result = await sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    expect(result.sizeBytes).toBe(bytes.length)
    expect(result.sizeBytes).toBe(result.decompressedBytes)
  })

  it('calls agent.destroy() after a successful request', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))

    await sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })

    expect(mockDestroy).toHaveBeenCalledTimes(1)
  })

  it('calls agent.destroy() even after a failed request', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network error'))

    await expect(
      sendRequest({ method: 'GET', url: 'https://example.com', headers: {} })
    ).rejects.toThrow()

    expect(mockDestroy).toHaveBeenCalledTimes(1)
  })

  // ── Body shaping (undici H2 buffer-body workaround) ─────────────────────────
  // See REQ-0046: undici v8 H2 client asserts `contentLength === body.byteLength`
  // for buffer bodies, but nulls contentLength when the method does not expect a
  // payload. We sidestep that by passing a Readable stream for those methods.

  it('forwards a string body unchanged for POST', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({
      method: 'POST',
      url: 'https://example.com',
      headers: {},
      body: 'hello'
    })
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ body: 'hello' }))
  })

  it.each(['GET', 'DELETE', 'HEAD', 'OPTIONS'])(
    'wraps a non-empty body as a Readable stream for %s',
    async (method) => {
      const { Readable } = await import('node:stream')
      mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
      await sendRequest({
        method,
        url: 'https://example.com',
        headers: {},
        body: '{"q":"foo"}'
      })

      const callArg = mockRequest.mock.calls[0][0] as { body: unknown }
      expect(callArg.body).toBeInstanceOf(Readable)
    }
  )

  it.each(['GET', 'DELETE'])('passes a null body when body is empty for %s', async (method) => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({ method, url: 'https://example.com', headers: {}, body: '' })

    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ body: null }))
  })

  it('passes a null body when body is undefined regardless of method', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({ method: 'POST', url: 'https://example.com', headers: {} })
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ body: null }))
  })

  it('treats lowercase method casing the same as uppercase', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({
      method: 'post',
      url: 'https://example.com',
      headers: {},
      body: 'x'
    })
    // 'post' should still be treated as a payload method, so body stays a string.
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ body: 'x' }))
  })

  // ── Binary body pass-through (REQ-0065) ──────────────────────────────────
  it('passes a Buffer binary body through unchanged for POST/PUT/PATCH', async () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02])
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequestWithRaw(
      { method: 'POST', url: 'https://example.com/u', headers: {} },
      { binaryBody: buf }
    )
    const callArg = mockRequest.mock.calls[0][0] as { body: unknown }
    expect(Buffer.isBuffer(callArg.body)).toBe(true)
    expect((callArg.body as Buffer).equals(buf)).toBe(true)
  })

  it('binaryBody takes precedence over httpRequest.body', async () => {
    const buf = Buffer.from('binary content')
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequestWithRaw(
      { method: 'POST', url: 'https://example.com/u', headers: {}, body: 'should-be-ignored' },
      { binaryBody: buf }
    )
    const callArg = mockRequest.mock.calls[0][0] as { body: unknown }
    expect(Buffer.isBuffer(callArg.body)).toBe(true)
    expect((callArg.body as Buffer).toString()).toBe('binary content')
  })

  it('wraps a Buffer body as a Readable for bodyless methods (H2 workaround)', async () => {
    const { Readable } = await import('node:stream')
    const buf = Buffer.from('payload')
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequestWithRaw(
      { method: 'DELETE', url: 'https://example.com/u', headers: {} },
      { binaryBody: buf }
    )
    const callArg = mockRequest.mock.calls[0][0] as { body: unknown }
    expect(callArg.body).toBeInstanceOf(Readable)
  })

  // ENG-04: a streamed body has no length undici can read, so the client states
  // it; otherwise HTTP/1.1 frames it chunked.
  it.each([
    ['a string body', { body: '{"q":"é"}' }, {}, 10],
    ['a Buffer body', {}, { binaryBody: Buffer.from([1, 2, 3]) }, 3]
  ])('declares the byte length of %s it streams', async (_, req, opts, length) => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequestWithRaw(
      { method: 'DELETE', url: 'https://example.com/u', headers: {}, ...req },
      opts
    )
    const callArg = mockRequest.mock.calls[0][0] as { headers: Record<string, string> }
    expect(callArg.headers['Content-Length']).toBe(String(length))
  })

  it('declares the length in the ordered header list form too', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequestWithRaw({
      method: 'GET',
      url: 'https://example.com/_search',
      headers: { Accept: 'application/json' },
      headerList: [{ name: 'Accept', value: 'application/json' }],
      body: '{"q":1}'
    })
    const callArg = mockRequest.mock.calls[0][0] as { headers: string[] }
    expect(callArg.headers).toEqual([
      'Accept',
      'application/json',
      'User-Agent',
      expect.stringMatching(/Fetchpier/),
      'Content-Length',
      '7'
    ])
  })

  it.each([
    ['record', { headers: { 'content-length': '7' } }],
    [
      'header list',
      {
        headers: { 'CONTENT-LENGTH': '7' },
        headerList: [{ name: 'CONTENT-LENGTH', value: '7' }]
      }
    ]
  ])('keeps a Content-Length the user set (%s form)', async (_, req) => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequestWithRaw({
      method: 'DELETE',
      url: 'https://example.com/u',
      body: 'abcdefg',
      ...req
    })
    const headers = (mockRequest.mock.calls[0][0] as { headers: unknown }).headers
    const lengths = (
      Array.isArray(headers)
        ? (headers as string[]).filter((_v, i) => i % 2 === 0)
        : Object.keys(headers as object)
    ).filter((name) => name.toLowerCase() === 'content-length')
    expect(lengths).toHaveLength(1)
    expect(JSON.stringify(headers)).toContain('"7"')
  })

  it.each([
    ['POST with a body', { method: 'POST', body: 'hello' }],
    ['DELETE without a body', { method: 'DELETE', body: '' }]
  ])('adds no Content-Length for %s (the transport frames it)', async (_, req) => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequestWithRaw({ url: 'https://example.com/u', headers: {}, ...req })
    const callArg = mockRequest.mock.calls[0][0] as { headers: Record<string, string> }
    expect(callArg.headers['Content-Length']).toBeUndefined()
  })

  it('passes null when binaryBody is an empty Buffer', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequestWithRaw(
      { method: 'POST', url: 'https://example.com/u', headers: {} },
      { binaryBody: Buffer.alloc(0) }
    )
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ body: null }))
  })
})

// ── Coverage-gap additions (REQ-0055 §4.3.1) ───────────────────────────────

describe('URL normalisation and User-Agent', () => {
  it('prepends https:// when the URL omits a scheme', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({ method: 'GET', url: 'example.com/api', headers: {} })
    const call = mockRequest.mock.calls[0][0] as { origin: string; path: string }
    expect(call.origin).toBe('https://example.com')
    expect(call.path).toBe('/api')
  })

  it('preserves the scheme when http:// is already present', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({ method: 'GET', url: 'http://insecure.test/', headers: {} })
    const call = mockRequest.mock.calls[0][0] as { origin: string }
    expect(call.origin).toBe('http://insecure.test')
  })

  it('preserves the query string in the constructed path', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({
      method: 'GET',
      url: 'https://x.test/search?q=fetchpier&page=2',
      headers: {}
    })
    const call = mockRequest.mock.calls[0][0] as { path: string }
    expect(call.path).toBe('/search?q=fetchpier&page=2')
  })

  it('adds a default User-Agent when the caller omits one', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({ method: 'GET', url: 'https://x/', headers: {} })
    const call = mockRequest.mock.calls[0][0] as { headers: Record<string, string> }
    expect(call.headers['User-Agent']).toMatch(/Fetchpier/)
  })

  it('preserves a caller-supplied User-Agent (any casing)', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({
      method: 'GET',
      url: 'https://x/',
      headers: { 'user-agent': 'my-bot/1.0' }
    })
    const call = mockRequest.mock.calls[0][0] as { headers: Record<string, string> }
    expect(call.headers['User-Agent']).toBeUndefined()
    expect(call.headers['user-agent']).toBe('my-bot/1.0')
  })

  it('passes signal=null when no AbortSignal is supplied', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest({ method: 'GET', url: 'https://x/', headers: {} })
    const call = mockRequest.mock.calls[0][0] as { signal: AbortSignal | null }
    expect(call.signal).toBeNull()
  })

  it('wraps a non-Error throw value into an Error', async () => {
    mockRequest.mockRejectedValueOnce('opaque string failure')
    await expect(sendRequest({ method: 'GET', url: 'https://x/', headers: {} })).rejects.toThrow(
      'opaque string failure'
    )
  })
})

describe('sendRequestWithRaw — Set-Cookie capture', () => {
  it('returns Set-Cookie values as a separate array, preserving commas', async () => {
    const setCookieA = 'sid=abc; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/'
    const setCookieB = 'pref=dark; Path=/'
    mockRequest.mockResolvedValueOnce(
      makeResponse(200, { 'set-cookie': [setCookieA, setCookieB] }, 'ok')
    )
    const { response, rawSetCookie } = await sendRequestWithRaw({
      method: 'GET',
      url: 'https://x/',
      headers: {}
    })
    expect(response.status).toBe(200)
    expect(rawSetCookie).toEqual([setCookieA, setCookieB])
    // headers field still joins by ", " for legacy display.
    expect(response.headers['set-cookie']).toBe(`${setCookieA}, ${setCookieB}`)
  })

  it('lists every response header value in order, one entry per value (ENG-02)', async () => {
    const setCookieA = 'session=abc; Path=/; HttpOnly'
    const setCookieB = 'csrf=xyz; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT'
    mockRequest.mockResolvedValueOnce(
      makeResponse(
        200,
        {
          'content-type': 'text/plain',
          'set-cookie': [setCookieA, setCookieB],
          'x-trace': ['1', '2'],
          'x-empty': undefined as unknown as string
        },
        'ok'
      )
    )
    const { response } = await sendRequestWithRaw({ method: 'GET', url: 'https://x/', headers: {} })
    expect(response.headerList).toEqual([
      { name: 'content-type', value: 'text/plain' },
      { name: 'set-cookie', value: setCookieA },
      { name: 'set-cookie', value: setCookieB },
      { name: 'x-trace', value: '1' },
      { name: 'x-trace', value: '2' }
    ])
    // The joined record is unchanged.
    expect(response.headers['x-trace']).toBe('1, 2')
  })

  it('returns an empty array when no Set-Cookie was received', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    const { rawSetCookie } = await sendRequestWithRaw({
      method: 'GET',
      url: 'https://x/',
      headers: {}
    })
    expect(rawSetCookie).toEqual([])
  })

  it('captures a single Set-Cookie returned as a bare string (not array)', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, { 'set-cookie': 'one=1; Path=/' }, ''))
    const { rawSetCookie } = await sendRequestWithRaw({
      method: 'GET',
      url: 'https://x/',
      headers: {}
    })
    expect(rawSetCookie).toEqual(['one=1; Path=/'])
  })

  it('skips header entries whose value is undefined', async () => {
    mockRequest.mockResolvedValueOnce(
      makeResponse(200, { 'x-undef': undefined as unknown as string, 'x-defined': 'y' }, '')
    )
    const { response } = await sendRequestWithRaw({
      method: 'GET',
      url: 'https://x/',
      headers: {}
    })
    expect(response.headers['x-defined']).toBe('y')
    expect(response.headers['x-undef']).toBeUndefined()
  })
})

describe('Dispatcher construction — settings, proxy, TLS material', () => {
  it('builds a plain Agent with allowH2=true for HTTPS in auto mode', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { settings: settingsWith({ httpVersion: 'auto', followRedirects: false }) }
    )
    expect(agentConstructorCalls).toHaveLength(1)
    expect(agentConstructorCalls[0]).toMatchObject({ allowH2: true })
  })

  it('builds a plain Agent with allowH2=false for plain HTTP in auto mode', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'http://x/', headers: {} },
      { settings: settingsWith({ httpVersion: 'auto', followRedirects: false }) }
    )
    expect(agentConstructorCalls[0]).toMatchObject({ allowH2: false })
  })

  it('advises and falls back to HTTP/1.1 when http2 is requested over plain HTTP', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onWarning = vi.fn()
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'http://x/', headers: {} },
      { settings: settingsWith({ httpVersion: 'http2', followRedirects: false }), onWarning }
    )
    expect(onWarning).toHaveBeenCalledWith({ code: 'HTTP2_DOWNGRADED' })
    expect(warnSpy).not.toHaveBeenCalled()
    expect(agentConstructorCalls[0]).toMatchObject({ allowH2: false })
    warnSpy.mockRestore()
  })

  it('honours httpVersion=http1 explicitly', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { settings: settingsWith({ httpVersion: 'http1', followRedirects: false }) }
    )
    expect(agentConstructorCalls[0]).toMatchObject({ allowH2: false })
  })

  it('respects verifySsl=false in the connect TLS options', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { settings: settingsWith({ verifySsl: false, followRedirects: false }) }
    )
    const opts = agentConstructorCalls[0] as { connect: { rejectUnauthorized: boolean } }
    expect(opts.connect.rejectUnauthorized).toBe(false)
  })

  it('attaches CA / cert / key / pfx / passphrase TLS material to the agent', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    const ca = [Buffer.from('CA1')]
    const cert = Buffer.from('CERT')
    const key = Buffer.from('KEY')
    const pfx = Buffer.from('PFX')
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        settings: settingsWith({ followRedirects: false }),
        tls: { ca, cert, key, pfx, passphrase: 'pw' }
      }
    )
    const opts = agentConstructorCalls[0] as { connect: Record<string, unknown> }
    expect(opts.connect.ca).toBe(ca)
    expect(opts.connect.cert).toBe(cert)
    expect(opts.connect.key).toBe(key)
    expect(opts.connect.pfx).toBe(pfx)
    expect(opts.connect.passphrase).toBe('pw')
  })

  it('omits TLS material when arrays are empty / fields absent', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { settings: settingsWith({ followRedirects: false }), tls: { ca: [] } }
    )
    const opts = agentConstructorCalls[0] as { connect: Record<string, unknown> }
    expect(opts.connect.ca).toBeUndefined()
    expect(opts.connect.cert).toBeUndefined()
  })

  it('uses ProxyAgent when proxy.enabled and proxy.url are set', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        proxy: {
          enabled: true,
          url: 'http://proxy.local:8080',
          username: '',
          password: ''
        },
        settings: settingsWith({ followRedirects: false })
      }
    )
    expect(agentConstructorCalls).toHaveLength(0)
    expect(proxyAgentConstructorCalls).toHaveLength(1)
    const opts = proxyAgentConstructorCalls[0] as { uri: string; token: string | undefined }
    expect(opts.uri).toBe('http://proxy.local:8080')
    expect(opts.token).toBeUndefined() // no creds → no Basic header
  })

  it('builds a Basic-auth token for the proxy when username is set', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        proxy: {
          enabled: true,
          url: 'http://proxy.local:8080',
          username: 'user',
          password: 'pw'
        },
        settings: settingsWith({ followRedirects: false })
      }
    )
    const opts = proxyAgentConstructorCalls[0] as { token: string }
    expect(opts.token).toBe('Basic ' + Buffer.from('user:pw').toString('base64'))
  })

  it('ignores proxy when enabled=false even if url is set', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        proxy: { enabled: false, url: 'http://nope/', username: '', password: '' },
        settings: settingsWith({ followRedirects: false })
      }
    )
    expect(proxyAgentConstructorCalls).toHaveLength(0)
    expect(agentConstructorCalls).toHaveLength(1)
  })

  it('gives the proxy only the trust material, never the client certificate', async () => {
    // The certificate identifies the client to the server it was chosen for; the
    // proxy is not that server.
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    const ca = [Buffer.from('CA1')]
    const cert = Buffer.from('CERT')
    const key = Buffer.from('KEY')
    const pfx = Buffer.from('PFX')
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        proxy: { enabled: true, url: 'https://proxy.local:8443', username: '', password: '' },
        settings: settingsWith({ followRedirects: false, verifySsl: false }),
        tls: { ca, cert, key, pfx, passphrase: 'pw' }
      }
    )
    const opts = proxyAgentConstructorCalls[0] as {
      requestTls: Record<string, unknown>
      proxyTls: Record<string, unknown>
    }
    expect(opts.requestTls).toMatchObject({ ca, cert, key, pfx, passphrase: 'pw' })
    expect(opts.proxyTls).toEqual({ rejectUnauthorized: false, ca })
  })

  it('awaits a TLS resolver for the first hop and attaches what it returns', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    const cert = Buffer.from('CERT')
    const tls = vi.fn(async () => ({ cert }))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { settings: settingsWith({ followRedirects: false }), tls }
    )
    expect(tls).toHaveBeenCalledWith('https://x/')
    const opts = agentConstructorCalls[0] as { connect: Record<string, unknown> }
    expect(opts.connect.cert).toBe(cert)
  })

  it('ignores proxy when url is blank', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        proxy: { enabled: true, url: '   ', username: '', password: '' },
        settings: settingsWith({ followRedirects: false })
      }
    )
    expect(proxyAgentConstructorCalls).toHaveLength(0)
  })
})

describe('Redirect interceptor composition', () => {
  it('does NOT compose any interceptor when followRedirects is false', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { settings: settingsWith({ followRedirects: false }) }
    )
    expect(lastComposedInterceptor).toBeNull()
  })

  it('composes an interceptor when followRedirects=true and maxRedirects>0', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { settings: settingsWith({ followRedirects: true, maxRedirects: 5 }) }
    )
    expect(typeof lastComposedInterceptor).toBe('function')
  })

  it('composes an interceptor when followAuthorizationOnRedirect=true', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        settings: settingsWith({
          followRedirects: true,
          maxRedirects: 3,
          followAuthorizationOnRedirect: true
        })
      }
    )
    expect(typeof lastComposedInterceptor).toBe('function')
  })

  it('composes a no-op interceptor when maxRedirects=0 even with followRedirects=true', async () => {
    // followRedirects:true + maxRedirects:0 → buildAgent returns base early
    // (before composing). Confirm no interceptor is captured.
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { settings: settingsWith({ followRedirects: true, maxRedirects: 0 }) }
    )
    expect(lastComposedInterceptor).toBeNull()
  })

  // REQ-0115: the per-hop cookie jar depends entirely on this ordering. `compose`
  // makes the LAST entry outermost, so the redirect interceptor must come after
  // the cookie one — otherwise the jar runs once for the whole chain instead of
  // once per hop, and the product silently goes back to capturing nothing on a
  // login that redirects. The behavior is proven end-to-end in
  // `cookie-redirect-execute.test.ts`; this pins the wiring that enables it.
  const noopHooks = { headerFor: () => '', capture: () => {} }

  it('places the cookie interceptor inside the redirect interceptor', async () => {
    // Innermost first: the per-hop router (P1-2), the cookie jar, the `Location`
    // correction, then the redirect interceptor that drives the loop.
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        settings: settingsWith({ followRedirects: true, maxRedirects: 5 }),
        cookies: noopHooks
      }
    )
    expect(lastComposedChain).toHaveLength(4)
  })

  it('adds the Authorization follow-up per hop only when the setting asks for it', async () => {
    mockRequest.mockResolvedValue(makeResponse(200, {}, ''))
    const send = (followAuthorizationOnRedirect: boolean) =>
      sendRequest(
        { method: 'GET', url: 'https://x/', headers: {} },
        {
          settings: settingsWith({
            followRedirects: true,
            maxRedirects: 5,
            followAuthorizationOnRedirect
          })
        }
      )
    await send(false)
    expect(lastComposedChain).toHaveLength(3)
    await send(true)
    expect(lastComposedChain).toHaveLength(4)
  })

  it('composes the cookie interceptor even when redirects are off', async () => {
    // Without this, a workspace with followRedirects:false would attach no
    // cookies at all — the jar would be wired only into the redirect path.
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      {
        settings: settingsWith({ followRedirects: false, maxRedirects: 0 }),
        cookies: noopHooks
      }
    )
    expect(lastComposedChain).toHaveLength(1)
  })
})

describe('ordered, duplicate-capable headers (CA-03)', () => {
  it('sends duplicate header names to undici as the positional array form', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      {
        method: 'GET',
        url: 'https://x/',
        headers: { Accept: 'text/html', 'User-Agent': 'ua' },
        headerList: [
          { name: 'Accept', value: 'application/json' },
          { name: 'Accept', value: 'text/html' },
          { name: 'User-Agent', value: 'ua' }
        ]
      },
      { settings: settingsWith({ followRedirects: false }) }
    )
    const opts = mockRequest.mock.calls[0][0] as { headers: unknown }
    // Array form preserves order + duplicates ([name, value, name, value, …]).
    expect(opts.headers).toEqual([
      'Accept',
      'application/json',
      'Accept',
      'text/html',
      'User-Agent',
      'ua'
    ])
  })

  it('injects a default User-Agent into the array form when absent', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      {
        method: 'GET',
        url: 'https://x/',
        headers: { Accept: 'application/json' },
        headerList: [{ name: 'Accept', value: 'application/json' }]
      },
      { settings: settingsWith({ followRedirects: false }) }
    )
    const opts = mockRequest.mock.calls[0][0] as { headers: string[] }
    expect(opts.headers).toContain('User-Agent')
  })
})

// ── CLI readiness: default UA, decoding, timeout reason, proxy resolver ───────

describe('sendRequestWithRaw — CLI readiness', () => {
  it('uses the caller-supplied default User-Agent when the request carries none', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://x/', headers: {} },
      { userAgent: 'Fetchpier-CLI/9.9.9' }
    )
    expect(mockRequest.mock.calls[0][0].headers['User-Agent']).toBe('Fetchpier-CLI/9.9.9')
  })

  it('decodes a gzip body and reports both sizes and the status, keeping the headers', async () => {
    const { gzipSync } = await import('node:zlib')
    const text = 'x'.repeat(2000)
    const wire = gzipSync(Buffer.from(text))
    mockRequest.mockResolvedValueOnce(makeResponse(200, { 'content-encoding': 'gzip' }, wire))
    const r = await sendRequest({ method: 'GET', url: 'https://x/', headers: {} })
    expect(r.body).toBe(text)
    expect(r.decodingStatus).toBe('decoded')
    expect(r.compressedBytes).toBe(wire.length)
    expect(r.decompressedBytes).toBe(2000)
    expect(r.sizeBytes).toBe(2000)
    expect(r.headers['content-encoding']).toBe('gzip')
  })

  it('keeps an undecodable body as received and advises', async () => {
    const onWarning = vi.fn()
    mockRequest.mockResolvedValueOnce(makeResponse(200, { 'content-encoding': 'zstd' }, 'raw'))
    const r = await sendRequest({ method: 'GET', url: 'https://x/', headers: {} }, { onWarning })
    expect(r.body).toBe('raw')
    expect(r.decodingStatus).toBe('unsupported')
    expect(onWarning).toHaveBeenCalledWith({
      code: 'UNSUPPORTED_CONTENT_ENCODING',
      encoding: 'zstd'
    })
  })

  it('an uncompressed body is not-required with equal sizes', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, 'plain'))
    const r = await sendRequest({ method: 'GET', url: 'https://x/', headers: {} })
    expect(r.decodingStatus).toBe('not-required')
    expect(r.compressedBytes).toBe(5)
    expect(r.decompressedBytes).toBe(5)
  })

  it('reports an expired adapter timer as a timeout naming the limit, not a cancellation', async () => {
    const { timeoutAbortReason } = await import('./client')
    const controller = new AbortController()
    controller.abort(timeoutAbortReason(30000))
    const { errors } = await import('undici')
    mockRequest.mockRejectedValueOnce(new errors.RequestAbortedError())
    await expect(
      sendRequest({ method: 'GET', url: 'https://x/', headers: {} }, { signal: controller.signal })
    ).rejects.toThrow('timed out after 30 s')
  })

  it('keeps the timeout message when undici rejects with the abort reason itself', async () => {
    // What undici really raises on an aborted signal: `signal.reason`.
    const { timeoutAbortReason } = await import('./client')
    const controller = new AbortController()
    controller.abort(timeoutAbortReason(1500))
    mockRequest.mockRejectedValueOnce(controller.signal.reason)
    await expect(
      sendRequest({ method: 'GET', url: 'https://x/', headers: {} }, { signal: controller.signal })
    ).rejects.toThrow('timed out after 1.5 s')
  })

  it('a plain abort is still a cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const { errors } = await import('undici')
    mockRequest.mockRejectedValueOnce(new errors.RequestAbortedError())
    await expect(
      sendRequest({ method: 'GET', url: 'https://x/', headers: {} }, { signal: controller.signal })
    ).rejects.toThrow('Request cancelled')
  })

  it('asks a proxy resolver for the target and connects through what it returns', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    const resolver = vi.fn(() => ({
      enabled: true,
      url: 'http://proxy:3128',
      username: '',
      password: ''
    }))
    await sendRequest(
      { method: 'GET', url: 'https://api.test/x', headers: {} },
      { proxy: resolver }
    )
    expect(resolver).toHaveBeenCalledWith('https://api.test/x')
    expect(proxyAgentConstructorCalls[0]).toMatchObject({ uri: 'http://proxy:3128' })
  })

  it('a resolver returning undefined connects directly', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse(200, {}, ''))
    await sendRequest(
      { method: 'GET', url: 'https://api.test/x', headers: {} },
      { proxy: () => undefined }
    )
    expect(proxyAgentConstructorCalls).toHaveLength(0)
    expect(agentConstructorCalls).toHaveLength(1)
  })
})

describe('formatTimeoutLimit', () => {
  it.each([
    [200, '200 ms'],
    [1000, '1 s'],
    [1500, '1.5 s'],
    [30000, '30 s']
  ])('%d → %s', async (ms, text) => {
    const { formatTimeoutLimit } = await import('./client')
    expect(formatTimeoutLimit(ms)).toBe(text)
  })
})
