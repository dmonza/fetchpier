import { afterEach, describe, expect, it } from 'vitest'
import {
  TREE_INDENT_PX,
  classifyDrop,
  clearDragSource,
  getDragSource,
  guideLeftPx,
  rowPaddingLeftPx,
  setDragSource
} from './tree-dnd'

describe('indent metrics', () => {
  it('indents 16px per level from a 4px base', () => {
    expect(TREE_INDENT_PX).toBe(16)
    expect(rowPaddingLeftPx(0)).toBe(4)
    expect(rowPaddingLeftPx(1)).toBe(4 + TREE_INDENT_PX)
    expect(rowPaddingLeftPx(3)).toBe(4 + 3 * TREE_INDENT_PX)
  })

  it('centers the guide under the parent chevron column', () => {
    // Chevron at depth d starts at rowPaddingLeftPx(d) and is 14px wide.
    expect(guideLeftPx(0)).toBe(rowPaddingLeftPx(0) + 7)
    expect(guideLeftPx(2)).toBe(rowPaddingLeftPx(2) + 7)
  })
})

describe('classifyDrop', () => {
  const root = '/ws/requests'

  it('moves a file into a different folder', () => {
    expect(classifyDrop(`${root}/a/req.http`, `${root}/b`)).toBe('move')
  })

  it('moves a file from a nested folder up to the root', () => {
    expect(classifyDrop(`${root}/a/b/req.http`, root)).toBe('move')
  })

  it('is a noop when the source already lives directly inside the target', () => {
    expect(classifyDrop(`${root}/a/req.http`, `${root}/a`)).toBe('noop')
    expect(classifyDrop(`${root}/req.http`, root)).toBe('noop')
  })

  it('is not a noop for a deeper ancestor (grandparent is a real move)', () => {
    expect(classifyDrop(`${root}/a/b/req.http`, `${root}/a`)).toBe('move')
  })

  it('rejects dropping a folder onto itself', () => {
    expect(classifyDrop(`${root}/a`, `${root}/a`)).toBe('invalid')
  })

  it('rejects dropping a folder into its own descendant', () => {
    expect(classifyDrop(`${root}/a`, `${root}/a/b`)).toBe('invalid')
    expect(classifyDrop(`${root}/a`, `${root}/a/b/c`)).toBe('invalid')
  })

  it('does not treat sibling prefixes as descendants', () => {
    // `/a-old` starts with `/a` as a string but is not inside it.
    expect(classifyDrop(`${root}/a`, `${root}/a-old`)).toBe('move')
  })

  it('rejects when there is no tracked source (foreign drag)', () => {
    expect(classifyDrop(null, root)).toBe('invalid')
    expect(classifyDrop('', root)).toBe('invalid')
  })

  it('normalizes Windows separators and trailing slashes', () => {
    expect(classifyDrop('C:\\ws\\requests\\a\\req.http', 'C:/ws/requests/b')).toBe('move')
    expect(classifyDrop('C:\\ws\\requests\\a', 'C:\\ws\\requests\\a\\b')).toBe('invalid')
    expect(classifyDrop('C:\\ws\\requests\\a\\req.http', 'C:\\ws\\requests\\a\\')).toBe('noop')
  })
})

describe('drag-source tracking', () => {
  afterEach(() => clearDragSource())

  it('mirrors the active drag between dragstart and dragend', () => {
    expect(getDragSource()).toBeNull()
    setDragSource('/ws/requests/a/req.http')
    expect(getDragSource()).toBe('/ws/requests/a/req.http')
    clearDragSource()
    expect(getDragSource()).toBeNull()
  })
})
