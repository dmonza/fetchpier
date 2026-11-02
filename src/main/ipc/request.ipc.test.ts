/**
 * REQ-0104 Stage 2: `http:send` must clean up its in-flight registration on
 * EVERY pre-flight failure path, not just the binary/multipart ones. A
 * failure while resolving `{{$env.NAME}}` references previously propagated as
 * a raw rejection and left the execution's AbortController registered
 * forever — leaking on every retry of a failing send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpRequest } from '../../shared/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const ipcHandlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => ipcHandlers.set(channel, fn)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('./appsettings.ipc', () => ({
  readAppSettings: () => ({ requestTimeoutSeconds: 30, proxy: undefined })
}))

vi.mock('../config/workspace-settings-store', () => ({
  getCachedHttpSettings: () => ({ followRedirects: true }),
  loadHttpSettings: async () => ({ followRedirects: true })
}))

vi.mock('../tls/store', () => ({
  resolveTlsForUrl: vi.fn()
}))

vi.mock('../secrets/service', () => ({
  buildSendMasker: vi.fn(async () => undefined),
  lockAllSecrets: vi.fn(),
  resolvePassphraseSecrets: vi.fn(async () => ({}))
}))

vi.mock('../secrets/local-values', () => ({
  loadMergedEnvironment: vi.fn(async () => ({
    merged: { secretsMap: {} },
    localPlainOverlay: {},
    orphanNotice: undefined
  })),
  persistScriptEnvChanges: vi.fn(async () => {})
}))

const { resolveReferences } = vi.hoisted(() => ({
  resolveReferences: vi.fn(async (vars: Record<string, string>) => vars)
}))

vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: () => ({
    path: '/fake/workspace',
    dotenv: { resolveReferences },
    binary: { read: vi.fn(), stat: vi.fn() }
  })
}))

const executeMock = vi.fn(async (..._args: unknown[]) => ({
  response: { status: 200, statusText: 'OK', headers: {}, body: '', durationMs: 1 },
  scriptResults: [],
  environmentChanges: undefined,
  resolvedSettings: {},
  cookies: { sent: [], received: [] }
}))

// The route must not derive a reason itself. Stubbing the shared operation
// with a recognisable marker is what proves it goes through it: the composition
// rules are already pinned in the core package's own suite and are deliberately
// not re-proven here.
const describeErrorMock = vi.hoisted(() =>
  vi.fn((err: unknown) => `described:${(err as Error)?.name ?? typeof err}`)
)

vi.mock('@fetchpier/core', () => ({
  describeError: describeErrorMock,
  requests: { execute: (...args: unknown[]) => executeMock(...args) },
  CoreError: class CoreError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.code = code
    }
  },
  workspace: {
    DEFAULT_WORKSPACE_HTTP_SETTINGS: { followRedirects: true }
  }
}))

let mod: typeof import('./request.ipc')

const BASE_REQUEST: HttpRequest = {
  method: 'GET',
  url: 'https://example.com',
  headers: {},
  variables: { token: '{{$env.TOKEN}}' }
}

beforeEach(async () => {
  ipcHandlers.clear()
  resolveReferences.mockReset()
  resolveReferences.mockImplementation(async (vars: Record<string, string>) => vars)
  executeMock.mockClear()
  vi.resetModules()
  mod = await import('./request.ipc')
  mod.registerRequestHandlers()
  mod.setActiveWorkspaceForHttp('/fake/workspace')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('http:send — environment-reference resolution failure (REQ-0104 CA-06/CA-07)', () => {
  it('CA-06: a rejected resolveReferences returns the standard error result and deregisters the execution', async () => {
    resolveReferences.mockRejectedValueOnce(new Error('boom'))

    const result = await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-1')
    expect(result).toEqual({ error: 'boom' })

    // The controller was deregistered — cancel on it is a no-op.
    const cancelled = await ipcHandlers.get('http:cancel')!({}, 'exec-1')
    expect(cancelled).toBe(false)
  })

  it('CA-07: a subsequent healthy send is unaffected and cancels normally', async () => {
    resolveReferences.mockRejectedValueOnce(new Error('boom'))
    await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-1')

    const sendPromise = ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-2')
    // Registration happens right after `getResolvedWorkspaceSettings`'s first
    // await — yield a tick so `exec-2` is in the in-flight map before cancel.
    await Promise.resolve()
    const cancelled = await ipcHandlers.get('http:cancel')!({}, 'exec-2')
    expect(cancelled).toBe(true)

    const result = await sendPromise
    expect(executeMock).toHaveBeenCalledTimes(1)
    expect(result).not.toHaveProperty('error')
  })
})

/**
 * A failure that escapes the pipeline reaches the renderer through this catch.
 * Reading `.message` here is what let an empty-message failure render as no
 * error at all, so the route derives its reason through the shared operation
 * instead — see the requirement "Every failed send reports a reason", CA-08.
 */
describe('http:send — the reported reason is never derived locally', () => {
  it('describes a failure whose own message is empty', async () => {
    const aggregated = new AggregateError(
      [
        new Error('connect ECONNREFUSED ::1:8082'),
        new Error('connect ECONNREFUSED 127.0.0.1:8082')
      ],
      ''
    )
    executeMock.mockRejectedValueOnce(aggregated)

    const result = await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-agg')

    expect(describeErrorMock).toHaveBeenCalledWith(aggregated)
    expect(result).toEqual({ error: 'described:AggregateError', errorCode: undefined })
  })

  it('deregisters the execution after describing the failure', async () => {
    executeMock.mockRejectedValueOnce(new AggregateError([], ''))

    await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-agg-2')

    expect(await ipcHandlers.get('http:cancel')!({}, 'exec-agg-2')).toBe(false)
  })
})
