import { describe, it, expect } from 'vitest'
import { buildSeededSettings } from './settings-seed'
import type { AppSettings } from '../../../src/shared/types'

// Why this suite exists: the seed used to be a partial literal, and the app
// materializes every missing default onto disk the first time *anything*
// writes. The window-bounds persister writes ~400 ms after the window settles,
// which under a virtual display lands mid-spec — so a spec comparing the
// settings file before and after an action saw unrelated keys appear and
// failed on a correct product. The failure only reproduced on the CI platform.
//
// Two guards, in opposite directions:
//   - a field ADDED to `AppSettings` breaks `buildSeededSettings` at typecheck,
//     because the base object is annotated with the full type;
//   - a field REMOVED from the builder breaks the key-set assertion below.
//
// The second is why the expected key list is restated here rather than derived:
// a runtime list cannot come from a compile-time type, and restating it makes
// dropping a key a deliberate two-file act.

/** Every field `AppSettings` requires — i.e. everything `DEFAULTS` materializes. */
const REQUIRED_KEYS = [
  'zoomFactor',
  'language',
  'requestTimeoutSeconds',
  'proxy',
  'lastVersion',
  'updates',
  'theme',
  'hideSecretsInResponses'
] as const satisfies readonly (keyof AppSettings)[]

const UPDATES = {
  autoCheckEnabled: false,
  intervalDays: 30,
  lastCheckAt: '2026-08-03T00:00:00.000Z'
}

describe('buildSeededSettings', () => {
  it('writes every field the settings document requires', () => {
    const seeded = buildSeededSettings({
      language: 'en',
      lastVersion: '1.2.3',
      updates: UPDATES,
      theme: 'system'
    })

    expect(Object.keys(seeded).sort()).toEqual([...REQUIRED_KEYS].sort())
  })

  it('writes a complete proxy block rather than an empty placeholder', () => {
    const seeded = buildSeededSettings({
      language: 'en',
      lastVersion: '1.2.3',
      updates: UPDATES,
      theme: 'system'
    })

    // A partial nested object would be merged with the defaults on read and
    // then materialized on the next write — the same defect one level down.
    expect(Object.keys(seeded.proxy ?? {}).sort()).toEqual([
      'enabled',
      'password',
      'url',
      'username'
    ])
  })

  it('omits only lastVersion when asked for a file that predates the field', () => {
    const seeded = buildSeededSettings({
      language: 'en',
      lastVersion: null,
      updates: UPDATES,
      theme: 'system'
    })

    expect(seeded).not.toHaveProperty('lastVersion')
    expect(Object.keys(seeded).sort()).toEqual(
      REQUIRED_KEYS.filter((k) => k !== 'lastVersion').sort()
    )
  })

  it('passes the caller’s language and update preferences through verbatim', () => {
    const seeded = buildSeededSettings({
      language: 'es',
      lastVersion: '9.9.9',
      updates: UPDATES,
      theme: 'system'
    })

    expect(seeded.language).toBe('es')
    expect(seeded.lastVersion).toBe('9.9.9')
    expect(seeded.updates).toEqual(UPDATES)
  })

  it('seeds the theme preference the app resolves before creating its window', () => {
    // Seeding an explicit preference is the only way a spec can put the app in
    // a theme the host machine is not already in.
    const seeded = buildSeededSettings({
      language: 'en',
      lastVersion: '1.0.0',
      updates: UPDATES,
      theme: 'dark'
    })

    expect(seeded.theme).toBe('dark')
  })

  it('never seeds a null lastCheckAt, which the app would read as “prompt now”', () => {
    // `mergeDefaults` stamps a null `lastCheckAt` on read; seeding one would make
    // the update dialog open over whatever UI a spec is driving.
    const seeded = buildSeededSettings({
      language: 'en',
      lastVersion: '1.0.0',
      updates: { ...UPDATES, lastCheckAt: '2026-01-01T00:00:00.000Z' },
      theme: 'system'
    })

    expect(seeded.updates?.lastCheckAt).not.toBeNull()
  })
})
