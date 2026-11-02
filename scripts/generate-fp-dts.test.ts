import { describe, it, expect } from 'vitest'
// @ts-expect-error — mjs with JSDoc types, no .d.ts emitted.
import {
  buildBase,
  buildPreRequest,
  buildPostResponse,
  transformSource
} from './generate-fp-dts.mjs'

describe('generate-fp-dts transform', () => {
  it('strips `export` from interface declarations', () => {
    const src = `export interface Foo {\n  bar: string\n}\n`
    const out = transformSource(src)
    expect(out).toContain('interface Foo {')
    expect(out).not.toContain('export interface Foo')
  })

  it('strips single-line `import type` statements', () => {
    const src = ["import type { Baz } from './other'", 'export interface Foo { bar: Baz }'].join(
      '\n'
    )
    const out = transformSource(src)
    expect(out).not.toMatch(/^import\b/m)
    expect(out).toContain('interface Foo { bar: Baz }')
  })

  it('drops `export type { … }` re-exports', () => {
    const src = ['export type { Foo, Bar } from "./x"', 'export interface Kept {}'].join('\n')
    const out = transformSource(src)
    expect(out).not.toMatch(/export\s+type\s*\{/)
    expect(out).toContain('interface Kept {}')
  })

  it('is idempotent — running transform on the output adds no further change', () => {
    const src = `export interface Foo {}\nexport interface Bar {}\n`
    const once = transformSource(src)
    const twice = transformSource(once)
    expect(twice).toBe(once)
  })
})

describe('generate-fp-dts buildBase', () => {
  it('produces a base output with header and stripped source — no `declare const fp`', () => {
    const src = `export interface FpApi { foo(): void }\n`
    const out = buildBase(src)
    expect(out).toMatch(/^\/\/ AUTO-GENERATED/)
    expect(out).toContain('interface FpApi')
    // Base file never declares `fp`; that lives in the phase files.
    expect(out).not.toContain('declare const fp')
  })
})

describe('generate-fp-dts buildPreRequest', () => {
  const out = buildPreRequest()

  it('declares `const fp: FpApiPreRequest`', () => {
    expect(out).toContain('declare const fp: FpApiPreRequest')
  })

  it('types `response` as never with a warning JSDoc', () => {
    expect(out).toContain('readonly response: never')
    expect(out).toMatch(/not available.*pre-request/i)
  })

  it('extends the base FpApi via Omit', () => {
    expect(out).toContain("Omit<FpApi, 'response'>")
  })

  it('starts with the AUTO-GENERATED header', () => {
    expect(out).toMatch(/^\/\/ AUTO-GENERATED/)
  })
})

describe('generate-fp-dts buildPostResponse', () => {
  const out = buildPostResponse()

  it('declares `const fp: FpApiPostResponse`', () => {
    expect(out).toContain('declare const fp: FpApiPostResponse')
  })

  it('makes request read-only and response non-optional', () => {
    expect(out).toContain('readonly request: Readonly<FpRequest>')
    expect(out).toContain('readonly response: FpResponse')
  })

  it('extends the base FpApi via Omit of both request and response', () => {
    expect(out).toContain("Omit<FpApi, 'request' | 'response'>")
  })

  it('starts with the AUTO-GENERATED header', () => {
    expect(out).toMatch(/^\/\/ AUTO-GENERATED/)
  })
})
