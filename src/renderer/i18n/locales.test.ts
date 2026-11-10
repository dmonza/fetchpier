/**
 * The About's license block is rendered from the packaged LICENSE file, not
 * from translations. The copyright line and the license description must not
 * come back as translatable strings, in any locale.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import { SCHEMA_IMPORT_WARNING_KINDS } from '../../shared/types'

const locales = { en, es } as const

function keysOf(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    keysOf(child, prefix ? `${prefix}.${key}` : key)
  )
}

describe.each(Object.entries(locales))('%s locale', (_name, locale) => {
  const keys = keysOf(locale)

  it.each(['about.license.copyright', 'about.license.body', 'about.license.bodyBeta'])(
    'does not define %s',
    (key) => {
      expect(keys).not.toContain(key)
    }
  )

  it('labels the build a public beta, not a private one', () => {
    expect(keys).toContain('about.publicBeta.badge')
    expect(keys).not.toContain('about.privateBeta.badge')
  })

  // The app ships under the MIT licence, which grants redistribution. No string
  // the interface can show may say otherwise.
  it('has no string that restricts redistribution', () => {
    const offending = keys.filter((key) => {
      const value = key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], locale)
      return typeof value === 'string' && /redistribu/i.test(value)
    })
    expect(offending).toEqual([])
  })

  // The import summary groups warnings under `schemaImport.warningKind.<kind>`;
  // a kind without a label would render as a raw key (REQ "In-house OpenAPI
  // reference resolution", CA-24).
  it.each(SCHEMA_IMPORT_WARNING_KINDS)('labels the %s schema-import warning kind', (kind) => {
    const label = (locale.schemaImport.warningKind as Record<string, unknown>)[kind]
    expect(typeof label).toBe('string')
    expect((label as string).trim()).not.toBe('')
  })

  it('includes the unresolved-reference warning kind', () => {
    expect(SCHEMA_IMPORT_WARNING_KINDS).toContain('unresolved-ref')
  })

  it('defines the license-block chrome keys', () => {
    expect(keys).toContain('about.license.title')
    expect(keys).toContain('about.license.loading')
    expect(keys).toContain('about.license.loadError')
  })
})

it('keeps the English and Spanish key sets identical', () => {
  expect(keysOf(es).sort()).toEqual(keysOf(en).sort())
})
