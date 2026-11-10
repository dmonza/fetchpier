import { describe, expect, it } from 'vitest'
import { generateExampleFromJsonSchema, prettyJson } from './example-generator'
import {
  MAX_REF_HOPS,
  TOO_DEEP_MARKER,
  circularMarker,
  createRefResolver,
  notFoundMarker
} from './ref-resolver'

/** A ref-aware generation context over `schemas` (addressed as `#/s/<name>`). */
function withRefs(schemas: Record<string, unknown>): {
  gen: (schema: unknown) => unknown
  warnings: () => ReturnType<ReturnType<typeof createRefResolver>['warnings']>
} {
  const resolver = createRefResolver({ s: schemas })
  const refs = { resolve: (node: unknown) => resolver.resolve(node, 'POST /x') }
  return {
    gen: (schema) => generateExampleFromJsonSchema(schema as never, 0, refs),
    warnings: () => resolver.warnings()
  }
}

const ref = (name: string): { $ref: string } => ({ $ref: `#/s/${name}` })

describe('generateExampleFromJsonSchema with references', () => {
  it('resolves a reference and ignores its sibling members (§6.4)', () => {
    const { gen, warnings } = withRefs({
      User: { type: 'object', properties: { id: { type: 'integer' } } }
    })
    expect(gen({ ...ref('User'), example: { id: 99 }, description: 'x' })).toEqual({ id: 0 })
    expect(warnings()).toEqual([])
  })

  it('a hop does not consume generation depth (parity with inlined schemas)', () => {
    const { gen } = withRefs({ A: ref('B'), B: ref('C'), C: { type: 'boolean' } })
    expect(gen(ref('A'))).toBe(false)
  })

  it('CA-09 direct recursion yields the circular marker at the recursion point', () => {
    const { gen, warnings } = withRefs({
      Node: {
        type: 'object',
        properties: { name: { type: 'string' }, child: ref('Node') }
      }
    })
    expect(gen(ref('Node'))).toEqual({ name: 'string', child: circularMarker('#/s/Node') })
    expect(warnings()).toEqual([])
  })

  // Rows mirror the requirement's §9.3-C table (CA-10).
  it('C01 indirect recursion A → B → A', () => {
    const { gen } = withRefs({
      A: { type: 'object', properties: { b: ref('B') } },
      B: { type: 'object', properties: { a: ref('A') } }
    })
    expect(gen(ref('A'))).toEqual({ b: { a: circularMarker('#/s/A') } })
  })

  it('C02 recursion through array items', () => {
    const { gen } = withRefs({
      Tree: { type: 'object', properties: { children: { type: 'array', items: ref('Tree') } } }
    })
    expect(gen(ref('Tree'))).toEqual({ children: [circularMarker('#/s/Tree')] })
  })

  it('C03 recursion through allOf', () => {
    const { gen } = withRefs({
      Base: { type: 'object', properties: { name: { type: 'string' } } },
      Pet: { allOf: [ref('Base'), { type: 'object', properties: { parent: ref('Pet') } }] }
    })
    expect(gen(ref('Pet'))).toEqual({ name: 'string', parent: circularMarker('#/s/Pet') })
  })

  it('C04 recursion through the oneOf member used for generation', () => {
    const { gen } = withRefs({ Expr: { oneOf: [ref('Expr'), { type: 'string' }] } })
    expect(gen(ref('Expr'))).toBe(circularMarker('#/s/Expr'))
  })

  it('C05 additionalProperties is not expanded (unchanged)', () => {
    const { gen } = withRefs({ Map: { type: 'object', additionalProperties: ref('Map') } })
    expect(gen(ref('Map'))).toEqual({})
  })

  it('C06 recursion closing deeper than the depth cap keeps the depth-capped output', () => {
    const levels: Record<string, unknown> = {}
    for (let i = 0; i < 8; i++) {
      levels[`L${i}`] = { type: 'object', properties: { n: ref(i < 7 ? `L${i + 1}` : 'L0') } }
    }
    const { gen } = withRefs(levels)
    let expected: unknown = null
    for (let i = 0; i < 7; i++) expected = { n: expected }
    expect(gen(ref('L0'))).toEqual(expected)
  })

  it('C07 independent recursions each name their own reference', () => {
    const { gen } = withRefs({
      Node: { type: 'object', properties: { next: ref('Node') } },
      Tree: { type: 'object', properties: { kids: { type: 'array', items: ref('Tree') } } }
    })
    expect(gen({ type: 'object', properties: { list: ref('Node'), tree: ref('Tree') } })).toEqual({
      list: { next: circularMarker('#/s/Node') },
      tree: { kids: [circularMarker('#/s/Tree')] }
    })
  })

  it('recursion that closes on a chain member names that member', () => {
    const { gen } = withRefs({
      A: ref('B'),
      B: { type: 'object', properties: { back: ref('A') } }
    })
    expect(gen(ref('A'))).toEqual({ back: circularMarker('#/s/A') })
  })

  it('CA-11 the same reference in sibling branches is expanded in each', () => {
    const { gen } = withRefs({
      Address: { type: 'object', properties: { street: { type: 'string' } } },
      Order: { type: 'object', properties: { billing: ref('Address'), shipping: ref('Address') } }
    })
    expect(gen(ref('Order'))).toEqual({
      billing: { street: 'string' },
      shipping: { street: 'string' }
    })
  })

  it('an unresolvable reference yields the not-found marker and a warning', () => {
    const { gen, warnings } = withRefs({
      Owner: { type: 'object', properties: { pet: ref('Missing') } }
    })
    expect(gen(ref('Owner'))).toEqual({ pet: notFoundMarker('#/s/Missing') })
    expect(warnings()).toHaveLength(1)
  })

  it('CA-17 a broken link inside a chain names the failing reference', () => {
    const { gen } = withRefs({ A: ref('Missing') })
    expect(gen(ref('A'))).toBe(notFoundMarker('#/s/Missing'))
  })

  it('an external reference yields the not-found marker', () => {
    const { gen } = withRefs({})
    expect(gen({ $ref: './common.yaml#/Ok' })).toBe(notFoundMarker('./common.yaml#/Ok'))
  })

  it('CA-18 a pure reference loop yields the not-found marker', () => {
    const { gen, warnings } = withRefs({ X: ref('X') })
    expect(gen(ref('X'))).toBe(notFoundMarker('#/s/X'))
    expect(warnings()[0].message).toContain('circular reference chain')
  })

  it('CA-08 more than 30 hops yields the too-deep marker without a warning', () => {
    const schemas: Record<string, unknown> = { T: { type: 'boolean' } }
    for (let i = 1; i <= MAX_REF_HOPS; i++)
      schemas[`h${i}`] = ref(i < MAX_REF_HOPS ? `h${i + 1}` : 'T')
    const { gen, warnings } = withRefs(schemas)
    expect(gen(ref('h1'))).toBe(TOO_DEEP_MARKER)
    expect(gen(ref('h2'))).toBe(false)
    expect(warnings()).toEqual([])
  })

  it('CA-21 literal example / default / enum data is copied verbatim, never resolved', () => {
    const { gen, warnings } = withRefs({})
    const literal = { $ref: '#/s/Missing' }
    expect(gen({ type: 'object', example: literal })).toEqual(literal)
    expect(gen({ type: 'object', default: literal })).toEqual(literal)
    expect(gen({ enum: [literal] })).toEqual(literal)
    expect(gen({ const: literal })).toEqual({})
    expect(warnings()).toEqual([])
  })

  it('CA-22 a property named $ref is a property, and a non-string $ref is plain data', () => {
    const { gen, warnings } = withRefs({})
    expect(
      gen({ type: 'object', properties: { $ref: { type: 'string' }, ok: { type: 'boolean' } } })
    ).toEqual({ $ref: 'string', ok: false })
    expect(gen({ $ref: 42, type: 'integer' })).toBe(0)
    expect(gen({ $ref: null, type: 'string' })).toBe('string')
    expect(warnings()).toEqual([])
  })

  it('without a refs context, a reference is treated exactly as before', () => {
    expect(generateExampleFromJsonSchema({ $ref: '#/s/User' })).toEqual({})
  })

  it('CA-31 a fan-out document stays bounded and fast', () => {
    const schemas: Record<string, unknown> = { L20: { type: 'string' } }
    for (let i = 0; i < 20; i++) {
      schemas[`L${i}`] = {
        type: 'object',
        properties: { left: ref(`L${i + 1}`), right: ref(`L${i + 1}`) }
      }
    }
    const { gen } = withRefs(schemas)
    const start = performance.now()
    let body: unknown
    for (let op = 0; op < 500; op++) body = gen(ref('L0'))
    expect(performance.now() - start).toBeLessThan(2000)
    // Depth cap 6: L0..L6 are objects, L7 is cut to null → 2^7 leaves.
    expect(JSON.stringify(body).match(/null/g)).toHaveLength(2 ** 7)
  })
})

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
