import { describe, it, expect } from 'vitest'
import type { WorkspaceTree } from '../../../shared/types'
import { flattenVisible, resolveTreeKey, typeAheadMatch, type VisibleNode } from './tree-nav'

// folderA/ { reqA1.http, reqA2.http { reqA2.x.instance.http } }, reqRoot.http
const tree: WorkspaceTree[] = [
  {
    name: 'folderA',
    path: '/w/folderA',
    type: 'folder',
    kind: 'folder',
    children: [
      { name: 'reqA1.http', path: '/w/folderA/reqA1.http', type: 'file', kind: 'request' },
      {
        name: 'reqA2.http',
        path: '/w/folderA/reqA2.http',
        type: 'file',
        kind: 'request',
        children: [
          {
            name: 'reqA2.x.instance.http',
            path: '/w/folderA/reqA2.x.instance.http',
            type: 'file',
            kind: 'instance'
          }
        ]
      }
    ]
  },
  { name: 'reqRoot.http', path: '/w/reqRoot.http', type: 'file', kind: 'request' }
]

const allExpanded = (): boolean => true
const noneExpanded = (): boolean => false

describe('flattenVisible', () => {
  it('lists nodes in rendered order with depth, expandable, and display names', () => {
    const v = flattenVisible(tree, allExpanded)
    expect(v.map((n) => n.path)).toEqual([
      '/w/folderA',
      '/w/folderA/reqA1.http',
      '/w/folderA/reqA2.http',
      '/w/folderA/reqA2.x.instance.http',
      '/w/reqRoot.http'
    ])
    expect(v.map((n) => n.name)).toEqual(['folderA', 'reqA1', 'reqA2', 'x', 'reqRoot'])
    expect(v.map((n) => n.depth)).toEqual([0, 1, 1, 2, 0])
    expect(v.find((n) => n.path === '/w/folderA/reqA2.http')?.expandable).toBe(true)
    expect(v.find((n) => n.path === '/w/folderA/reqA1.http')?.expandable).toBe(false)
  })

  it('hides children of collapsed nodes', () => {
    const v = flattenVisible(tree, noneExpanded)
    expect(v.map((n) => n.path)).toEqual(['/w/folderA', '/w/reqRoot.http'])
  })
})

describe('resolveTreeKey', () => {
  const v = flattenVisible(tree, allExpanded)

  it('seeds focus from nothing on ArrowDown / ArrowUp', () => {
    expect(resolveTreeKey(v, null, 'ArrowDown')).toEqual({ type: 'focus', path: '/w/folderA' })
    expect(resolveTreeKey(v, null, 'ArrowUp')).toEqual({ type: 'focus', path: '/w/reqRoot.http' })
  })

  it('ArrowDown / ArrowUp move focus and stop at the ends (no wrap)', () => {
    expect(resolveTreeKey(v, '/w/folderA', 'ArrowDown')).toEqual({
      type: 'focus',
      path: '/w/folderA/reqA1.http'
    })
    expect(resolveTreeKey(v, '/w/folderA', 'ArrowUp')).toBeNull()
    expect(resolveTreeKey(v, '/w/reqRoot.http', 'ArrowDown')).toBeNull()
  })

  it('Home / End jump to the first / last visible node', () => {
    expect(resolveTreeKey(v, '/w/reqRoot.http', 'Home')).toEqual({
      type: 'focus',
      path: '/w/folderA'
    })
    expect(resolveTreeKey(v, '/w/folderA', 'End')).toEqual({
      type: 'focus',
      path: '/w/reqRoot.http'
    })
  })

  it('ArrowRight expands a collapsed node, then steps into the first child', () => {
    const collapsed = flattenVisible(tree, (p) => p !== '/w/folderA') // folderA collapsed
    expect(resolveTreeKey(collapsed, '/w/folderA', 'ArrowRight')).toEqual({
      type: 'setExpanded',
      path: '/w/folderA',
      open: true
    })
    expect(resolveTreeKey(v, '/w/folderA', 'ArrowRight')).toEqual({
      type: 'focus',
      path: '/w/folderA/reqA1.http'
    })
  })

  it('ArrowLeft collapses an expanded node, else moves to the parent', () => {
    expect(resolveTreeKey(v, '/w/folderA', 'ArrowLeft')).toEqual({
      type: 'setExpanded',
      path: '/w/folderA',
      open: false
    })
    expect(resolveTreeKey(v, '/w/folderA/reqA1.http', 'ArrowLeft')).toEqual({
      type: 'focus',
      path: '/w/folderA'
    })
  })

  it('Enter opens a file and toggles a folder', () => {
    expect(resolveTreeKey(v, '/w/folderA/reqA1.http', 'Enter')).toEqual({
      type: 'open',
      path: '/w/folderA/reqA1.http'
    })
    expect(resolveTreeKey(v, '/w/folderA', 'Enter')).toEqual({
      type: 'setExpanded',
      path: '/w/folderA',
      open: false // expanded → toggles closed
    })
  })

  it('F2 renames and Delete deletes the focused node', () => {
    expect(resolveTreeKey(v, '/w/folderA/reqA1.http', 'F2')).toEqual({
      type: 'rename',
      path: '/w/folderA/reqA1.http'
    })
    expect(resolveTreeKey(v, '/w/folderA/reqA1.http', 'Delete')).toEqual({
      type: 'delete',
      path: '/w/folderA/reqA1.http'
    })
  })

  it('ignores unrelated keys', () => {
    expect(resolveTreeKey(v, '/w/folderA', 'a')).toBeNull()
  })
})

describe('typeAheadMatch', () => {
  const v: VisibleNode[] = flattenVisible(tree, allExpanded)

  it('a multi-char prefix sticks to the current match', () => {
    expect(typeAheadMatch(v, '/w/folderA', 'req')).toBe('/w/folderA/reqA1.http')
  })

  it('a single char cycles through matches after the focus, wrapping', () => {
    expect(typeAheadMatch(v, '/w/folderA/reqA1.http', 'r')).toBe('/w/folderA/reqA2.http')
    expect(typeAheadMatch(v, '/w/folderA/reqA2.http', 'r')).toBe('/w/reqRoot.http')
    expect(typeAheadMatch(v, '/w/reqRoot.http', 'r')).toBe('/w/folderA/reqA1.http') // wrap
  })

  it('returns null when nothing matches', () => {
    expect(typeAheadMatch(v, null, 'zzz')).toBeNull()
  })
})
