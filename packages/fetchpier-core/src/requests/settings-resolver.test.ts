import { describe, it, expect } from 'vitest'
import { countOverrides, resolveSettings } from './settings-resolver'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import type { RequestSettings, WorkspaceHttpSettings } from '@shared/types'

const ws: WorkspaceHttpSettings = { ...DEFAULT_WORKSPACE_HTTP_SETTINGS }

describe('resolveSettings', () => {
  it('returns workspace defaults when request has no overrides', () => {
    const resolved = resolveSettings(undefined, ws)
    expect(resolved).toEqual(ws)
  })

  it('returns workspace defaults when all fields marked as inherit', () => {
    const req: RequestSettings = {
      httpVersion: { inherit: true },
      verifySsl: { inherit: true },
      followRedirects: { inherit: true },
      maxRedirects: { inherit: true },
      followAuthorizationOnRedirect: { inherit: true },
      encodeUrl: { inherit: true },
      disableCookieJar: { inherit: true }
    }
    expect(resolveSettings(req, ws)).toEqual(ws)
  })

  it('uses request value when inherit=false', () => {
    const req: RequestSettings = {
      verifySsl: { inherit: false, value: false },
      maxRedirects: { inherit: false, value: 3 }
    }
    const resolved = resolveSettings(req, ws)
    expect(resolved.verifySsl).toBe(false)
    expect(resolved.maxRedirects).toBe(3)
    expect(resolved.followRedirects).toBe(ws.followRedirects)
  })

  it('supports full override', () => {
    const req: RequestSettings = {
      httpVersion: { inherit: false, value: 'http2' },
      verifySsl: { inherit: false, value: false },
      followRedirects: { inherit: false, value: false },
      maxRedirects: { inherit: false, value: 0 },
      followAuthorizationOnRedirect: { inherit: false, value: true },
      encodeUrl: { inherit: false, value: false },
      disableCookieJar: { inherit: false, value: true }
    }
    const resolved = resolveSettings(req, ws)
    expect(resolved.httpVersion).toBe('http2')
    expect(resolved.verifySsl).toBe(false)
    expect(resolved.followRedirects).toBe(false)
    expect(resolved.maxRedirects).toBe(0)
    expect(resolved.followAuthorizationOnRedirect).toBe(true)
    expect(resolved.encodeUrl).toBe(false)
    expect(resolved.disableCookieJar).toBe(true)
  })
})

describe('countOverrides', () => {
  it('returns 0 for undefined or empty', () => {
    expect(countOverrides(undefined)).toBe(0)
    expect(countOverrides({})).toBe(0)
  })

  it('counts only inherit=false entries', () => {
    const s: RequestSettings = {
      verifySsl: { inherit: false, value: false },
      followRedirects: { inherit: true },
      maxRedirects: { inherit: false, value: 5 }
    }
    expect(countOverrides(s)).toBe(2)
  })
})
