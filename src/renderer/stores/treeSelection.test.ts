import { describe, it, expect, beforeEach } from 'vitest'
import { useTreeSelectionStore, resolveTargetFolder } from './treeSelection'

describe('useTreeSelectionStore', () => {
  beforeEach(() => {
    useTreeSelectionStore.getState().clear()
  })

  it('starts empty', () => {
    expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
    expect(useTreeSelectionStore.getState().selectedType).toBeNull()
  })

  it('records the selected node and clears it', () => {
    useTreeSelectionStore.getState().setSelected('/ws/requests/api', 'folder')
    expect(useTreeSelectionStore.getState().selectedPath).toBe('/ws/requests/api')
    expect(useTreeSelectionStore.getState().selectedType).toBe('folder')

    useTreeSelectionStore.getState().clear()
    expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
    expect(useTreeSelectionStore.getState().selectedType).toBeNull()
  })

  describe('clearIfWithin', () => {
    it('clears the selection when the deleted node IS the selection', () => {
      useTreeSelectionStore.getState().setSelected('/ws/requests/api', 'folder')
      useTreeSelectionStore.getState().clearIfWithin('/ws/requests/api')
      expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
      expect(useTreeSelectionStore.getState().selectedType).toBeNull()
    })

    it('clears the selection when an ancestor folder is deleted', () => {
      useTreeSelectionStore.getState().setSelected('/ws/requests/api/users.http', 'file')
      useTreeSelectionStore.getState().clearIfWithin('/ws/requests/api')
      expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
    })

    it('keeps the selection when an unrelated/sibling node is deleted', () => {
      useTreeSelectionStore.getState().setSelected('/ws/requests/api', 'folder')
      useTreeSelectionStore.getState().clearIfWithin('/ws/requests/other')
      expect(useTreeSelectionStore.getState().selectedPath).toBe('/ws/requests/api')
    })

    it('does not treat a path prefix as containment', () => {
      // "/ws/requests/api2" must NOT be considered inside "/ws/requests/api".
      useTreeSelectionStore.getState().setSelected('/ws/requests/api2', 'folder')
      useTreeSelectionStore.getState().clearIfWithin('/ws/requests/api')
      expect(useTreeSelectionStore.getState().selectedPath).toBe('/ws/requests/api2')
    })

    it('handles Windows-style backslash paths', () => {
      useTreeSelectionStore.getState().setSelected('C:\\ws\\requests\\api\\u.http', 'file')
      useTreeSelectionStore.getState().clearIfWithin('C:\\ws\\requests\\api')
      expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
    })

    it('is a no-op when there is no selection', () => {
      useTreeSelectionStore.getState().clearIfWithin('/ws/requests/api')
      expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
    })
  })

  describe('roving focus', () => {
    it('setSelected also focuses the clicked node (mouse/keyboard sync)', () => {
      useTreeSelectionStore.getState().setSelected('/ws/requests/api/u.http', 'file')
      expect(useTreeSelectionStore.getState().focusedPath).toBe('/ws/requests/api/u.http')
    })

    it('setFocused moves focus without touching the create/import selection', () => {
      useTreeSelectionStore.getState().setSelected('/ws/requests/api', 'folder')
      useTreeSelectionStore.getState().setFocused('/ws/requests/api/u.http')
      expect(useTreeSelectionStore.getState().focusedPath).toBe('/ws/requests/api/u.http')
      expect(useTreeSelectionStore.getState().selectedPath).toBe('/ws/requests/api')
    })

    it('reconcile prunes a focus whose node is gone', () => {
      useTreeSelectionStore.getState().setFocused('/ws/requests/gone.http')
      useTreeSelectionStore.getState().reconcile(['/ws/requests/api'])
      expect(useTreeSelectionStore.getState().focusedPath).toBeNull()
    })

    it('clearIfWithin prunes a focus inside a deleted folder', () => {
      useTreeSelectionStore.getState().setFocused('/ws/requests/api/u.http')
      useTreeSelectionStore.getState().clearIfWithin('/ws/requests/api')
      expect(useTreeSelectionStore.getState().focusedPath).toBeNull()
    })
  })

  describe('reconcile', () => {
    it('clears the selection when its path is gone from the live tree', () => {
      useTreeSelectionStore.getState().setSelected('/ws/requests/gone', 'folder')
      useTreeSelectionStore.getState().reconcile(['/ws/requests/api', '/ws/requests/auth'])
      expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
    })

    it('keeps the selection when its path still exists', () => {
      useTreeSelectionStore.getState().setSelected('/ws/requests/api', 'folder')
      useTreeSelectionStore.getState().reconcile(['/ws/requests/api', '/ws/requests/auth'])
      expect(useTreeSelectionStore.getState().selectedPath).toBe('/ws/requests/api')
    })

    it('matches across path separators', () => {
      useTreeSelectionStore.getState().setSelected('C:\\ws\\requests\\api', 'folder')
      useTreeSelectionStore.getState().reconcile(['C:/ws/requests/api'])
      expect(useTreeSelectionStore.getState().selectedPath).toBe('C:\\ws\\requests\\api')
    })

    it('is a no-op when there is no selection', () => {
      useTreeSelectionStore.getState().reconcile([])
      expect(useTreeSelectionStore.getState().selectedPath).toBeNull()
    })
  })
})

describe('resolveTargetFolder', () => {
  const root = '/ws/requests'

  it('returns the root when nothing is selected', () => {
    expect(resolveTargetFolder(root, null, null)).toBe(root)
  })

  it('returns a selected folder as-is', () => {
    expect(resolveTargetFolder(root, '/ws/requests/api', 'folder')).toBe('/ws/requests/api')
  })

  it('returns the parent folder of a selected file', () => {
    expect(resolveTargetFolder(root, '/ws/requests/api/users.http', 'file')).toBe(
      '/ws/requests/api'
    )
  })

  it('returns the root when a selected file lives directly under the root', () => {
    expect(resolveTargetFolder(root, '/ws/requests/users.http', 'file')).toBe(root)
  })

  it('ignores a selection outside the requests root', () => {
    expect(resolveTargetFolder(root, '/ws/environments/dev', 'folder')).toBe(root)
  })

  it('handles Windows-style backslash paths', () => {
    expect(resolveTargetFolder('C:\\ws\\requests', 'C:\\ws\\requests\\api', 'folder')).toBe(
      'C:\\ws\\requests\\api'
    )
    expect(resolveTargetFolder('C:\\ws\\requests', 'C:\\ws\\requests\\api\\u.http', 'file')).toBe(
      'C:\\ws\\requests\\api'
    )
  })

  it('returns the root when there is no root', () => {
    expect(resolveTargetFolder('', '/ws/requests/api', 'folder')).toBe('')
  })
})
