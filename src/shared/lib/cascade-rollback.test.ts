import { describe, expect, it } from 'vitest'
import {
  CASCADE_ROLLBACK_FAILED,
  formatCascadeRollbackMessage,
  parseCascadeRollbackPaths
} from './cascade-rollback'

describe('cascade-rollback message contract', () => {
  it('leads with the token and round-trips the stranded paths', () => {
    const paths = ['requests/signin.http', 'requests/signin.ok.instance.http']
    const message = formatCascadeRollbackMessage(
      'rename',
      'requests/login.http',
      'EIO: i/o error',
      paths
    )
    expect(message.startsWith(`${CASCADE_ROLLBACK_FAILED}:`)).toBe(true)
    expect(message).toContain('requests/login.http')
    expect(message).toContain('EIO: i/o error')
    expect(parseCascadeRollbackPaths(message)).toEqual(paths)
  })

  it('round-trips names with spaces, unicode and brackets', () => {
    const paths = ['requests/my folder/ñandú [v2].http', 'requests/a]b.http']
    const message = formatCascadeRollbackMessage('move', 'requests/x.http', 'EBUSY', paths)
    expect(parseCascadeRollbackPaths(message)).toEqual(paths)
  })

  it('finds the list inside a message wrapped by the IPC boundary', () => {
    const inner = formatCascadeRollbackMessage('rename', 'requests/a.http', 'EIO', [
      'requests/b.http'
    ])
    const wrapped = `Error invoking remote method 'fs:rename': Error: ${inner}`
    expect(parseCascadeRollbackPaths(wrapped)).toEqual(['requests/b.http'])
  })

  it('returns null for any other error', () => {
    expect(parseCascadeRollbackPaths('EBUSY: resource busy or locked')).toBeNull()
    expect(parseCascadeRollbackPaths('')).toBeNull()
  })

  it('returns null when the token has no parsable list', () => {
    expect(parseCascadeRollbackPaths(`${CASCADE_ROLLBACK_FAILED}: something`)).toBeNull()
    expect(parseCascadeRollbackPaths(`${CASCADE_ROLLBACK_FAILED}: x\n{"a":1}`)).toBeNull()
    expect(parseCascadeRollbackPaths(`${CASCADE_ROLLBACK_FAILED}: x\n[1, 2]`)).toBeNull()
    expect(parseCascadeRollbackPaths(`${CASCADE_ROLLBACK_FAILED}: x\n[]`)).toBeNull()
    expect(parseCascadeRollbackPaths(`${CASCADE_ROLLBACK_FAILED}: x\n[not json`)).toBeNull()
  })
})
