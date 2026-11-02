import { describe, it, expect, vi } from 'vitest'
import {
  resolveHttpTarget,
  type HttpTargetDeps,
  type TargetResolution
} from './resolve-http-target'

// Unit coverage for the HTTP-target decision tree.
//
// The tree decides whether the Playwright suite talks to a controlled local
// container or to the public service. Getting it wrong is exactly the defect
// this module exists to remove: a green run that silently validated against the
// internet. Every collaborator is injected, so no test here touches Docker,
// the network, the filesystem, or process.env.

const LOCAL = 'http://localhost:8080'
const PUBLIC = 'https://httpbin.org'

/** Deps for the happy container path; override per test. */
function deps(over: Partial<HttpTargetDeps> = {}): HttpTargetDeps {
  return {
    envUrl: undefined,
    strict: false,
    localUrl: LOCAL,
    publicUrl: PUBLIC,
    isDockerAvailable: vi.fn(() => true),
    imageExists: vi.fn(() => true),
    pullImage: vi.fn(),
    startContainer: vi.fn(() => 'created' as const),
    waitForHealth: vi.fn(async () => 42),
    ...over
  }
}

function expectOk(res: TargetResolution) {
  if (res.status !== 'ok') {
    throw new Error(`expected ok, got strict-violation: ${res.message}`)
  }
  return res.target
}

function expectViolation(res: TargetResolution) {
  if (res.status !== 'strict-violation') {
    throw new Error(`expected strict-violation, got ok (${res.target.mode})`)
  }
  return res
}

describe('resolveHttpTarget — explicit override', () => {
  it('honors an explicit target verbatim and performs no container work', async () => {
    const d = deps({ envUrl: 'http://example.test:9200' })
    const target = expectOk(await resolveHttpTarget(d))

    expect(target.mode).toBe('user-provided')
    expect(target.url).toBe('http://example.test:9200')
    expect(d.isDockerAvailable).not.toHaveBeenCalled()
    expect(d.imageExists).not.toHaveBeenCalled()
    expect(d.pullImage).not.toHaveBeenCalled()
    expect(d.startContainer).not.toHaveBeenCalled()
  })

  it('does not abort under strict mode — an explicit override is a deliberate operator act', async () => {
    const d = deps({ envUrl: 'http://example.test:9200', strict: true })
    const target = expectOk(await resolveHttpTarget(d))

    expect(target.mode).toBe('user-provided')
  })

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['undefined', undefined]
  ])('treats a %s override as unset and falls through to the container', async (_label, envUrl) => {
    const d = deps({ envUrl })
    const target = expectOk(await resolveHttpTarget(d))

    expect(target.mode).toBe('docker')
    expect(target.url).toBe(LOCAL)
  })
})

describe('resolveHttpTarget — container path', () => {
  it('uses the container without pulling when the pinned image is already present', async () => {
    const d = deps()
    const target = expectOk(await resolveHttpTarget(d))

    expect(target.mode).toBe('docker')
    expect(target.url).toBe(LOCAL)
    expect(target.pulled).toBe(false)
    expect(d.pullImage).not.toHaveBeenCalled()
    expect(target.healthMs).toBe(42)
  })

  it('fetches the pinned image when it is absent, then proceeds', async () => {
    const d = deps({ imageExists: vi.fn(() => false) })
    const target = expectOk(await resolveHttpTarget(d))

    expect(d.pullImage).toHaveBeenCalledTimes(1)
    expect(target.mode).toBe('docker')
    expect(target.pulled).toBe(true)
  })

  it.each([
    ['created', 'created'],
    ['started', 'started'],
    ['already-running', 'already-running']
  ] as const)('reports the %s container transition', async (_label, action) => {
    const d = deps({ startContainer: vi.fn(() => action) })
    const target = expectOk(await resolveHttpTarget(d))

    expect(target.containerAction).toBe(action)
  })
})

describe('resolveHttpTarget — fallback when strict mode is off', () => {
  it.each([
    ['no container runtime', { isDockerAvailable: () => false }, 'no-runtime'],
    [
      'the image cannot be fetched',
      {
        imageExists: () => false,
        pullImage: () => {
          throw new Error('manifest unknown')
        }
      },
      'pull-failed'
    ],
    [
      'the container fails to start',
      {
        startContainer: () => {
          throw new Error('port is already allocated')
        }
      },
      'start-failed'
    ],
    [
      'the health check times out',
      {
        waitForHealth: async () => {
          throw new Error('healthcheck timed out after 10000ms')
        }
      },
      'health-failed'
    ]
  ])('degrades to the public service when %s', async (_label, over, kind) => {
    const target = expectOk(await resolveHttpTarget(deps(over as Partial<HttpTargetDeps>)))

    expect(target.mode).toBe('public')
    expect(target.url).toBe(PUBLIC)
    expect(target.degradedReason?.kind).toBe(kind)
  })
})

describe('resolveHttpTarget — strict mode', () => {
  it.each([
    ['no container runtime', { isDockerAvailable: () => false }, 'no-runtime'],
    [
      'the image cannot be fetched',
      {
        imageExists: () => false,
        pullImage: () => {
          throw new Error('manifest unknown')
        }
      },
      'pull-failed'
    ],
    [
      'the container fails to start',
      {
        startContainer: () => {
          throw new Error('port is already allocated')
        }
      },
      'start-failed'
    ],
    [
      'the health check times out',
      {
        waitForHealth: async () => {
          throw new Error('healthcheck timed out after 10000ms')
        }
      },
      'health-failed'
    ]
  ])('refuses to run when %s', async (_label, over, kind) => {
    const res = expectViolation(
      await resolveHttpTarget(deps({ ...(over as Partial<HttpTargetDeps>), strict: true }))
    )

    expect(res.reason.kind).toBe(kind)
    expect(res.target.mode).toBe('public')
  })

  it('names the resolved target and the underlying reason in the failure message', async () => {
    const res = expectViolation(
      await resolveHttpTarget(
        deps({
          strict: true,
          startContainer: () => {
            throw new Error('port is already allocated')
          }
        })
      )
    )

    expect(res.message).toContain(PUBLIC)
    expect(res.message).toContain('port is already allocated')
  })

  it('still succeeds through the container path', async () => {
    const target = expectOk(await resolveHttpTarget(deps({ strict: true })))

    expect(target.mode).toBe('docker')
  })
})
