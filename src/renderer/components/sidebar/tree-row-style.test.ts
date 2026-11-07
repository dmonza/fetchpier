import { describe, expect, it } from 'vitest'
import { treeRowStateClass } from './tree-row-style'

// The selected row of the collection tree must be told apart from a hovered row
// (requirement *Dynamic color themes* §6.4.2, CA-36): selection uses the
// selection tint, hover the neutral hover colour, and a selected row keeps its
// look while hovered.
describe('treeRowStateClass', () => {
  it('marks the active request with the selection tint and no hover change', () => {
    const cls = treeRowStateClass({ selected: true, emphasis: true })
    expect(cls).toContain('bg-primary-tint')
    expect(cls).toContain('font-medium')
    expect(cls).not.toMatch(/hover:/)
  })

  it('marks the selected folder with the selection tint, not the hover colour', () => {
    const cls = treeRowStateClass({ selected: true, emphasis: false })
    expect(cls).toContain('bg-primary-tint')
    expect(cls).not.toContain('bg-accent')
    expect(cls).not.toMatch(/hover:/)
  })

  it('gives an unselected row the hover colour only on hover', () => {
    const cls = treeRowStateClass({ selected: false, emphasis: false })
    expect(cls).toContain('hover:bg-accent')
    expect(cls).not.toContain('bg-primary-tint')
  })
})
