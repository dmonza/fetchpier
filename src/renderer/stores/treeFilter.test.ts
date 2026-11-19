import { beforeEach, describe, expect, it } from 'vitest'
import { useTreeFilterStore } from './treeFilter'

describe('useTreeFilterStore', () => {
  beforeEach(() => {
    useTreeFilterStore.setState({ query: '', focusRequested: false })
  })

  it('holds the query typed in the filter field', () => {
    useTreeFilterStore.getState().setQuery('login')
    expect(useTreeFilterStore.getState().query).toBe('login')
    useTreeFilterStore.getState().setQuery('')
    expect(useTreeFilterStore.getState().query).toBe('')
  })

  it('a focus request stays pending until the tree consumes it', () => {
    useTreeFilterStore.getState().requestFocus()
    expect(useTreeFilterStore.getState().focusRequested).toBe(true)
    useTreeFilterStore.getState().consumeFocus()
    expect(useTreeFilterStore.getState().focusRequested).toBe(false)
  })
})
