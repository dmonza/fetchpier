/**
 * Helpers for the ordered, duplicate-capable header list (`HeaderEntry[]`) — the
 * canonical wire/round-trip header representation (`.http` round-trip fidelity).
 *
 * The name→value `Record<string,string>` form is retained across the codebase as
 * a lossy convenience view (it cannot hold duplicates). These helpers convert
 * between the two and provide name-keyed access over the list that mirrors the
 * de-facto model of similar tools: first-match convenience plus duplicate-aware
 * operations. Header names compare case-insensitively.
 */
import type { HeaderEntry } from '../types'

/** Flatten a header list into a name→value map (last value wins on duplicates). */
export function headersToRecord(entries: HeaderEntry[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of entries) out[e.name] = e.value
  return out
}

/** Lift a name→value map into a header list (insertion order). */
export function recordToHeaders(record: Record<string, string>): HeaderEntry[] {
  return Object.entries(record).map(([name, value]) => ({ name, value }))
}

/** First value for `name` (case-insensitive), or undefined. */
export function getHeader(entries: HeaderEntry[], name: string): string | undefined {
  const lower = name.toLowerCase()
  return entries.find((e) => e.name.toLowerCase() === lower)?.value
}

/** All values for `name` (case-insensitive), in order. */
export function getAllHeaders(entries: HeaderEntry[], name: string): string[] {
  const lower = name.toLowerCase()
  return entries.filter((e) => e.name.toLowerCase() === lower).map((e) => e.value)
}

/** True when at least one entry matches `name` (case-insensitive). */
export function hasHeader(entries: HeaderEntry[], name: string): boolean {
  const lower = name.toLowerCase()
  return entries.some((e) => e.name.toLowerCase() === lower)
}

/** New list with every entry named `name` (case-insensitive) removed. */
export function removeHeaders(entries: HeaderEntry[], name: string): HeaderEntry[] {
  const lower = name.toLowerCase()
  return entries.filter((e) => e.name.toLowerCase() !== lower)
}

/**
 * New list with every same-name entry removed and a single `{name, value}`
 * appended at the end. Used where a name must resolve to exactly one value
 * (e.g. an auth scheme that owns its header name, the cookie jar).
 */
export function setHeaderUnique(
  entries: HeaderEntry[],
  name: string,
  value: string
): HeaderEntry[] {
  return [...removeHeaders(entries, name), { name, value }]
}

/**
 * Flatten a header list into undici's positional array form
 * (`[name, value, name, value, …]`), which preserves order **and** duplicates
 * on the wire (the object form would collapse same-name entries).
 */
export function headersToUndiciArray(entries: HeaderEntry[]): string[] {
  const out: string[] = []
  for (const e of entries) out.push(e.name, e.value)
  return out
}
