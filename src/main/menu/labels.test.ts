import { describe, it, expect } from 'vitest'
import en from '../../renderer/i18n/locales/en.json'
import es from '../../renderer/i18n/locales/es.json'
import { FALLBACK_MENU_LABELS, isMenuLabels } from './labels'

/**
 * The contract between the two halves of the menu's vocabulary: main declares
 * the shape it needs, the locale files provide the strings, and the renderer
 * pushes them across. Nothing type-checks that hand-off — the push is built
 * from `t()` calls, which return a string for a missing key just as happily as
 * for a present one — so it is asserted here.
 *
 * This is also what keeps the previously-dead `menu.*` keys honest: before this
 * REQ they existed in both locale files and nothing read them.
 *
 * REQ Application menu coherence on macOS §6.6, §9.2.
 */

type Shape = Record<string, unknown>

/** Every leaf path in an object, as dotted strings. */
function leafPaths(value: Shape, prefix = ''): string[] {
  const out: string[] = []
  for (const key of Object.keys(value)) {
    const child = value[key]
    const path = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      out.push(...leafPaths(child as Shape, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

const expected = leafPaths(FALLBACK_MENU_LABELS as unknown as Shape)

describe('menu vocabulary', () => {
  it('is fully defined in English', () => {
    expect(leafPaths((en as Shape).menu as Shape)).toEqual(expected)
  })

  it('is fully defined in Spanish', () => {
    expect(leafPaths((es as Shape).menu as Shape)).toEqual(expected)
  })

  it('carries no key in one language that the other lacks', () => {
    expect(leafPaths((en as Shape).menu as Shape)).toEqual(leafPaths((es as Shape).menu as Shape))
  })

  it('leaves no unread key behind', () => {
    // The reverse direction of the two assertions above: a locale entry the
    // menu never asks for is dead weight, which is exactly the state this REQ
    // found the `menu.*` block in.
    const inLocaleOnly = leafPaths((en as Shape).menu as Shape).filter((p) => !expected.includes(p))
    expect(inLocaleOnly).toEqual([])
  })

  it('translates every label — no Spanish entry is left at its English text', () => {
    // Product nouns legitimately match across languages; everything else
    // differing is the signal that a real translation was written.
    const untranslated = expected.filter((path) => read(en, path) === read(es, path))
    expect(untranslated).toEqual(['request.label', 'window.zoom'])
  })
})

describe('isMenuLabels', () => {
  it('accepts a complete vocabulary', () => {
    expect(isMenuLabels(FALLBACK_MENU_LABELS)).toBe(true)
    expect(isMenuLabels((en as Shape).menu)).toBe(true)
    expect(isMenuLabels((es as Shape).menu)).toBe(true)
  })

  it('rejects a partial one rather than half-applying it', () => {
    const partial = JSON.parse(JSON.stringify(FALLBACK_MENU_LABELS))
    delete partial.file.save
    expect(isMenuLabels(partial)).toBe(false)
  })

  it('rejects a non-object and a wrong leaf type', () => {
    expect(isMenuLabels(null)).toBe(false)
    expect(isMenuLabels('labels')).toBe(false)
    expect(isMenuLabels([])).toBe(false)

    const wrongLeaf = JSON.parse(JSON.stringify(FALLBACK_MENU_LABELS))
    wrongLeaf.view.zoomIn = 42
    expect(isMenuLabels(wrongLeaf)).toBe(false)
  })
})

function read(root: unknown, dotted: string): unknown {
  return `menu.${dotted}`
    .split('.')
    .reduce<unknown>((acc, key) => (acc as Shape | undefined)?.[key], root)
}
