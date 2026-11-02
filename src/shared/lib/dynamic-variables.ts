/**
 * Dynamic (system-generated) variables — shared, pure metadata.
 *
 * Dynamic variables are addressed as `{{$name}}` and resolved at send time to a
 * freshly generated value (UUID, timestamp, random int, …). The *generation* is
 * engine-owned and lives in `@fetchpier/core` (it needs `node:crypto`); this
 * module holds only the pure data both the engine and the renderer need:
 *  - the canonical name list (for the suggestion list + the inline highlighter),
 *  - the dynamic-name predicate,
 *  - the reserved-`$`-prefix predicate (the whole `$` prefix is a system
 *    namespace — user variable names may not begin with it).
 *
 * Keep this file free of Node imports: the renderer imports it directly and must
 * never pull a Node built-in across the bridge.
 */

/**
 * The whole `$` prefix is reserved for system tokens. A user-defined variable
 * name may never begin with it (rejected at every write chokepoint). This
 * removes precedence ambiguity: a token either starts with `$` (system) or it
 * does not (user).
 */
export const RESERVED_VARIABLE_NAME_PREFIX = '$'

/** Whether a variable name is reserved (begins with the system `$` prefix). */
export function isReservedVariableName(name: string): boolean {
  return name.trim().startsWith(RESERVED_VARIABLE_NAME_PREFIX)
}

/**
 * The v1 dynamic-variable registry — algorithmic primitives only (no curated
 * dataset). Names are case-sensitive and carry the `$` prefix. The core
 * generator registry is keyed by exactly these names (a test asserts parity).
 */
export const DYNAMIC_VARIABLE_NAMES = [
  '$guid',
  '$randomUUID',
  '$timestamp',
  '$isoTimestamp',
  '$randomInt',
  '$randomBoolean',
  '$randomAlphaNumeric',
  '$randomHexColor',
  '$randomIP',
  '$randomIPV6',
  '$randomMACAddress',
  '$randomPassword',
  '$randomSemver'
] as const

export type DynamicVariableName = (typeof DYNAMIC_VARIABLE_NAMES)[number]

const DYNAMIC_VARIABLE_SET: ReadonlySet<string> = new Set(DYNAMIC_VARIABLE_NAMES)

/**
 * Whether a (trimmed) token name is a known dynamic variable. Case-sensitive,
 * matching the established convention. `{{ $guid }}` ≡ `{{$guid}}` (the name is
 * trimmed before matching, consistent with ordinary tokens).
 */
export function isDynamicVariableName(name: string): boolean {
  return DYNAMIC_VARIABLE_SET.has(name.trim())
}
