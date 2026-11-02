// Regression tests for REQ-44: the scripts editor must preserve the full
// default `completionKeymap` (ArrowUp/Down, PageUp/Down, Escape, Ctrl-Space)
// alongside the REQ-43 custom Tab/Enter bindings.
//
// These tests exercise the exact `smartCompletionKeymap` and
// `scriptEditorBaseKeymap` extensions that `useScriptEditor` uses in
// production — not a parallel copy — so removing `...completionKeymap` from
// the keymap will break them.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  autocompletion,
  completionStatus,
  selectedCompletion,
  startCompletion,
  type CompletionSource
} from '@codemirror/autocomplete'
import {
  completionNavigationKeymap,
  scriptEditorBaseKeymap,
  smartCompletionKeymap,
  useScriptEditor
} from './useScriptEditor'
import { getTsEnvironmentFor, type ScriptPhase } from './tsLanguageService'

// ── Mocks for the working-file lifecycle suite (REQ-0093) ───────────────────
//
// We replace the TS environment and the codemirror-ts glue with controllable
// stubs so we can assert exactly which working files the hook creates and
// removes across mount/unmount, without loading the multi-MB TypeScript bundle.

vi.mock('./tsLanguageService', () => ({
  SCRIPT_PATH: '/script.ts',
  getTsEnvironmentFor: vi.fn()
}))

vi.mock('@valtown/codemirror-ts', () => ({
  tsFacet: { of: () => [] },
  tsSync: () => [],
  tsHover: () => [],
  getLints: vi.fn(async () => [])
}))

const getTsEnvironmentForMock = vi.mocked(getTsEnvironmentFor)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Driver ──────────────────────────────────────────────────────────────────

function mockCompletionSource(labels: string[]): CompletionSource {
  return (ctx) => {
    const before = ctx.matchBefore(/[\w$]*/)
    if (!before) return null
    if (before.from === before.to && !ctx.explicit) return null
    return {
      from: before.from,
      options: labels.map((label) => ({ label }))
    }
  }
}

interface EditorFixture {
  doc: string
  caret?: number
  completions: string[]
}

function createEditor(fixture: EditorFixture): EditorView {
  const caret = fixture.caret ?? fixture.doc.length
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const state = EditorState.create({
    doc: fixture.doc,
    selection: { anchor: caret },
    extensions: [
      smartCompletionKeymap,
      completionNavigationKeymap,
      scriptEditorBaseKeymap,
      autocompletion({
        override: [mockCompletionSource(fixture.completions)],
        defaultKeymap: false,
        // CM's default 75ms `interactionDelay` blocks moveCompletionSelection
        // and acceptCompletion for a brief moment after the popup opens. The
        // user-facing intent is unchanged; zero is fine for an automated test.
        interactionDelay: 0
      })
    ]
  })
  return new EditorView({ state, parent })
}

function sendKey(view: EditorView, key: string, modifiers: Partial<KeyboardEventInit> = {}): void {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers
  })
  view.contentDOM.dispatchEvent(event)
}

async function waitForStatus(
  view: EditorView,
  want: 'active' | 'pending' | null,
  tries = 40
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (completionStatus(view.state) === want) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(
    `completion status never reached ${String(want)} (last: ${String(completionStatus(view.state))})`
  )
}

const views: EditorView[] = []
function track(view: EditorView): EditorView {
  views.push(view)
  return view
}

afterEach(() => {
  while (views.length) {
    const v = views.pop()
    v?.destroy()
  }
})

// ── Default completion keymap bindings (REQ-44) ─────────────────────────────

describe('scripts editor — default completion keymap bindings', () => {
  it('ArrowDown moves selection to the next item', async () => {
    const view = track(
      createEditor({
        doc: 'al',
        caret: 2,
        completions: ['alpha', 'alphabet', 'altitude']
      })
    )
    startCompletion(view)
    await waitForStatus(view, 'active')
    expect(selectedCompletion(view.state)?.label).toBe('alpha')

    sendKey(view, 'ArrowDown')
    expect(selectedCompletion(view.state)?.label).toBe('alphabet')
  })

  it('ArrowUp moves selection to the previous item', async () => {
    const view = track(
      createEditor({
        doc: 'al',
        caret: 2,
        completions: ['alpha', 'alphabet', 'altitude']
      })
    )
    startCompletion(view)
    await waitForStatus(view, 'active')
    sendKey(view, 'ArrowDown') // alpha → alphabet
    expect(selectedCompletion(view.state)?.label).toBe('alphabet')

    sendKey(view, 'ArrowUp') // alphabet → alpha
    expect(selectedCompletion(view.state)?.label).toBe('alpha')
  })

  // PageDown/PageUp cannot fully run in jsdom — CM computes the "page" step
  // from the tooltip's rendered height, which is 0 in a headless DOM. We can
  // still verify the keymap routes the event to `moveCompletionSelection`
  // (vs. falling through to `cursorPageDown`, which would close the popup).
  it('PageDown does not fall through to cursor movement (keeps popup open)', async () => {
    const labels = Array.from({ length: 20 }, (_, i) => `item${String(i).padStart(2, '0')}`)
    const view = track(createEditor({ doc: 'item', caret: 4, completions: labels }))
    startCompletion(view)
    await waitForStatus(view, 'active')
    expect(completionStatus(view.state)).toBe('active')

    sendKey(view, 'PageDown')
    expect(completionStatus(view.state)).toBe('active')
  })

  it('PageUp does not fall through to cursor movement (keeps popup open)', async () => {
    const labels = Array.from({ length: 20 }, (_, i) => `item${String(i).padStart(2, '0')}`)
    const view = track(createEditor({ doc: 'item', caret: 4, completions: labels }))
    startCompletion(view)
    await waitForStatus(view, 'active')

    sendKey(view, 'PageUp')
    expect(completionStatus(view.state)).toBe('active')
  })

  it('Escape closes the popup without inserting text', async () => {
    const view = track(createEditor({ doc: 'a', caret: 1, completions: ['alpha'] }))
    startCompletion(view)
    await waitForStatus(view, 'active')
    expect(completionStatus(view.state)).toBe('active')

    sendKey(view, 'Escape')
    expect(completionStatus(view.state)).toBeNull()
    expect(view.state.doc.toString()).toBe('a')
  })

  it('Ctrl-Space opens the popup when it is closed', async () => {
    const view = track(createEditor({ doc: 'a', caret: 1, completions: ['alpha'] }))
    expect(completionStatus(view.state)).toBeNull()

    sendKey(view, ' ', { ctrlKey: true })
    // `completionKeymap`'s Ctrl-Space binding calls `startCompletion`, which
    // transitions status to 'pending' (source running) then 'active'.
    await waitForStatus(view, 'active')
    expect(completionStatus(view.state)).toBe('active')
  })
})

// ── REQ-43 custom bindings (regression guard) ───────────────────────────────

describe('scripts editor — REQ-43 custom bindings still work', () => {
  it('Tab accepts the selected completion when the popup is active', async () => {
    const view = track(createEditor({ doc: 'alp', caret: 3, completions: ['alpha', 'alphabet'] }))
    startCompletion(view)
    await waitForStatus(view, 'active')
    expect(selectedCompletion(view.state)?.label).toBe('alpha')

    sendKey(view, 'Tab')
    expect(view.state.doc.toString()).toBe('alpha')
  })

  it('Enter accepts when the selected label differs from the typed prefix', async () => {
    const view = track(createEditor({ doc: 'al', caret: 2, completions: ['alpha'] }))
    startCompletion(view)
    await waitForStatus(view, 'active')

    sendKey(view, 'Enter')
    expect(view.state.doc.toString()).toBe('alpha')
  })

  it('Enter inserts a newline when the selected label equals the typed prefix', async () => {
    const view = track(createEditor({ doc: 'alpha', caret: 5, completions: ['alpha'] }))
    startCompletion(view)
    await waitForStatus(view, 'active')

    sendKey(view, 'Enter')
    // `acceptIfSmart` returns false (label === prefix) so Enter falls through
    // to `defaultKeymap`'s `insertNewlineAndIndent`.
    expect(view.state.doc.toString()).toBe('alpha\n')
  })
})

// ── Working-file lifecycle in the shared per-phase VFS (REQ-0093) ────────────
//
// Regression guard for the stale-session leak: each mounted editor registers a
// uniquely-named working file in the shared per-phase TS environment and MUST
// remove it on unmount, or leftover files collide in the shared global scope
// (false `Cannot redeclare …` diagnostics + stale completions).

interface FakeEnv {
  createFile: ReturnType<typeof vi.fn>
  updateFile: ReturnType<typeof vi.fn>
  deleteFile: ReturnType<typeof vi.fn>
  getSourceFile: ReturnType<typeof vi.fn>
  languageService: {
    getCompletionsAtPosition: ReturnType<typeof vi.fn>
    getCompletionEntryDetails: ReturnType<typeof vi.fn>
  }
}

function makeFakeEnv(): FakeEnv {
  return {
    createFile: vi.fn(),
    updateFile: vi.fn(),
    deleteFile: vi.fn(),
    getSourceFile: vi.fn(() => undefined),
    languageService: {
      getCompletionsAtPosition: vi.fn(() => undefined),
      getCompletionEntryDetails: vi.fn(() => undefined)
    }
  }
}

function Harness({ phase }: { phase: ScriptPhase }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useScriptEditor(ref, { value: 'const data = 1', onChange: () => {}, phase })
  return <div ref={ref} />
}

const mounted: { root: Root; host: HTMLDivElement }[] = []

async function mountHarness(phase: ScriptPhase): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<Harness phase={phase} />)
  })
  const entry = { root, host }
  mounted.push(entry)
  return entry
}

function unmount(entry: { root: Root; host: HTMLDivElement }): void {
  act(() => entry.root.unmount())
  entry.host.remove()
  const idx = mounted.indexOf(entry)
  if (idx >= 0) mounted.splice(idx, 1)
}

/** Flush the editor's async `getTsEnvironmentFor()` init (microtasks + a macrotask). */
async function flushInit(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Poll a predicate, flushing pending async init between attempts. */
async function waitFor(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await flushInit()
  }
  throw new Error('waitFor: predicate never satisfied')
}

describe('useScriptEditor — working-file lifecycle (REQ-0093)', () => {
  afterEach(() => {
    while (mounted.length) unmount(mounted[0])
    getTsEnvironmentForMock.mockReset()
  })

  // CA-03: the editor's working file is removed from the shared env on teardown.
  it('CA-03: removes its working file from the env on unmount', async () => {
    const env = makeFakeEnv()
    getTsEnvironmentForMock.mockResolvedValue({ env } as never)

    const entry = await mountHarness('postResponse')
    await waitFor(() => env.createFile.mock.calls.length >= 1)

    expect(env.createFile).toHaveBeenCalledTimes(1)
    const path = env.createFile.mock.calls[0][0] as string
    expect(path).toMatch(/\.ts$/)

    unmount(entry)

    expect(env.deleteFile).toHaveBeenCalledTimes(1)
    expect(env.deleteFile).toHaveBeenCalledWith(path)
  })

  // CA-05: unmounting before the async env init resolves leaves nothing behind
  // and raises no error.
  it('CA-05: unmount before init completes creates and deletes nothing, no throw', async () => {
    const env = makeFakeEnv()
    let resolveEnv: (value: { env: FakeEnv }) => void = () => {}
    getTsEnvironmentForMock.mockReturnValue(
      new Promise<{ env: FakeEnv }>((res) => {
        resolveEnv = res
      }) as never
    )

    const entry = await mountHarness('preRequest')
    // Tear down before resolving the env init promise.
    unmount(entry)

    // Now let the pending init settle: the hook must short-circuit on `cancelled`.
    resolveEnv({ env })
    await flushInit()

    expect(env.createFile).not.toHaveBeenCalled()
    expect(env.deleteFile).not.toHaveBeenCalled()
  })

  // CA-04: two same-phase editors share one env; tearing one down removes only
  // its own working file, leaving the other's intact.
  it('CA-04: concurrent same-phase editors each remove only their own file', async () => {
    const env = makeFakeEnv()
    getTsEnvironmentForMock.mockResolvedValue({ env } as never)

    const first = await mountHarness('postResponse')
    // Second editor of the same phase; left mounted (afterEach unmounts it) so
    // we can assert tearing down `first` does not touch the second's file.
    await mountHarness('postResponse')
    await waitFor(() => env.createFile.mock.calls.length >= 2)

    expect(env.createFile).toHaveBeenCalledTimes(2)
    const pathA = env.createFile.mock.calls[0][0] as string
    const pathB = env.createFile.mock.calls[1][0] as string
    expect(pathA).not.toBe(pathB)

    unmount(first)

    expect(env.deleteFile).toHaveBeenCalledTimes(1)
    expect(env.deleteFile).toHaveBeenCalledWith(pathA)
    expect(env.deleteFile).not.toHaveBeenCalledWith(pathB)
  })
})
