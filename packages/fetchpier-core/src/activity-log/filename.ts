// Filename builder for activity-log `.http` files (REQ-0068 §5.2.4).
//
// Format: `<timestamp>-<disambiguator>-<METHOD>-<slug>.http`
//
//   • timestamp     ISO 8601 basic format, UTC, ms precision: YYYYMMDDTHHMMSSmmmZ
//                   (avoids the `:` that Windows forbids; lex sort = chrono sort).
//   • disambiguator counter > 0 → 5-digit zero-padded counter (mock domain);
//                   counter = 0   → 4-hex FNV-1a hash of the run-id (requests).
//   • METHOD        upper-case HTTP method, sanitized to ASCII letters.
//   • slug          path sanitized: `/` → `_`, query stripped, non
//                   `[a-zA-Z0-9._-]` → `_`, consecutive `_` collapsed,
//                   leading/trailing `_` trimmed. Empty path → `root`.
//   • cap           200 chars total; if exceeded, slug is truncated and a
//                   `<slug>-<hash4(fullPath)>` suffix is appended.
//
// The hash uses a pure-JS FNV-1a 32-bit — no `node:crypto` import — so the
// module stays renderer-safe.

import type { FilenameSpec } from './types'

const FILENAME_CAP = 200
const FILENAME_EXT = '.http'

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a 32-bit hash of a UTF-8 string, returned as a lowercase 4-character
 * hex string (the low 16 bits of the 32-bit digest). Collisions are expected
 * for adversarial input; for non-adversarial run-ids the 1-in-65 536 chance
 * within the same millisecond is acceptable (REQ-0068 §6.2).
 */
export function hash4(input: string): string {
  let h = FNV_OFFSET_BASIS
  // Encode as UTF-8 then hash byte-by-byte. TextEncoder is available in both
  // Node and renderer; matching engines produces identical digests.
  const bytes = new TextEncoder().encode(input)
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!
    // Math.imul keeps multiplication 32-bit; `h >>> 0` re-normalizes to u32.
    h = Math.imul(h, FNV_PRIME) >>> 0
  }
  return (h & 0xffff).toString(16).padStart(4, '0')
}

function toBasicIsoTimestamp(timestamp: Date | string): string {
  const d = typeof timestamp === 'string' ? new Date(timestamp) : timestamp
  if (Number.isNaN(d.getTime())) {
    throw new Error(`activity-log/filename: invalid timestamp: ${String(timestamp)}`)
  }
  const Y = d.getUTCFullYear().toString().padStart(4, '0')
  const M = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const D = d.getUTCDate().toString().padStart(2, '0')
  const h = d.getUTCHours().toString().padStart(2, '0')
  const m = d.getUTCMinutes().toString().padStart(2, '0')
  const s = d.getUTCSeconds().toString().padStart(2, '0')
  const ms = d.getUTCMilliseconds().toString().padStart(3, '0')
  return `${Y}${M}${D}T${h}${m}${s}${ms}Z`
}

function sanitizeMethod(method: string): string {
  const cleaned = method.replace(/[^A-Z]/gi, '').toUpperCase()
  return cleaned || 'UNKNOWN'
}

function disambiguator(spec: FilenameSpec): string {
  if (spec.counter > 0) return spec.counter.toString().padStart(5, '0')
  return hash4(spec.runId)
}

/**
 * Slug a URL path per the rules above. Strips the query string and any
 * leading `/`. Empty result → `root`.
 */
function slugifyPath(pathRaw: string): string {
  // Strip scheme + host if present (we tolerate both raw paths and full URLs).
  let p = pathRaw.replace(/^https?:\/\/[^/]*/, '')
  // Strip query and fragment.
  const q = p.indexOf('?')
  if (q >= 0) p = p.slice(0, q)
  const f = p.indexOf('#')
  if (f >= 0) p = p.slice(0, f)
  // Drop the leading `/`.
  if (p.startsWith('/')) p = p.slice(1)
  // `/` → `_`.
  p = p.replace(/\//g, '_')
  // Non `[a-zA-Z0-9._-]` → `_`.
  p = p.replace(/[^a-zA-Z0-9._-]/g, '_')
  // Collapse consecutive `_`.
  p = p.replace(/_+/g, '_')
  // Trim leading/trailing `_`. One per edge is all that can remain after the
  // collapse above, and matching a run here would be quadratic on a long path.
  p = p.replace(/^_|_$/g, '')
  return p.length > 0 ? p : 'root'
}

/**
 * Build the filename for one activity-log entry.
 *
 * The 200-character cap is enforced on the full filename (including the
 * `.http` extension). When the slug would push us over the cap, the slug is
 * truncated and a `-<hash4(pathRaw)>` suffix is added so two different paths
 * producing the same truncated slug still distinguish themselves.
 */
export function buildActivityLogFilename(spec: FilenameSpec): string {
  const ts = toBasicIsoTimestamp(spec.timestamp)
  const dis = disambiguator(spec)
  const method = sanitizeMethod(spec.method)
  const slug = slugifyPath(spec.pathRaw)

  const prefix = `${ts}-${dis}-${method}-` // everything before the slug
  const full = `${prefix}${slug}${FILENAME_EXT}`
  if (full.length <= FILENAME_CAP) return full

  // Need to truncate. Reserve room for `-<hash4>.http`.
  const truncSuffix = `-${hash4(spec.pathRaw)}${FILENAME_EXT}`
  const room = FILENAME_CAP - prefix.length - truncSuffix.length
  const safeRoom = Math.max(1, room)
  const truncatedSlug = slug.slice(0, safeRoom).replace(/_+$/, '') || slug.slice(0, safeRoom) || 'x'
  return `${prefix}${truncatedSlug}${truncSuffix}`
}
