/**
 * Pure model behind the environment variables table (REQ-0079 ordered list,
 * REQ-0108 unshared variables). Extracted from `EnvironmentManager.tsx` so the
 * ordering, serialization and materialization rules are unit-testable without
 * rendering the modal — the component keeps only rendering and I/O.
 */
import type { Environment } from '../../shared/types'
import { isReservedVariableName } from '../../shared/lib/dynamic-variables'

/** The reserved ciphertext prefix — a plain value may never claim it (REQ-0076). */
export const RESERVED_PREFIX = 'enc:'

export interface VarRow {
  id: string
  key: string
  value: string
  /**
   * The persisted key this row represents, captured at load. Used to match the row
   * to its entry in the variables map (REQ-0079 single ordered list) so a row keeps
   * its position while its key is being edited. `undefined` for new/blank rows.
   */
  mapKey?: string
}

let rowIdCounter = 0
export function newRow(): VarRow {
  return { id: `var-${rowIdCounter++}`, key: '', value: '' }
}

export function isEncValue(value: string | null): value is string {
  return typeof value === 'string' && value.startsWith(RESERVED_PREFIX)
}

/** A secret-shaped value: `enc:` ciphertext or `null` (needs-value). */
export function isSecretShape(value: string | null): boolean {
  return value === null || isEncValue(value)
}

/** Build editable rows from the *plain* entries only (secret/needs-value have their own rows). */
export function variablesToRows(variables: Record<string, string | null>): VarRow[] {
  return Object.entries(variables)
    .filter((entry): entry is [string, string] => !isSecretShape(entry[1]))
    .map(([key, value]) => ({
      id: `var-${rowIdCounter++}`,
      key,
      value,
      mapKey: key
    }))
}

// ── Unified ordered list (REQ-0079) ──────────────────────────────────────────
// Plain and secret variables render as a single drag-reorderable list whose order
// is the `variables` map's key order. Each entry carries a stable id: a plain row's
// `VarRow.id`, or `secret:<name>` for a secret. An unshared variable (REQ-0108) is
// not part of this list until it reaches `config.json` — until then it has no slot
// to persist an order into, which is why it carries no drag handle.

export type EnvEntry =
  | { id: string; kind: 'plain'; row: VarRow }
  | { id: string; kind: 'secret'; name: string; value: string | null }

/**
 * Build the natural entry order from the map: secrets inline at their map position,
 * plain entries matched to their editable row (by captured `mapKey`, falling back to
 * the live key so a just-renamed row still matches post-save). Rows not bound to any
 * map key (new/blank/unsaved) trail at the end in row order.
 */
export function computeEnvEntries(rows: VarRow[], env: Environment | null): EnvEntry[] {
  if (!env) return []
  const entries: EnvEntry[] = []
  const usedRowIds = new Set<string>()
  const takeRow = (name: string): VarRow | undefined => {
    let r = rows.find((x) => !usedRowIds.has(x.id) && x.mapKey === name)
    if (!r) r = rows.find((x) => !usedRowIds.has(x.id) && x.key.trim() === name)
    if (r) usedRowIds.add(r.id)
    return r
  }
  for (const [name, value] of Object.entries(env.variables)) {
    if (isSecretShape(value)) {
      entries.push({ id: `secret:${name}`, kind: 'secret', name, value })
    } else {
      const row = takeRow(name)
      if (row) entries.push({ id: row.id, kind: 'plain', row })
    }
  }
  for (const row of rows) {
    if (!usedRowIds.has(row.id)) entries.push({ id: row.id, kind: 'plain', row })
  }
  return entries
}

/** Reorder entries to follow an explicit id order; unknown/new entries trail in natural order. */
export function orderEnvEntries(entries: EnvEntry[], order: string[] | null): EnvEntry[] {
  if (!order) return entries
  const byId = new Map(entries.map((e) => [e.id, e]))
  const out: EnvEntry[] = []
  const seen = new Set<string>()
  for (const id of order) {
    const e = byId.get(id)
    if (e) {
      out.push(e)
      seen.add(id)
    }
  }
  for (const e of entries) if (!seen.has(e.id)) out.push(e)
  return out
}

/**
 * Serialize ordered entries back into a `variables` map in display order. Secret
 * *values* are carried verbatim (their position follows the list; `env:save` resolves
 * the authoritative ciphertext from disk). Plain rows contribute their live key/value;
 * blank rows are skipped.
 */
export function envEntriesToVariables(
  ordered: EnvEntry[],
  env: Environment
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const e of ordered) {
    if (e.kind === 'secret') {
      out[e.name] = env.variables[e.name] ?? e.value
    } else {
      const key = e.row.key.trim()
      if (key) out[key] = e.row.value
    }
  }
  return out
}

/** The `variables` map for the current rows in display order (what `env:save` receives). */
export function serializeVariables(
  rows: VarRow[],
  env: Environment,
  dragOrder: string[] | null
): Record<string, string | null> {
  return envEntriesToVariables(orderEnvEntries(computeEnvEntries(rows, env), dragOrder), env)
}

// ── Materialization of an unshared variable (REQ-0108) ───────────────────────

/** Why a materialization was refused. Maps 1:1 to an inline editor message. */
export type MaterializeRejection = 'reserved-name' | 'reserved-prefix'

export type MaterializeResult =
  | { ok: true; rows: VarRow[]; variables: Record<string, string | null> }
  | { ok: false; reason: MaterializeRejection }

/**
 * REQ-0108 §6.5/§6.6 — give an unshared variable an entry in the shared environment
 * file. The name is appended as a `VarRow`, not written straight into the map: an
 * entry with no matching row is dropped by {@link computeEnvEntries}, so writing the
 * map alone would make the next field blur delete the name again.
 *
 * The row lands at the end of the list, which is where unshared rows are displayed,
 * so the materialized name keeps the position it visibly occupied.
 *
 * The value is the Shared cell's content — never the local one. A local value only
 * ever travels shared → local (§6.1), so this function has no access to it by design.
 */
export function materializeVariable(
  rows: VarRow[],
  env: Environment,
  dragOrder: string[] | null,
  name: string,
  sharedValue: string
): MaterializeResult {
  if (isReservedVariableName(name)) return { ok: false, reason: 'reserved-name' }
  if (sharedValue.startsWith(RESERVED_PREFIX)) return { ok: false, reason: 'reserved-prefix' }
  const nextRows = [
    ...rows,
    { id: `var-${rowIdCounter++}`, key: name, value: sharedValue, mapKey: name }
  ]
  return { ok: true, rows: nextRows, variables: serializeVariables(nextRows, env, dragOrder) }
}

/**
 * REQ-0108 §6.8 — the write sequence shared by both materialization gestures.
 * The shared file commits **first**; the local entry is cleared only after it
 * succeeded, so a failed write can never leave the value destroyed against a shared
 * entry that does not exist. `clearLocal` is omitted when the gesture keeps the local
 * override (editing the Shared cell, §6.5).
 */
export async function commitMaterialization(io: {
  saveShared: () => Promise<void>
  clearLocal?: () => Promise<void>
}): Promise<void> {
  await io.saveShared()
  if (io.clearLocal) await io.clearLocal()
}
