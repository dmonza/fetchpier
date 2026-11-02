import { CLI_VERSION } from './version'

/**
 * The project's copyright notice, byte-identical to the `Copyright` line of
 * LICENSE. It lives here rather than being read at runtime because the
 * published package ships only `dist/`; `banner.test.ts` fails if it ever
 * drifts from the LICENSE files.
 */
export const COPYRIGHT_LINE = 'Copyright (c) 2026 Daniel Monza — Fetchpier (https://fetchpier.com)'

/**
 * Two-line identity banner: product name + version, then the copyright notice.
 * Printed only by `fp --version` (stdout) and by a bare `fp` (stderr, above
 * the usage text). Never by a command that produces output — stdout belongs to
 * the reporters.
 */
export function formatBanner(): string {
  return `Fetchpier ${CLI_VERSION}\n${COPYRIGHT_LINE}`
}
