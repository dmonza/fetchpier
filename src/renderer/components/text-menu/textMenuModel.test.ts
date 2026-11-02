import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildTextMenuModel,
  menuItemsFor,
  getSelectedText,
  cutFromTarget,
  pasteIntoTarget
} from './textMenuModel'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeInput(value: string, readOnly = false): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  input.readOnly = readOnly
  document.body.appendChild(input)
  return input
}

function select(input: HTMLInputElement, start: number, end: number): void {
  input.setSelectionRange(start, end)
}

/** Stub a DOM selection so read-only/contentEditable paths are deterministic. */
function stubWindowSelection(text: string): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => text
  } as unknown as Selection)
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// ── buildTextMenuModel ───────────────────────────────────────────────────────

describe('buildTextMenuModel', () => {
  it('editable text input with no selection → show, editable, no selection (CA-03)', () => {
    stubWindowSelection('')
    const input = makeInput('hello')
    select(input, 3, 3)
    expect(buildTextMenuModel(input)).toEqual({ show: true, editable: true, hasSelection: false })
  })

  it('editable text input with a selection → show, editable, selection (CA-02)', () => {
    const input = makeInput('hello')
    select(input, 1, 3)
    expect(buildTextMenuModel(input)).toEqual({ show: true, editable: true, hasSelection: true })
  })

  it('textarea is editable', () => {
    const ta = document.createElement('textarea')
    ta.value = 'abc'
    document.body.appendChild(ta)
    ta.setSelectionRange(0, 2)
    expect(buildTextMenuModel(ta)).toEqual({ show: true, editable: true, hasSelection: true })
  })

  it('contentEditable element is editable (CodeMirror .cm-content)', () => {
    stubWindowSelection('xy')
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    document.body.appendChild(el)
    expect(buildTextMenuModel(el)).toEqual({ show: true, editable: true, hasSelection: true })
  })

  it('read-only contentEditable (aria-readonly) is NOT editable — read-only CodeMirror keeps contenteditable=true but adds aria-readonly (response body)', () => {
    stubWindowSelection('selected')
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    el.setAttribute('aria-readonly', 'true')
    document.body.appendChild(el)
    expect(buildTextMenuModel(el)).toEqual({ show: true, editable: false, hasSelection: true })
  })

  it('a DESCENDANT token of a read-only CodeMirror is NOT editable — inherited contentEditable + ancestor aria-readonly (the real right-click target)', () => {
    stubWindowSelection('selected')
    // `.cm-content` is contenteditable + aria-readonly; the click lands on an
    // inner highlight `<span>` that has no attributes but inherits contentEditable.
    const content = document.createElement('div')
    content.setAttribute('contenteditable', 'true')
    content.setAttribute('aria-readonly', 'true')
    const token = document.createElement('span')
    content.appendChild(token)
    document.body.appendChild(content)
    // Real browsers report inherited contentEditable on the descendant token;
    // jsdom does not, so simulate it to reproduce the production DOM.
    Object.defineProperty(token, 'isContentEditable', { value: true, configurable: true })
    expect(buildTextMenuModel(token)).toEqual({ show: true, editable: false, hasSelection: true })
  })

  it('a descendant token of an EDITABLE CodeMirror stays editable (no aria-readonly ancestor)', () => {
    stubWindowSelection('selected')
    const content = document.createElement('div')
    content.setAttribute('contenteditable', 'true')
    const token = document.createElement('span')
    content.appendChild(token)
    document.body.appendChild(content)
    Object.defineProperty(token, 'isContentEditable', { value: true, configurable: true })
    expect(buildTextMenuModel(token)).toEqual({ show: true, editable: true, hasSelection: true })
  })

  it('read-only input with a selection → Copy-only model (CA-01)', () => {
    const input = makeInput('hello', true)
    select(input, 0, 5)
    expect(buildTextMenuModel(input)).toEqual({ show: true, editable: false, hasSelection: true })
  })

  it('non-editable area with a DOM selection → Copy-only model (CA-01)', () => {
    stubWindowSelection('selected')
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(buildTextMenuModel(div)).toEqual({ show: true, editable: false, hasSelection: true })
  })

  it('non-editable area with no selection → no menu (CA-04)', () => {
    stubWindowSelection('')
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(buildTextMenuModel(div)).toEqual({ show: false })
  })

  it('null target → no menu', () => {
    stubWindowSelection('')
    expect(buildTextMenuModel(null)).toEqual({ show: false })
  })
})

// ── menuItemsFor ─────────────────────────────────────────────────────────────

describe('menuItemsFor', () => {
  it('editable + selection → Cut/Copy/Paste, all enabled when clipboard has text (CA-02)', () => {
    expect(menuItemsFor({ show: true, editable: true, hasSelection: true }, true)).toEqual([
      { id: 'cut', disabled: false },
      { id: 'copy', disabled: false },
      { id: 'paste', disabled: false }
    ])
  })

  it('editable + no selection → Cut/Copy disabled; Paste enabled iff clipboard has text (CA-03)', () => {
    expect(menuItemsFor({ show: true, editable: true, hasSelection: false }, true)).toEqual([
      { id: 'cut', disabled: true },
      { id: 'copy', disabled: true },
      { id: 'paste', disabled: false }
    ])
    expect(menuItemsFor({ show: true, editable: true, hasSelection: false }, false)).toEqual([
      { id: 'cut', disabled: true },
      { id: 'copy', disabled: true },
      { id: 'paste', disabled: true }
    ])
  })

  it('non-editable + selection → Cut(disabled), Copy(enabled), Paste(disabled) (CA-01)', () => {
    expect(menuItemsFor({ show: true, editable: false, hasSelection: true }, false)).toEqual([
      { id: 'cut', disabled: true },
      { id: 'copy', disabled: false },
      { id: 'paste', disabled: true }
    ])
  })

  it('non-editable: Paste stays disabled even if the clipboard holds text', () => {
    expect(menuItemsFor({ show: true, editable: false, hasSelection: true }, true)).toEqual([
      { id: 'cut', disabled: true },
      { id: 'copy', disabled: false },
      { id: 'paste', disabled: true }
    ])
  })
})

// ── getSelectedText ──────────────────────────────────────────────────────────

describe('getSelectedText', () => {
  it('returns the sliced input value for an input', () => {
    const input = makeInput('hello world')
    select(input, 6, 11)
    expect(getSelectedText(input)).toBe('world')
  })

  it('falls back to the DOM selection for non-inputs', () => {
    stubWindowSelection('dom-selected')
    const div = document.createElement('div')
    expect(getSelectedText(div)).toBe('dom-selected')
  })
})

// ── verb helpers — input path (CA-07) ────────────────────────────────────────

describe('cut / paste on a controlled input (CA-07)', () => {
  let writeText: ReturnType<typeof vi.fn>
  let readText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    readText = vi.fn().mockResolvedValue('')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText }
    })
  })

  it('paste splices clipboard text at the selection and fires an input event', async () => {
    readText.mockResolvedValue('XX')
    const input = makeInput('hello')
    select(input, 2, 4) // "ll"
    const onInput = vi.fn()
    input.addEventListener('input', onInput)

    await pasteIntoTarget(input)

    expect(input.value).toBe('heXXo')
    expect(input.selectionStart).toBe(4)
    expect(onInput).toHaveBeenCalledOnce()
  })

  it('paste at a collapsed caret inserts without replacing', async () => {
    readText.mockResolvedValue('-Z-')
    const input = makeInput('ab')
    select(input, 1, 1)
    await pasteIntoTarget(input)
    expect(input.value).toBe('a-Z-b')
  })

  it('cut copies the selection to the clipboard and removes it, firing input', async () => {
    const input = makeInput('hello')
    select(input, 2, 4) // "ll"
    const onInput = vi.fn()
    input.addEventListener('input', onInput)

    await cutFromTarget(input)

    expect(writeText).toHaveBeenCalledWith('ll')
    expect(input.value).toBe('heo')
    expect(onInput).toHaveBeenCalledOnce()
  })

  it('cut with no selection is a no-op', async () => {
    const input = makeInput('hello')
    select(input, 2, 2)
    await cutFromTarget(input)
    expect(writeText).not.toHaveBeenCalled()
    expect(input.value).toBe('hello')
  })

  it('paste with an empty clipboard leaves the value unchanged', async () => {
    readText.mockResolvedValue('')
    const input = makeInput('hello')
    select(input, 0, 0)
    await pasteIntoTarget(input)
    expect(input.value).toBe('hello')
  })

  it('paste swallows a clipboard-read rejection (no throw, no change)', async () => {
    readText.mockRejectedValue(new Error('blocked'))
    const input = makeInput('hello')
    select(input, 0, 0)
    await expect(pasteIntoTarget(input)).resolves.toBeUndefined()
    expect(input.value).toBe('hello')
  })
})
