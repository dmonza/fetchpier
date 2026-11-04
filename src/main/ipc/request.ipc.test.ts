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
  app: { getVersion: () => '9.8.7' },
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
  lockAllSecrets: vi.fn()
}))

vi.mock('../secrets/keystore', () => ({
  getWorkspaceKey: vi.fn(async () => null)
}))

vi.mock('../secrets/local-values', () => ({
  normalizeLocalLayer: vi.fn(async () => undefined)
}))

const { resolveReferences } = vi.hoisted(() => ({
  resolveReferences: vi.fn(async (vars: Record<string, string>) => vars)
}))

vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: () => ({
    path: '/fake/workspace',
    dotenv: { resolveReferences },
    secrets: { readManifest: async () => null },
    binary: { read: vi.fn(), stat: vi.fn() }
  })
}))

// The variable session is the core's (pinned in the core suite). The stand-in
// keeps the observable seams: `{{$env.*}}` resolution goes through the handle
// (so its failure path is still exercised), `apply` reports what it could not
// persist, and `secretNames` drives the renderer-side masking.
const sessionState = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  secretNames: [] as string[],
  applyWarnings: [] as unknown[],
  apply: vi.fn()
}))
const createVariableSession = vi.hoisted(() =>
  vi.fn(async (opts: Record<string, unknown>) => {
    sessionState.options = opts
    const ws = opts.workspace as {
      dotenv: { resolveReferences: (v: Record<string, string>) => Promise<Record<string, string>> }
    }
    const variables = await ws.dotenv.resolveReferences(
      (opts.basePlainVariables as Record<string, string>) ?? {}
    )
    return {
      orphans: [],
      prepare: async (request: HttpRequest) => ({
        request: { ...request, variables },
        secretNames: sessionState.secretNames,
        warnings: [],
        resolvePassphraseSecrets: async () => ({})
      }),
      apply: async (changes: unknown) => {
        sessionState.apply(changes)
        return sessionState.applyWarnings
      }
    }
  })
)

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
  requests: {
    execute: (...args: unknown[]) => executeMock(...args),
    createVariableSession,
    timeoutAbortReason: (ms: number) =>
      Object.assign(new Error(`timed out after ${ms}`), { name: 'TimeoutError' })
  },
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
  sessionState.secretNames = []
  sessionState.applyWarnings = []
  sessionState.apply.mockClear()
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

describe('http:send — binary bodies are the engine’s (CLI hardening, CA-06)', () => {
  it('does not read the staged file itself; the engine gets the workspace path and no bytes', async () => {
    const binaryRequest: HttpRequest = {
      method: 'POST',
      url: 'https://example.com/upload',
      headers: {},
      bodyType: 'binary',
      binaryFile: {
        ref: `${'a'.repeat(64)}__photo.png`,
        originalName: 'photo.png',
        sizeBytes: 0,
        mimeType: 'image/png'
      }
    }
    await ipcHandlers.get('http:send')!({}, binaryRequest, 'exec-bin')
    const options = executeMock.mock.calls[0][1] as Record<string, unknown>
    expect(options.workspacePath).toBe('/fake/workspace')
    expect(options).not.toHaveProperty('binaryBody')
    const sent = executeMock.mock.calls[0][0] as HttpRequest
    // No Content-Type added here either — the engine derives it.
    expect(sent.headers).toEqual({})
  })
})

describe('http:send — core-governed variables (CLI readiness)', () => {
  it('builds a persisting session from the variables the renderer sent', async () => {
    mod.setActiveEnvironmentForCookies('env-1')
    await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-s1')
    expect(createVariableSession).toHaveBeenCalledTimes(1)
    expect(sessionState.options).toMatchObject({
      environmentId: 'env-1',
      basePlainVariables: { token: '{{$env.TOKEN}}' },
      persistence: 'persist'
    })
  })

  it('sends the desktop default User-Agent with the app version', async () => {
    await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-ua')
    expect(executeMock.mock.calls[0][1]).toMatchObject({ userAgent: 'Fetchpier/9.8.7' })
  })

  it('applies script writes through the session and surfaces what could not be persisted', async () => {
    mod.setActiveEnvironmentForCookies('env-1')
    const changes = { set: { token: 'plaintext-jwt', note: 'n' }, removed: [] }
    sessionState.secretNames = ['token']
    sessionState.applyWarnings = [
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'KEY_MISSING' }
    ]
    executeMock.mockResolvedValueOnce({
      response: { status: 200, statusText: 'OK', headers: {}, body: '', durationMs: 1 },
      scriptResults: [],
      environmentChanges: changes,
      resolvedSettings: {},
      cookies: { sent: [], received: [] }
    } as never)

    const result = (await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-apply')) as {
      environmentChanges: { set: Record<string, string> }
      warnings: unknown[]
    }

    // The session received the plaintext it needs to persist…
    expect(sessionState.apply).toHaveBeenCalledWith(changes)
    // …and the renderer never does: a secret-named write leaves main masked.
    expect(result.environmentChanges.set).toEqual({ token: '{secret:token}', note: 'n' })
    expect(JSON.stringify(result)).not.toContain('plaintext-jwt')
    expect(result.warnings).toContainEqual({
      code: 'ENV_WRITE_NOT_PERSISTED',
      name: 'token',
      reason: 'KEY_MISSING'
    })
  })
})
