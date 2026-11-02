/**
 * Dynamic-variable generation (engine-owned).
 *
 * Each `{{$name}}` token resolves to a freshly generated value on the send path
 * (see `resolveString`). Generation is a pure, side-effect-free call per textual
 * occurrence: it writes nothing to the environment and persists nothing. Because
 * it lives here in `@fetchpier/core`, the desktop adapter and the CLI runner
 * inherit identical behavior by construction.
 *
 * The canonical name list and the predicates live in `@shared/lib/dynamic-variables`
 * (pure, renderer-safe). This module owns only the generators, keyed by exactly
 * those names — `dynamic-variables.test.ts` asserts the two stay in sync.
 */

import { randomUUID, randomInt, randomBytes } from 'node:crypto'
import type { DynamicVariableName } from '@shared/lib/dynamic-variables'

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** A string of `length` characters drawn uniformly from `[A-Za-z0-9]`. */
function randomAlphaNumeric(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ALPHANUMERIC[randomInt(0, ALPHANUMERIC.length)]
  }
  return out
}

/**
 * The generator registry. Typed as a total map over `DynamicVariableName`, so
 * adding a name to the shared list without a generator (or vice versa) is a
 * compile error.
 */
const GENERATORS: Record<DynamicVariableName, () => string> = {
  $guid: () => randomUUID(),
  $randomUUID: () => randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randomInt(0, 1001)), // 0…1000 inclusive
  $randomBoolean: () => (randomInt(0, 2) === 1 ? 'true' : 'false'),
  $randomAlphaNumeric: () => randomAlphaNumeric(1),
  $randomHexColor: () => `#${randomBytes(3).toString('hex')}`,
  $randomIP: () => Array.from({ length: 4 }, () => randomInt(0, 256)).join('.'),
  $randomIPV6: () =>
    Array.from({ length: 8 }, () => randomInt(0, 0x10000).toString(16).padStart(4, '0')).join(':'),
  $randomMACAddress: () =>
    Array.from({ length: 6 }, () => randomInt(0, 256).toString(16).padStart(2, '0')).join(':'),
  $randomPassword: () => randomAlphaNumeric(15),
  $randomSemver: () => `${randomInt(0, 100)}.${randomInt(0, 100)}.${randomInt(0, 100)}`
}

/**
 * Generate a value for a `$`-prefixed token name, or `undefined` when the name is
 * not a known dynamic variable (an unknown system token — the caller leaves it
 * literal and reports it unresolved, exactly like a missing user variable).
 *
 * @param name The trimmed token name including the `$` prefix (e.g. `"$guid"`).
 */
export function generateDynamicVariable(name: string): string | undefined {
  const gen = GENERATORS[name as DynamicVariableName]
  return gen ? gen() : undefined
}

/** The names this module can generate (exported for the parity test). */
export function dynamicGeneratorNames(): string[] {
  return Object.keys(GENERATORS)
}
