import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveInsideActiveWorkspace } from './safe-path'
import { setActiveWorkspace } from '../state/active-workspace'

// Pure helpers (`resolveInsideWorkspace`, `assertSafeIdentifier`) live in and
// are tested by `@fetchpier/core/workspace`. This suite covers the
// singleton-bound adapters that stay in the main process.

const WS = path.resolve('/tmp/ws')

beforeEach(() => {
  setActiveWorkspace(null)
})
afterEach(() => {
  setActiveWorkspace(null)
})

describe('resolveInsideActiveWorkspace', () => {
  it('uses the active workspace singleton', () => {
    setActiveWorkspace(WS)
    expect(resolveInsideActiveWorkspace('requests', 'a.http')).toBe(
      path.join(WS, 'requests', 'a.http')
    )
  })

  it('throws when no active workspace is set', () => {
    expect(() => resolveInsideActiveWorkspace('x')).toThrow(/No active workspace/)
  })
})
