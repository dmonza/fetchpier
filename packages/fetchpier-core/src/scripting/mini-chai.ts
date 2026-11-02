// Minimal chai-like assertion DSL for the Fetchpier sandbox.

import type { ChaiExpect, ChaiIncludeTerminal } from './fp-api'

export type { ChaiExpect, ChaiIncludeTerminal }

export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

function fail(message: string): never {
  throw new AssertionError(message)
}

function stringify(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (typeof v === 'function') return '[Function]'
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false

  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false

  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}

function describe(target: unknown): string {
  return stringify(target)
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function resolveNestedPath(target: unknown, path: string): { found: boolean; value: unknown } {
  const segments = path.split('.')
  let cur: unknown = target
  for (const seg of segments) {
    if (cur === null || cur === undefined) return { found: false, value: undefined }
    if (Array.isArray(cur)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        return { found: false, value: undefined }
      }
      cur = cur[idx]
      continue
    }
    if (typeof cur !== 'object') return { found: false, value: undefined }
    const obj = cur as Record<string, unknown>
    if (!(seg in obj)) return { found: false, value: undefined }
    cur = obj[seg]
  }
  return { found: true, value: cur }
}

function buildExpect(
  target: unknown,
  negated: boolean,
  deepFlag = false,
  nestedFlag = false
): ChaiExpect {
  const t = target
  const neg = negated

  function check(ok: boolean, posMsg: string, negMsg: string): void {
    const failed = neg ? ok : !ok
    if (failed) fail(neg ? negMsg : posMsg)
  }

  // `Object.create(null)` (instead of `{}`) gives the chain a null prototype.
  // From inside the sandbox, this means `chain.constructor` is `undefined` and
  // `Object.getPrototypeOf(chain)` is `null`, so an accidental
  // `fp.expect(x).constructor.constructor("...")` walk no longer lands on the
  // host realm's `Function`. This is surface-reduction hardening within the
  // user-trusts-their-own-scripts model — not a security boundary against a
  // malicious author. See `SECURITY.md` ("Scope") and the
  // regression suite in `fp-sandbox.isolation.test.ts`.
  const self: ChaiExpect = Object.create(null) as ChaiExpect

  // Chainable no-ops (no flag changes)
  const chainNoOps: ReadonlyArray<keyof ChaiExpect> = [
    'to',
    'be',
    'been',
    'is',
    'that',
    'which',
    'and',
    'has',
    'have',
    'with',
    'at',
    'of',
    'same'
  ]
  for (const key of chainNoOps) {
    Object.defineProperty(self, key, { get: () => self })
  }

  // `.deep` flips subsequent equal() into deep equality
  Object.defineProperty(self, 'deep', {
    get: () => buildExpect(t, neg, true, nestedFlag)
  })

  // `.nested` flips subsequent `property()` into dotted-path mode
  Object.defineProperty(self, 'nested', {
    get: () => buildExpect(t, neg, deepFlag, true)
  })

  Object.defineProperty(self, 'not', {
    get: () => buildExpect(t, !neg, deepFlag, nestedFlag)
  })

  // Existence
  Object.defineProperty(self, 'exist', {
    get: () => {
      check(
        t !== null && t !== undefined,
        `expected ${describe(t)} to exist`,
        `expected ${describe(t)} to not exist`
      )
    }
  })
  Object.defineProperty(self, 'ok', {
    get: () => {
      check(!!t, `expected ${describe(t)} to be truthy`, `expected ${describe(t)} to be falsy`)
    }
  })
  Object.defineProperty(self, 'true', {
    get: () => {
      check(
        t === true,
        `expected ${describe(t)} to be true`,
        `expected ${describe(t)} to not be true`
      )
    }
  })
  Object.defineProperty(self, 'false', {
    get: () => {
      check(
        t === false,
        `expected ${describe(t)} to be false`,
        `expected ${describe(t)} to not be false`
      )
    }
  })
  Object.defineProperty(self, 'null', {
    get: () => {
      check(
        t === null,
        `expected ${describe(t)} to be null`,
        `expected ${describe(t)} to not be null`
      )
    }
  })
  Object.defineProperty(self, 'undefined', {
    get: () => {
      check(
        t === undefined,
        `expected ${describe(t)} to be undefined`,
        `expected ${describe(t)} to not be undefined`
      )
    }
  })
  Object.defineProperty(self, 'empty', {
    get: () => {
      let ok: boolean
      if (typeof t === 'string' || Array.isArray(t)) {
        ok = (t as string | unknown[]).length === 0
      } else if (t && typeof t === 'object') {
        ok = Object.keys(t as object).length === 0
      } else {
        fail(`expected ${describe(t)} to be an empty string/array/object`)
      }
      check(ok, `expected ${describe(t)} to be empty`, `expected ${describe(t)} to not be empty`)
    }
  })

  // Equality — switches to deep equality when `.deep` has been used
  const eq = (expected: unknown): void => {
    const ok = deepFlag ? deepEqual(t, expected) : Object.is(t, expected)
    const kind = deepFlag ? 'deeply equal' : 'equal'
    check(
      ok,
      `expected ${describe(t)} to ${kind} ${describe(expected)}`,
      `expected ${describe(t)} to not ${kind} ${describe(expected)}`
    )
  }
  self.equal = eq
  self.equals = eq
  self.eq = eq

  const deq = (expected: unknown): void =>
    check(
      deepEqual(t, expected),
      `expected ${describe(t)} to deeply equal ${describe(expected)}`,
      `expected ${describe(t)} to not deeply equal ${describe(expected)}`
    )
  self.eql = deq
  self.deepEqual = deq

  // Types
  const isType = (type: string): void =>
    check(
      typeOf(t) === type.toLowerCase(),
      `expected ${describe(t)} to be a ${type}`,
      `expected ${describe(t)} to not be a ${type}`
    )
  self.a = isType
  self.an = isType

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  self.instanceOf = (ctor: Function): void =>
    check(
      t instanceof (ctor as { new (...a: unknown[]): unknown }),
      `expected ${describe(t)} to be an instance of ${ctor.name}`,
      `expected ${describe(t)} to not be an instance of ${ctor.name}`
    )

  // Property — when `nestedFlag` is set, `name` is a dotted path (e.g. "a.b.0.c").
  self.property = function property(name: string, value?: unknown): void {
    if (t === null || t === undefined || typeof t !== 'object') {
      fail(`expected ${describe(t)} to be an object`)
    }
    const label = nestedFlag ? `nested path "${name}"` : `property "${name}"`
    let has: boolean
    let actual: unknown
    if (nestedFlag) {
      const res = resolveNestedPath(t, name)
      has = res.found
      actual = res.value
    } else {
      has = Object.prototype.hasOwnProperty.call(t, name) || name in (t as object)
      actual = has ? (t as Record<string, unknown>)[name] : undefined
    }
    check(
      has,
      `expected ${describe(t)} to have ${label}`,
      `expected ${describe(t)} to not have ${label}`
    )
    if (has && arguments.length > 1) {
      check(
        deepEqual(actual, value),
        `expected ${label} to equal ${describe(value)} but got ${describe(actual)}`,
        `expected ${label} to not equal ${describe(value)}`
      )
    }
  }

  // Include / contain — dual-role: callable terminal + `.keys(...)` subset chain.
  const includeTerminal = (value: unknown): void => {
    let ok: boolean
    if (typeof t === 'string') ok = t.includes(String(value))
    else if (Array.isArray(t)) ok = t.some((v) => deepEqual(v, value))
    else if (t && typeof t === 'object') {
      if (value && typeof value === 'object') {
        ok = Object.entries(value as Record<string, unknown>).every(([k, v]) =>
          deepEqual((t as Record<string, unknown>)[k], v)
        )
      } else ok = false
    } else ok = false
    check(
      ok,
      `expected ${describe(t)} to include ${describe(value)}`,
      `expected ${describe(t)} to not include ${describe(value)}`
    )
  }
  const includeFn = includeTerminal as ChaiIncludeTerminal
  includeFn.keys = (...names: Array<string | string[]>): void => {
    if (t === null || t === undefined || typeof t !== 'object') {
      fail(`expected ${describe(t)} to be an object`)
    }
    const expected = names.flat()
    const actual = Object.keys(t as object)
    const ok = expected.every((k) => actual.includes(k))
    check(
      ok,
      `expected ${describe(t)} to include keys ${describe(expected)} (got ${describe(actual)})`,
      `expected ${describe(t)} to not include keys ${describe(expected)}`
    )
  }
  self.include = includeFn
  self.contain = includeFn

  self.match = (regex: RegExp): void =>
    check(
      typeof t === 'string' && regex.test(t),
      `expected ${describe(t)} to match ${regex}`,
      `expected ${describe(t)} to not match ${regex}`
    )

  // Numeric comparisons
  const asNum = (v: unknown): number => {
    if (typeof v !== 'number') fail(`expected ${describe(v)} to be a number`)
    return v
  }
  self.above = (n: number): void =>
    check(
      asNum(t) > n,
      `expected ${describe(t)} to be above ${n}`,
      `expected ${describe(t)} to not be above ${n}`
    )
  self.greaterThan = self.above
  self.below = (n: number): void =>
    check(
      asNum(t) < n,
      `expected ${describe(t)} to be below ${n}`,
      `expected ${describe(t)} to not be below ${n}`
    )
  self.lessThan = self.below
  self.least = (n: number): void =>
    check(
      asNum(t) >= n,
      `expected ${describe(t)} to be at least ${n}`,
      `expected ${describe(t)} to not be at least ${n}`
    )
  self.most = (n: number): void =>
    check(
      asNum(t) <= n,
      `expected ${describe(t)} to be at most ${n}`,
      `expected ${describe(t)} to not be at most ${n}`
    )

  self.lengthOf = (n: number): void => {
    const len = (t as { length?: number })?.length
    if (typeof len !== 'number') fail(`expected ${describe(t)} to have a length`)
    check(
      len === n,
      `expected length ${len} to equal ${n}`,
      `expected length ${len} to not equal ${n}`
    )
  }

  // satisfy — pass if predicate returns truthy for target.
  self.satisfy = (predicate: (value: unknown) => boolean): void => {
    if (typeof predicate !== 'function') {
      fail(`expected a function predicate, got ${describe(predicate)}`)
    }
    let ok: boolean
    try {
      ok = !!predicate(t)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fail(`predicate threw while evaluating ${describe(t)}: ${msg}`)
    }
    check(
      ok,
      `expected ${describe(t)} to satisfy the given predicate`,
      `expected ${describe(t)} to not satisfy the given predicate`
    )
  }

  // oneOf — target deepEquals one of the list elements.
  self.oneOf = (list: unknown[]): void => {
    if (!Array.isArray(list)) fail(`expected an array for oneOf, got ${describe(list)}`)
    const ok = list.some((candidate) => deepEqual(t, candidate))
    check(
      ok,
      `expected ${describe(t)} to be one of ${describe(list)}`,
      `expected ${describe(t)} to not be one of ${describe(list)}`
    )
  }

  // closeTo — numeric comparison with tolerance.
  self.closeTo = (expected: number, delta: number): void => {
    if (typeof t !== 'number') fail(`expected ${describe(t)} to be a number`)
    if (typeof expected !== 'number' || typeof delta !== 'number') {
      fail(`closeTo requires numeric expected and delta`)
    }
    const diff = Math.abs((t as number) - expected)
    check(
      diff <= delta,
      `expected ${t} to be close to ${expected} ±${delta} (diff ${diff})`,
      `expected ${t} to not be close to ${expected} ±${delta}`
    )
  }

  // keys — exact key-set check; use `.include.keys(...)` for "at least".
  self.keys = (...names: Array<string | string[]>): void => {
    if (t === null || t === undefined || typeof t !== 'object') {
      fail(`expected ${describe(t)} to be an object`)
    }
    // Allow both rest args (...names) and a single array argument.
    const expected = names.flat()
    const actual = Object.keys(t as object)
    const expectedSet = new Set(expected)
    const actualSet = new Set(actual)

    const hasAll = expected.every((k) => actualSet.has(k))
    const sameSize = actualSet.size === expectedSet.size
    const ok = hasAll && sameSize
    check(
      ok,
      `expected ${describe(t)} to have keys ${describe(expected)} (got ${describe(actual)})`,
      `expected ${describe(t)} to not have exactly keys ${describe(expected)}`
    )
  }

  // throw — target must be a function that throws (optionally matching matcher).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  self.throw = (matcher?: string | RegExp | Function): void => {
    if (typeof t !== 'function') fail(`expected ${describe(t)} to be a function`)
    let thrown: unknown
    let didThrow = false
    try {
      ;(t as () => unknown)()
    } catch (err) {
      didThrow = true
      thrown = err
    }

    if (matcher === undefined) {
      check(
        didThrow,
        `expected function to throw`,
        `expected function to not throw, but it threw ${describe(
          thrown instanceof Error ? thrown.message : thrown
        )}`
      )
      return
    }

    if (!didThrow) {
      check(false, `expected function to throw`, `expected function to not throw`)
      return
    }

    const thrownMsg = thrown instanceof Error ? thrown.message : String(thrown)
    let matches: boolean
    let desc: string

    if (typeof matcher === 'string') {
      matches = thrownMsg.includes(matcher)
      desc = `including "${matcher}"`
    } else if (matcher instanceof RegExp) {
      matches = matcher.test(thrownMsg)
      desc = `matching ${matcher}`
    } else if (typeof matcher === 'function') {
      matches = thrown instanceof (matcher as { new (...a: unknown[]): Error })
      desc = `of type ${(matcher as { name?: string }).name || 'Error'}`
    } else {
      fail(`unsupported matcher ${describe(matcher)}`)
    }

    check(
      matches,
      `expected function to throw an error ${desc}, got ${describe(thrownMsg)}`,
      `expected function to not throw an error ${desc}`
    )
  }

  // startWith / endWith — string edges.
  self.startWith = (prefix: string): void => {
    if (typeof t !== 'string') fail(`expected ${describe(t)} to be a string`)
    check(
      (t as string).startsWith(prefix),
      `expected ${describe(t)} to start with ${describe(prefix)}`,
      `expected ${describe(t)} to not start with ${describe(prefix)}`
    )
  }
  self.endWith = (suffix: string): void => {
    if (typeof t !== 'string') fail(`expected ${describe(t)} to be a string`)
    check(
      (t as string).endsWith(suffix),
      `expected ${describe(t)} to end with ${describe(suffix)}`,
      `expected ${describe(t)} to not end with ${describe(suffix)}`
    )
  }

  return self
}

export function createExpect(): (value: unknown) => ChaiExpect {
  return (value: unknown): ChaiExpect => buildExpect(value, false)
}
