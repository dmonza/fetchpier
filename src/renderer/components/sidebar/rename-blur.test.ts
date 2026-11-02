import { describe, it, expect, afterEach } from 'vitest'
import { blurLandsInPopupMenu, resolveRenameBlur } from './rename-blur'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('blurLandsInPopupMenu', () => {
  it('true when focus moves into a popup menu item (text context menu)', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    item.setAttribute('role', 'menuitem')
    menu.appendChild(item)
    document.body.appendChild(menu)
    expect(blurLandsInPopupMenu(item)).toBe(true)
  })

  it('true when focus moves to the menu container itself', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    expect(blurLandsInPopupMenu(menu)).toBe(true)
  })

  it('false when focus leaves to nowhere (null relatedTarget)', () => {
    expect(blurLandsInPopupMenu(null)).toBe(false)
  })

  it('false when focus moves to an unrelated element', () => {
    const other = document.createElement('button')
    document.body.appendChild(other)
    expect(blurLandsInPopupMenu(other)).toBe(false)
  })
})

describe('resolveRenameBlur', () => {
  it('ignores blur into the text context menu (edit survives)', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    item.setAttribute('role', 'menuitem')
    menu.appendChild(item)
    document.body.appendChild(menu)
    expect(resolveRenameBlur({ relatedTarget: item, isEmpty: false, hasConflict: false })).toBe(
      'ignore'
    )
  })

  it('commits when clicking away with a valid name (VSCode-style)', () => {
    expect(resolveRenameBlur({ relatedTarget: null, isEmpty: false, hasConflict: false })).toBe(
      'commit'
    )
  })

  it('cancels when the name is blank', () => {
    expect(resolveRenameBlur({ relatedTarget: null, isEmpty: true, hasConflict: false })).toBe(
      'cancel'
    )
  })

  it('cancels when the name conflicts with a sibling', () => {
    expect(resolveRenameBlur({ relatedTarget: null, isEmpty: false, hasConflict: true })).toBe(
      'cancel'
    )
  })

  it('a popup-menu blur is ignored even with a conflict (menu takes precedence)', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    expect(resolveRenameBlur({ relatedTarget: menu, isEmpty: false, hasConflict: true })).toBe(
      'ignore'
    )
  })
})
