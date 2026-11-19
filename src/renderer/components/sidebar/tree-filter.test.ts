import { describe, expect, it } from 'vitest'
import type { WorkspaceTree } from '../../../shared/types'
import { filterTree, matchRanges } from './tree-filter'

const folder = (name: string, children: WorkspaceTree[]): WorkspaceTree => ({
  name,
  path: `/ws/requests/${name}`,
  type: 'folder',
  kind: 'folder',
  children
})

const file = (name: string, parent = ''): WorkspaceTree => ({
  name: `${name}.http`,
  path: parent ? `/ws/requests/${parent}/${name}.http` : `/ws/requests/${name}.http`,
  type: 'file',
  kind: 'request'
})

const instance = (parentStem: string, instName: string, parent = ''): WorkspaceTree => ({
  name: `${parentStem}.${instName}.instance.http`,
  path: parent
    ? `/ws/requests/${parent}/${parentStem}.${instName}.instance.http`
    : `/ws/requests/${parentStem}.${instName}.instance.http`,
  type: 'file',
  kind: 'instance'
})

describe('filterTree', () => {
  const tree: WorkspaceTree[] = [
    folder('auth', [
      { ...file('login', 'auth'), children: [instance('login', 'happy-path', 'auth')] },
      file('logout', 'auth')
    ]),
    folder('users', [file('list-users', 'users'), file('create-user', 'users')]),
    file('healthcheck')
  ]

  it('returns the original tree unchanged for empty or whitespace queries', () => {
    expect(filterTree(tree, '')).toBe(tree)
    expect(filterTree(tree, '   ')).toBe(tree)
  })

  it('matches case-insensitively across request stems and prunes non-matching branches', () => {
    const result = filterTree(tree, 'LOGIN')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('auth')
    expect(result[0].children?.map((c) => c.name)).toEqual(['login.http'])
  })

  it('does not match the .http file extension itself', () => {
    expect(filterTree(tree, '.http')).toEqual([])
  })

  it('keeps all children of a directly matching folder', () => {
    const result = filterTree(tree, 'auth')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('auth')
    expect(result[0].children?.map((c) => c.name)).toEqual(['login.http', 'logout.http'])
  })

  it('matches instance display names under a parent request', () => {
    const result = filterTree(tree, 'happy')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('auth')
    const loginNode = result[0].children?.[0]
    expect(loginNode?.name).toBe('login.http')
    expect(loginNode?.children?.map((c) => c.name)).toEqual(['login.happy-path.instance.http'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterTree(tree, 'does-not-exist')).toEqual([])
  })

  it('a multi-word query keeps only names that contain every word, in any order', () => {
    const result = filterTree(tree, 'user create')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('users')
    expect(result[0].children?.map((c) => c.name)).toEqual(['create-user.http'])
    // A name holding only one of the words is not a match.
    expect(filterTree(tree, 'list create')).toEqual([])
  })
})

describe('matchRanges', () => {
  it('returns nothing for an empty query or a label that does not hold every word', () => {
    expect(matchRanges('create-user', '')).toEqual([])
    expect(matchRanges('create-user', '   ')).toEqual([])
    expect(matchRanges('create-user', 'create list')).toEqual([])
  })

  it('marks every occurrence of every word, case-insensitively, sorted', () => {
    expect(matchRanges('Create-User', 'user CREATE')).toEqual([
      [0, 6],
      [7, 11]
    ])
    expect(matchRanges('abab', 'ab')).toEqual([
      [0, 2],
      [2, 4]
    ])
  })

  it('merges overlapping words into one range', () => {
    // 'health' is [0, 6), 'althc' is [2, 7): one range [0, 7).
    expect(matchRanges('healthcheck', 'health althc')).toEqual([[0, 7]])
  })
})
