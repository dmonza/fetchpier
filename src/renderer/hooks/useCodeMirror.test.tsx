// Regression tests for REQ-48: switching request tabs reuses the same
// CodeMirror instance, so syncing the editor doc to a new external `value`
// prop must NOT look like a user edit (which would mark the request dirty).
//
// These tests mount the real `useCodeMirror` hook so the production
// `updateListener` + value-sync effect are exercised, not a parallel copy.

import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'

vi.mock('../stores/codemirror-theme', () => ({
  useCodeMirrorThemeStore: <T,>(selector: (s: { themeFamily: string }) => T): T =>
    selector({ themeFamily: 'default' })
}))

vi.mock('../stores/theme', () => ({
  useThemeStore: <T,>(selector: (s: { resolvedTheme: 'light' | 'dark' }) => T): T =>
    selector({ resolvedTheme: 'light' })
}))

import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { resolveThemeExtension, useCodeMirror } from './useCodeMirror'
import { paletteChrome } from './editorPaletteTheme'
import { generatePalette } from '../../shared/palette/generate'

function Harness({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useCodeMirror(ref, { value, onChange })
  return <div ref={ref} />
}

const roots: Array<{ root: Root; container: HTMLDivElement }> = []

async function mount(props: {
  value: string
  onChange: (v: string) => void
}): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness {...props} />)
  })
  roots.push({ root, container })
  return container
}

async function rerender(
  container: HTMLDivElement,
  props: { value: string; onChange: (v: string) => void }
): Promise<void> {
  const entry = roots.find((r) => r.container === container)!
  await act(async () => {
    entry.root.render(<Harness {...props} />)
  })
}

function viewOf(container: HTMLDivElement): EditorView {
  const dom = container.querySelector('.cm-editor') as HTMLElement
  const view = EditorView.findFromDOM(dom)
  if (!view) throw new Error('EditorView not found in container')
  return view
}

afterEach(() => {
  while (roots.length) {
    const { root, container } = roots.pop()!
    act(() => root.unmount())
    container.remove()
  }
})

describe('useCodeMirror — external value sync', () => {
  it('does not call onChange when the value prop changes (e.g. switching tabs)', async () => {
    const onChange = vi.fn()
    const container = await mount({ value: 'foo', onChange })
    expect(onChange).not.toHaveBeenCalled()
    expect(viewOf(container).state.doc.toString()).toBe('foo')

    await rerender(container, { value: 'bar', onChange })

    expect(viewOf(container).state.doc.toString()).toBe('bar')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('still calls onChange for an actual edit in the editor', async () => {
    const onChange = vi.fn()
    const container = await mount({ value: 'foo', onChange })
    const view = viewOf(container)

    act(() => {
      view.dispatch({ changes: { from: 3, insert: 'X' }, userEvent: 'input.type' })
    })

    expect(view.state.doc.toString()).toBe('fooX')
    expect(onChange).toHaveBeenCalledWith('fooX')
  })

  it('does not re-emit a value it just synced when the user then edits it', async () => {
    const onChange = vi.fn()
    const container = await mount({ value: 'foo', onChange })
    await rerender(container, { value: 'bar', onChange })
    onChange.mockClear()

    const view = viewOf(container)
    act(() => {
      view.dispatch({ changes: { from: 3, insert: 'Z' }, userEvent: 'input.type' })
    })

    expect(view.state.doc.toString()).toBe('barZ')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('barZ')
  })
})

// Requirement *Dynamic color themes* CA-32: with Original the editor is exactly
// as before; with a palette, the palette's chrome and syntax come first.
describe('resolveThemeExtension — palettes', () => {
  it('returns the family unchanged when the Original palette is in force', () => {
    expect(resolveThemeExtension('github', 'light')).toBe(githubLight)
    expect(resolveThemeExtension('github', 'dark', null)).toBe(githubDark)
  })

  it('puts the palette chrome ahead of the family when a palette is in force', () => {
    const palette = generatePalette('light', {
      hue: 150,
      intensity: 60,
      surfaceTint: 60,
      brightness: 80
    })
    const ext = resolveThemeExtension('github', 'light', palette) as unknown[]
    expect(Array.isArray(ext)).toBe(true)
    expect((ext[0] as unknown[])[0]).toBe(paletteChrome)
    expect(ext[ext.length - 1]).toBe(githubLight)
  })
})
