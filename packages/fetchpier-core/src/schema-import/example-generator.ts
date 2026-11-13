type JsonSchema = {
  type?: string | string[]
  format?: string
  enum?: unknown[]
  example?: unknown
  default?: unknown
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema | JsonSchema[]
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  allOf?: JsonSchema[]
  [k: string]: unknown
}

import {
  TOO_DEEP_MARKER,
  circularMarker,
  isReference,
  notFoundMarker,
  type RefResult
} from './ref-resolver'

const MAX_DEPTH = 6

/**
 * Reference handling for generation. `resolve` follows a `$ref` (recording
 * unresolvable ones against the caller's location); `ancestors` are the
 * references being expanded on the current branch — meeting one of them again
 * is recursion and yields the circular marker instead of expanding further.
 */
export interface ExampleRefContext {
  resolve: (node: unknown) => RefResult
  ancestors?: readonly string[]
}

function pickType(schema: JsonSchema): string | undefined {
  const t = schema.type
  if (Array.isArray(t)) return t.find((x) => x !== 'null') ?? t[0]
  return t
}

/**
 * Example value for a JSON Schema. Without `refs`, a `$ref` is an ordinary
 * member (the schema is used as written). With `refs`, a reference is replaced
 * by its target — sibling members ignored, no depth consumed by the hop — and
 * unresolvable / recursive / too-deep references become marker strings.
 */
export function generateExampleFromJsonSchema(
  schema: JsonSchema | undefined,
  depth = 0,
  refs?: ExampleRefContext
): unknown {
  if (!schema || typeof schema !== 'object') return null
  if (depth > MAX_DEPTH) return null

  if (refs && isReference(schema)) {
    const ancestors = refs.ancestors ?? []
    if (ancestors.includes(schema.$ref)) return circularMarker(schema.$ref)
    const result = refs.resolve(schema)
    if (result.status === 'unresolved') return notFoundMarker(result.ref)
    if (result.status === 'too-deep') return TOO_DEEP_MARKER
    const recurring = result.chain.find((r) => ancestors.includes(r))
    if (recurring) return circularMarker(recurring)
    // The hop itself consumes no depth: a referenced schema generates exactly as if inlined.
    return generateExampleFromJsonSchema(result.value as JsonSchema, depth, {
      resolve: refs.resolve,
      ancestors: [...ancestors, ...result.chain]
    })
  }
  return generateFromSchema(schema, depth, refs)
}

function generateFromSchema(schema: JsonSchema, depth: number, refs?: ExampleRefContext): unknown {
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]

  if (schema.allOf && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {}
    for (const sub of schema.allOf) {
      const value = generateExampleFromJsonSchema(sub, depth + 1, refs)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(merged, value)
      }
    }
    if (Object.keys(merged).length > 0) {
      // The schema's own `properties` beside `allOf` are part of the same
      // constraints (`allOf: [Base]` + properties ≡ `allOf: [Base, {properties}]`).
      return Object.assign(merged, generateProperties(schema, depth, refs))
    }
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return generateExampleFromJsonSchema(schema.oneOf[0], depth + 1, refs)
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return generateExampleFromJsonSchema(schema.anyOf[0], depth + 1, refs)
  }

  const type = pickType(schema)

  switch (type) {
    case 'string': {
      switch (schema.format) {
        case 'date-time':
          return '2026-01-01T00:00:00Z'
        case 'date':
          return '2026-01-01'
        case 'email':
          return 'user@example.com'
        case 'uuid':
          return '00000000-0000-0000-0000-000000000000'
        case 'uri':
        case 'url':
          return 'https://example.com'
        default:
          return 'string'
      }
    }
    case 'integer':
      return 0
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'null':
      return null
    case 'array': {
      const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
      const example = generateExampleFromJsonSchema(items, depth + 1, refs)
      return example === null ? [] : [example]
    }
    case 'object':
    case undefined:
      return generateProperties(schema, depth, refs)
    default:
      return null
  }
}

/** One example value per entry of the schema's own `properties`. */
function generateProperties(
  schema: JsonSchema,
  depth: number,
  refs?: ExampleRefContext
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      out[key] = generateExampleFromJsonSchema(sub, depth + 1, refs)
    }
  }
  return out
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return 'null'
  }
}
