import { describe, it, expect, beforeEach } from 'vitest'
import {
  getTsEnvironmentFor,
  SCRIPT_PATH,
  __resetTsEnvironmentForTests,
  type ScriptPhase
} from './tsLanguageService'

type Env = Awaited<ReturnType<typeof getTsEnvironmentFor>>['env']

function updateScript(env: Env, src: string): void {
  env.updateFile(SCRIPT_PATH, src)
}

function diagnosticMessages(env: Env): string[] {
  return env.languageService
    .getSemanticDiagnostics(SCRIPT_PATH)
    .map((d) => (typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText))
}

function completionNamesAt(env: Env, src: string, position: number): string[] {
  updateScript(env, src)
  const completions = env.languageService.getCompletionsAtPosition(SCRIPT_PATH, position, undefined)
  return completions?.entries.map((e) => e.name) ?? []
}

describe('tsLanguageService — shared behavior (both phases)', () => {
  beforeEach(() => __resetTsEnvironmentForTests())

  for (const phase of ['preRequest', 'postResponse'] as ScriptPhase[]) {
    it(
      `[${phase}] exposes \`fp\` as a global with the expected members`,
      { timeout: 30_000 },
      async () => {
        const { env } = await getTsEnvironmentFor(phase)
        const names = completionNamesAt(env, 'fp.', 'fp.'.length)
        expect(names).toEqual(
          expect.arrayContaining([
            'request',
            'response',
            'environment',
            'variables',
            'test',
            'expect',
            'log'
          ])
        )
      }
    )

    it(
      `[${phase}] flags use of forbidden globals like \`setTimeout\` as "Cannot find name"`,
      { timeout: 30_000 },
      async () => {
        const { env } = await getTsEnvironmentFor(phase)
        updateScript(env, 'setTimeout(() => {}, 100)')
        expect(diagnosticMessages(env).some((m) => /Cannot find name 'setTimeout'/.test(m))).toBe(
          true
        )
      }
    )

    it(`[${phase}] exposes \`console\` with log/warn/error/info`, { timeout: 30_000 }, async () => {
      const { env } = await getTsEnvironmentFor(phase)
      updateScript(env, 'console.log("hi")')
      expect(diagnosticMessages(env)).toEqual([])

      const names = completionNamesAt(env, 'console.', 'console.'.length)
      expect(names).toEqual(expect.arrayContaining(['log', 'warn', 'error', 'info']))
    })

    it(
      `[${phase}] emits a diagnostic for type mismatch in fp.environment.set()`,
      { timeout: 30_000 },
      async () => {
        const { env } = await getTsEnvironmentFor(phase)
        updateScript(env, 'fp.environment.set(123, "x")')
        expect(
          diagnosticMessages(env).some((m) =>
            /Argument of type 'number' is not assignable to parameter of type 'string'/.test(m)
          )
        ).toBe(true)
      }
    )
  }
})

describe('tsLanguageService — phase-specific typing', () => {
  beforeEach(() => __resetTsEnvironmentForTests())

  it(
    'pre-request: flags `fp.response.status` (response is never)',
    { timeout: 30_000 },
    async () => {
      const { env } = await getTsEnvironmentFor('preRequest')
      updateScript(env, 'fp.response.status')
      const messages = diagnosticMessages(env)
      // TS emits "Property 'status' does not exist on type 'never'" (or a
      // similar never-related message). Accept any diagnostic mentioning
      // `never` or `status`.
      expect(messages.some((m) => /never|Property 'status'/.test(m))).toBe(true)
    }
  )

  it('post-response: `fp.response.status` compiles cleanly', { timeout: 30_000 }, async () => {
    const { env } = await getTsEnvironmentFor('postResponse')
    updateScript(env, 'const n: number = fp.response.status')
    expect(diagnosticMessages(env)).toEqual([])
  })

  it('pre-request: mutating `fp.request.url` is allowed', { timeout: 30_000 }, async () => {
    const { env } = await getTsEnvironmentFor('preRequest')
    updateScript(env, 'fp.request.url = "https://example.com"')
    expect(diagnosticMessages(env)).toEqual([])
  })

  it(
    'post-response: mutating `fp.request.url` is rejected (read-only)',
    { timeout: 30_000 },
    async () => {
      const { env } = await getTsEnvironmentFor('postResponse')
      updateScript(env, 'fp.request.url = "https://example.com"')
      const messages = diagnosticMessages(env)
      expect(messages.some((m) => /read-only|Cannot assign to 'url'/.test(m))).toBe(true)
    }
  )
})

describe('tsLanguageService — parsed-body accessors are freely usable (REQ-0082)', () => {
  beforeEach(() => __resetTsEnvironmentForTests())

  it(
    'CA-01: property access on fp.response.json() produces no diagnostic',
    { timeout: 30_000 },
    async () => {
      const { env } = await getTsEnvironmentFor('postResponse')
      updateScript(
        env,
        [
          'fp.response.json().accessToken',
          'fp.response.json().data.items[0].id',
          'fp.response.json()["x"]'
        ].join('\n')
      )
      expect(diagnosticMessages(env)).toEqual([])
    }
  )

  it(
    'CA-02: passing a parsed value into fp.environment.set() produces no diagnostic',
    { timeout: 30_000 },
    async () => {
      const { env } = await getTsEnvironmentFor('postResponse')
      updateScript(env, 'fp.environment.set("javaToken", fp.response.json().accessToken)')
      expect(diagnosticMessages(env)).toEqual([])
    }
  )

  it(
    'CA-03: fp.response.xml2Json() property access produces no diagnostic',
    { timeout: 30_000 },
    async () => {
      const { env } = await getTsEnvironmentFor('postResponse')
      updateScript(
        env,
        [
          'fp.response.xml2Json().some.nested.value',
          'fp.response.xml2Json({ stripNamespaces: true }).Envelope.Body'
        ].join('\n')
      )
      expect(diagnosticMessages(env)).toEqual([])
    }
  )

  it(
    'CA-05: no member suggestions immediately after fp.response.json().',
    { timeout: 30_000 },
    async () => {
      const { env } = await getTsEnvironmentFor('postResponse')
      const src = 'fp.response.json().'
      const names = completionNamesAt(env, src, src.length)
      expect(names).toEqual([])
    }
  )
})

describe('tsLanguageService — phase cache', () => {
  beforeEach(() => __resetTsEnvironmentForTests())

  it('returns independent bundles for each phase', { timeout: 30_000 }, async () => {
    const preRequest = await getTsEnvironmentFor('preRequest')
    const postResponse = await getTsEnvironmentFor('postResponse')
    expect(preRequest.env).not.toBe(postResponse.env)
    expect(preRequest.env.languageService).not.toBe(postResponse.env.languageService)
  })

  it(
    'caches the bundle per phase (second call returns same instance)',
    { timeout: 30_000 },
    async () => {
      const first = await getTsEnvironmentFor('preRequest')
      const second = await getTsEnvironmentFor('preRequest')
      expect(first).toBe(second)
    }
  )
})

describe('tsLanguageService — stale working files do not leak across sessions (REQ-0093)', () => {
  beforeEach(() => __resetTsEnvironmentForTests())

  // The per-phase env is shared and long-lived. Each editor registers a unique
  // working file in it; because scripts are non-module global scripts, every
  // file's top-level declarations share one global scope. These tests pin the
  // exact contract the leak violated: a leftover file collides with the live
  // one until it is removed via `deleteFile` (which the editor now does on
  // unmount — see useScriptEditor.test.ts CA-03/04/05).

  // CA-01: a leftover file declaring the same top-level const produces a
  // redeclaration diagnostic on the live script, and removing it clears it.
  it(
    'CA-01: redeclaration from a leftover working file clears once it is deleted',
    { timeout: 30_000 },
    async () => {
      const { env } = await getTsEnvironmentFor('postResponse')
      const leftover = '/script-leftover-abc.ts'
      env.createFile(leftover, 'const data = 1')
      updateScript(env, 'const data = 2')

      const redeclare = /Cannot redeclare block-scoped variable 'data'/
      expect(diagnosticMessages(env).some((m) => redeclare.test(m))).toBe(true)

      env.deleteFile(leftover)
      expect(diagnosticMessages(env).some((m) => redeclare.test(m))).toBe(false)
    }
  )

  // CA-02: a leftover file's top-level identifier pollutes completions in the
  // live script until the file is removed.
  it(
    'CA-02: completions stop offering a leftover file identifier once it is deleted',
    { timeout: 30_000 },
    async () => {
      const { env } = await getTsEnvironmentFor('postResponse')
      const leftover = '/script-leftover-xyz.ts'
      env.createFile(leftover, 'const staleToken = 1')

      const src = 'stale'
      expect(completionNamesAt(env, src, src.length)).toContain('staleToken')

      env.deleteFile(leftover)
      expect(completionNamesAt(env, src, src.length)).not.toContain('staleToken')
    }
  )
})
