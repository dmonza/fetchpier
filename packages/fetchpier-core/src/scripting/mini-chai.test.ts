import { describe, it, expect as vExpect } from 'vitest'
import { AssertionError, createExpect } from './mini-chai'

const expect = createExpect()

describe('mini-chai', () => {
  it('equals passes for identical primitives', () => {
    vExpect(() => expect(1).to.equal(1)).not.toThrow()
    vExpect(() => expect('a').to.equal('a')).not.toThrow()
  })

  it('equals fails for different primitives', () => {
    vExpect(() => expect(1).to.equal(2)).toThrow(AssertionError)
  })

  it('deepEqual handles nested structures', () => {
    vExpect(() =>
      expect({ a: [1, 2, { b: 3 }] }).to.deep.equal({ a: [1, 2, { b: 3 }] })
    ).not.toThrow()
    vExpect(() => expect({ a: [1, 2, { b: 3 }] }).to.eql({ a: [1, 2, { b: 4 }] })).toThrow(
      AssertionError
    )
  })

  it('exist detects null/undefined', () => {
    vExpect(() => expect({}).to.exist).not.toThrow()
    vExpect(() => expect(null).to.exist).toThrow(AssertionError)
    vExpect(() => expect(undefined).to.exist).toThrow(AssertionError)
  })

  it('a() checks type', () => {
    vExpect(() => expect('hi').to.be.a('string')).not.toThrow()
    vExpect(() => expect([]).to.be.an('array')).not.toThrow()
    vExpect(() => expect({}).to.be.an('array')).toThrow(AssertionError)
  })

  it('property with value', () => {
    vExpect(() => expect({ id: 42 }).to.have.property('id', 42)).not.toThrow()
    vExpect(() => expect({ id: 42 }).to.have.property('missing')).toThrow(AssertionError)
  })

  it('include works on string, array, object', () => {
    vExpect(() => expect('hello world').to.include('world')).not.toThrow()
    vExpect(() => expect([1, 2, 3]).to.include(2)).not.toThrow()
    vExpect(() => expect({ a: 1, b: 2 }).to.include({ a: 1 })).not.toThrow()
    vExpect(() => expect([1, 2]).to.include(3)).toThrow(AssertionError)
  })

  it('above / below', () => {
    vExpect(() => expect(10).to.be.above(5)).not.toThrow()
    vExpect(() => expect(5).to.be.below(10)).not.toThrow()
    vExpect(() => expect(5).to.be.above(10)).toThrow(AssertionError)
  })

  it('match regex', () => {
    vExpect(() => expect('abc123').to.match(/\d+/)).not.toThrow()
    vExpect(() => expect('abc').to.match(/\d+/)).toThrow(AssertionError)
  })

  it('negation with .not', () => {
    vExpect(() => expect(1).to.not.equal(2)).not.toThrow()
    vExpect(() => expect(1).to.not.equal(1)).toThrow(AssertionError)
  })

  it('true/false/null literals', () => {
    vExpect(() => expect(true).to.be.true).not.toThrow()
    vExpect(() => expect(false).to.be.false).not.toThrow()
    vExpect(() => expect(null).to.be.null).not.toThrow()
    vExpect(() => expect(undefined).to.be.undefined).not.toThrow()
    vExpect(() => expect(1).to.be.true).toThrow(AssertionError)
  })

  it('lengthOf', () => {
    vExpect(() => expect([1, 2, 3]).to.have.lengthOf(3)).not.toThrow()
    vExpect(() => expect('abc').to.have.lengthOf(3)).not.toThrow()
    vExpect(() => expect([1]).to.have.lengthOf(3)).toThrow(AssertionError)
  })

  // ── New REQ-30 assertions ────────────────────────────────────────────────

  it('satisfy — passes when predicate returns truthy', () => {
    vExpect(() => expect(10).to.satisfy((n) => (n as number) > 5)).not.toThrow()
  })

  it('satisfy — fails when predicate returns falsy', () => {
    vExpect(() => expect(1).to.satisfy((n) => (n as number) > 5)).toThrow(AssertionError)
  })

  it('satisfy — negated', () => {
    vExpect(() => expect(1).to.not.satisfy((n) => (n as number) > 5)).not.toThrow()
  })

  it('oneOf — deep equality against list', () => {
    vExpect(() => expect({ id: 1 }).to.be.oneOf([{ id: 1 }, { id: 2 }])).not.toThrow()
    vExpect(() => expect({ id: 3 }).to.be.oneOf([{ id: 1 }, { id: 2 }])).toThrow(AssertionError)
  })

  it('oneOf — negated', () => {
    vExpect(() => expect(99).to.not.be.oneOf([1, 2, 3])).not.toThrow()
  })

  it('closeTo — within delta', () => {
    vExpect(() => expect(1.01).to.be.closeTo(1, 0.05)).not.toThrow()
    vExpect(() => expect(1.2).to.be.closeTo(1, 0.05)).toThrow(AssertionError)
  })

  it('closeTo — negated', () => {
    vExpect(() => expect(1.2).to.not.be.closeTo(1, 0.05)).not.toThrow()
  })

  it('keys — exact match', () => {
    vExpect(() => expect({ a: 1, b: 2 }).to.have.keys('a', 'b')).not.toThrow()
    vExpect(() => expect({ a: 1, b: 2 }).to.have.keys(['a', 'b'])).not.toThrow()
    vExpect(() => expect({ a: 1, b: 2, c: 3 }).to.have.keys('a', 'b')).toThrow(AssertionError)
    vExpect(() => expect({ a: 1 }).to.have.keys('a', 'b')).toThrow(AssertionError)
  })

  it('keys — via include.keys for subset', () => {
    vExpect(() => expect({ a: 1, b: 2, c: 3 }).to.include.keys('a', 'b')).not.toThrow()
    vExpect(() => expect({ a: 1 }).to.include.keys('a', 'b')).toThrow(AssertionError)
  })

  it('throw — without matcher', () => {
    vExpect(() =>
      expect(() => {
        throw new Error('boom')
      }).to.throw()
    ).not.toThrow()
    vExpect(() => expect(() => 1).to.throw()).toThrow(AssertionError)
  })

  it('throw — with string matcher', () => {
    vExpect(() =>
      expect(() => {
        throw new Error('something went boom')
      }).to.throw('boom')
    ).not.toThrow()
    vExpect(() =>
      expect(() => {
        throw new Error('other')
      }).to.throw('boom')
    ).toThrow(AssertionError)
  })

  it('throw — with regex matcher', () => {
    vExpect(() =>
      expect(() => {
        throw new Error('code 42 failed')
      }).to.throw(/\d+/)
    ).not.toThrow()
  })

  it('throw — with Error class matcher', () => {
    class MyErr extends Error {}
    vExpect(() =>
      expect(() => {
        throw new MyErr('x')
      }).to.throw(MyErr)
    ).not.toThrow()
    vExpect(() =>
      expect(() => {
        throw new Error('x')
      }).to.throw(MyErr)
    ).toThrow(AssertionError)
  })

  it('throw — negated (function must not throw)', () => {
    vExpect(() => expect(() => 1).to.not.throw()).not.toThrow()
  })

  it('startWith / endWith', () => {
    vExpect(() => expect('hello world').to.startWith('hello')).not.toThrow()
    vExpect(() => expect('hello world').to.endWith('world')).not.toThrow()
    vExpect(() => expect('hello').to.startWith('world')).toThrow(AssertionError)
    vExpect(() => expect('hello').to.not.startWith('world')).not.toThrow()
  })

  it('nested.property — dotted path access', () => {
    const obj = { a: { b: [10, 20, { c: 'deep' }] } }
    vExpect(() => expect(obj).to.have.nested.property('a.b.0')).not.toThrow()
    vExpect(() => expect(obj).to.have.nested.property('a.b.0', 10)).not.toThrow()
    vExpect(() => expect(obj).to.have.nested.property('a.b.2.c', 'deep')).not.toThrow()
    vExpect(() => expect(obj).to.have.nested.property('a.missing')).toThrow(AssertionError)
    vExpect(() => expect(obj).to.have.nested.property('a.b.0', 999)).toThrow(AssertionError)
  })

  it('nested.property — negated', () => {
    const obj = { a: { b: 1 } }
    vExpect(() => expect(obj).to.not.have.nested.property('a.missing')).not.toThrow()
    vExpect(() => expect(obj).to.not.have.nested.property('a.b')).toThrow(AssertionError)
  })

  // chai: a negated property(name, value) fails only when the property exists
  // AND deep-equals the value.
  it('not.property(name, value) — passes on a different value or a missing property', () => {
    const obj = { a: 1, o: { x: 1 } }
    vExpect(() => expect(obj).to.not.have.property('a', 2)).not.toThrow()
    vExpect(() => expect(obj).to.not.have.property('b', 1)).not.toThrow()
    vExpect(() => expect(obj).to.not.have.property('o', { x: 2 })).not.toThrow()
    vExpect(() => expect(obj).to.not.have.property('a', 1)).toThrow(
      'expected property "a" to not equal 1'
    )
    vExpect(() => expect(obj).to.not.have.property('o', { x: 1 })).toThrow(AssertionError)
    // An explicit undefined value is still a value: a missing property passes.
    vExpect(() => expect(obj).to.not.have.property('b', undefined)).not.toThrow()
  })

  it('not.nested.property(path, value) — same semantics on dotted paths', () => {
    const obj = { a: { b: [10, { c: 'deep' }] } }
    vExpect(() => expect(obj).to.not.have.nested.property('a.b.0', 11)).not.toThrow()
    vExpect(() => expect(obj).to.not.have.nested.property('a.missing', 10)).not.toThrow()
    vExpect(() => expect(obj).to.not.have.nested.property('a.b.0', 10)).toThrow(AssertionError)
    vExpect(() => expect(obj).to.not.have.nested.property('a.b.1', { c: 'deep' })).toThrow(
      AssertionError
    )
  })

  it('positive property(name, value) still fails on a missing property or a different value', () => {
    vExpect(() => expect({ a: 1 }).to.have.property('b', 1)).toThrow(
      'expected {"a":1} to have property "b"'
    )
    vExpect(() => expect({ a: 1 }).to.have.property('a', 2)).toThrow(
      'expected property "a" to equal 2 but got 1'
    )
  })
})
