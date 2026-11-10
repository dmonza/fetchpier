/**
 * Minimal Semantic Versioning 2.0.0 support for the update check: validation and
 * the "greater than" precedence comparison. Written from the specification
 * (https://semver.org/spec/v2.0.0.html §2, §9–§11), not from any library.
 *
 * Accepted input, beyond the bare grammar: surrounding whitespace and a single
 * leading `v` or `=` (catalogue values are sometimes written `v1.2.3`).
 * Build metadata is validated and then dropped from the normalized form,
 * because it never affects precedence (§10).
 */

const MAX_LENGTH = 256

const NUMERIC = /^(0|[1-9]\d*)$/
const IDENTIFIER = /^[0-9A-Za-z-]+$/
const CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parse(input: string): ParsedVersion | null {
  if (input.length > MAX_LENGTH) return null
  let text = input.trim()
  if (text.startsWith('v') || text.startsWith('=')) text = text.slice(1)

  const plus = text.indexOf('+')
  if (plus !== -1) {
    const build = text.slice(plus + 1).split('.')
    if (!build.every((id) => IDENTIFIER.test(id))) return null
    text = text.slice(0, plus)
  }

  const dash = text.indexOf('-')
  const core = dash === -1 ? text : text.slice(0, dash)
  let prerelease: string[] = []
  if (dash !== -1) {
    prerelease = text.slice(dash + 1).split('.')
    const ok = prerelease.every(
      (id) => IDENTIFIER.test(id) && (!/^\d+$/.test(id) || NUMERIC.test(id))
    )
    if (!ok) return null
  }

  const match = CORE.exec(core)
  if (!match) return null
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch, prerelease }
}

function format(v: ParsedVersion): string {
  const core = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease.length > 0 ? `${core}-${v.prerelease.join('.')}` : core
}

/** The normalized version (no prefix, no build metadata), or `null` when invalid. */
export function valid(input: string): string | null {
  const parsed = parse(input)
  return parsed ? format(parsed) : null
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a)
  const bNumeric = NUMERIC.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  // §11.4.3: numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1
  if (bNumeric) return 1
  // §11.4.2: alphanumeric identifiers compare lexically in ASCII order.
  return a < b ? -1 : a > b ? 1 : 0
}

function compare(a: ParsedVersion, b: ParsedVersion): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (core !== 0) return core
  // §11.3: a pre-release version has lower precedence than the normal version.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < shared; i++) {
    const order = compareIdentifiers(a.prerelease[i], b.prerelease[i])
    if (order !== 0) return order
  }
  // §11.4.4: a larger set of pre-release fields has higher precedence.
  return a.prerelease.length - b.prerelease.length
}

function parseOrThrow(input: string): ParsedVersion {
  const parsed = parse(input)
  if (!parsed) throw new TypeError(`Invalid version: ${input}`)
  return parsed
}

/** Whether `a` has higher precedence than `b`. Throws `TypeError` on an invalid version. */
export function gt(a: string, b: string): boolean {
  return compare(parseOrThrow(a), parseOrThrow(b)) > 0
}
