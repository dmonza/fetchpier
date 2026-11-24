const SAFE_CLONE_MAX_DEPTH = 3

export interface SafeCloneOptions {
  /**
   * Rewrites an Error's `stack` before it is kept (the sandbox reduces it to the
   * script's own frames). Without it the stack is kept as it is.
   */
  stack?: (stack: string) => string
}

/**
 * Depth-limited, cycle-safe structural clone used to snapshot values logged
 * from the `fp` sandbox before they cross back into host code. Functions become
 * `{ __inspect: 'fn' }`, cycles become `{ __inspect: 'circular' }`, and anything
 * past {@link SAFE_CLONE_MAX_DEPTH} is truncated. Values whose data is not in
 * enumerable properties become plain data: an Error is `{ name, message, stack }`
 * plus its enumerable own properties, a Date its ISO string (`'Invalid Date'`
 * when invalid), a Map an array of `[key, value]` entries, a Set an array of its
 * values. Detection works across realms (sandbox values come from the vm realm).
 * Keeps log payloads small and serialisable without holding references to live
 * sandbox objects.
 */
export function safeClone(value: unknown, options: SafeCloneOptions = {}): unknown {
  return cloneAt(value, 0, new WeakSet<object>(), options)
}

/** The ISO string of a Date (any realm), or undefined when `obj` is not a Date. */
function dateString(obj: object): string | undefined {
  let time: number
  try {
    // Brand check on the internal slot: throws for anything but a Date.
    time = Date.prototype.getTime.call(obj)
  } catch {
    return undefined
  }
  return Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString()
}

function isMap(obj: object): obj is Map<unknown, unknown> {
  try {
    Map.prototype.has.call(obj, undefined)
    return true
  } catch {
    return false
  }
}

function isSet(obj: object): obj is Set<unknown> {
  try {
    Set.prototype.has.call(obj, undefined)
    return true
  } catch {
    return false
  }
}

// JS has no brand check for errors on every supported runtime; the tag is set
// from the internal slot for errors of any realm.
function isError(obj: object): boolean {
  return Object.prototype.toString.call(obj) === '[object Error]'
}

function readString(obj: object, key: string): string | undefined {
  try {
    const v = (obj as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

function cloneAt(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  options: SafeCloneOptions
): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return value
  if (t === 'function') {
    const fn = value as { name?: string }
    return { __inspect: 'fn', name: fn.name || '(anonymous)' }
  }
  if (t === 'object') {
    const obj = value as object
    // A Date is a leaf, like a primitive: no depth or cycle bookkeeping.
    const date = dateString(obj)
    if (date !== undefined) return date
    if (seen.has(obj)) return { __inspect: 'circular' }
    seen.add(obj)
    if (Array.isArray(obj)) {
      if (depth >= SAFE_CLONE_MAX_DEPTH) {
        seen.delete(obj)
        return { __inspect: 'truncated', kind: 'array' }
      }
      // `Array.prototype.map.call`, not `obj.map`: an array-like proxy such as
      // the sandbox's multipart parts collection passes `Array.isArray` yet
      // exposes no Array methods. `map` also keeps the holes of a sparse array,
      // where an index loop would allocate every slot in host code.
      const result: unknown[] = Array.prototype.map.call(obj, (item: unknown) =>
        cloneAt(item, depth + 1, seen, options)
      )
      seen.delete(obj)
      return result
    }
    // Host prototype methods read the internal slots, so they work on a Map or
    // Set of the vm realm and ignore anything the script overrode on it.
    if (isMap(obj) || isSet(obj)) {
      if (depth >= SAFE_CLONE_MAX_DEPTH) {
        seen.delete(obj)
        return { __inspect: 'truncated', kind: 'array' }
      }
      const result: unknown[] = []
      if (isMap(obj)) {
        // Keys and values sit one level down, like an object's values.
        for (const [k, v] of Map.prototype.entries.call(obj)) {
          result.push([cloneAt(k, depth + 1, seen, options), cloneAt(v, depth + 1, seen, options)])
        }
      } else {
        for (const v of Set.prototype.values.call(obj)) {
          result.push(cloneAt(v, depth + 1, seen, options))
        }
      }
      seen.delete(obj)
      return result
    }
    if (depth >= SAFE_CLONE_MAX_DEPTH) {
      seen.delete(obj)
      return { __inspect: 'truncated', kind: 'object' }
    }
    const result: Record<string, unknown> = {}
    const error = isError(obj)
    if (error) {
      result.name = readString(obj, 'name') ?? 'Error'
      result.message = readString(obj, 'message') ?? ''
      const stack = readString(obj, 'stack')
      if (stack !== undefined) result.stack = options.stack ? options.stack(stack) : stack
    }
    for (const [k, v] of Object.entries(obj)) {
      // An error's own enumerable `name`, `message` or `stack` never bypasses
      // the values read above (nor the stack filter).
      if (error && (k === 'name' || k === 'message' || k === 'stack')) continue
      result[k] = cloneAt(v, depth + 1, seen, options)
    }
    seen.delete(obj)
    return result
  }
  return String(value)
}
