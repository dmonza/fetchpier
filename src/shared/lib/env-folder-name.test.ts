import { describe, it, expect } from 'vitest'
import { MAX_ENV_FOLDER_NAME, deriveEnvFolderName, firstFreeEnvCopyName } from './env-folder-name'

describe('deriveEnvFolderName', () => {
  // The worked-example table from the requirement's derivation rule.
  it.each([
    ['Staging', 'staging'],
    ['Producción', 'produccion'],
    ['Café QA', 'cafe-qa'],
    ['Dev / Local', 'dev-local'],
    ['  Dev  ', 'dev'],
    ['本番', ''],
    ['!!!', ''],
    ['', '']
  ])('derives %j → %j', (typed, folder) => {
    expect(deriveEnvFolderName(typed)).toBe(folder)
  })

  it('transliterates before sanitizing so accents survive as their base letter', () => {
    // Without the NFD decomposition these collapse to hyphens instead.
    expect(deriveEnvFolderName('Ñandú')).toBe('nandu')
    expect(deriveEnvFolderName('Über-Straße')).toBe('uber-stra-e')
  })

  it('collapses every run of non-alphanumerics to a single hyphen', () => {
    expect(deriveEnvFolderName('a___b   c...d')).toBe('a-b-c-d')
    expect(deriveEnvFolderName('--a--')).toBe('a')
  })

  it('keeps digits', () => {
    expect(deriveEnvFolderName('Staging 2')).toBe('staging-2')
  })

  describe('length cap', () => {
    it('caps the derived name', () => {
      const long = 'word '.repeat(40)
      expect(deriveEnvFolderName(long).length).toBeLessThanOrEqual(MAX_ENV_FOLDER_NAME)
    })

    it('truncates at a hyphen boundary rather than mid-word', () => {
      const typed = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
      const derived = deriveEnvFolderName(typed)
      expect(derived.length).toBeLessThanOrEqual(MAX_ENV_FOLDER_NAME)
      // Every retained segment is whole — no partial word at the tail.
      const segments = derived.split('-')
      expect(typed.toLowerCase().split(' ')).toEqual(expect.arrayContaining(segments))
      expect(derived.endsWith('-')).toBe(false)
    })

    it('hard-truncates a single word longer than the cap', () => {
      const derived = deriveEnvFolderName('x'.repeat(80))
      expect(derived).toBe('x'.repeat(MAX_ENV_FOLDER_NAME))
    })
  })

  it('is idempotent — a derived name derives to itself', () => {
    for (const typed of [
      'Staging',
      'Producción',
      'Café QA',
      'Dev / Local',
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet',
      'x'.repeat(80)
    ]) {
      const once = deriveEnvFolderName(typed)
      expect(deriveEnvFolderName(once)).toBe(once)
    }
  })
})

describe('firstFreeEnvCopyName', () => {
  it('uses <name>-copy when its folder is free', () => {
    expect(firstFreeEnvCopyName('staging', new Set())).toBe('staging-copy')
  })

  it('skips to -copy-2 when the -copy folder is taken', () => {
    expect(firstFreeEnvCopyName('staging', new Set(['staging', 'staging-copy']))).toBe(
      'staging-copy-2'
    )
  })

  it('walks the ladder past every taken folder', () => {
    const taken = new Set(['staging-copy', 'staging-copy-2', 'staging-copy-4'])
    expect(firstFreeEnvCopyName('staging', taken)).toBe('staging-copy-3')
  })

  it('compares on the derived folder, not the typed name', () => {
    // `Producción-copy` derives to `produccion-copy`, which is taken.
    expect(firstFreeEnvCopyName('Producción', new Set(['produccion-copy']))).toBe(
      'Producción-copy-2'
    )
  })

  it('compares case-insensitively', () => {
    expect(firstFreeEnvCopyName('Staging', new Set(['STAGING-COPY']))).toBe('Staging-copy-2')
  })
})
