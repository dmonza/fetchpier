import { describe, expect, it } from 'vitest'
import type { WorkspaceTree } from '../../../shared/types'
import { collectFolderOptions } from './folder-options'

const TREE: WorkspaceTree[] = [
  {
    name: 'api',
    path: '/ws/requests/api',
    type: 'folder',
    kind: 'folder',
    children: [
      { name: 'get.http', path: '/ws/requests/api/get.http', type: 'file', kind: 'request' },
      {
        name: 'v2',
        path: '/ws/requests/api/v2',
        type: 'folder',
        kind: 'folder',
        children: []
      }
    ]
  },
  { name: 'ping.http', path: '/ws/requests/ping.http', type: 'file', kind: 'request' },
  { name: 'auth', path: '/ws/requests/auth', type: 'folder', kind: 'folder', children: [] }
]

describe('collectFolderOptions', () => {
  it('lists every folder depth-first in tree order with its depth, and no files', () => {
    expect(collectFolderOptions(TREE)).toEqual([
      { path: '/ws/requests/api', label: 'api', depth: 0 },
      { path: '/ws/requests/api/v2', label: 'v2', depth: 1 },
      { path: '/ws/requests/auth', label: 'auth', depth: 0 }
    ])
  })

  it('leaves out the excluded folder and everything under it', () => {
    expect(collectFolderOptions(TREE, '/ws/requests/api')).toEqual([
      { path: '/ws/requests/auth', label: 'auth', depth: 0 }
    ])
  })

  it('returns nothing for an empty tree', () => {
    expect(collectFolderOptions([])).toEqual([])
  })
})
