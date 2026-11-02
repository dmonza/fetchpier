const SAFE_CLONE_MAX_DEPTH = 3

/**
 * Depth-limited, cycle-safe structural clone used to snapshot values logged
 * from the `fp` sandbox before they cross back into host code. Functions become
 * `{ __inspect: 'fn' }`, cycles become `{ __inspect: 'circular' }`, and anything
 * past {@link SAFE_CLONE_MAX_DEPTH} is truncated. Keeps log payloads small and
 * serialisable without holding references to live sandbox objects.
 */
export function safeClone(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return value
  if (t === 'function') {
    const fn = value as { name?: string }
    return { __inspect: 'fn', name: fn.name || '(anonymous)' }
  }
  if (t === 'object') {
    const obj = value as object
    if (seen.has(obj)) return { __inspect: 'circular' }
    seen.add(obj)
    if (Array.isArray(obj)) {
      if (depth >= SAFE_CLONE_MAX_DEPTH) {
        seen.delete(obj)
        return { __inspect: 'truncated', kind: 'array' }
      }
      const result = obj.map((item) => safeClone(item, depth + 1, seen))
      seen.delete(obj)
      return result
    }
    if (depth >= SAFE_CLONE_MAX_DEPTH) {
      seen.delete(obj)
      return { __inspect: 'truncated', kind: 'object' }
    }
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      result[k] = safeClone(v, depth + 1, seen)
    }
    seen.delete(obj)
    return result
  }
  return String(value)
}
