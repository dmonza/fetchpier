import { describe, expect, it } from 'vitest'
import { treeNameErrorMessage } from './tree-name-error'
import en from '../../i18n/locales/en.json'
import es from '../../i18n/locales/es.json'

const t = (key: string, opts?: { name?: string }): string => `${key}(${opts?.name ?? ''})`

describe('treeNameErrorMessage — create / rename errors the sidebar explains', () => {
  it('maps INVALID_ENTRY_NAME to the translated invalid-name message', () => {
    const err = new Error('INVALID_ENTRY_NAME: "Step 1: login" is not a valid name')
    expect(treeNameErrorMessage(err, 'Step 1: login', t)).toBe(
      'collection.errors.invalidEntryName(Step 1: login)'
    )
  })

  it('also recognizes the token in an IPC-wrapped message', () => {
    const err = new Error(
      'Error invoking remote method \'filesystem:rename\': Error: INVALID_ENTRY_NAME: "CON" is not a valid name'
    )
    expect(treeNameErrorMessage(err, 'CON', t)).toBe('collection.errors.invalidEntryName(CON)')
  })

  it.each(['REQUEST_NAME_CONFLICT', 'COLLECTION_NAME_CONFLICT'])(
    'maps %s to the name-conflict message',
    (token) => {
      expect(treeNameErrorMessage(new Error(`${token}: "a" exists`), 'a', t)).toBe(
        'collection.errors.nameConflict(a)'
      )
    }
  )

  it('returns null for any other error (left to the caller)', () => {
    expect(treeNameErrorMessage(new Error('EPERM: operation not permitted'), 'a', t)).toBeNull()
    expect(treeNameErrorMessage('boom', 'a', t)).toBeNull()
  })

  it('has the invalid-name message in both locales, with the name placeholder', () => {
    expect(en.collection.errors.invalidEntryName).toContain('{{name}}')
    expect(es.collection.errors.invalidEntryName).toContain('{{name}}')
  })
})
