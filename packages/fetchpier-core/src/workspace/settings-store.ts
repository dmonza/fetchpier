import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceHttpSettings } from '@shared/types'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from './defaults'
import { atomicWriteFile } from './atomic-write'

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
 * Persist a partial HTTP-settings patch and return the merged result. Pure I/O —
 * caching and broadcasting are the adapter's responsibility.
 */
export async function updateHttpSettings(
  workspacePath: string,
  partial: Partial<WorkspaceHttpSettings>
): Promise<WorkspaceHttpSettings> {
  const file = await readSettingsFile(workspacePath)
  const current = mergeWithDefaults(file.http)
  const next: WorkspaceHttpSettings = { ...current, ...partial }
  const updated: SettingsFile = { ...file, http: next }
  if (!updated.version) updated.version = 1
  await writeSettingsFile(workspacePath, updated)
  return next
}
