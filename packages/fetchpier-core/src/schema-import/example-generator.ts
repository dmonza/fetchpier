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

const MAX_DEPTH = 6

function pickType(schema: JsonSchema): string | undefined {
  const t = schema.type
  if (Array.isArray(t)) return t.find((x) => x !== 'null') ?? t[0]
  return t
}

export function generateExampleFromJsonSchema(schema: JsonSchema | undefined, depth = 0): unknown {
  if (!schema || typeof schema !== 'object') return null
  if (depth > MAX_DEPTH) return null

  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]

  if (schema.allOf && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {}
    for (const sub of schema.allOf) {
      const value = generateExampleFromJsonSchema(sub, depth + 1)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(merged, value)
      }
    }
    if (Object.keys(merged).length > 0) return merged
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return generateExampleFromJsonSchema(schema.oneOf[0], depth + 1)
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return generateExampleFromJsonSchema(schema.anyOf[0], depth + 1)
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
      const example = generateExampleFromJsonSchema(items, depth + 1)
      return example === null ? [] : [example]
    }
    case 'object':
    case undefined: {
      const out: Record<string, unknown> = {}
      if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          out[key] = generateExampleFromJsonSchema(sub, depth + 1)
        }
      }
      return out
    }
    default:
      return null
  }
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return 'null'
  }
}
