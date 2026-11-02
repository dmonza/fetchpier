// Pure logic for the global text-selection context menu (Copy / Cut / Paste).
//
// Kept free of React/clipboard side effects where possible so the editable/
// selection model and the input-path verbs are unit-testable in jsdom. The
// contentEditable (CodeMirror) verb path delegates to `document.execCommand`,
// which jsdom does not implement — that path is covered by manual/e2e checks.

/** Result of inspecting a right-click target for the text menu. */
export type TextMenuModel =
  { show: false } | { show: true; editable: boolean; hasSelection: boolean }

type TextField = HTMLInputElement | HTMLTextAreaElement

// Input types that hold editable, selectable text. Excludes checkbox/radio/
// number/etc. whose `selectionStart` is null and that we never edit as text.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', ''])

function isTextField(el: Element): el is TextField {
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)
}

function isContentEditable(el: HTMLElement): boolean {
  // `isContentEditable` is inherited-true on descendant tokens in a real
  // browser; the attribute fallback keeps detection deterministic in jsdom.
  const attr = el.getAttribute('contenteditable')
  const editable = el.isContentEditable || attr === '' || attr === 'true'
  if (!editable) return false
  // Read-only CodeMirror keeps `.cm-content` `contenteditable="true"` but marks
  // it `aria-readonly="true"`. A right-click usually lands on a descendant token
  // (inherited contentEditable, no aria-readonly of its own), so check the whole
  // ancestor chain — not just this element — and treat the region as read-only.
  return el.closest('[aria-readonly="true"]') === null
}

function isEditable(el: HTMLElement): boolean {
  if (isTextField(el)) return !el.disabled && !el.readOnly
  return isContentEditable(el)
}

/** Climb from `node` to the nearest editable host (input/textarea/CE), or null. */
export function getEditableTarget(node: EventTarget | null): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : null
  while (el) {
    if (isEditable(el)) return el
    el = el.parentElement
  }
  return null
}

/** True when there is a non-empty selection over `target` (input range or DOM). */
function hasTextSelection(target: HTMLElement | null): boolean {
  if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    return target.selectionStart !== target.selectionEnd
  }
  const sel = window.getSelection()
  return !!sel && sel.toString().length > 0
}

/**
 * Build the menu model from a right-click target.
 * - editable target            → show (Cut/Copy/Paste, enablement decided later)
 * - non-editable + selection   → show (Copy only)
 * - non-editable + no selection→ hidden (no menu)
 */
export function buildTextMenuModel(node: EventTarget | null): TextMenuModel {
  const editableTarget = getEditableTarget(node)
  const editable = editableTarget !== null
  const probe = editableTarget ?? (node instanceof HTMLElement ? node : null)
  const hasSelection = hasTextSelection(probe)
  if (!editable && !hasSelection) return { show: false }
  return { show: true, editable, hasSelection }
}

/** A verb offered by the menu, with its enabled/disabled state. */
export interface TextMenuItem {
  id: 'cut' | 'copy' | 'paste'
  disabled: boolean
}

/**
 * The ordered item set for a shown menu. The shape is stable — always Cut, Copy,
 * Paste — with inapplicable items disabled rather than hidden.
 * - editable → Cut/Copy disabled without a selection; Paste disabled unless the
 *   clipboard holds text.
 * - non-editable → Cut and Paste are always disabled (nothing here can be
 *   mutated); Copy is the only live verb (the menu only shows with a selection).
 */
export function menuItemsFor(
  model: Extract<TextMenuModel, { show: true }>,
  canPaste: boolean
): TextMenuItem[] {
  if (model.editable) {
    return [
      { id: 'cut', disabled: !model.hasSelection },
      { id: 'copy', disabled: !model.hasSelection },
      { id: 'paste', disabled: !canPaste }
    ]
  }
  return [
    { id: 'cut', disabled: true },
    { id: 'copy', disabled: !model.hasSelection },
    { id: 'paste', disabled: true }
  ]
}

/** The currently selected text for `target` (input slice or DOM selection). */
export function getSelectedText(target: HTMLElement | null): string {
  if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? 0
    return target.value.slice(start, end)
  }
  return window.getSelection()?.toString() ?? ''
}

// ── verbs ────────────────────────────────────────────────────────────────────

/** Set a controlled input's value through React's tracked native setter. */
function setNativeValue(el: TextField, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
}

/** Replace the current selection of an input/textarea with `insert`, the React way. */
function spliceInput(el: TextField, insert: string): void {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? el.value.length
  setNativeValue(el, el.value.slice(0, start) + insert + el.value.slice(end))
  const caret = start + insert.length
  el.setSelectionRange(caret, caret)
  // Drives React's onChange and CodeMirror has no part here.
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Copy text to the clipboard. Rejection is the caller's to ignore. */
export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

/** Cut: copy the selection, then remove it through the field's normal input path. */
export async function cutFromTarget(target: HTMLElement): Promise<void> {
  const text = getSelectedText(target)
  if (!text) return
  try {
    await copyText(text)
  } catch {
    return // clipboard write blocked → leave the field untouched
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    spliceInput(target, '')
  } else {
    target.focus()
    document.execCommand('delete')
  }
}

/** Paste clipboard text at the caret/selection through the field's normal input path. */
export async function pasteIntoTarget(target: HTMLElement): Promise<void> {
  let text: string
  try {
    text = await navigator.clipboard.readText()
  } catch {
    return // clipboard read blocked under sandbox/contention → no-op
  }
  if (!text) return
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    spliceInput(target, text)
  } else {
    target.focus()
    document.execCommand('insertText', false, text)
  }
}
