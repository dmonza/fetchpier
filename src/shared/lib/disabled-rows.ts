/**
 * `# @disabled` grammar (`.http` round-trip fidelity). A disabled header / query
 * param / form field is persisted in the metadata region so it survives a save
 * and reload in its original position, uniform across kinds:
 *
 *   # @disabled header <pos> <Name>: <value>
 *   # @disabled param  <pos> <key>=<value>
 *   # @disabled field  <pos> <key>=<value>
 *
 * `<pos>` is the row's index in the full author-ordered list of its kind
 * (enabled + disabled), so it re-interleaves with the enabled rows on load.
 * Value encoding (D8): header values verbatim; param/field values percent-encoded
 * with the shared single-token grammar (`{{…}}` tokens verbatim) so an
 * enable→disable toggle is byte-identical. To an unaware reader every line reads
 * as an inert comment.
 */
import { mapTokenLiterals, mapTokenLiteralsSafe } from './token-grammar'
import type { DisabledKind, DisabledRow } from '../types'

export type { DisabledKind, DisabledRow }

const DISABLED_RE = /^\s*#\s*@disabled\s+(header|param|field)\s+(\d+)\s+([\s\S]*)$/

/** Serialize one disabled row to its `# @disabled` line. */
export function serializeDisabledRow(row: DisabledRow): string {
  if (row.kind === 'header') {
    return `# @disabled header ${row.pos} ${row.key}: ${row.value}`
  }
  const key = mapTokenLiterals(row.key, encodeURIComponent)
  // REQ-0124: a value-less query parameter keeps its authored shape here too —
  // the payload is the bare key, so re-enabling the row after a save restores a
  // flag parameter rather than an empty-valued one.
  if (row.valueless) return `# @disabled ${row.kind} ${row.pos} ${key}`
  const value = mapTokenLiterals(row.value, encodeURIComponent)
  return `# @disabled ${row.kind} ${row.pos} ${key}=${value}`
}

/** Parse a `# @disabled` line, or null if it is not one. */
export function parseDisabledRow(line: string): DisabledRow | null {
  const m = line.match(DISABLED_RE)
  if (!m) return null
  const kind = m[1] as DisabledKind
  const pos = Number.parseInt(m[2], 10)
  const payload = m[3]

  if (kind === 'header') {
    const colon = payload.indexOf(':')
    if (colon < 0) return null
    const key = payload.slice(0, colon).trim()
    let value = payload.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    return { kind, pos, key, value }
  }

  const eq = payload.indexOf('=')
  const rawKey = eq < 0 ? payload : payload.slice(0, eq)
  const rawValue = eq < 0 ? '' : payload.slice(eq + 1)
  // A malformed percent-escape used to throw out of here and abort the parse
  // (REQ-0113 §6.6). Keep the author's bytes for whichever side failed to decode
  // so the disabled row survives the round-trip instead of taking the file down.
  const key = mapTokenLiteralsSafe(rawKey, decodeURIComponent)
  const value = mapTokenLiteralsSafe(rawValue, decodeURIComponent)
  // REQ-0124: no `=` in a `param` payload means the row was authored as a bare
  // flag. Deliberately not applied to `field`: form fields share this grammar but
  // not the distinction, and setting it there would leak query-only state into
  // the form-urlencoded body path.
  const valueless = eq < 0 && kind === 'param' && rawKey !== ''

  return {
    kind,
    pos,
    key: key.failed ? rawKey : key.text,
    value: value.failed ? rawValue : value.text,
    ...(valueless && { valueless })
  }
}

/**
 * Re-insert disabled rows into the enabled, author-ordered list at their stored
 * positions. Positions are applied in ascending order; one out of range is
 * clamped (appended if beyond the end), never dropped (D7). `makeId` mints a
 * fresh, unique row id for each re-inserted row.
 */
export function reinterleaveDisabled<T extends { enabled: boolean }>(
  enabled: T[],
  disabled: DisabledRow[],
  make: (row: DisabledRow) => T
): T[] {
  const result = [...enabled]
  for (const row of [...disabled].sort((a, b) => a.pos - b.pos)) {
    const at = Math.min(Math.max(row.pos, 0), result.length)
    result.splice(at, 0, make(row))
  }
  return result
}
