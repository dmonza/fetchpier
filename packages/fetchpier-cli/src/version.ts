// Single source of truth for the CLI version surfaced in `fp --version` and the
// JSON reporter's `fetchpier.cliVersion`. Kept in sync with package.json by
// `version.test.ts`, which fails if they drift.
export const CLI_VERSION = '0.9.6'
