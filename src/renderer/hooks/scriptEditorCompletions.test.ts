import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { autocompletion, type Completion } from '@codemirror/autocomplete'
import {
  acceptIfSmart,
  commitCharactersFor,
  createRecentlyUsedTracker,
  isDeprecated,
  makeAutoTriggerApply,
  scriptKindToIcon,
  shouldAutoTrigger
} from './scriptEditorCompletions'

// ── scriptKindToIcon ────────────────────────────────────────────────────────

describe('scriptKindToIcon', () => {
  it.each([
    ['method', 'method'],
    ['function', 'function'],
    ['local function', 'function'],
    ['constructor', 'method'],
    ['getter', 'method'],
    ['setter', 'method'],
    ['property', 'property'],
    ['var', 'variable'],
    ['let', 'variable'],
    ['const', 'constant'],
    ['parameter', 'variable'],
    ['class', 'class'],
    ['interface', 'interface'],
    ['type', 'type'],
    ['enum', 'enum'],
    ['enum member', 'constant'],
    ['module', 'namespace'],
    ['keyword', 'keyword'],
    ['alias', 'variable'],
    ['string', 'text']
  ])('maps kind %s → %s', (kind, expected) => {
    expect(scriptKindToIcon(kind, '')).toBe(expected)
  })

  it('returns undefined for unknown kinds', () => {
    expect(scriptKindToIcon('some-unknown-kind', '')).toBeUndefined()
  })

  it('appends deprecated when modifier is present', () => {
    expect(scriptKindToIcon('method', 'public,deprecated')).toBe('method deprecated')
    expect(scriptKindToIcon('property', 'deprecated')).toBe('property deprecated')
  })

  it('returns just "deprecated" when kind is unknown but marked deprecated', () => {
    expect(scriptKindToIcon('mystery-kind', 'deprecated')).toBe('deprecated')
  })
})

// ── isDeprecated ────────────────────────────────────────────────────────────

describe('isDeprecated', () => {
  it('recognises the deprecated modifier among multiple', () => {
    expect(isDeprecated('public,deprecated')).toBe(true)
    expect(isDeprecated('public,static,deprecated,readonly')).toBe(true)
    expect(isDeprecated('deprecated')).toBe(true)
  })

  it('does not match substrings', () => {
    expect(isDeprecated('deprecationWarning')).toBe(false)
    expect(isDeprecated('undeprecated')).toBe(false)
  })

  it('handles empty / whitespace modifiers', () => {
    expect(isDeprecated('')).toBe(false)
    expect(isDeprecated('   ')).toBe(false)
  })
})

// ── commitCharactersFor ─────────────────────────────────────────────────────

describe('commitCharactersFor', () => {
  it('returns "." and "(" for methods and functions', () => {
    expect(commitCharactersFor('method')).toEqual(['.', '('])
    expect(commitCharactersFor('function')).toEqual(['.', '('])
    expect(commitCharactersFor('constructor')).toEqual(['.', '('])
  })

  it('returns value-like commit chars for properties & variables', () => {
    expect(commitCharactersFor('property')).toEqual(['.', ',', ';'])
    expect(commitCharactersFor('var')).toEqual(['.', ',', ';'])
    expect(commitCharactersFor('const')).toEqual(['.', ',', ';'])
    expect(commitCharactersFor('parameter')).toEqual(['.', ',', ';'])
  })

  it('returns only "." for namespaces / classes / types', () => {
    expect(commitCharactersFor('module')).toEqual(['.'])
    expect(commitCharactersFor('class')).toEqual(['.'])
    expect(commitCharactersFor('interface')).toEqual(['.'])
    expect(commitCharactersFor('enum')).toEqual(['.'])
    expect(commitCharactersFor('type')).toEqual(['.'])
  })

  it('returns a space for keywords', () => {
    expect(commitCharactersFor('keyword')).toEqual([' '])
  })

  it('returns empty for unknown kinds', () => {
    expect(commitCharactersFor('some-unknown-kind')).toEqual([])
  })
})

// ── createRecentlyUsedTracker ───────────────────────────────────────────────

describe('createRecentlyUsedTracker', () => {
  const a: Completion = { label: 'alpha' }
  const b: Completion = { label: 'beta' }
  const c: Completion = { label: 'gamma' }

  it('returns 0 when the prefix has no recent entry', () => {
    const tracker = createRecentlyUsedTracker()
    expect(tracker.compare(a, b, 'al')).toBe(0)
  })

  it('promotes the recently accepted label for the same prefix', () => {
    const tracker = createRecentlyUsedTracker()
    tracker.record('or', 'beta')
    expect(tracker.compare(a, b, 'or')).toBeGreaterThan(0) // a after b
    expect(tracker.compare(b, a, 'or')).toBeLessThan(0) // b before a
  })

  it('case-insensitive on the prefix', () => {
    const tracker = createRecentlyUsedTracker()
    tracker.record('OR', 'beta')
    expect(tracker.compare(b, a, 'or')).toBeLessThan(0)
    expect(tracker.compare(b, a, 'Or')).toBeLessThan(0)
  })

  it('latest record wins for the same prefix', () => {
    const tracker = createRecentlyUsedTracker()
    tracker.record('foo', 'alpha')
    tracker.record('foo', 'gamma')
    expect(tracker.compare(c, a, 'foo')).toBeLessThan(0) // gamma wins now
    expect(tracker.compare(a, c, 'foo')).toBeGreaterThan(0)
  })

  it('does not confuse different prefixes', () => {
    const tracker = createRecentlyUsedTracker()
    tracker.record('bar', 'alpha')
    expect(tracker.compare(a, b, 'foo')).toBe(0)
  })
})

// ── acceptIfSmart ───────────────────────────────────────────────────────────

function createEditor(doc: string, caret: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [autocompletion()]
  })
  const parent = document.createElement('div')
  // Keep the view detached from the DOM tree is fine — it still responds to
  // dispatch() and state queries. We just need a parent element for construction.
  return new EditorView({ state, parent })
}

describe('acceptIfSmart', () => {
  it('returns false when no completion popup is active (lets newline happen)', () => {
    const view = createEditor('fp.te', 5)
    expect(acceptIfSmart(view)).toBe(false)
    view.destroy()
  })

  it('returns false for an empty document with no popup', () => {
    const view = createEditor('', 0)
    expect(acceptIfSmart(view)).toBe(false)
    view.destroy()
  })
})

// ── makeAutoTriggerApply ────────────────────────────────────────────────────

describe('makeAutoTriggerApply', () => {
  it('inserts label + () and positions cursor between parentheses', () => {
    const view = createEditor('fp.', 3)
    const apply = makeAutoTriggerApply('set')
    apply(view, { label: 'set' } as Completion, 3, 3)
    expect(view.state.doc.toString()).toBe('fp.set()')
    // Cursor should be between '(' and ')'.
    expect(view.state.selection.main.head).toBe('fp.set('.length)
    view.destroy()
  })

  it('replaces the existing range when the user was mid-typing', () => {
    const view = createEditor('fp.se', 5)
    const apply = makeAutoTriggerApply('set')
    apply(view, { label: 'set' } as Completion, 3, 5)
    expect(view.state.doc.toString()).toBe('fp.set()')
    expect(view.state.selection.main.head).toBe('fp.set('.length)
    view.destroy()
  })
})

// ── shouldAutoTrigger ───────────────────────────────────────────────────────

describe('shouldAutoTrigger', () => {
  it('is true for callables', () => {
    expect(shouldAutoTrigger('method')).toBe(true)
    expect(shouldAutoTrigger('function')).toBe(true)
    expect(shouldAutoTrigger('constructor')).toBe(true)
  })

  it('is false for non-callables', () => {
    expect(shouldAutoTrigger('property')).toBe(false)
    expect(shouldAutoTrigger('var')).toBe(false)
    expect(shouldAutoTrigger('class')).toBe(false)
    expect(shouldAutoTrigger('keyword')).toBe(false)
  })
})
