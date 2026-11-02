import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock undici before importing the module under test ───────────────────────
// REQ-0061: the update check now egresses through `undici.request`, not Node's
// global `fetch`. `request` resolves to `{ statusCode, body }` and does not
// throw on non-2xx.
const mockRequest = vi.fn()
vi.mock('undici', () => ({ request: (...args: unknown[]) => mockRequest(...args) }))

import { checkForUpdates } from './check'

function mockResponse(init: { status?: number; body?: string; throwOnText?: boolean }): {
  statusCode: number
  body: { text: () => Promise<string>; dump: () => Promise<void> }
} {
  const { status = 200, body = '', throwOnText = false } = init
  return {
    statusCode: status,
    body: {
      text: throwOnText
        ? (): Promise<string> => Promise.reject(new Error('body read failed'))
        : (): Promise<string> => Promise.resolve(body),
      dump: (): Promise<void> => Promise.resolve()
    }
  }
}

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mockRequest.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns isNewer=true when the published version is greater', async () => {
    mockRequest.mockResolvedValue(
      mockResponse({
        body: JSON.stringify({
          products: [
            { name: 'fetchpier', version: '0.2.0' },
            { name: 'other', version: '9.9.9' }
          ]
        })
      })
    )

    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.currentVersion).toBe('0.1.0')
      expect(res.data.publishedVersion).toBe('0.2.0')
      expect(res.data.isNewer).toBe(true)
      expect(typeof res.data.fetchedAt).toBe('string')
    }
  })

  it('returns isNewer=false when versions match', async () => {
    mockRequest.mockResolvedValue(
      mockResponse({
        body: JSON.stringify({
          products: [{ name: 'fetchpier', version: '0.1.0' }]
        })
      })
    )

    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.isNewer).toBe(false)
  })

  it('handles pre-release comparison correctly (0.1.0-beta < 0.1.0)', async () => {
    mockRequest.mockResolvedValue(
      mockResponse({
        body: JSON.stringify({
          products: [{ name: 'fetchpier', version: '0.1.0' }]
        })
      })
    )

    const res = await checkForUpdates('0.1.0-beta.1')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.isNewer).toBe(true)
  })

  it('matches the product name case-insensitively', async () => {
    mockRequest.mockResolvedValue(
      mockResponse({
        body: JSON.stringify({
          products: [{ name: 'Fetchpier', version: '0.1.0' }]
        })
      })
    )

    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(true)
  })

  it('returns product-not-found when the product is missing', async () => {
    mockRequest.mockResolvedValue(
      mockResponse({
        body: JSON.stringify({ products: [{ name: 'other', version: '1.0.0' }] })
      })
    )

    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorKind).toBe('product-not-found')
  })

  it('returns invalid-json when the payload is not valid JSON', async () => {
    mockRequest.mockResolvedValue(mockResponse({ body: 'not-json' }))

    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorKind).toBe('invalid-json')
  })

  it('returns invalid-json when the shape is wrong', async () => {
    mockRequest.mockResolvedValue(mockResponse({ body: JSON.stringify({ foo: 1 }) }))

    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorKind).toBe('invalid-json')
  })

  it('returns invalid-json when a product item is malformed', async () => {
    mockRequest.mockResolvedValue(
      mockResponse({
        body: JSON.stringify({ products: [{ name: 'fetchpier' }] })
      })
    )

    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorKind).toBe('invalid-json')
  })

  it('returns invalid-version when the published version is not semver', async () => {
    mockRequest.mockResolvedValue(
      mockResponse({
        body: JSON.stringify({
          products: [{ name: 'fetchpier', version: 'not-a-version' }]
        })
      })
    )

    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorKind).toBe('invalid-version')
  })

  it('returns network when fetch rejects with a non-abort error', async () => {
    mockRequest.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorKind).toBe('network')
  })

  it('returns network when the response status is not ok', async () => {
    mockRequest.mockResolvedValue(mockResponse({ status: 503 }))
    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorKind).toBe('network')
  })

  it('returns timeout when fetch is aborted', async () => {
    mockRequest.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const res = await checkForUpdates('0.1.0')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errorKind).toBe('timeout')
  })

  it('treats non-semver current versions as outdated when server is valid', async () => {
    mockRequest.mockResolvedValue(
      mockResponse({
        body: JSON.stringify({
          products: [{ name: 'fetchpier', version: '0.1.0' }]
        })
      })
    )

    const res = await checkForUpdates('dev-build')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.isNewer).toBe(true)
      expect(res.data.currentVersion).toBe('dev-build')
    }
  })
})
