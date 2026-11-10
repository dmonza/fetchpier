/**
 * On-demand `$ref` resolution for the OpenAPI / Swagger importer.
 *
 * Written from JSON Pointer (RFC 6901), URI fragment encoding (RFC 3986 §3.5)
 * and the OpenAPI specifications; behavior is defined by the requirement
 * "In-house OpenAPI reference resolution" (see docs/SYSTEM.md, schema import).
 *
 * - Only same-document references (`#…`) are resolved. Anything else is
 *   external and is never read: this module imports no filesystem or network
 *   API, on purpose.
 * - Resolution is on demand: callers resolve exactly what they read, so a
 *   broken reference nobody needs is never noticed.
 * - Every unresolvable reference is recorded against the place that needed it,
 *   and `warnings()` turns them into one warning per distinct reference text.
 */
import type { SchemaImportWarning } from '@shared/types'

/** Consecutive reference hops followed before a chain is cut as too deep. */
export const MAX_REF_HOPS = 30

/** Upper bound on `unresolved-ref` warnings, the last slot becoming an overflow entry. */
export const MAX_UNRESOLVED_REF_WARNINGS = 1000

export const TOO_DEEP_MARKER = '<Error: Too many levels of nesting to fake this schema>'

export function notFoundMarker(ref: string): string {
  return `reference ${ref} not found in the OpenAPI spec`
}

export function circularMarker(ref: string): string {
  return `<Circular reference to ${ref} detected>`
}

export type UnresolvedReason = 'not-found' | 'external' | 'circular-chain'

export type RefResult =
  /** `chain` lists every reference followed to reach `value` (empty when the node was not a reference). */
  | { status: 'value'; value: unknown; chain: readonly string[] }
  | { status: 'unresolved'; ref: string; reason: UnresolvedReason }
  /** More than `MAX_REF_HOPS` consecutive hops; `ref` is the first reference of the chain. */
  | { status: 'too-deep'; ref: string }

type PointerResult = { found: true; value: unknown } | { found: false }

const NOT_FOUND: PointerResult = { found: false }
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/

export function isReference(node: unknown): node is { $ref: string } {
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    Object.prototype.hasOwnProperty.call(node, '$ref') &&
    typeof (node as { $ref: unknown }).$ref === 'string'
  )
}

/**
 * Evaluate a same-document reference (`#` + JSON Pointer) against the raw
 * document. The fragment is percent-decoded first, then each segment is
 * unescaped (`~1` → `/`, then `~0` → `~`). Lookups are own-property only, array
 * indexes must be canonical decimals in range, and an intermediate `$ref` is
 * never followed — the pointer addresses the document as written.
 */
export function evaluateInternalRef(doc: unknown, ref: string): PointerResult {
  if (!ref.startsWith('#')) return NOT_FOUND
  let pointer: string
  try {
    pointer = decodeURIComponent(ref.slice(1))
  } catch {
    return NOT_FOUND
  }
  if (pointer === '') return { found: true, value: doc }
  if (!pointer.startsWith('/')) return NOT_FOUND

  let node: unknown = doc
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX.test(segment)) return NOT_FOUND
      const index = Number(segment)
      if (index >= node.length) return NOT_FOUND
      node = node[index]
      continue
    }
    if (typeof node !== 'object' || node === null) return NOT_FOUND
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return NOT_FOUND
    node = (node as Record<string, unknown>)[segment]
  }
  return { found: true, value: node }
}

/** JSON Pointer location of a path item, used for references needed outside an operation. */
export function pathItemLocation(pathKey: string): string {
  return `#/paths/${pathKey.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

const REASON_TEXT: Record<UnresolvedReason | 'too-deep', string> = {
  'not-found': 'not found in the document',
  external: 'external references are not resolved',
  'circular-chain': 'circular reference chain',
  'too-deep': 'reference chain too long'
}

interface Unresolved {
  reason: UnresolvedReason | 'too-deep'
  location: string
  count: number
}

export interface RefResolver {
  /**
   * Follow `node` if it is a reference. Unresolvable results are recorded
   * against `location`; a too-deep chain is not (in a value position it becomes
   * a marker, which already makes it visible).
   */
  resolve(node: unknown, location: string): RefResult
  /**
   * Resolve an object read in a structural position (parameter, body, path
   * item, security scheme…). Returns the target — or `node` itself when it is
   * not a reference — and `undefined` when it cannot be resolved, in which case
   * the object is absent and the problem (too-deep included) is recorded.
   */
  resolveObject(node: unknown, location: string): unknown
  /** One `unresolved-ref` warning per distinct reference text, in encounter order. */
  warnings(): SchemaImportWarning[]
}

export function createRefResolver(doc: unknown): RefResolver {
  const pointerCache = new Map<string, PointerResult>()
  const unresolved = new Map<string, Unresolved>()

  function lookup(ref: string): PointerResult {
    let hit = pointerCache.get(ref)
    if (!hit) {
      hit = evaluateInternalRef(doc, ref)
      pointerCache.set(ref, hit)
    }
    return hit
  }

  function record(ref: string, reason: Unresolved['reason'], location: string): void {
    const entry = unresolved.get(ref)
    if (entry) entry.count++
    else unresolved.set(ref, { reason, location, count: 1 })
  }

  function resolve(node: unknown, location: string): RefResult {
    if (!isReference(node)) return { status: 'value', value: node, chain: [] }

    const chain: string[] = []
    let current: unknown = node
    while (isReference(current)) {
      const ref = current.$ref
      if (chain.includes(ref)) {
        record(ref, 'circular-chain', location)
        return { status: 'unresolved', ref, reason: 'circular-chain' }
      }
      if (chain.length === MAX_REF_HOPS) return { status: 'too-deep', ref: chain[0] }
      chain.push(ref)
      if (!ref.startsWith('#')) {
        record(ref, 'external', location)
        return { status: 'unresolved', ref, reason: 'external' }
      }
      const hit = lookup(ref)
      if (!hit.found) {
        record(ref, 'not-found', location)
        return { status: 'unresolved', ref, reason: 'not-found' }
      }
      current = hit.value
    }
    return { status: 'value', value: current, chain }
  }

  function resolveObject(node: unknown, location: string): unknown {
    const result = resolve(node, location)
    if (result.status === 'value') return result.value
    if (result.status === 'too-deep') record(result.ref, 'too-deep', location)
    return undefined
  }

  function warnings(): SchemaImportWarning[] {
    const entries = [...unresolved.entries()]
    const overflow = entries.length > MAX_UNRESOLVED_REF_WARNINGS
    const listed = overflow ? entries.slice(0, MAX_UNRESOLVED_REF_WARNINGS - 1) : entries
    const out: SchemaImportWarning[] = listed.map(([ref, { reason, location, count }]) => ({
      kind: 'unresolved-ref',
      message: `${ref} — ${REASON_TEXT[reason]}${count > 1 ? ` (used in ${count} places)` : ''}`,
      location
    }))
    if (overflow) {
      out.push({
        kind: 'unresolved-ref',
        message: `${entries.length - listed.length} more unresolved references not listed`
      })
    }
    return out
  }

  return { resolve, resolveObject, warnings }
}
