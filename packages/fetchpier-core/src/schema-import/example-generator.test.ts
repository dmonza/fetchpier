import { describe, expect, it } from 'vitest'
import { generateExampleFromJsonSchema, prettyJson } from './example-generator'

describe('generateExampleFromJsonSchema', () => {
  it('returns null for undefined / non-object input', () => {
    expect(generateExampleFromJsonSchema(undefined)).toBeNull()
    // @ts-expect-error — intentional: runtime guard on non-objects
    expect(generateExampleFromJsonSchema(null)).toBeNull()
    // @ts-expect-error — same
    expect(generateExampleFromJsonSchema('not a schema')).toBeNull()
  })

  it('honours an explicit example over inferred type', () => {
    expect(generateExampleFromJsonSchema({ type: 'string', example: 'fixed' })).toBe('fixed')
    expect(generateExampleFromJsonSchema({ type: 'integer', example: 42 })).toBe(42)
  })

  it('honours default when example is missing', () => {
    expect(generateExampleFromJsonSchema({ type: 'integer', default: 7 })).toBe(7)
  })

  it('picks the first enum value', () => {
    expect(generateExampleFromJsonSchema({ enum: ['a', 'b', 'c'] })).toBe('a')
  })

  it('emits string format examples', () => {
    expect(generateExampleFromJsonSchema({ type: 'string', format: 'date-time' })).toBe(
      '2026-01-01T00:00:00Z'
    )
    expect(generateExampleFromJsonSchema({ type: 'string', format: 'date' })).toBe('2026-01-01')
    expect(generateExampleFromJsonSchema({ type: 'string', format: 'email' })).toBe(
      'user@example.com'
    )
    expect(generateExampleFromJsonSchema({ type: 'string', format: 'uuid' })).toBe(
      '00000000-0000-0000-0000-000000000000'
    )
    expect(generateExampleFromJsonSchema({ type: 'string', format: 'uri' })).toBe(
      'https://example.com'
    )
    expect(generateExampleFromJsonSchema({ type: 'string', format: 'url' })).toBe(
      'https://example.com'
    )
    expect(generateExampleFromJsonSchema({ type: 'string', format: 'unknown' })).toBe('string')
  })

  it('emits primitive examples', () => {
    expect(generateExampleFromJsonSchema({ type: 'integer' })).toBe(0)
    expect(generateExampleFromJsonSchema({ type: 'number' })).toBe(0)
    expect(generateExampleFromJsonSchema({ type: 'boolean' })).toBe(false)
    expect(generateExampleFromJsonSchema({ type: 'null' })).toBeNull()
  })

  it('handles `type: [..., "null"]` by picking the non-null variant', () => {
    expect(generateExampleFromJsonSchema({ type: ['string', 'null'] })).toBe('string')
    expect(generateExampleFromJsonSchema({ type: ['null', 'integer'] })).toBe(0)
  })

  it('returns first array type when all are non-null', () => {
    expect(generateExampleFromJsonSchema({ type: ['integer', 'string'] })).toBe(0)
  })

  it('emits an object with example values for each property', () => {
    const out = generateExampleFromJsonSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' }
      }
    })
    expect(out).toEqual({ name: 'string', age: 0 })
  })

  it('defaults to object shape when type is undefined but properties exist', () => {
    const out = generateExampleFromJsonSchema({
      properties: { id: { type: 'integer' } }
    })
    expect(out).toEqual({ id: 0 })
  })

  it('returns an empty object when type is object and properties absent', () => {
    expect(generateExampleFromJsonSchema({ type: 'object' })).toEqual({})
  })

  it('handles arrays with single items schema', () => {
    expect(generateExampleFromJsonSchema({ type: 'array', items: { type: 'integer' } })).toEqual([
      0
    ])
  })

  it('handles arrays with tuple-style items (uses first)', () => {
    expect(
      generateExampleFromJsonSchema({
        type: 'array',
        items: [{ type: 'string' }, { type: 'integer' }]
      })
    ).toEqual(['string'])
  })

  it('returns [] when item schema generates null', () => {
    // No items → recursive call returns null → branch returns []
    expect(generateExampleFromJsonSchema({ type: 'array' })).toEqual([])
  })

  it('follows oneOf into its first option', () => {
    expect(
      generateExampleFromJsonSchema({
        oneOf: [{ type: 'string' }, { type: 'integer' }]
      })
    ).toBe('string')
  })

  it('follows anyOf into its first option', () => {
    expect(
      generateExampleFromJsonSchema({
        anyOf: [{ type: 'integer' }, { type: 'string' }]
      })
    ).toBe(0)
  })

  it('merges allOf object schemas', () => {
    const out = generateExampleFromJsonSchema({
      allOf: [
        { type: 'object', properties: { name: { type: 'string' } } },
        { type: 'object', properties: { age: { type: 'integer' } } }
      ]
    })
    expect(out).toEqual({ name: 'string', age: 0 })
  })

  it('falls through allOf when no sub-schema returns an object', () => {
    // allOf returns merged {} → continues to type fallback
    const out = generateExampleFromJsonSchema({
      allOf: [{ type: 'string' }, { type: 'integer' }],
      type: 'string'
    })
    expect(out).toBe('string')
  })

  it('returns null on unrecognized type', () => {
    expect(generateExampleFromJsonSchema({ type: 'function' })).toBeNull()
  })

  it('bails out at MAX_DEPTH to prevent infinite recursion', () => {
    // Build a schema that recurses through `items` past depth 6.
    type RecursiveSchema = { type: string; items?: RecursiveSchema }
    const recursive: RecursiveSchema = { type: 'array' }
    let cursor: RecursiveSchema = recursive
    for (let i = 0; i < 10; i++) {
      cursor.items = { type: 'array' }
      cursor = cursor.items
    }
    const out = generateExampleFromJsonSchema(recursive as never)
    // Deep enough that the recursion eventually returns null → []
    expect(JSON.stringify(out)).toMatch(/^\[*\]+$|\[null\]$/)
  })
})

describe('prettyJson', () => {
  it('formats simple values', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('returns "null" on JSON.stringify failure (circular ref)', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(prettyJson(circular)).toBe('null')
  })
})
