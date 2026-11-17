import { describe, expect, it } from 'vitest'
import { formatCascadeRollbackMessage } from '@shared/lib/cascade-rollback'
import { treeMutationErrorToast, treeNameErrorMessage } from './tree-name-error'
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

// ISS-0175 — every failed rename/move says so; one whose undo also failed names
// the files left at their new location.
describe('treeMutationErrorToast — rename / move failures', () => {
  const tp = (key: string, opts?: { name?: string; paths?: string }): string =>
    `${key}(${opts?.name ?? opts?.paths ?? ''})`
  const rollbackError = new Error(
    `Error invoking remote method 'fs:rename': Error: ${formatCascadeRollbackMessage(
      'rename',
      'requests/login.http',
      'EIO',
      ['requests/signin.http', 'requests/signin.ok.instance.http']
    )}`
  )

  it('shows the generic rename message for a non-name failure (was console-only)', () => {
    expect(treeMutationErrorToast(new Error('EBUSY: locked'), 'rename', 'signin', tp)).toEqual({
      message: 'collection.errors.rename()'
    })
  })

  it('keeps the name messages for a rename', () => {
    expect(
      treeMutationErrorToast(new Error('REQUEST_NAME_CONFLICT: x'), 'rename', 'b', tp).message
    ).toBe('collection.errors.nameConflict(b)')
    expect(
      treeMutationErrorToast(new Error('INVALID_ENTRY_NAME: x'), 'rename', 'CON', tp).message
    ).toBe('collection.errors.invalidEntryName(CON)')
  })

  it('keeps the move messages', () => {
    expect(treeMutationErrorToast(new Error('MOVE_CONFLICT: x'), 'move', 'login', tp).message).toBe(
      'collection.errors.moveConflict(login)'
    )
    expect(treeMutationErrorToast(new Error('MOVE_INTO_SELF: x'), 'move', 'col', tp).message).toBe(
      'collection.errors.moveIntoItself()'
    )
    expect(treeMutationErrorToast(new Error('EIO'), 'move', 'login', tp).message).toBe(
      'collection.errors.move()'
    )
  })

  it.each(['rename', 'move'] as const)(
    'names the stranded files, longer-lived, when the undo of a %s failed',
    (op) => {
      expect(treeMutationErrorToast(rollbackError, op, 'signin', tp)).toEqual({
        message:
          'collection.errors.cascadeRollbackFailed(requests/signin.http, requests/signin.ok.instance.http)',
        durationMs: 10_000
      })
    }
  )

  it('falls back to the generic message when the token carries no list', () => {
    const err = new Error('CASCADE_ROLLBACK_FAILED: garbled')
    expect(treeMutationErrorToast(err, 'rename', 'a', tp)).toEqual({
      message: 'collection.errors.rename()'
    })
  })

  it('has the rollback message in both locales, with the paths placeholder', () => {
    expect(en.collection.errors.cascadeRollbackFailed).toContain('{{paths}}')
    expect(es.collection.errors.cascadeRollbackFailed).toContain('{{paths}}')
  })
})
