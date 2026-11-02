import { describe, it, expect } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { inspect, inspectLine } from './inspect'

async function renderToText(node: React.ReactNode): Promise<string> {
  const container = document.createElement('span')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<>{node}</>)
  })
  const text = container.textContent ?? ''
  act(() => root.unmount())
  container.remove()
  return text
}

describe('inspect', () => {
  it('renders null', async () => {
    expect(await renderToText(inspect(null))).toBe('null')
  })

  it('renders undefined', async () => {
    expect(await renderToText(inspect(undefined))).toBe('undefined')
  })

  it('renders string with quotes', async () => {
    expect(await renderToText(inspect('hello'))).toBe('"hello"')
  })

  it('renders number', async () => {
    expect(await renderToText(inspect(42))).toBe('42')
  })

  it('renders float', async () => {
    expect(await renderToText(inspect(3.14))).toBe('3.14')
  })

  it('renders boolean true', async () => {
    expect(await renderToText(inspect(true))).toBe('true')
  })

  it('renders boolean false', async () => {
    expect(await renderToText(inspect(false))).toBe('false')
  })

  it('renders named function', async () => {
    function myFunc() {}
    expect(await renderToText(inspect(myFunc))).toBe('[Function: myFunc]')
  })

  it('renders anonymous function', async () => {
    const fn = function () {}
    Object.defineProperty(fn, 'name', { value: '', configurable: true })
    expect(await renderToText(inspect(fn))).toBe('[Function: (anonymous)]')
  })

  it('renders simple array', async () => {
    expect(await renderToText(inspect([1, 2, 3]))).toBe('[1, 2, 3]')
  })

  it('renders array with mixed types', async () => {
    const text = await renderToText(inspect(['status:', 200, { ok: true }]))
    expect(text).toContain('"status:"')
    expect(text).toContain('200')
    expect(text).toContain('ok')
    expect(text).toContain('true')
  })

  it('renders simple object', async () => {
    const text = await renderToText(inspect({ a: 1, b: 'two' }))
    expect(text).toContain('a')
    expect(text).toContain('1')
    expect(text).toContain('b')
    expect(text).toContain('"two"')
  })

  it('renders nested object', async () => {
    const text = await renderToText(inspect({ outer: { inner: 42 } }))
    expect(text).toContain('outer')
    expect(text).toContain('inner')
    expect(text).toContain('42')
  })

  it('cuts off arrays at depth 3', async () => {
    const deep = [[[[1]]]]
    const text = await renderToText(inspect(deep))
    expect(text).toContain('[...]')
  })

  it('cuts off objects at depth 3', async () => {
    const deep = { a: { b: { c: { d: 1 } } } }
    const text = await renderToText(inspect(deep))
    expect(text).toContain('{')
    expect(text).toContain('}')
    // d:1 should not be visible — cut off at depth 3
    expect(text).not.toContain('d')
  })

  it('detects circular references', async () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    const text = await renderToText(inspect(obj))
    expect(text).toContain('[Circular]')
  })
})

describe('inspectLine', () => {
  it('joins multiple args', async () => {
    const text = await renderToText(inspectLine(['status:', 200, { ok: true }]))
    expect(text).toContain('"status:"')
    expect(text).toContain('200')
    expect(text).toContain('ok')
  })

  it('renders single arg', async () => {
    expect(await renderToText(inspectLine([42]))).toBe('42')
  })

  it('renders empty args', async () => {
    expect(await renderToText(inspectLine([]))).toBe('')
  })
})
