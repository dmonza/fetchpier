import { describe, it, expect } from 'vitest'
import type { WorkspaceTree } from '../../shared/types'
import { findNode, firstFreeCopyName, siblingsOf } from './name-conflict'

// Tree navigation + the duplicate pre-fill ladder. Name-conflict verdicts moved
// to the core (REQ case-insensitive tree name uniqueness) — see
// lib/name-availability.test.ts for the inline-validation state machine.

const ROOT = '/ws/requests'

function file(parent: string, name: string): WorkspaceTree {
  return { name, path: `${parent}/${name}`, type: 'file', kind: 'request' } as WorkspaceTree
}
function folder(parent: string, name: string, children: WorkspaceTree[] = []): WorkspaceTree {
  return { name, path: `${parent}/${name}`, type: 'folder', children } as WorkspaceTree
}

describe('findNode', () => {
  const child = file(`${ROOT}/api`, 'get.http')
  const tree: WorkspaceTree[] = [file(ROOT, 'health.http'), folder(ROOT, 'api', [child])]

  it('finds a nested node by absolute path', () => {
    expect(findNode(tree, `${ROOT}/api/get.http`)).toBe(child)
  })
  it('returns null for an unknown path', () => {
    expect(findNode(tree, `${ROOT}/ghost.http`)).toBeNull()
  })
})

describe('siblingsOf returns the array containing the node', () => {
  const child = file(`${ROOT}/api`, 'get.http')
  const api = folder(ROOT, 'api', [child])
  const health = file(ROOT, 'health.http')
  const tree: WorkspaceTree[] = [health, api]

  it('finds a nested node’s own level', () => {
    expect(siblingsOf(tree, child).map((n) => n.name)).toEqual(['get.http'])
  })
  it('finds a top-level node’s own level', () => {
    expect(siblingsOf(tree, health).map((n) => n.name)).toEqual(['health.http', 'api'])
  })
  it('returns [] when the node is not in the tree', () => {
    expect(siblingsOf(tree, file(ROOT, 'ghost.http'))).toEqual([])
  })
})

describe('firstFreeCopyName walks the -copy / -copy-N ladder', () => {
  it('uses <base>-copy when it is free', () => {
    expect(firstFreeCopyName('happy-path', new Set())).toBe('happy-path-copy')
  })
  it('skips to -copy-2 when <base>-copy is taken', () => {
    expect(firstFreeCopyName('happy-path', new Set(['happy-path-copy']))).toBe('happy-path-copy-2')
  })
  it('finds the first gap in a run of copies', () => {
    const taken = new Set(['happy-path-copy', 'happy-path-copy-2', 'happy-path-copy-4'])
    expect(firstFreeCopyName('happy-path', taken)).toBe('happy-path-copy-3')
  })
  it('suffixes the source name as-is when duplicating an existing copy', () => {
    expect(firstFreeCopyName('happy-path-copy', new Set())).toBe('happy-path-copy-copy')
  })
})
