import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  MAX_REF_HOPS,
  MAX_UNRESOLVED_REF_WARNINGS,
  createRefResolver,
  evaluateInternalRef,
  isReference,
  pathItemLocation
} from './ref-resolver'

const user = { type: 'object', properties: { id: { type: 'integer' } } }

const doc = {
  openapi: '3.0.0',
  info: { title: 't', version: '1.2.3' },
  paths: {
    '/users': {
      get: {
        parameters: [
          { name: 'a', in: 'query' },
          { name: 'b', in: 'query' }
        ]
      }
    }
  },
  'x-shared': { headers: { Trace: { type: 'string' } } },
  components: {
    schemas: {
      User: user,
      'a/b': { title: 'slash' },
      'a~b': { title: 'tilde' },
      'a~1': { title: 'tilde-one' },
      'a/': { title: 'slash-trailing' },
      'My Thing': { title: 'space' },
      '✓': { title: 'unicode' },
      '': { title: 'empty-key' },
      Alias: { $ref: '#/components/schemas/User' },
      Anchored: { $anchor: 'someAnchor', type: 'string' }
    }
  }
}

describe('evaluateInternalRef — JSON Pointer syntax (CA-25, CA-28)', () => {
  // P-numbers mirror the requirement's §9.3-P table; X-rows are plan extensions (D10).
  it.each([
    ['P01', '#/components/schemas/User', user],
    ['P02', '#/components/schemas/a~1b', { title: 'slash' }],
    ['P03', '#/components/schemas/a~0b', { title: 'tilde' }],
    ['P04', '#/components/schemas/a~01', { title: 'tilde-one' }],
    ['P05', '#/components/schemas/My%20Thing', { title: 'space' }],
    ['P06', '#/components/schemas/%E2%9C%93', { title: 'unicode' }],
    ['P08', '#/components/schemas/User/properties/id', { type: 'integer' }],
    ['P09', '#/paths/~1users/get/parameters/0', { name: 'a', in: 'query' }],
    ['P13', '#/components/schemas/', { title: 'empty-key' }],
    ['P15', '#/components/schemas', doc.components.schemas],
    ['P16', '#/x-shared/headers/Trace', { type: 'string' }],
    ['root', '#', doc],
    ['non-object target', '#/info/version', '1.2.3'],
    ['X01 %2F is a segment separator', '#/components%2Fschemas%2FUser', user]
  ])('%s %s resolves', (_id, ref, expected) => {
    expect(evaluateInternalRef(doc, ref)).toEqual({ found: true, value: expected })
  })

  it.each([
    ['P07 malformed percent escape', '#/components/schemas/Bad%ZZ'],
    ['P10 leading-zero index', '#/paths/~1users/get/parameters/01'],
    ['P11 "-" index', '#/paths/~1users/get/parameters/-'],
    ['P12 out-of-range index', '#/paths/~1users/get/parameters/9'],
    ['P17 case-sensitive', '#/components/schemas/user'],
    ['P18 no trimming', '#/components/schemas/User '],
    ['P19 missing leaf', '#/components/schemas/User/properties/nope'],
    ['P26 anchors are unsupported', '#someAnchor'],
    ['X02 never follows an intermediate $ref', '#/components/schemas/Alias/properties/id'],
    ['X03 prototype key __proto__', '#/components/schemas/__proto__'],
    ['X04 prototype key constructor', '#/components/schemas/constructor'],
    ['X05 prototype key toString', '#/components/toString'],
    ['X06 descends into a string', '#/info/version/length'],
    ['X07 negative index', '#/paths/~1users/get/parameters/-1'],
    ['X08 non-numeric index', '#/paths/~1users/get/parameters/first']
  ])('%s (%s) is not found', (_id, ref) => {
    expect(evaluateInternalRef(doc, ref)).toEqual({ found: false })
  })

  it('P14 an empty trailing segment needs a "" key', () => {
    const noEmpty = { components: { schemas: { User: user } } }
    expect(evaluateInternalRef(noEmpty, '#/components/schemas/')).toEqual({ found: false })
  })
})

describe('isReference — what counts as a reference (§6.1)', () => {
  it('is an object whose own $ref is a string', () => {
    expect(isReference({ $ref: '#/a' })).toBe(true)
    expect(isReference({ $ref: '' })).toBe(true)
  })

  it.each([
    ['number', { $ref: 42 }],
    ['null', { $ref: null }],
    ['object', { $ref: {} }],
    ['array', { $ref: [] }],
    ['array node', [{ $ref: '#/a' }]],
    ['primitive', '#/a'],
    ['null node', null],
    ['inherited $ref', Object.create({ $ref: '#/a' })]
  ])('a %s $ref is not a reference', (_label, node) => {
    expect(isReference(node)).toBe(false)
  })
})

/** A chain of `hops` consecutive references ending in `{ type: 'boolean' }`. */
function chainDoc(hops: number): { doc: Record<string, unknown>; start: { $ref: string } } {
  const c: Record<string, unknown> = { target: { type: 'boolean' } }
  for (let i = 1; i < hops; i++) {
    c[`h${i}`] = { $ref: i + 1 < hops ? `#/c/h${i + 1}` : '#/c/target' }
  }
  const start = { $ref: hops === 1 ? '#/c/target' : '#/c/h1' }
  return { doc: { c }, start }
}

describe('createRefResolver().resolve — chains, loops, external refs', () => {
  it('returns a non-reference as-is with an empty chain', () => {
    const r = createRefResolver(doc)
    const node = { type: 'string' }
    expect(r.resolve(node, 'GET /x')).toEqual({ status: 'value', value: node, chain: [] })
    expect(r.warnings()).toEqual([])
  })

  it('follows a reference to a reference (chain)', () => {
    const r = createRefResolver(doc)
    expect(r.resolve({ $ref: '#/components/schemas/Alias' }, 'GET /x')).toEqual({
      status: 'value',
      value: user,
      chain: ['#/components/schemas/Alias', '#/components/schemas/User']
    })
  })

  it.each([1, 2, MAX_REF_HOPS])('CA-08 a chain of %i hops resolves', (hops) => {
    const { doc: d, start } = chainDoc(hops)
    const result = createRefResolver(d).resolve(start, 'GET /x')
    expect(result.status).toBe('value')
    expect(result.status === 'value' && result.value).toEqual({ type: 'boolean' })
    expect(result.status === 'value' && result.chain).toHaveLength(hops)
  })

  it('CA-08 the 31st hop is too deep, and too-deep is not a warning by itself', () => {
    const { doc: d, start } = chainDoc(MAX_REF_HOPS + 1)
    const r = createRefResolver(d)
    expect(r.resolve(start, 'GET /x')).toEqual({ status: 'too-deep', ref: start.$ref })
    expect(r.warnings()).toEqual([])
  })

  it('CA-18 a self loop is a circular chain', () => {
    const d = { s: { X: { $ref: '#/s/X' } } }
    expect(createRefResolver(d).resolve({ $ref: '#/s/X' }, 'GET /x')).toEqual({
      status: 'unresolved',
      ref: '#/s/X',
      reason: 'circular-chain'
    })
  })

  it('CA-18 a two-step loop is a circular chain naming the recurring ref', () => {
    const d = { s: { P: { $ref: '#/s/Q' }, Q: { $ref: '#/s/P' } } }
    expect(createRefResolver(d).resolve({ $ref: '#/s/P' }, 'GET /x')).toEqual({
      status: 'unresolved',
      ref: '#/s/P',
      reason: 'circular-chain'
    })
  })

  it('CA-17 a broken link inside a chain reports the failing reference', () => {
    const d = { s: { A: { $ref: '#/s/Missing' } } }
    expect(createRefResolver(d).resolve({ $ref: '#/s/A' }, 'GET /x')).toEqual({
      status: 'unresolved',
      ref: '#/s/Missing',
      reason: 'not-found'
    })
  })

  it.each([
    ['P20 empty string', ''],
    ['P21 no leading #', 'components/schemas/User'],
    ['P22 relative file', './common.yaml#/Ok'],
    ['P22 bare file', 'common.yaml'],
    ['P22 parent dir', '../x/y.json#/A'],
    ['P23 absolute posix path', '/abs/path.yaml#/X'],
    ['P23 windows path', 'C:\\specs\\x.yaml'],
    ['P24 file URI', 'file:///etc/hosts'],
    ['P25 https URL', 'https://api.example.com/s.yaml#/X'],
    ['P25 http URL', 'http://localhost:9200/s.json']
  ])('%s is external', (_id, ref) => {
    expect(createRefResolver(doc).resolve({ $ref: ref }, 'GET /x')).toEqual({
      status: 'unresolved',
      ref,
      reason: 'external'
    })
  })

  it('an external hop inside a chain is external', () => {
    const d = { s: { A: { $ref: './other.yaml#/B' } } }
    expect(createRefResolver(d).resolve({ $ref: '#/s/A' }, 'GET /x')).toEqual({
      status: 'unresolved',
      ref: './other.yaml#/B',
      reason: 'external'
    })
  })

  it('ignores sibling members of a reference (§6.4)', () => {
    const r = createRefResolver(doc)
    const result = r.resolve(
      { $ref: '#/components/schemas/User', description: 'override', example: { id: 99 } },
      'GET /x'
    )
    expect(result).toEqual({ status: 'value', value: user, chain: ['#/components/schemas/User'] })
  })
})

describe('createRefResolver().resolveObject — structural positions (§6.7)', () => {
  it('returns the target, or the node itself when it is not a reference', () => {
    const r = createRefResolver(doc)
    expect(r.resolveObject({ $ref: '#/components/schemas/User' }, 'GET /x')).toBe(user)
    const inline = { name: 'q', in: 'query' }
    expect(r.resolveObject(inline, 'GET /x')).toBe(inline)
  })

  it('returns undefined for an unresolvable reference and records it', () => {
    const r = createRefResolver(doc)
    expect(r.resolveObject({ $ref: '#/components/parameters/Nope' }, 'GET /x')).toBeUndefined()
    expect(r.warnings()).toEqual([
      {
        kind: 'unresolved-ref',
        message: '#/components/parameters/Nope — not found in the document',
        location: 'GET /x'
      }
    ])
  })

  it('D11 a too-deep chain in a structural position is absent and warned', () => {
    const { doc: d, start } = chainDoc(MAX_REF_HOPS + 1)
    const r = createRefResolver(d)
    expect(r.resolveObject(start, 'GET /x')).toBeUndefined()
    expect(r.warnings()).toEqual([
      {
        kind: 'unresolved-ref',
        message: `${start.$ref} — reference chain too long`,
        location: 'GET /x'
      }
    ])
  })
})

describe('createRefResolver().warnings — one per distinct reference (CA-13, CA-23)', () => {
  it('dedups by ref text, counts every place, keeps the first location and encounter order', () => {
    const r = createRefResolver(doc)
    r.resolve({ $ref: '#/components/schemas/Gone' }, 'GET /x')
    r.resolve({ $ref: '#/components/schemas/AlsoGone' }, 'GET /y')
    r.resolve({ $ref: '#/components/schemas/Gone' }, 'GET /y')
    r.resolve({ $ref: '#/components/schemas/Gone' }, 'GET /z')
    r.resolve({ $ref: 'https://api.example.com/x.yaml' }, 'GET /z')
    r.resolve({ $ref: '#/components/schemas/User' }, 'GET /z')
    expect(r.warnings()).toEqual([
      {
        kind: 'unresolved-ref',
        message: '#/components/schemas/Gone — not found in the document (used in 3 places)',
        location: 'GET /x'
      },
      {
        kind: 'unresolved-ref',
        message: '#/components/schemas/AlsoGone — not found in the document',
        location: 'GET /y'
      },
      {
        kind: 'unresolved-ref',
        message: 'https://api.example.com/x.yaml — external references are not resolved',
        location: 'GET /z'
      }
    ])
  })

  it('reports a circular chain with its reason', () => {
    const r = createRefResolver({ s: { X: { $ref: '#/s/X' } } })
    r.resolve({ $ref: '#/s/X' }, 'POST /loop')
    expect(r.warnings()).toEqual([
      {
        kind: 'unresolved-ref',
        message: '#/s/X — circular reference chain',
        location: 'POST /loop'
      }
    ])
  })

  function withDistinctMisses(n: number): ReturnType<typeof createRefResolver> {
    const r = createRefResolver(doc)
    for (let i = 0; i < n; i++) r.resolve({ $ref: `#/components/schemas/Miss${i}` }, `GET /${i}`)
    return r
  }

  it(`lists exactly ${MAX_UNRESOLVED_REF_WARNINGS} distinct refs without an overflow entry`, () => {
    const w = withDistinctMisses(MAX_UNRESOLVED_REF_WARNINGS).warnings()
    expect(w).toHaveLength(MAX_UNRESOLVED_REF_WARNINGS)
    expect(w[w.length - 1].message).toBe(
      `#/components/schemas/Miss${MAX_UNRESOLVED_REF_WARNINGS - 1} — not found in the document`
    )
  })

  it(`lists ${MAX_UNRESOLVED_REF_WARNINGS - 1} plus an overflow entry past the cap`, () => {
    const w = withDistinctMisses(MAX_UNRESOLVED_REF_WARNINGS + 1).warnings()
    expect(w).toHaveLength(MAX_UNRESOLVED_REF_WARNINGS)
    expect(w[MAX_UNRESOLVED_REF_WARNINGS - 2].message).toBe(
      `#/components/schemas/Miss${MAX_UNRESOLVED_REF_WARNINGS - 2} — not found in the document`
    )
    expect(w[MAX_UNRESOLVED_REF_WARNINGS - 1]).toEqual({
      kind: 'unresolved-ref',
      message: '2 more unresolved references not listed'
    })
  })
})

describe('pathItemLocation', () => {
  it('escapes the path key as a JSON Pointer', () => {
    expect(pathItemLocation('/v2/users/{id}')).toBe('#/paths/~1v2~1users~1{id}')
    expect(pathItemLocation('/a~b')).toBe('#/paths/~1a~0b')
  })
})

describe('no I/O (§6.9)', () => {
  it('the resolver module imports no filesystem or network module', () => {
    const source = readFileSync(path.join(__dirname, 'ref-resolver.ts'), 'utf8')
    expect(source).not.toMatch(
      /from ['"](node:)?(fs|fs\/promises|http|https|net|tls|dns|undici|child_process)['"]/
    )
    expect(source).not.toMatch(/require\(/)
  })
})
