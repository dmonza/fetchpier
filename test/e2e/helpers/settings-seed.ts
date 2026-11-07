import type { AppSettings, Theme, UpdatesSettings } from '../../../src/shared/types'

// The settings document every E2E launch starts from.
//
// It must be **complete**: the app merges missing fields against its defaults in
// memory on every read, but only materializes them on disk when something
// writes — and `writeAppSettings` persists the whole merged document, not the
// patch it was handed. A partial seed therefore grows new keys the first time
// any writer runs, which under a virtual display happens mid-spec (the
// window-bounds persister fires ~400 ms after the window settles). A spec
// comparing the file before and after an action then fails on keys no behavior
// under test ever touched.
//
// The values do not have to match the app's own defaults — a parsed field always
// wins over the default, so whatever is seeded here is what stays on disk. Only
// *presence* matters.
//
// The `AppSettings` annotation on `base` is the load-bearing part: a new
// required field in the settings document fails `npm run typecheck`, which runs
// on every platform, rather than surfacing as a scheduled Linux-only failure.
// Optional fields are deliberately not seeded — they never enter the app's
// defaults, so they are never materialized.

export interface SeedSettingsOptions {
  language: 'en' | 'es'
  /** `null` omits the key entirely — the shape of a file written before the field existed. */
  lastVersion: string | null
  updates: UpdatesSettings
  /**
   * The theme preference the app resolves *before* it creates its window. Seed
   * an explicit value to exercise a preference that disagrees with the host's
   * own theme, which is the case no runner can otherwise produce.
   */
  theme: Theme
  /**
   * The palette preferences, seeded only when given — like the field itself,
   * which is optional and never materialized by the app on its own.
   */
  appearancePalettes?: unknown
}

/**
 * The seed as it is written to disk. `lastVersion` is optional here and only
 * here: dropping it is how a spec exercises "the About was never shown".
 */
export type SeededSettings = Partial<AppSettings>

export function buildSeededSettings(options: SeedSettingsOptions): SeededSettings {
  const base: AppSettings = {
    zoomFactor: 1,
    language: options.language,
    requestTimeoutSeconds: 30,
    proxy: { enabled: false, url: '', username: '', password: '' },
    lastVersion: options.lastVersion,
    updates: options.updates,
    theme: options.theme,
    hideSecretsInResponses: true
  }

  const seeded: SeededSettings = { ...base }
  if (options.lastVersion === null) delete seeded.lastVersion
  if (options.appearancePalettes !== undefined)
    seeded.appearancePalettes = options.appearancePalettes
  return seeded
}
