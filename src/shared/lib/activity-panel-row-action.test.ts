import { describe, expect, it } from 'vitest'
import {
  MAX_ENTRY_ID_LENGTH,
  MAX_SOURCE_FILE_LENGTH,
  parseActivityPanelRowAction
} from './activity-panel-row-action'

describe('parseActivityPanelRowAction — accepted actions', () => {
  it.each([
    [{ kind: 'view', entryId: 'run-1' }],
    [{ kind: 'repeat', entryId: 'run-1' }],
    [{ kind: 'raw', entryId: 'run-1', method: 'GET', url: 'https://api.example.com/a' }],
    [{ kind: 'open-source-file', sourceFile: 'requests/users/list.http' }],
    [{ kind: 'open-source-file', sourceFile: 'requests\\users\\list.http' }]
  ])('accepts %o as is', (action) => {
    expect(parseActivityPanelRowAction(action)).toEqual(action)
  })

  it('drops properties the kind does not carry', () => {
    expect(
      parseActivityPanelRowAction({ kind: 'view', entryId: 'run-1', sourceFile: '../x', extra: 1 })
    ).toEqual({ kind: 'view', entryId: 'run-1' })
  })

  it('accepts an id and a path exactly at their length limits', () => {
    const id = 'a'.repeat(MAX_ENTRY_ID_LENGTH)
    expect(parseActivityPanelRowAction({ kind: 'view', entryId: id })).not.toBeNull()
    const path = 'r'.repeat(MAX_SOURCE_FILE_LENGTH)
    expect(
      parseActivityPanelRowAction({ kind: 'open-source-file', sourceFile: path })
    ).not.toBeNull()
  })

  it('accepts an empty method and URL in a raw action (they only title the tab)', () => {
    expect(
      parseActivityPanelRowAction({ kind: 'raw', entryId: 'run-1', method: '', url: '' })
    ).toEqual({ kind: 'raw', entryId: 'run-1', method: '', url: '' })
  })
})

describe('parseActivityPanelRowAction — refused input', () => {
  it.each([
    ['null', null],
    ['a string', 'view'],
    ['an array', [{ kind: 'view', entryId: 'run-1' }]],
    ['an unknown kind', { kind: 'delete', entryId: 'run-1' }],
    ['no kind', { entryId: 'run-1' }],
    ['a missing id', { kind: 'view' }],
    ['a non-string id', { kind: 'repeat', entryId: 42 }],
    ['an empty id', { kind: 'view', entryId: '' }],
    ['an id over the limit', { kind: 'view', entryId: 'a'.repeat(MAX_ENTRY_ID_LENGTH + 1) }],
    ['an id with a control character', { kind: 'view', entryId: 'run\n1' }],
    ['a raw action without a method', { kind: 'raw', entryId: 'run-1', url: 'u' }],
    [
      'a raw action with a non-string URL',
      { kind: 'raw', entryId: 'run-1', method: 'GET', url: 1 }
    ],
    [
      'a raw title with a control character',
      { kind: 'raw', entryId: 'r', method: 'G\u0000', url: '' }
    ],
    ['a missing source path', { kind: 'open-source-file' }],
    ['an empty source path', { kind: 'open-source-file', sourceFile: '' }],
    [
      'a source path over the limit',
      { kind: 'open-source-file', sourceFile: 'r'.repeat(MAX_SOURCE_FILE_LENGTH + 1) }
    ],
    ['a POSIX absolute source path', { kind: 'open-source-file', sourceFile: '/etc/passwd' }],
    ['a backslash-rooted source path', { kind: 'open-source-file', sourceFile: '\\x\\y.http' }],
    ['a drive-letter source path', { kind: 'open-source-file', sourceFile: 'C:/x/y.http' }],
    ['a source path climbing out', { kind: 'open-source-file', sourceFile: 'requests/../../x' }],
    ['a source path with a NUL', { kind: 'open-source-file', sourceFile: 'requests/a\u0000.http' }]
  ])('refuses %s', (_label, value) => {
    expect(parseActivityPanelRowAction(value)).toBeNull()
  })
})
