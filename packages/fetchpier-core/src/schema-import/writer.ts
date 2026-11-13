import { promises as fs } from 'fs'
import type {
  IntermediateSchema,
  SchemaImportWarning,
  SchemaConflictStrategy,
  IntermediateOperation,
  PostmanImportOptions,
  Environment
} from '@shared/types'
import { serializeRequest } from '@shared/lib/http-serializer'
import { sanitizeName } from './sanitize'
import {
  assertEnvironmentNameAvailable,
  createEnvironmentFile,
  envConfigPath,
  resolveEnvFolder,
  envDirPath,
  readEnvFile,
  writeEnvFile
} from '../workspace/environments'
import { resolveInsideWorkspace } from '../workspace/safe-path'
import { atomicWriteFile } from '../workspace/atomic-write'

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export interface WriteOptions {
  targetFolder: string
  collectionName: string
  conflictStrategy: SchemaConflictStrategy
  /** Workspace root. Required — used to confine every write under the workspace. */
  workspacePath: string
  /** Postman-specific options (only honored when the schema carries `envVariables`). */
  postman?: PostmanImportOptions
  onProgress?: (current: number, total: number, message?: string) => void
}

export interface WriteResult {
  collectionPath: string
  operationsCreated: number
  foldersCreated: number
  warnings: SchemaImportWarning[]
  /** File stem (id) of an env created by this write. */
  environmentCreated?: string
  /** Id of an env that was merged into by this write. */
  environmentMerged?: string
}

export async function writeSchemaToDisk(
  schema: IntermediateSchema,
  opts: WriteOptions
): Promise<WriteResult> {
  if (!opts.workspacePath) {
    throw new Error('writeSchemaToDisk: workspacePath is required')
  }
  const warnings: SchemaImportWarning[] = []
  const collectionDirName = sanitizeName(opts.collectionName, 'api-schema')
  // Confine every write under the active workspace.
  const safeTargetFolder = resolveInsideWorkspace(opts.workspacePath, opts.targetFolder)
  const collectionPath = resolveInsideWorkspace(
    opts.workspacePath,
    safeTargetFolder,
    collectionDirName
  )

  const alreadyExists = await exists(collectionPath)
  if (alreadyExists) {
    if (opts.conflictStrategy === 'abort') {
      // The code leads the message (it does not survive IPC as a property); the
      // collection is named by its folder, never by an absolute path.
      throw new Error(`TARGET_EXISTS: collection folder "${collectionDirName}" already exists`)
    }
    // 'merge' → keep existing folder, skip colliding files. There is no
    // destructive option: an existing collection is never wiped (REQ write-safety).
  }

  // Environment handling is Postman-only and runs after the requests are
  // written, so a new environment's name is checked here, before any write:
  // a taken folder (even one with no config.json) must not leave the import
  // half done.
  const postman = opts.postman
  const envVars = schema.envVariables
  const handlesEnv =
    !!postman &&
    postman.environmentStrategy !== 'none' &&
    !!envVars &&
    Object.keys(envVars).length > 0
  const newEnvName = (
    postman?.environmentName?.trim() ||
    opts.collectionName ||
    'imported'
  ).toString()
  if (handlesEnv && postman.environmentStrategy === 'new') {
    await assertEnvironmentNameAvailable(opts.workspacePath, newEnvName)
  }

  await fs.mkdir(collectionPath, { recursive: true })

  const foldersCreated = new Set<string>()
  const run: RunState = { written: new Set(), existing: new Map() }
  let operationsCreated = 0

  const total = schema.operations.length
  let current = 0
  for (const op of schema.operations) {
    current++
    opts.onProgress?.(current, total, op.displayName)
    try {
      const written = await writeOperation(
        op,
        collectionPath,
        opts.workspacePath,
        warnings,
        foldersCreated,
        run
      )
      if (written) operationsCreated++
    } catch (err) {
      warnings.push({
        kind: 'skipped-operation',
        message: (err as Error).message,
        location: `${op.folderPath.join('/')}/${op.name}`
      })
    }
  }

  // Environment handling (Postman-only)
  let environmentCreated: string | undefined
  let environmentMerged: string | undefined
  if (handlesEnv && postman && envVars) {
    const envDir = resolveInsideWorkspace(opts.workspacePath, envDirPath(opts.workspacePath))
    await fs.mkdir(envDir, { recursive: true })

    if (postman.environmentStrategy === 'new') {
      const env = await createEnvironmentFile(opts.workspacePath, newEnvName, { ...envVars })
      // The user-facing handle is the folder, not the opaque identifier.
      environmentCreated = env.folder
    } else if (postman.environmentStrategy === 'merge' && postman.mergeEnvironmentId) {
      try {
        // The merge target is addressed by its opaque identifier; resolve it to a
        // folder rather than treating it as one (§6.10).
        const targetFolder = await resolveEnvFolder(opts.workspacePath, postman.mergeEnvironmentId)
        const envPath = resolveInsideWorkspace(
          opts.workspacePath,
          envConfigPath(opts.workspacePath, targetFolder)
        )
        const env = await readEnvFile(envPath)
        // Existing vars take precedence and keep the order the user set (it is
        // meaningful and persisted); only missing keys are appended.
        const variables = { ...env.variables }
        for (const [key, value] of Object.entries(envVars)) {
          if (!Object.hasOwn(variables, key)) variables[key] = value
        }
        const merged: Environment = {
          ...env,
          // Pin the folder explicitly rather than trusting the parsed file — the
          // write must land in the folder we just resolved, nowhere else.
          folder: targetFolder,
          variables
        }
        await writeEnvFile(opts.workspacePath, merged)
        environmentMerged = targetFolder
      } catch (err) {
        warnings.push({
          kind: 'other',
          message: `Could not merge into environment "${postman.mergeEnvironmentId}": ${(err as Error).message}`
        })
      }
    } else if (postman.environmentStrategy === 'merge' && !postman.mergeEnvironmentId) {
      warnings.push({
        kind: 'other',
        message: 'Environment merge requested but no active environment id was provided'
      })
    }
  }

  return {
    collectionPath,
    operationsCreated,
    foldersCreated: foldersCreated.size,
    warnings,
    environmentCreated,
    environmentMerged
  }
}

async function writeOperation(
  op: IntermediateOperation,
  collectionPath: string,
  workspacePath: string,
  warnings: SchemaImportWarning[],
  foldersCreated: Set<string>,
  run: RunState
): Promise<boolean> {
  const dirSegments = op.folderPath.map((s) => sanitizeName(s, 'folder'))
  // Belt-and-braces: even with sanitizeName rejecting dots, confirm the
  // resolved directory stays under collectionPath (and therefore the workspace).
  const dir = resolveInsideWorkspace(workspacePath, collectionPath, ...dirSegments)
  if (!foldersCreated.has(dir)) {
    const dirDidExist = await exists(dir)
    await fs.mkdir(dir, { recursive: true })
    if (!dirDidExist) foldersCreated.add(dir)
  }

  // Names compare case-insensitively on every platform (the tree rule), and two
  // operations of this import can reach the same on-disk name: names that differ
  // only by case, or raw names that sanitize alike. A collision with a file this
  // run wrote takes a `-N` suffix; only a file that was there before the import
  // is skipped.
  const stem = sanitizeName(op.name, 'op')
  const existing = await namesBeforeImport(dir, run)
  const runKey = (name: string): string =>
    resolveInsideWorkspace(workspacePath, dir, name).toLowerCase()
  let fileName = `${stem}.http`
  if (run.written.has(runKey(fileName))) {
    let n = 2
    const taken = (name: string): boolean =>
      run.written.has(runKey(name)) || existing.has(name.toLowerCase())
    while (taken(`${stem}-${n}.http`)) n++
    fileName = `${stem}-${n}.http`
  }
  const filePath = resolveInsideWorkspace(workspacePath, dir, fileName)

  if (existing.has(fileName.toLowerCase()) || (await exists(filePath))) {
    // No strategy overwrites an existing request (REQ write-safety): 'merge'
    // skips the collision; 'abort' already threw if the collection pre-existed.
    warnings.push({
      kind: 'name-collision',
      message: `File already exists, skipped: ${fileName}`,
      location: dir
    })
    return false
  }

  let content = serializeRequest(op.editorState, op.id)
  if (op.comment) {
    const commentLines = op.comment
      .split(/\r?\n/)
      .map((l) => `# ${l}`)
      .join('\n')
    content = `${commentLines}\n${content}`
  }
  await atomicWriteFile(filePath, content)
  run.written.add(filePath.toLowerCase())
  return true
}

/** What one import run has written so far, and what each folder held before it. */
interface RunState {
  /** Lowercased full paths of the files this run wrote. */
  written: Set<string>
  /** Per folder, the lowercased names it held when this run first reached it. */
  existing: Map<string, Set<string>>
}

async function namesBeforeImport(dir: string, run: RunState): Promise<Set<string>> {
  let names = run.existing.get(dir)
  if (!names) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    names = new Set(entries.map((name) => name.toLowerCase()))
    run.existing.set(dir, names)
  }
  return names
}
