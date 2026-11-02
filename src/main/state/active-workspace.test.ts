import { beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  getActiveWorkspaceHandle,
  requireActiveWorkspaceHandle,
  setActiveWorkspace
} from './active-workspace'

beforeEach(() => {
  setActiveWorkspace(null)
})

describe('active-workspace session handle', () => {
  it('starts with no handle', () => {
    expect(getActiveWorkspaceHandle()).toBeNull()
  })

  it('opens a handle for the given path', () => {
    setActiveWorkspace('/tmp/ws')
    expect(getActiveWorkspaceHandle()?.path).toBe(resolve('/tmp/ws'))
  })

  it('replaces the handle on subsequent set', () => {
    setActiveWorkspace('/tmp/a')
    setActiveWorkspace('/tmp/b')
    expect(requireActiveWorkspaceHandle().path).toBe(resolve('/tmp/b'))
  })

  it('clears the handle with null', () => {
    setActiveWorkspace('/tmp/ws')
    setActiveWorkspace(null)
    expect(getActiveWorkspaceHandle()).toBeNull()
  })

  it('requireActiveWorkspaceHandle throws when none is open', () => {
    expect(() => requireActiveWorkspaceHandle()).toThrow(/No active workspace/)
  })

  it('requireActiveWorkspaceHandle throws after clear', () => {
    setActiveWorkspace('/tmp/ws')
    setActiveWorkspace(null)
    expect(() => requireActiveWorkspaceHandle()).toThrow(/No active workspace/)
  })
})
