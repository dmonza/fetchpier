import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { Environment } from '@shared/types'
import { isReservedVariableName } from '@shared/lib/dynamic-variables'
import { deriveEnvFolderName } from '@shared/lib/env-folder-name'
import { CoreError } from '../shared/context'
import { describeError } from '../shared/describe-error'
import { isEncryptedValue } from '../secrets/crypto'
import { assertSafeIdentifier, resolveInsideWorkspace } from './safe-path'
import { atomicWriteFile } from './atomic-write'

/** Top-level workspace folder that holds one sub-folder per environment. */
export const ENVIRONMENTS_DIR = 'environments'
/** Filename of the per-environment configuration inside its folder. */
export const ENV_CONFIG_FILE = 'config.json'

export function envDirPath(workspacePath: string): string {
  return join(workspacePath, ENVIRONMENTS_DIR)
}

/**
 * Absolute path of a single environment's folder.
 *
 * **Keyed by folder name, never by identifier.** The identifier is opaque and is
 * never a path segment; callers holding one resolve it first with
 * {@link resolveEnvFolder}.
 */
export function envFolderPath(workspacePath: string, folderName: string): string {
  return join(envDirPath(workspacePath), folderName)
}

/** Absolute path of a single environment's `config.json`. Keyed by folder name. */
export function envConfigPath(workspacePath: string, folderName: string): string {
  return join(envFolderPath(workspacePath, folderName), ENV_CONFIG_FILE)
}

/**
 * Read a `config.json` from an absolute file path. REQ-0076: the format is the
 * unified single-`variables` map (value shape classifies — plain string, `enc:`
 * ciphertext, or `null` needs-value). The legacy split shape is **not** supported:
 * a `secrets` key fails closed (never silently dropped) so no secret is lost and no
 * partial environment is exposed; the file must be migrated by moving its entries
 * into `variables`.
 */
export async function readEnvFile(filePath: string): Promise<Environment> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json: unknown = JSON.parse(raw)
  // A file that parses but has the wrong shape is as unreadable as one that does
  // not parse: rejecting it here sends it down the same path (the listing reports
  // it, the CLI warns or exits 4). Letting it through made a single hand-written
  // environment without a `name` crash every listing of the workspace.
  const invalid = (detail: string): CoreError =>
    new CoreError('WORKSPACE_INVALID', `Environment config "${filePath}": ${detail}`)
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw invalid('expected a JSON object')
  }
  const parsed = json as {
    id?: unknown
    name?: unknown
    variables?: unknown
    secrets?: unknown
  }
  if (typeof parsed.id !== 'string' || parsed.id === '') {
    throw invalid('"id" must be a non-empty string')
  }
  if (typeof parsed.name !== 'string' || parsed.name === '') {
    throw invalid('"name" must be a non-empty string')
  }
  if (
    parsed.variables !== undefined &&
    (parsed.variables === null ||
      typeof parsed.variables !== 'object' ||
      Array.isArray(parsed.variables))
  ) {
    throw invalid('"variables" must be an object')
  }
  if (parsed.secrets !== undefined) {
    throw new CoreError(
      'WORKSPACE_INVALID',
      `Environment config "${filePath}" uses the legacy split format (a "secrets" map). ` +
        `Move its entries into "variables" — an "enc:v1:" value stays a secret and ` +
        `null stays needs-value — and remove the "secrets" key.`,
      { environmentId: parsed.id }
    )
  }
  return {
    id: parsed.id,
    name: parsed.name,
    variables: (parsed.variables as Record<string, string | null> | undefined) ?? {},
    // The folder is data that already exists on disk; it is deliberately not a
    // field of the file (§5.2 — a second copy would be a second source of truth).
    folder: basename(dirname(filePath))
  }
}

/** Whether a value is in a *secret* shape: needs-value (`null`) or `enc:` ciphertext. */
export function isSecretValueShape(value: unknown): value is string | null {
  return value === null || isEncryptedValue(value)
}

/**
 * Atomically write an environment's `config.json` (temp + rename).
 *
 * Keyed by `env.folder`, which is validated here (no slashes/`..`/NUL) and
 * re-confined to the workspace, because it can arrive from on-disk content (e.g.
 * a Git-shared workspace) or from a renderer payload, not just from a validated
 * IPC argument — an unvalidated folder would let a crafted value drive a write
 * outside the workspace (REQ-0070 security review, Vuln 1).
 *
 * Only `{ id, name, variables }` is serialized: the folder is data that already
 * exists on disk and storing it twice would create a second source of truth.
 */
export async function writeEnvFile(workspacePath: string, env: Environment): Promise<void> {
  assertSafeIdentifier(env.folder, 'environment folder')
  const folder = resolveInsideWorkspace(workspacePath, envFolderPath(workspacePath, env.folder))
  const filePath = join(folder, ENV_CONFIG_FILE)
  const serialized = { id: env.id, name: env.name, variables: env.variables }
  await atomicWriteFile(filePath, JSON.stringify(serialized, null, 2))
}

/** Derive a folder name, refusing a name that survives the derivation as nothing. */
function deriveFolderOrThrow(name: string): string {
  const folder = deriveEnvFolderName(name)
  if (!folder) {
    throw new Error(
      `ENVIRONMENT_NAME_EMPTY: "${name}" contains no letter or digit, so it maps to no folder name`
    )
  }
  return folder
}

/**
 * Folder names currently under `environments/`, lowercased for the
 * case-insensitive uniqueness rule (§6.3 — the two dominant desktop platforms
 * have case-insensitive filesystems, so two names must not land in folders that
 * differ only by case).
 */
async function readEnvFolderNames(workspacePath: string): Promise<string[]> {
  const dir = envDirPath(workspacePath)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const folders: string[] = []
  for (const entry of entries) {
    try {
      const stat = await fs.stat(join(dir, entry))
      if (stat.isDirectory()) folders.push(entry)
    } catch {
      // Skip unreadable entries.
    }
  }
  return folders
}

/**
 * Reject `folder` when another environment already occupies it. `exceptFolder`
 * is the folder the operation's own environment currently sits in, so renaming
 * to a name that derives to the folder it already occupies is not a collision.
 * The product never invents a disambiguated name: the folder is the public handle
 * a pipeline will use, so it must be one the user chose (§6.3).
 */
async function assertFolderAvailable(
  workspacePath: string,
  folder: string,
  exceptFolder?: string
): Promise<void> {
  const target = folder.toLowerCase()
  if (exceptFolder && exceptFolder.toLowerCase() === target) return
  for (const existing of await readEnvFolderNames(workspacePath)) {
    if (existing.toLowerCase() !== target) continue
    let occupant = existing
    try {
      occupant = (await readEnvFile(envConfigPath(workspacePath, existing))).name
    } catch {
      // Folder without a readable config still occupies the name.
    }
    throw new Error(
      `ENVIRONMENT_NAME_CONFLICT: folder "${existing}" is already used by environment "${occupant}"`
    )
  }
}

/**
 * Check, without writing anything, that `name` can create a new environment:
 * it derives to a folder (`ENVIRONMENT_NAME_EMPTY` otherwise) that nothing under
 * `environments/` occupies (`ENVIRONMENT_NAME_CONFLICT` otherwise) — the same
 * rule `createEnvironmentFile` applies. Lets a caller that writes other files
 * first fail before it has written any of them. Returns the derived folder.
 */
export async function assertEnvironmentNameAvailable(
  workspacePath: string,
  name: string
): Promise<string> {
  const folder = deriveFolderOrThrow(name)
  await assertFolderAvailable(workspacePath, folder)
  return folder
}

/**
 * Resolve an opaque identifier to the folder that holds it (§6.10).
 *
 * The fast path covers every workspace created before the identity split (and
 * every legacy identifier, which is kept verbatim): if `environments/<id>/` holds
 * a config whose own `id` is `<id>`, that is the folder — one `readFile`, which is
 * what keeps the send hot path bounded (the cookie jar resolves twice per
 * request). Otherwise the directory is scanned.
 *
 * Never falls back to interpreting the identifier as a folder name: doing so
 * could address — or create — an unintended folder.
 */
export async function resolveEnvFolder(workspacePath: string, envId: string): Promise<string> {
  if (isSafeFolderSegment(envId)) {
    try {
      const direct = await readEnvFile(envConfigPath(workspacePath, envId))
      if (direct.id === envId) return envId
    } catch {
      // No such folder, or it holds a different environment — fall through.
    }
  }

  for (const folder of await readEnvFolderNames(workspacePath)) {
    if (folder === envId) continue // already tried on the fast path
    try {
      const env = await readEnvFile(envConfigPath(workspacePath, folder))
      if (env.id === envId) return folder
    } catch {
      // Skip folders without a readable config.json.
    }
  }

  throw new CoreError(
    'ENVIRONMENT_NOT_FOUND',
    `No environment with id "${envId}" exists in this workspace.`,
    { environmentId: envId }
  )
}

/** Whether a string may be used as a single path segment (see `assertSafeIdentifier`). */
function isSafeFolderSegment(value: string): boolean {
  try {
    assertSafeIdentifier(value, 'environment folder')
    return true
  } catch {
    return false
  }
}

/**
 * Create a new environment: derive its folder from the name the user typed,
 * reject an empty derivation or a taken folder (§6.3), generate a fresh opaque
 * identifier, and write the configuration file.
 *
 * The identifier is opaque and never becomes a path segment, so it carries no
 * meaning and is never parsed — a legacy slug-shaped one is as valid as this.
 */
export async function createEnvironmentFile(
  workspacePath: string,
  name: string,
  variables: Record<string, string | null> = {}
): Promise<Environment> {
  const folder = deriveFolderOrThrow(name)
  await assertFolderAvailable(workspacePath, folder)

  const env: Environment = { id: randomUUID(), name, variables, folder }
  await fs.mkdir(resolveInsideWorkspace(workspacePath, envFolderPath(workspacePath, folder)), {
    recursive: true
  })
  await writeEnvFile(workspacePath, env)
  return env
}

/**
 * Rename an environment (§6.4): renames the folder, then writes the new display
 * name. The identifier is untouched, so the personal workspace state never has to
 * be re-pointed and an active environment stays active. Because the folder moves
 * as a unit, its machine-local `.state/` (cookie jar, local value overrides) moves
 * with it — there is no cascade and no window in which it is orphaned.
 *
 * The folder rename runs **first**: if it fails (permissions, a lock held by
 * another process) the display name is not written either, so the environment is
 * left exactly as it was (§7.2).
 */
export async function renameEnvironment(
  workspacePath: string,
  envId: string,
  newName: string
): Promise<Environment> {
  const currentFolder = await resolveEnvFolder(workspacePath, envId)
  const nextFolder = deriveFolderOrThrow(newName)
  await assertFolderAvailable(workspacePath, nextFolder, currentFolder)

  if (nextFolder.toLowerCase() !== currentFolder.toLowerCase()) {
    await fs.rename(
      resolveInsideWorkspace(workspacePath, envFolderPath(workspacePath, currentFolder)),
      resolveInsideWorkspace(workspacePath, envFolderPath(workspacePath, nextFolder))
    )
  }

  const landedFolder =
    nextFolder.toLowerCase() === currentFolder.toLowerCase() ? currentFolder : nextFolder
  const existing = await readEnvFile(envConfigPath(workspacePath, landedFolder))
  const renamed: Environment = { ...existing, name: newName, folder: landedFolder }
  await writeEnvFile(workspacePath, renamed)
  return renamed
}

/**
 * Duplicate an environment (§6.5): behaves exactly as create, with the source's
 * variables map as the initial one. Plain values, `enc:` ciphertext and
 * needs-value entries all copy verbatim — a secret's AEAD associated data is the
 * variable name rather than the environment, so ciphertext keeps decrypting after
 * the copy. Machine-local state is **not** copied: it is personal to one machine
 * and excluded from version control, while duplicating is a gesture on the shared
 * artifact.
 */
export async function duplicateEnvironment(
  workspacePath: string,
  sourceEnvId: string,
  newName: string
): Promise<Environment> {
  const sourceFolder = await resolveEnvFolder(workspacePath, sourceEnvId)
  const source = await readEnvFile(envConfigPath(workspacePath, sourceFolder))
  return createEnvironmentFile(workspacePath, newName, { ...source.variables })
}

/**
 * List the folder names under `environments/`.
 * Lightweight: a `readdir` + `stat` per entry, without reading each `config.json`.
 * Returns `[]` when the directory is absent.
 */
export async function listEnvironmentFolders(workspacePath: string): Promise<string[]> {
  const dir = envDirPath(workspacePath)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const entry of entries) {
    try {
      const stat = await fs.stat(envFolderPath(workspacePath, entry))
      if (stat.isDirectory()) ids.push(entry)
    } catch {
      // Skip unreadable entries.
    }
  }
  return ids
}

/**
 * List every environment with a readable `config.json`, each carrying the folder
 * it was found in so a caller can resolve its paths without a second lookup.
 * Folders without a valid config (in-progress edits, unrelated content) are
 * skipped. Returns `[]` when the `environments/` directory is absent.
 *
 * **Display-name repair.** The folder is the environment's name and the
 * filesystem owns the truth, so a folder renamed by hand (or through a
 * version-control operation) *is* a rename. Because the derivation is
 * deterministic the divergence is detectable, and this is where it is detected:
 * the folder name becomes the display name and `config.json` is repaired to match,
 * so there is no window in which the file disagrees with the folder. The folder is
 * **never** renamed back — the product does not move a user's files (§6.8).
 *
 * The repair is best-effort: a write failure (read-only workspace, permissions) is
 * swallowed and the folder name is still what the caller sees.
 */
export async function listEnvironments(workspacePath: string): Promise<Environment[]> {
  return (await listEnvironmentsWithErrors(workspacePath)).environments
}

/** An environment folder whose `config.json` exists but cannot be read or parsed. */
export interface UnreadableEnvironment {
  folder: string
  /** Absolute path of the unreadable `config.json`. */
  file: string
  reason: string
}

/**
 * {@link listEnvironments}, also reporting the folders whose `config.json`
 * exists but cannot be read — so a caller can say "could not be read" instead of
 * letting the environment look absent. A folder with no `config.json` at all is
 * not an environment and is not reported. Same repair rule as the plain listing.
 */
export async function listEnvironmentsWithErrors(
  workspacePath: string
): Promise<{ environments: Environment[]; unreadable: UnreadableEnvironment[] }> {
  const envs: Environment[] = []
  const unreadable: UnreadableEnvironment[] = []
  for (const folder of await readEnvFolderNames(workspacePath)) {
    let env: Environment
    const file = envConfigPath(workspacePath, folder)
    try {
      env = await readEnvFile(file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        unreadable.push({ folder, file, reason: describeError(err) })
      }
      continue // Skip folders without a readable config.json.
    }
    // Compare case-insensitively and repair to the folder verbatim: the
    // derivation lowercases, so a hand-created `Staging/` folder would otherwise
    // be "repaired" on every single read. A name equal to the folder is the
    // repair's fixed point even when the folder is not in derived form
    // (`prod_eu`, `qa.v2`, `My Env`), so it is never rewritten again.
    if (env.name !== folder && deriveEnvFolderName(env.name) !== folder.toLowerCase()) {
      env = { ...env, name: folder }
      await writeEnvFile(workspacePath, env).catch(() => undefined)
    }
    envs.push(env)
  }
  return { environments: envs, unreadable }
}

/**
 * Remove an environment's whole folder, including its `.state/` (cookies, local
 * values). The identifier is resolved to a folder first, so a stale identifier
 * surfaces as `ENVIRONMENT_NOT_FOUND` rather than silently removing nothing —
 * or, worse, a folder that merely happens to be named after it (§6.10).
 */
export async function deleteEnvironment(workspacePath: string, envId: string): Promise<void> {
  const folderName = await resolveEnvFolder(workspacePath, envId)
  const folder = resolveInsideWorkspace(workspacePath, envFolderPath(workspacePath, folderName))
  await fs.rm(folder, { recursive: true, force: true })
}

/**
 * Persist an environment's `config.json` with the concurrent-edit merge
 * (REQ-0076/0079). The renderer only manages plain `variables`; on-disk
 * secret-shaped entries (`enc:`/`null`) keep their authoritative disk value and
 * are never round-tripped as ciphertext through the editor. A plain value
 * claiming the reserved `enc:` prefix is rejected; a `$`-prefixed name is rejected
 * (reserved for system dynamic variables, REQ-0087).
 *
 * The map is written in the renderer's key order (a reorder persists). The saver
 * only owns the variables it actually changed relative to its pre-edit `baseline`;
 * variables it did not touch keep their current on-disk value, so a concurrent
 * editor's change to a *different* variable is never clobbered. Without a baseline
 * every plain entry is treated as changed → last-writer-wins. Secrets present on
 * disk but absent from the payload are appended so secret material is never dropped.
 */
export async function saveEnvironment(
  workspacePath: string,
  env: Environment,
  baseline?: Record<string, string | null>
): Promise<void> {
  // The target folder is resolved from the opaque id, never from the caller's
  // `folder` — a renderer payload must not be able to redirect the write, and the
  // folder may have changed since the editor loaded it (§6.10, resolve close to
  // the write).
  const folder = await resolveEnvFolder(workspacePath, env.id)

  // Variable names are arbitrary, so every map here has no prototype and every
  // membership test is own-property: a variable named `constructor`, `toString`
  // or `__proto__` is an ordinary name, never an inherited member.
  const disk: Record<string, string | null> = Object.create(null)
  const secretShaped: Record<string, string | null> = Object.create(null)
  try {
    const existing = await readEnvFile(envConfigPath(workspacePath, folder))
    for (const [name, value] of Object.entries(existing.variables)) {
      disk[name] = value
      if (value === null || isEncryptedValue(value)) secretShaped[name] = value
    }
  } catch {
    // New environment or unreadable — nothing to preserve.
  }

  const changedBySaver = (name: string, value: string | null): boolean =>
    !baseline || !Object.hasOwn(baseline, name) || baseline[name] !== value

  const variables: Record<string, string | null> = Object.create(null)
  for (const [name, value] of Object.entries(env.variables)) {
    if (isReservedVariableName(name)) {
      throw new CoreError(
        'RESERVED_VARIABLE_NAME',
        `env:save — variable name "${name}" begins with "$", which is reserved for system dynamic variables.`
      )
    }
    if (Object.hasOwn(secretShaped, name)) {
      variables[name] = secretShaped[name] // authoritative disk value at the renderer's position
      continue
    }
    if (value !== null && isEncryptedValue(value)) {
      throw new Error(
        `env:save — value for "${name}" starts with "enc:", which is reserved for encrypted secrets.`
      )
    }
    if (changedBySaver(name, value)) {
      if (value === null) continue // needs-value with no on-disk secret: nothing to persist
      variables[name] = value
    } else if (Object.hasOwn(disk, name)) {
      if (disk[name] !== null) variables[name] = disk[name]
    } else if (value !== null) {
      variables[name] = value
    }
  }

  for (const [name, value] of Object.entries(disk)) {
    if (Object.hasOwn(variables, name) || Object.hasOwn(env.variables, name)) continue
    const isSecret = value === null || isEncryptedValue(value)
    if (isSecret) {
      variables[name] = value
      continue
    }
    if (baseline && Object.hasOwn(baseline, name)) continue // saver deleted it
    variables[name] = value // concurrently added elsewhere
  }

  await writeEnvFile(workspacePath, { id: env.id, name: env.name, variables, folder })
}
