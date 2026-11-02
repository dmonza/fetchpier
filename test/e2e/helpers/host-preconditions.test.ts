import { describe, it, expect } from 'vitest'
import { resolveHostPreconditions, type HostPreconditionInput } from './host-preconditions'
import { SECCOMP_MODE_FILTER, type RendererProcessView } from './renderer-sandbox'

// The policy half of the host-precondition guard, with every collaborator
// injected — the same split `resolve-http-target.ts` uses, and for the same
// reason: the decision this makes ("is this machine fit to run the suite?")
// only ever executes on the CI runner, so it has to be provable without one.

function renderer(over: Partial<RendererProcessView> = {}): RendererProcessView {
  return { pid: 1234, sandboxed: null, seccomp: null, ...over }
}

function input(over: Partial<HostPreconditionInput> = {}): HostPreconditionInput {
  return {
    platform: 'linux',
    sandbox: { requested: true, renderers: [renderer({ seccomp: SECCOMP_MODE_FILTER })] },
    requireKeyring: false,
    keyringBackend: 'os-keychain',
    allowUnsandboxed: false,
    ...over
  }
}

const UNSANDBOXED = { requested: true, renderers: [renderer({ pid: 9557, seccomp: 0 })] }

describe('resolveHostPreconditions — renderer sandbox', () => {
  it('accepts a Linux host whose renderers are all seccomp-filtered', () => {
    expect(resolveHostPreconditions(input()).status).toBe('ok')
  })

  it('rejects a Linux host whose renderer carries no seccomp filter', () => {
    const result = resolveHostPreconditions(
      input({ sandbox: { requested: true, renderers: [renderer({ pid: 9557, seccomp: 0 })] } })
    )

    expect(result.status).toBe('unmet')
    if (result.status !== 'unmet') return
    expect(result.unmet.map((u) => u.kind)).toEqual(['renderer-sandbox'])
    // The message has to carry the observed value: "not sandboxed" alone does
    // not tell the reader whether the remedy worked and something else broke.
    expect(result.message).toContain('9557')
    expect(result.message).toContain('0')
  })

  it('rejects a Linux host where the kernel reports no seccomp field at all', () => {
    const result = resolveHostPreconditions(
      input({ sandbox: { requested: true, renderers: [renderer({ seccomp: null })] } })
    )

    expect(result.status).toBe('unmet')
  })

  it('rejects when a renderer is filtered but another is not', () => {
    const result = resolveHostPreconditions(
      input({
        sandbox: {
          requested: true,
          renderers: [
            renderer({ pid: 1, seccomp: SECCOMP_MODE_FILTER }),
            renderer({ pid: 2, seccomp: 0 })
          ]
        }
      })
    )

    expect(result.status).toBe('unmet')
    if (result.status !== 'unmet') return
    expect(result.message).toContain('2')
  })

  it('stays silent when the app never requested a sandbox — that is the product’s state, not the host’s', () => {
    // The discriminator. Without it, flipping `sandbox: false` in the product
    // would abort the whole suite with a message blaming the runner, hiding the
    // real regression that `sandbox.spec.ts` exists to catch.
    const result = resolveHostPreconditions(
      input({ sandbox: { requested: false, renderers: [renderer({ seccomp: 0 })] } })
    )

    expect(result.status).toBe('ok')
  })

  it('rejects when no renderer process was observed at all', () => {
    const result = resolveHostPreconditions(input({ sandbox: { requested: true, renderers: [] } }))

    expect(result.status).toBe('unmet')
    if (result.status !== 'unmet') return
    expect(result.unmet[0]?.observed).toMatch(/no renderer/i)
  })

  it('reads the process metric rather than seccomp off Linux', () => {
    const ok = resolveHostPreconditions(
      input({
        platform: 'win32',
        sandbox: { requested: true, renderers: [renderer({ sandboxed: true, seccomp: null })] }
      })
    )
    const bad = resolveHostPreconditions(
      input({
        platform: 'darwin',
        sandbox: { requested: true, renderers: [renderer({ sandboxed: false, seccomp: null })] }
      })
    )

    expect(ok.status).toBe('ok')
    expect(bad.status).toBe('unmet')
  })

  it('rejects off Linux when the platform reports no sandbox metric', () => {
    // `sandboxed` is documented for darwin/win32; a null there means the signal
    // was lost, not that the process is sandboxed.
    const result = resolveHostPreconditions(
      input({
        platform: 'win32',
        sandbox: { requested: true, renderers: [renderer({ sandboxed: null })] }
      })
    )

    expect(result.status).toBe('unmet')
  })

  it('ignores the always-absent process metric on Linux', () => {
    const result = resolveHostPreconditions(
      input({
        platform: 'linux',
        sandbox: {
          requested: true,
          renderers: [renderer({ sandboxed: null, seccomp: SECCOMP_MODE_FILTER })]
        }
      })
    )

    expect(result.status).toBe('ok')
  })
})

describe('resolveHostPreconditions — OS keyring', () => {
  it('ignores the backend entirely when the run does not require a keyring', () => {
    const result = resolveHostPreconditions(
      input({ requireKeyring: false, keyringBackend: 'session-only' })
    )

    expect(result.status).toBe('ok')
  })

  it('rejects a memory-only backend when the run requires a keyring', () => {
    const result = resolveHostPreconditions(
      input({ requireKeyring: true, keyringBackend: 'session-only' })
    )

    expect(result.status).toBe('unmet')
    if (result.status !== 'unmet') return
    expect(result.unmet.map((u) => u.kind)).toEqual(['os-keyring'])
    expect(result.unmet[0]?.observed).toContain('session-only')
    // Without the invocation the reader has to go find it; that is the whole
    // difference between a stated precondition and a cryptic abort.
    expect(result.unmet[0]?.remedy).toMatch(/keyring/i)
  })

  it('accepts a real keyring when the run requires one', () => {
    const result = resolveHostPreconditions(
      input({ requireKeyring: true, keyringBackend: 'os-keychain' })
    )

    expect(result.status).toBe('ok')
  })
})

describe('resolveHostPreconditions — the unsandboxed waiver', () => {
  // Hosts exist that cannot sandbox a renderer at all; a CI runner is one. The
  // waiver lets such a host run the rest of the suite, and it is deliberately
  // opt-OUT while every other precondition is opt-IN: relaxing a security
  // invariant has to be an explicit act, never the default.

  it('is off by default, so an unsandboxed host still aborts', () => {
    expect(resolveHostPreconditions(input({ sandbox: UNSANDBOXED })).status).toBe('unmet')
  })

  it('lets the run proceed but reports the sandbox as waived, never as met', () => {
    const result = resolveHostPreconditions(input({ sandbox: UNSANDBOXED, allowUnsandboxed: true }))

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // Silence here would recreate the exact condition this whole guard exists to
    // prevent: a green run that quietly exercised a configuration that never ships.
    expect(result.waived.map((w) => w.kind)).toEqual(['renderer-sandbox'])
    expect(result.waived[0]?.observed).toContain('9557')
  })

  it('waives nothing when the host does sandbox', () => {
    const result = resolveHostPreconditions(input({ allowUnsandboxed: true }))

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.waived).toEqual([])
  })

  it('never waives the keyring — the flag is about the sandbox alone', () => {
    const result = resolveHostPreconditions(
      input({ allowUnsandboxed: true, requireKeyring: true, keyringBackend: 'session-only' })
    )

    expect(result.status).toBe('unmet')
    if (result.status !== 'unmet') return
    expect(result.unmet.map((u) => u.kind)).toEqual(['os-keyring'])
  })

  it('waives the sandbox and still aborts on an unrelated unmet precondition', () => {
    const result = resolveHostPreconditions(
      input({
        sandbox: UNSANDBOXED,
        allowUnsandboxed: true,
        requireKeyring: true,
        keyringBackend: 'session-only'
      })
    )

    expect(result.status).toBe('unmet')
    if (result.status !== 'unmet') return
    expect(result.unmet.map((u) => u.kind)).toEqual(['os-keyring'])
    expect(result.message).not.toContain('9557')
  })
})

describe('resolveHostPreconditions — reporting', () => {
  it('reports every unmet precondition in one message rather than the first', () => {
    const result = resolveHostPreconditions(
      input({
        sandbox: { requested: true, renderers: [renderer({ pid: 42, seccomp: 0 })] },
        requireKeyring: true,
        keyringBackend: 'session-only'
      })
    )

    expect(result.status).toBe('unmet')
    if (result.status !== 'unmet') return
    expect(result.unmet.map((u) => u.kind).sort()).toEqual(['os-keyring', 'renderer-sandbox'])
    expect(result.message).toContain('42')
    expect(result.message).toContain('session-only')
  })
})
