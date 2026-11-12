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

// Every main → renderer event the handler broadcasts, as `[channel, payload]`.
const sentEvents = vi.hoisted(() => [] as Array<[string, unknown]>)

vi.mock('electron', () => ({
  app: { getVersion: () => '9.8.7' },
  ipcMain: {
    handle: (channel: string, fn: Handler) => ipcHandlers.set(channel, fn)
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sentEvents.push([channel, payload])
        }
      }
    ]
  }
}))

const appSettingsState = vi.hoisted(() => ({ hideSecretsInResponses: true }))
vi.mock('./appsettings.ipc', () => ({
  readAppSettings: () => ({
    requestTimeoutSeconds: 30,
    proxy: undefined,
    hideSecretsInResponses: appSettingsState.hideSecretsInResponses
  })
}))

const workspaceSettingsState = vi.hoisted(() => ({
  settings: { followRedirects: true } as Record<string, unknown>
}))
vi.mock('../config/workspace-settings-store', () => ({
  getCachedHttpSettings: () => workspaceSettingsState.settings,
  loadHttpSettings: async () => workspaceSettingsState.settings
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
        await sessionState.apply(changes)
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
  sessionState.apply.mockReset()
  sentEvents.length = 0
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

describe('http:send — script environment writes', () => {
  function resultWithChanges(changes: { set: Record<string, string>; removed: string[] }) {
    return {
      response: { status: 200, statusText: 'OK', headers: {}, body: '', durationMs: 1 },
      scriptResults: [],
      environmentChanges: changes,
      resolvedSettings: {},
      cookies: { sent: [], received: [] }
    } as never
  }

  function localValuesEvents(): unknown[] {
    return sentEvents.filter(([channel]) => channel === 'localValues:changed').map(([, p]) => p)
  }

  // ENG-10: the environment the send started with owns its writes, whatever the
  // renderer switches to while the request is in flight.
  it.each([
    ['No environment', null],
    ['another environment', 'env-B']
  ])(
    'a switch to %s mid-send keeps the writes on the send’s environment',
    async (_label, switchTo) => {
      mod.setActiveEnvironmentForCookies('env-A')
      const changes = { set: { token: 'new-token' }, removed: [] }
      let release!: () => void
      executeMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(resultWithChanges(changes))
          })
      )

      const pending = ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-switch') as Promise<{
        warnings?: unknown[]
      }>
      await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))
      mod.setActiveEnvironmentForCookies(switchTo)
      release()
      await pending

      expect(sessionState.options).toMatchObject({ environmentId: 'env-A' })
      expect(executeMock.mock.calls[0][1]).toMatchObject({ environmentId: 'env-A' })
      expect(sessionState.apply).toHaveBeenCalledWith(changes)
      expect(localValuesEvents()).toEqual([{ environmentId: 'env-A', orphanNotice: undefined }])
    }
  )

  it('a send started with no environment does not apply, even after a switch to one', async () => {
    mod.setActiveEnvironmentForCookies(null)
    let release!: () => void
    executeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(resultWithChanges({ set: { token: 't' }, removed: [] }))
        })
    )
    const pending = ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-none')
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))
    mod.setActiveEnvironmentForCookies('env-B')
    release()
    await pending

    expect(sessionState.apply).not.toHaveBeenCalled()
    expect(localValuesEvents()).toEqual([])
  })

  // ENG-11: a write that throws is a notice for every name it carried, never
  // just a log line.
  it('a rejected apply reports every set and removed name as WRITE_FAILED', async () => {
    mod.setActiveEnvironmentForCookies('env-1')
    sessionState.secretNames = ['token']
    sessionState.apply.mockRejectedValueOnce(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    )
    executeMock.mockResolvedValueOnce(
      resultWithChanges({ set: { token: 'plaintext-jwt', note: 'n' }, removed: ['old'] })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = (await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-fail')) as {
      warnings?: unknown[]
      error?: string
    }

    expect(result.error).toBeUndefined()
    expect(result.warnings).toEqual([
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'WRITE_FAILED' },
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'note', reason: 'WRITE_FAILED' },
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'old', reason: 'WRITE_FAILED' }
    ])
    // Nothing was saved, so no editor is told to refresh; the value never leaks.
    expect(localValuesEvents()).toEqual([])
    expect(JSON.stringify(result)).not.toContain('plaintext-jwt')
    errorSpy.mockRestore()
  })

  it('a rejected apply keeps the advisories the send already carried', async () => {
    mod.setActiveEnvironmentForCookies('env-1')
    sessionState.apply.mockRejectedValueOnce(new Error('ENVIRONMENT_NOT_FOUND'))
    executeMock.mockResolvedValueOnce({
      ...(resultWithChanges({ set: {}, removed: ['gone'] }) as object),
      warnings: [{ code: 'HTTP2_DOWNGRADED' }]
    } as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = (await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-fail2')) as {
      warnings?: unknown[]
    }

    expect(result.warnings).toEqual([
      { code: 'HTTP2_DOWNGRADED' },
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'gone', reason: 'WRITE_FAILED' }
    ])
  })
})

describe('http:send — secrets in the response viewer', () => {
  const masked = { status: 200, statusText: 'OK', headers: {}, body: '{secret:token}', timingMs: 1 }
  const asReceived = { ...masked, body: 'plaintext-jwt' }
  const engineResult = {
    response: masked,
    unmaskedResponse: asReceived,
    resolvedSettings: {},
    cookies: { sent: [], received: [] }
  }

  afterEach(() => {
    appSettingsState.hideSecretsInResponses = true
  })

  it('by default asks for no unmasked copy and never lets one reach the renderer', async () => {
    executeMock.mockResolvedValueOnce(engineResult as never)
    const result = (await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-hide')) as {
      response: unknown
      unmaskedResponse?: unknown
    }
    expect(executeMock.mock.calls[0][1]).toMatchObject({ revealResponse: false })
    expect(result.response).toEqual(masked)
    expect(result.unmaskedResponse).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('plaintext-jwt')
  })

  it('with the setting off, asks for the response as received and passes it through', async () => {
    appSettingsState.hideSecretsInResponses = false
    executeMock.mockResolvedValueOnce(engineResult as never)
    const result = (await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-show')) as {
      response: unknown
      unmaskedResponse?: unknown
    }
    expect(executeMock.mock.calls[0][1]).toMatchObject({ revealResponse: true })
    // The masked one still travels: it is what the activity log records.
    expect(result.response).toEqual(masked)
    expect(result.unmaskedResponse).toEqual(asReceived)
  })
})

describe('http:send — passive security findings', () => {
  afterEach(() => {
    workspaceSettingsState.settings = { followRedirects: true }
  })

  it('asks the engine to evaluate by default (a workspace with no findings block)', async () => {
    await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-f1')
    expect(executeMock.mock.calls[0][1]).toMatchObject({ evaluateFindings: true })
  })

  it('does not ask when the workspace turned findings off', async () => {
    workspaceSettingsState.settings = { followRedirects: true, findings: { enabled: false } }
    await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-f2')
    expect(executeMock.mock.calls[0][1]).toMatchObject({ evaluateFindings: false })
  })

  it('treats an unusable enabled value as the default', async () => {
    workspaceSettingsState.settings = { followRedirects: true, findings: { enabled: 'no' } }
    await ipcHandlers.get('http:send')!({}, BASE_REQUEST, 'exec-f3')
    expect(executeMock.mock.calls[0][1]).toMatchObject({ evaluateFindings: true })
  })
})
