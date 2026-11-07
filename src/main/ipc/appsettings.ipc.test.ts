/**
 * `lastVersion` persistence in the app-global settings file. The field drives
 * the once-per-version About dialog, so a settings file written before it
 * existed must read back as `null` (never as `undefined`), and a malformed
 * value must not leak into the runtime.
 *
 * `theme` is covered here too: it is read before the main window is created, so
 * a hand-edited or legacy file must never be able to stop startup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const writes: Array<{ path: string; contents: string }> = []
let fileContents: string | null = null

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('fs', () => ({
  readFileSync: () => {
    if (fileContents === null) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return fileContents
  }
}))

// The narrow subpath, mirroring the module under test: pulling the barrel here
// would also pull the request domain, which is exactly what production avoids.
let failWrites = false

vi.mock('@fetchpier/core/atomic-write', () => ({
  atomicWriteFileSync: (path: string, contents: string) => {
    if (failWrites) throw new Error('EACCES: permission denied')
    writes.push({ path, contents })
    fileContents = contents
  }
}))

const { readAppSettings, writeAppSettings, writeAppSettingsStrict } =
  await import('./appsettings.ipc')

beforeEach(() => {
  writes.length = 0
  fileContents = null
  failWrites = false
})

function seed(settings: Record<string, unknown>): void {
  fileContents = JSON.stringify(settings)
}

describe('readAppSettings — lastVersion', () => {
  it('defaults to null on a fresh install', () => {
    expect(readAppSettings().lastVersion).toBeNull()
  })

  it('defaults to null for a settings file written before the field existed', () => {
    seed({ zoomFactor: 1, language: 'en' })
    expect(readAppSettings().lastVersion).toBeNull()
  })

  it('preserves a stored version string', () => {
    seed({ lastVersion: '0.9.2' })
    expect(readAppSettings().lastVersion).toBe('0.9.2')
  })

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an object', { v: 1 }]
  ])('sanitizes %s to null', (_label, value) => {
    seed({ lastVersion: value })
    expect(readAppSettings().lastVersion).toBeNull()
  })

  it('keeps an explicit null', () => {
    seed({ lastVersion: null })
    expect(readAppSettings().lastVersion).toBeNull()
  })
})

describe('writeAppSettings — lastVersion', () => {
  it('persists a new version and round-trips it', () => {
    seed({ lastVersion: null })
    const updated = writeAppSettings({ lastVersion: '1.0.0' })
    expect(updated.lastVersion).toBe('1.0.0')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].contents).lastVersion).toBe('1.0.0')
    expect(readAppSettings().lastVersion).toBe('1.0.0')
  })

  it('leaves lastVersion untouched when the patch omits it', () => {
    seed({ lastVersion: '0.9.2' })
    const updated = writeAppSettings({ zoomFactor: 1.5 })
    expect(updated.lastVersion).toBe('0.9.2')
  })
})

describe('readAppSettings — theme', () => {
  it('defaults to system on a fresh install', () => {
    expect(readAppSettings().theme).toBe('system')
  })

  it('defaults to system for a settings file written before the field existed', () => {
    seed({ zoomFactor: 1, language: 'en' })
    expect(readAppSettings().theme).toBe('system')
  })

  it('does not rewrite an existing settings file just to materialize the field', () => {
    seed({ zoomFactor: 1, language: 'en' })
    readAppSettings()
    expect(writes).toHaveLength(0)
  })

  it.each(['light', 'dark', 'system'])('preserves the stored preference %s', (value) => {
    seed({ theme: value })
    expect(readAppSettings().theme).toBe(value)
  })

  it.each([
    ['an unrecognised string', 'solarized'],
    ['an empty string', ''],
    ['a number', 1],
    ['a boolean', true],
    ['an object', { theme: 'dark' }],
    ['null', null]
  ])('resolves %s to system', (_label, value) => {
    seed({ theme: value })
    expect(readAppSettings().theme).toBe('system')
  })

  it('starts normally when the theme is out of range', () => {
    seed({ theme: 'neon', zoomFactor: 1.25 })
    const settings = readAppSettings()
    expect(settings.theme).toBe('system')
    expect(settings.zoomFactor).toBe(1.25)
  })
})

describe('writeAppSettings — theme', () => {
  it('round-trips a preference through the settings file', () => {
    seed({ theme: 'system' })
    const updated = writeAppSettings({ theme: 'dark' })
    expect(updated.theme).toBe('dark')
    expect(JSON.parse(writes[0].contents).theme).toBe('dark')
    expect(readAppSettings().theme).toBe('dark')
  })

  it('leaves the theme untouched when the patch omits it', () => {
    seed({ theme: 'light' })
    expect(writeAppSettings({ zoomFactor: 1.5 }).theme).toBe('light')
  })
})

// Hiding secrets in the response viewer is the safe default: anything that is not
// an explicit `false` keeps them hidden.
describe('hideSecretsInResponses', () => {
  it('defaults to true on a fresh install', () => {
    expect(readAppSettings().hideSecretsInResponses).toBe(true)
  })

  it('defaults to true for a settings file written before the field existed', () => {
    seed({ zoomFactor: 1, language: 'en' })
    expect(readAppSettings().hideSecretsInResponses).toBe(true)
  })

  it.each([
    ['a string', 'false'],
    ['a number', 0],
    ['null', null]
  ])('reads %s as true', (_label, value) => {
    seed({ hideSecretsInResponses: value })
    expect(readAppSettings().hideSecretsInResponses).toBe(true)
  })

  it('round-trips false through the settings file', () => {
    seed({})
    expect(writeAppSettings({ hideSecretsInResponses: false }).hideSecretsInResponses).toBe(false)
    expect(readAppSettings().hideSecretsInResponses).toBe(false)
    expect(writeAppSettings({ zoomFactor: 1.5 }).hideSecretsInResponses).toBe(false)
  })
})

// Requirement *Dynamic color themes* §5.3: the block is kept raw (normalized by
// its consumers) so reading never rewrites the file, and a write replaces the
// block as a whole while preserving every other field (CA-31).
describe('appearancePalettes', () => {
  const block = {
    schemaVersion: 1,
    light: { selected: 'ocean' },
    dark: {
      selected: 'custom',
      custom: { hue: 150, intensity: 70, surfaceTint: 0, brightness: 55 }
    }
  }

  it('is absent on a fresh install', () => {
    expect(readAppSettings().appearancePalettes).toBeUndefined()
  })

  it('reads back exactly what the file holds, unknown versions included, without rewriting it', () => {
    const future = { schemaVersion: 2, light: { selected: 'aurora' } }
    seed({ zoomFactor: 1, appearancePalettes: future })
    expect(readAppSettings().appearancePalettes).toEqual(future)
    expect(writes).toHaveLength(0)
  })

  it('survives a write of another field', () => {
    seed({ appearancePalettes: block })
    writeAppSettings({ zoomFactor: 1.25 })
    expect(JSON.parse(fileContents!).appearancePalettes).toEqual(block)
  })

  it('is replaced as a whole and leaves the other fields untouched', () => {
    seed({ zoomFactor: 1.5, theme: 'dark', appearancePalettes: block })
    const next = {
      schemaVersion: 1 as const,
      light: { selected: 'original' },
      dark: { selected: 'forest' }
    }
    writeAppSettingsStrict({ appearancePalettes: next })
    const written = JSON.parse(fileContents!)
    expect(written.appearancePalettes).toEqual(next)
    expect(written.zoomFactor).toBe(1.5)
    expect(written.theme).toBe('dark')
  })
})

describe('writeAppSettingsStrict', () => {
  it('reports a failed write instead of swallowing it', () => {
    seed({ zoomFactor: 1 })
    failWrites = true
    expect(() => writeAppSettingsStrict({ zoomFactor: 2 })).toThrow(/permission denied/)
    expect(JSON.parse(fileContents!).zoomFactor).toBe(1)
  })

  it('leaves the lenient writer lenient', () => {
    seed({ zoomFactor: 1 })
    failWrites = true
    expect(() => writeAppSettings({ zoomFactor: 2 })).not.toThrow()
  })
})
