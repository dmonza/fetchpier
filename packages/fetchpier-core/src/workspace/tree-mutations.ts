// Request-tree mutations (REQ Core-owned workspace handle, F6). Relocated from the
// desktop adapter so the business rules — name-conflict refusal and the
// `*.instance.http` cascade over rename/move/delete — live in `@fetchpier/core`
// and are shared by every consumer. Every function takes the workspace path
// explicitly; the adapter's IPC handler is a thin validating/token-mapping shell.

import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  FsCascadeResult,
  FsDeleteResult,
  InstanceCascadePair,
  NameCheckInput,
  NameCheckResult
} from '@shared/types'
import { isSameFile } from './file-identity'
import {
  HTTP_SUFFIX,
  INSTANCE_SUFFIX,
  instanceFileName,
  isInstanceFileName,
  isValidInstanceName,
  splitInstanceName
} from '@shared/lib/request-instances'
import { assertSafeIdentifier, resolveInsideWorkspace } from './safe-path'
import { atomicWriteFile } from './atomic-write'
import { requestsRootPath } from './tree'

const HTTP_TEMPLATE = 'GET https://example.com\nContent-Type: application/json\n\n'

/** Whether `name` is a regular request file (`.http`, not `*.instance.http`). */
function isRegularRequestName(name: string): boolean {
  return name.endsWith(HTTP_SUFFIX) && !isInstanceFileName(name)
}

/**
 * The entry occupying `base` in `dir`, or null (REQ case-insensitive tree name
 * uniqueness). Names compare by lowercase fold on **all** platforms — the
 * uniqueness rule is the product's, not the filesystem's, so a workspace stays
 * valid when shared across operating systems. The check is uniform across both
 * kinds: a request (`<base>.http`) and a collection (folder `<base>`) cannot
 * share a name, so a collision with *either* form counts. `selfPath`, when
 * given, is excluded by **physical identity** (never by name): on a legacy
 * case-sensitive workspace a distinct casing-only sibling must stay a conflict,
 * or a rename would silently overwrite it.
 */
async function findNameCollision(
  dir: string,
  base: string,
  selfPath?: string
): Promise<'request' | 'collection' | null> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return null
  }
  const wantFile = `${base}${HTTP_SUFFIX}`.toLowerCase()
  const wantFolder = base.toLowerCase()
  for (const n of names) {
    const lower = n.toLowerCase()
    if (lower !== wantFile && lower !== wantFolder) continue
    if (selfPath && (await isSameFile(join(dir, n), selfPath))) continue
    return lower === wantFile ? 'request' : 'collection'
  }
  return null
}

/**
 * True if `fileName` is taken in `dir`, in any casing. `selfPath`, when given,
 * is excluded by **physical identity** — same rule and rationale as
 * `findNameCollision`: the entry that *is* the file being renamed is not an
 * occupant of its own target name, so a case-only rename proceeds, while a
 * distinct casing-only sibling still blocks it. Comparing against the real
 * directory entry is what makes this portable: the desired name may not exist
 * yet, and a path that cannot be stat'ed has no identity to compare.
 */
async function fileNameTaken(dir: string, fileName: string, selfPath?: string): Promise<boolean> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return false
  }
  const want = fileName.toLowerCase()
  for (const n of names) {
    if (n.toLowerCase() !== want) continue
    if (selfPath && (await isSameFile(join(dir, n), selfPath))) continue
    return true
  }
  return false
}

/**
 * Reject when a name is already taken in `dir` — create/rename never overwrite a
 * sibling (write-safety). See `findNameCollision` for the comparison rule. The
 * thrown token follows the operation's kind (`*_CONFLICT` convention the
 * renderer maps to i18n).
 */
async function assertNameAvailable(
  dir: string,
  base: string,
  kind: 'request' | 'collection',
  selfPath?: string
): Promise<void> {
  if (await findNameCollision(dir, base, selfPath)) {
    const token = kind === 'request' ? 'REQUEST_NAME_CONFLICT' : 'COLLECTION_NAME_CONFLICT'
    throw new Error(`${token}: "${base}" already exists in the target folder`)
  }
}

/** The regular-request stems among `names` — the binding set `splitInstanceName` needs. */
function regularStemsOf(names: readonly string[]): Set<string> {
  const stems = new Set<string>()
  for (const n of names) {
    if (!n.startsWith('.') && isRegularRequestName(n)) {
      stems.add(n.slice(0, -HTTP_SUFFIX.length))
    }
  }
  return stems
}

/**
 * Instance (`*.instance.http`) files in `dir` that bind to `parentStem`,
 * respecting the longest-prefix rule against the directory's regular stems.
 * Returns each instance's filename and the instance-name segment.
 */
async function findInstanceSiblings(
  dir: string,
  parentStem: string
): Promise<Array<{ name: string; instanceName: string }>> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const stems = regularStemsOf(names)
  const out: Array<{ name: string; instanceName: string }> = []
  for (const n of names) {
    if (n.startsWith('.') || !isInstanceFileName(n)) continue
    const split = splitInstanceName(n, stems)
    if (split && split.parentStem === parentStem) {
      out.push({ name: n, instanceName: split.instanceName })
    }
  }
  return out
}

/** Replace the first `# @id …` line with a fresh UUID (or prepend one). */
function withFreshRequestId(content: string): string {
  const idLine = `# @id ${randomUUID()}`
  const re = /^#\s*@id\s+\S.*$/im
  return re.test(content) ? content.replace(re, idLine) : `${idLine}\n${content}`
}

/**
 * Read-only name-availability verdict (REQ case-insensitive tree name
 * uniqueness §5.5) — the operation the UI's inline validation queries over the
 * adapter boundary. Applies exactly the rules the mutations enforce
 * (`findNameCollision` / `fileNameTaken`), but answers instead of throwing: a
 * collision is a verdict here, never an error. A missing parent folder answers
 * "available" — this is a name verdict, not a path check.
 */
export async function checkNameAvailable(
  workspacePath: string,
  input: NameCheckInput
): Promise<NameCheckResult> {
  if (input.kind === 'entry') {
    const dir = resolveInsideWorkspace(workspacePath, input.parentPath)
    const base = input.name.replace(/\.http$/, '')
    const selfPath = input.selfPath
      ? resolveInsideWorkspace(workspacePath, input.selfPath)
      : undefined
    const collision = await findNameCollision(dir, base, selfPath)
    return collision ? { available: false, conflict: collision } : { available: true }
  }
  // Instance filename derivation mirrors createInstance (parent request) and
  // duplicateInstance (source instance, longest-stem binding, orphan → orphan).
  const resolvedParent = resolveInsideWorkspace(workspacePath, input.parentPath)
  const dir = dirname(resolvedParent)
  const parentName = basename(resolvedParent)
  let fileName: string
  if (isInstanceFileName(parentName)) {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const split = splitInstanceName(parentName, regularStemsOf(names))
    fileName = split
      ? instanceFileName(split.parentStem, input.instanceName)
      : `${input.instanceName}${INSTANCE_SUFFIX}`
  } else {
    const stem = parentName.endsWith(HTTP_SUFFIX)
      ? parentName.slice(0, -HTTP_SUFFIX.length)
      : parentName
    fileName = instanceFileName(stem, input.instanceName)
  }
  return (await fileNameTaken(dir, fileName))
    ? { available: false, conflict: 'instance' }
    : { available: true }
}

/** Create a collection (folder) under `parentPath`, refusing a name collision. */
export async function createCollection(
  workspacePath: string,
  parentPath: string,
  name: string
): Promise<void> {
  assertSafeIdentifier(name, 'collection name')
  const parentDir = resolveInsideWorkspace(workspacePath, parentPath)
  await assertNameAvailable(parentDir, name, 'collection')
  const target = resolveInsideWorkspace(workspacePath, parentPath, name)
  await fs.mkdir(target, { recursive: true })
}

/** Create a request (`<name>.http`) under `parentPath`, refusing a collision. */
export async function createRequest(
  workspacePath: string,
  parentPath: string,
  name: string
): Promise<string> {
  const base = name.replace(/\.http$/, '')
  assertSafeIdentifier(base, 'request name')
  const parentDir = resolveInsideWorkspace(workspacePath, parentPath)
  await assertNameAvailable(parentDir, base, 'request')
  const target = resolveInsideWorkspace(workspacePath, parentPath, `${base}${HTTP_SUFFIX}`)
  await atomicWriteFile(target, HTTP_TEMPLATE)
  return target
}

/** Clone a parent request into `<stem>.<name>.instance.http` with a fresh `# @id`. */
export async function createInstance(
  workspacePath: string,
  parentPath: string,
  instanceName: string
): Promise<string> {
  const resolvedParent = resolveInsideWorkspace(workspacePath, parentPath)
  const parentName = basename(resolvedParent)
  if (isInstanceFileName(parentName)) {
    throw new Error('INSTANCE_OF_INSTANCE: cannot create an instance of an instance')
  }
  if (!isValidInstanceName(instanceName)) {
    throw new Error(`INVALID_INSTANCE_NAME: "${instanceName}" is not a valid instance name`)
  }
  const parentStem = parentName.endsWith(HTTP_SUFFIX)
    ? parentName.slice(0, -HTTP_SUFFIX.length)
    : parentName
  const fileName = instanceFileName(parentStem, instanceName)
  const dest = resolveInsideWorkspace(workspacePath, dirname(resolvedParent), fileName)
  if (await fileNameTaken(dirname(resolvedParent), fileName)) {
    throw new Error(`INSTANCE_NAME_CONFLICT: "${fileName}" already exists`)
  }
  const content = await fs.readFile(resolvedParent, 'utf8')
  await atomicWriteFile(dest, withFreshRequestId(content))
  return dest
}

/** Rename a request/collection, cascading over a regular request's instances. */
export async function renameEntry(
  workspacePath: string,
  oldPath: string,
  newName: string
): Promise<FsCascadeResult> {
  const resolvedOld = resolveInsideWorkspace(workspacePath, oldPath)
  assertSafeIdentifier(newName.replace(/\.http$/, ''), 'new name')
  const dir = dirname(resolvedOld)
  const newPath = resolveInsideWorkspace(workspacePath, dir, newName)
  const oldName = basename(resolvedOld)

  // Never rename over an existing sibling (request or collection). Skip the
  // check for a no-op rename (same resolved path) and exclude the source.
  if (newPath !== resolvedOld) {
    const newBase = basename(newPath).replace(/\.http$/, '')
    const kind = oldName.endsWith(HTTP_SUFFIX) ? 'request' : 'collection'
    await assertNameAvailable(dir, newBase, kind, resolvedOld)
  }

  // Find instance siblings BEFORE renaming the parent: the lookup binds them
  // by the parent's current stem, which disappears once the parent moves.
  let siblings: Array<{ name: string; instanceName: string }> = []
  let newStem = ''
  if (isRegularRequestName(oldName)) {
    const oldStem = oldName.slice(0, -HTTP_SUFFIX.length)
    newStem = basename(newPath).slice(0, -HTTP_SUFFIX.length)
    if (newStem !== oldStem) siblings = await findInstanceSiblings(dir, oldStem)
  }

  await fs.rename(resolvedOld, newPath)

  const instances: InstanceCascadePair[] = []
  for (const { name, instanceName } of siblings) {
    const from = resolveInsideWorkspace(workspacePath, dir, name)
    const to = resolveInsideWorkspace(workspacePath, dir, instanceFileName(newStem, instanceName))
    // Same rule as the parent: a case-insensitive occupant blocks the cascade,
    // unless that occupant is this very file (a case-only rename of the parent
    // stem). The exclusion compares `from` against the real directory entry —
    // comparing `from` with `to` cannot work, because on a case-sensitive
    // filesystem `to` does not exist yet and has no identity to compare.
    if (await fileNameTaken(dir, basename(to), from)) {
      console.warn(`[tree:rename] skipping instance "${name}": "${basename(to)}" already exists`)
      continue
    }
    await fs.rename(from, to)
    instances.push({ from, to })
  }
  return { newPath, instances }
}

/** Delete a request/collection, cascading over a regular request's instances. */
export async function deleteEntry(
  workspacePath: string,
  targetPath: string
): Promise<FsDeleteResult> {
  const resolved = resolveInsideWorkspace(workspacePath, targetPath)
  const name = basename(resolved)
  const dir = dirname(resolved)

  const deletedInstances: string[] = []
  if (isRegularRequestName(name)) {
    const stem = name.slice(0, -HTTP_SUFFIX.length)
    const siblings = await findInstanceSiblings(dir, stem)
    for (const { name: sibName } of siblings) {
      const sibPath = resolveInsideWorkspace(workspacePath, dir, sibName)
      await fs.rm(sibPath, { recursive: true, force: true })
      deletedInstances.push(sibPath)
    }
  }
  await fs.rm(resolved, { recursive: true, force: true })
  return { deletedInstances }
}

/** Move a request/collection into `targetFolder`, cascading over instances. */
export async function moveEntry(
  workspacePath: string,
  sourcePath: string,
  targetFolder: string
): Promise<FsCascadeResult> {
  const resolvedSource = resolveInsideWorkspace(workspacePath, sourcePath)
  const resolvedTarget = resolveInsideWorkspace(workspacePath, targetFolder)
  const name = basename(resolvedSource)
  const dest = resolveInsideWorkspace(workspacePath, resolvedTarget, name)
  const dir = dirname(resolvedSource)
  // The renderer pre-validates drops, but this is also reached via the Move-to
  // modal and future callers — guard here as the source of truth. The MOVE_*
  // tokens are stable: the renderer maps them to i18n.
  //
  // A destination that is the element's own folder is a silent no-op (REQ
  // case-insensitive tree name uniqueness §6.3) — decided by physical identity,
  // so a differently-cased path of the same folder also counts as "already
  // there" instead of surfacing a spurious conflict.
  if (dest === resolvedSource || (await isSameFile(dir, resolvedTarget))) {
    return { newPath: resolvedSource, instances: [] }
  }
  if (resolvedTarget === resolvedSource || resolvedTarget.startsWith(resolvedSource + sep)) {
    throw new Error(`MOVE_INTO_SELF: cannot move "${name}" into itself`)
  }
  // Uniform, case-insensitive uniqueness in the destination (same rule as
  // create/rename): `<base>.http` and folder `<base>` cannot coexist.
  const moveBase = name.endsWith(HTTP_SUFFIX) ? name.slice(0, -HTTP_SUFFIX.length) : name
  if (await findNameCollision(resolvedTarget, moveBase)) {
    throw new Error(`MOVE_CONFLICT: "${name}" already exists in the target folder`)
  }
  let siblings: Array<{ name: string; instanceName: string }> = []
  if (isRegularRequestName(name)) {
    siblings = await findInstanceSiblings(dir, name.slice(0, -HTTP_SUFFIX.length))
  }

  await fs.rename(resolvedSource, dest)

  const instances: InstanceCascadePair[] = []
  for (const { name: sibName } of siblings) {
    const from = resolveInsideWorkspace(workspacePath, dir, sibName)
    const to = resolveInsideWorkspace(workspacePath, resolvedTarget, sibName)
    if (await fileNameTaken(resolvedTarget, sibName)) {
      console.warn(`[tree:move] skipping instance "${sibName}": already exists in target`)
      continue
    }
    await fs.rename(from, to)
    instances.push({ from, to })
  }
  return { newPath: dest, instances }
}

/**
 * Find the first free `untitled-<n>.http` under `requests/` starting at `startN`,
 * ensuring `requests/` exists. Returns the absolute path and the bare name.
 */
export async function findAvailableUntitledPath(
  workspacePath: string,
  startN: number
): Promise<{ filePath: string; name: string }> {
  const root = requestsRootPath(workspacePath)
  await fs.mkdir(root, { recursive: true })
  let n = startN
  while (true) {
    const name = `untitled-${n}`
    const filePath = join(root, `${name}.http`)
    try {
      await fs.access(filePath)
      n++
    } catch {
      return { filePath, name }
    }
  }
}

/**
 * Duplicate an instance into a **sibling** instance of the same parent, under a
 * caller-supplied name and with a fresh `# @id`.
 *
 * Unlike `duplicateEntry`, the name is never auto-incremented past a collision:
 * the caller is holding the inline input and is told instead. The copy's parent
 * binding is resolved with the same longest-stem rule the tree reader uses —
 * never by suffixing the source's filename, which would silently produce a
 * regular request (`login.ok.instance-copy.http`) instead of an instance.
 * An orphan source (no parent request beside it) duplicates into another orphan.
 */
export async function duplicateInstance(
  workspacePath: string,
  sourcePath: string,
  instanceName: string
): Promise<string> {
  const resolved = resolveInsideWorkspace(workspacePath, sourcePath)
  const sourceName = basename(resolved)
  if (!isInstanceFileName(sourceName)) {
    throw new Error(`NOT_AN_INSTANCE: "${sourceName}" is not an instance file`)
  }
  if (!isValidInstanceName(instanceName)) {
    throw new Error(`INVALID_INSTANCE_NAME: "${instanceName}" is not a valid instance name`)
  }
  const dir = dirname(resolved)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const split = splitInstanceName(sourceName, regularStemsOf(names))
  const fileName = split
    ? instanceFileName(split.parentStem, instanceName)
    : `${instanceName}${INSTANCE_SUFFIX}`
  const dest = resolveInsideWorkspace(workspacePath, dir, fileName)
  if (await fileNameTaken(dir, fileName)) {
    throw new Error(`INSTANCE_NAME_CONFLICT: "${fileName}" already exists`)
  }
  const content = await fs.readFile(resolved, 'utf8')
  await atomicWriteFile(dest, withFreshRequestId(content))
  return dest
}

/**
 * Duplicate a file to `<base>-copy.http` (then `-copy-2`, …) in the same folder.
 *
 * A `.http` copy is born with its own identity (fresh `# @id`) rather than the
 * source's: two requests sharing one id would also share their per-request UI
 * state and history stream. Instances are refused — their name is structural,
 * so `-copy` would unbind them from the parent; they go through
 * `duplicateInstance`, which is name-aware.
 */
export async function duplicateEntry(workspacePath: string, filePath: string): Promise<string> {
  const resolved = resolveInsideWorkspace(workspacePath, filePath)
  const name = basename(resolved)
  if (isInstanceFileName(name)) {
    throw new Error(`DUPLICATE_OF_INSTANCE: "${name}" must be duplicated as an instance`)
  }
  const dir = dirname(resolved)
  const ext = extname(resolved)
  const base = basename(resolved, ext)
  // Find a unique name: name-copy.http, name-copy-2.http, etc.
  let dest = join(dir, `${base}-copy${ext}`)
  let counter = 2
  while (true) {
    try {
      await fs.access(dest)
      dest = join(dir, `${base}-copy-${counter}${ext}`)
      counter++
    } catch {
      break
    }
  }
  // Final safety check: the generated destination stays inside the workspace.
  const destSafe = resolveInsideWorkspace(workspacePath, dest)
  if (isRegularRequestName(name)) {
    const content = await fs.readFile(resolved, 'utf8')
    await atomicWriteFile(destSafe, withFreshRequestId(content))
  } else {
    await fs.copyFile(resolved, destSafe)
  }
  return destSafe
}
