import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceHttpSettings } from '@shared/types'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from './defaults'
import { atomicWriteFile } from './atomic-write'
import { CoreError } from '../shared/context'
import { describeError } from '../shared/describe-error'

const SETTINGS_FILE = '.fetchpier/settings.json'

interface SettingsFile {
  version?: number
  http?: Partial<WorkspaceHttpSettings>
  [key: string]: unknown
}

async function readSettingsFile(workspacePath: string): Promise<SettingsFile> {
  const filePath = join(workspacePath, SETTINGS_FILE)
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SettingsFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeSettingsFile(workspacePath: string, content: SettingsFile): Promise<void> {
  const filePath = join(workspacePath, SETTINGS_FILE)
  await atomicWriteFile(filePath, JSON.stringify(content, null, 2))
}

function mergeWithDefaults(
  partial: Partial<WorkspaceHttpSettings> | undefined
): WorkspaceHttpSettings {
  return { ...DEFAULT_WORKSPACE_HTTP_SETTINGS, ...(partial ?? {}) }
}

/**
 * Read `<workspace>/.fetchpier/settings.json` and merge its `http` block with
 * the defaults. Pure I/O — the per-session cache and the renderer broadcast
 * live in the desktop adapter.
 */
export async function loadHttpSettings(workspacePath: string): Promise<WorkspaceHttpSettings> {
  const file = await readSettingsFile(workspacePath)
  return mergeWithDefaults(file.http)
}

/**
 * Like {@link loadHttpSettings}, but an existing file that cannot be parsed is
 * an error instead of a silent fall-back to defaults. Falling back silently drops
 * the TLS block and the HTTP settings, and the run then fails far from its cause.
 * A missing file still means defaults. Used by the command line.
 *
 * @throws CoreError `WORKSPACE_INVALID` naming the file and the parse error.
 */
export async function loadHttpSettingsStrict(
  workspacePath: string
): Promise<WorkspaceHttpSettings> {
  return mergeWithDefaults((await readSettingsFileStrict(workspacePath)).http)
}

/**
 * Read the whole settings file strictly: a missing file is `{}`; any other read
 * error, a parse error or a non-object root throws.
 *
 * @throws CoreError `WORKSPACE_INVALID` naming the file and the cause.
 */
async function readSettingsFileStrict(workspacePath: string): Promise<SettingsFile> {
  const filePath = join(workspacePath, SETTINGS_FILE)
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new CoreError(
      'WORKSPACE_INVALID',
      `Workspace settings could not be read: ${filePath}: ${describeError(err)}`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new CoreError(
      'WORKSPACE_INVALID',
      `Workspace settings could not be read: ${filePath}: ${describeError(err)}`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CoreError(
      'WORKSPACE_INVALID',
      `Workspace settings could not be read: ${filePath}: expected a JSON object`
    )
  }
  return parsed as SettingsFile
}

/**
 * Persist a partial HTTP-settings patch and return the merged result. Pure I/O —
 * caching and broadcasting are the adapter's responsibility.
 *
 * The existing file is read strictly: rewriting from a lenient `{}` would turn a
 * temporary parse failure (a merge conflict, a hand-edit typo) into permanent
 * loss of the TLS block, the findings policy and every unknown key.
 *
 * @throws CoreError `WORKSPACE_INVALID` when the existing file cannot be read or
 *   parsed; nothing is written.
 */
export async function updateHttpSettings(
  workspacePath: string,
  partial: Partial<WorkspaceHttpSettings>
): Promise<WorkspaceHttpSettings> {
  const file = await readSettingsFileStrict(workspacePath)
  const current = mergeWithDefaults(file.http)
  const next: WorkspaceHttpSettings = { ...current, ...partial }
  const updated: SettingsFile = { ...file, http: next }
  if (!updated.version) updated.version = 1
  await writeSettingsFile(workspacePath, updated)
  return next
}
