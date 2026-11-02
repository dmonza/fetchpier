import { describe, it, expect, vi } from 'vitest'
import {
  commitMaterialization,
  computeEnvEntries,
  materializeVariable,
  orderEnvEntries,
  serializeVariables,
  variablesToRows,
  type VarRow
} from './environment-variables'
import type { Environment } from '../../shared/types'

function env(variables: Record<string, string | null>): Environment {
  return { id: 'e1', folder: 'e1', name: 'dev', variables }
}

describe('variablesToRows', () => {
  it('builds rows from plain entries only, leaving secrets to their own rows', () => {
    const rows = variablesToRows({ a: '1', s: 'enc:v1:xx', n: null, b: '2' })
    expect(rows.map((r) => r.key)).toEqual(['a', 'b'])
    expect(rows.every((r) => r.mapKey === r.key)).toBe(true)
  })
})

describe('serializeVariables', () => {
  it('keeps the map order and carries secret values verbatim', () => {
    const e = env({ a: '1', s: 'enc:v1:xx', b: '2' })
    const rows = variablesToRows(e.variables)
    expect(Object.keys(serializeVariables(rows, e, null))).toEqual(['a', 's', 'b'])
    expect(serializeVariables(rows, e, null).s).toBe('enc:v1:xx')
  })

  it('follows an explicit drag order', () => {
    const e = env({ a: '1', b: '2' })
    const rows = variablesToRows(e.variables)
    const entries = computeEnvEntries(rows, e)
    const reversed = orderEnvEntries(entries, [entries[1].id, entries[0].id]).map((x) => x.id)
    expect(Object.keys(serializeVariables(rows, e, reversed))).toEqual(['b', 'a'])
  })

  it('drops a map entry that has no matching row', () => {
    // The reason materialization must add a VarRow rather than write the map directly.
    const e = env({ a: '1', ghost: '2' })
    const rows = variablesToRows({ a: '1' })
    expect(Object.keys(serializeVariables(rows, e, null))).toEqual(['a'])
  })
})

describe('materializeVariable', () => {
  const shared = env({ a: '1', s: 'enc:v1:xx' })
  const rows = (): VarRow[] => variablesToRows(shared.variables)

  it('appends the unshared name at the end, after every shared entry', () => {
    const res = materializeVariable(rows(), shared, null, 'baseUrl', '')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(Object.keys(res.variables)).toEqual(['a', 's', 'baseUrl'])
    expect(res.variables.baseUrl).toBe('')
  })

  it('materializes with the Shared cell value when the user typed one', () => {
    const res = materializeVariable(rows(), shared, null, 'baseUrl', 'https://team.example.com')
    expect(res.ok && res.variables.baseUrl).toBe('https://team.example.com')
  })

  it('returns rows that keep the name on a subsequent serialize (no silent re-drop)', () => {
    const res = materializeVariable(rows(), shared, null, 'baseUrl', 'v')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const saved = env(res.variables as Record<string, string>)
    expect(Object.keys(serializeVariables(res.rows, saved, null))).toContain('baseUrl')
  })

  it('preserves an explicit drag order of the existing entries', () => {
    const r = rows()
    const entries = computeEnvEntries(r, shared)
    const dragOrder = [entries[1].id, entries[0].id]
    const res = materializeVariable(r, shared, dragOrder, 'baseUrl', '')
    expect(res.ok && Object.keys(res.variables)).toEqual(['s', 'a', 'baseUrl'])
  })

  it('rejects a name in the reserved system namespace', () => {
    expect(materializeVariable(rows(), shared, null, '$guid', '')).toEqual({
      ok: false,
      reason: 'reserved-name'
    })
  })

  it('rejects a shared value claiming the reserved ciphertext prefix', () => {
    expect(materializeVariable(rows(), shared, null, 'baseUrl', 'enc:v1:forged')).toEqual({
      ok: false,
      reason: 'reserved-prefix'
    })
  })

  it('never carries a local value — only the Shared cell reaches the map', () => {
    // The signature has no local-value parameter by design (REQ-0108 §6.1): the
    // materialized entry can only ever hold what the Shared cell held.
    const res = materializeVariable(rows(), shared, null, 'token', '')
    expect(res.ok && Object.values(res.variables)).not.toContain('local-secret-value')
  })
})

describe('commitMaterialization', () => {
  it('writes the shared file before clearing the local entry', async () => {
    const calls: string[] = []
    await commitMaterialization({
      saveShared: async () => void calls.push('shared'),
      clearLocal: async () => void calls.push('local')
    })
    expect(calls).toEqual(['shared', 'local'])
  })

  it('never clears the local entry when the shared write fails', async () => {
    const clearLocal = vi.fn(async () => undefined)
    await expect(
      commitMaterialization({
        saveShared: async () => {
          throw new Error('EACCES')
        },
        clearLocal
      })
    ).rejects.toThrow('EACCES')
    expect(clearLocal).not.toHaveBeenCalled()
  })

  it('keeps the local override when the gesture does not clear it', async () => {
    const saveShared = vi.fn(async () => undefined)
    await commitMaterialization({ saveShared })
    expect(saveShared).toHaveBeenCalledOnce()
  })
})
