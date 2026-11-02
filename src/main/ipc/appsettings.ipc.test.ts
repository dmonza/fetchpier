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
vi.mock('@fetchpier/core/atomic-write', () => ({
  atomicWriteFileSync: (path: string, contents: string) => {
    writes.push({ path, contents })
    fileContents = contents
  }
}))

const { readAppSettings, writeAppSettings } = await import('./appsettings.ipc')

beforeEach(() => {
  writes.length = 0
  fileContents = null
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
