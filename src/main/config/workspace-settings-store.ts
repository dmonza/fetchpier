import { BrowserWindow } from 'electron'
import { workspace } from '@fetchpier/core'
import type { WorkspaceHttpSettings } from '../../shared/types'

// File I/O lives in `@fetchpier/core/workspace`, reached through the workspace
// handle (`openWorkspace(path).settings`). This adapter adds the two pieces that
// are contextual to the desktop session: a per-process cache (so `http:send` can
// read settings synchronously) and the renderer broadcast.

let cached: { workspacePath: string; settings: WorkspaceHttpSettings } | null = null

export async function loadHttpSettings(workspacePath: string): Promise<WorkspaceHttpSettings> {
  if (cached && cached.workspacePath === workspacePath) return cached.settings
  const settings = await workspace.openWorkspace(workspacePath).settings.load()
  cached = { workspacePath, settings }
  return settings
}

/**
 * Validate a partial settings patch. Throws when the patch is structurally
 * malformed (typed-wise the renderer enforces shape, but `.fetchpier/settings.json`
 * is also editable by hand). Currently checks `binaryFileLimits` invariants.
 */
function validatePartial(partial: Partial<WorkspaceHttpSettings>): void {
  if (partial.binaryFileLimits !== undefined) {
    const { warnBytes, blockBytes } = partial.binaryFileLimits
    if (!Number.isFinite(warnBytes) || !Number.isFinite(blockBytes)) {
      throw new Error('binaryFileLimits: warnBytes and blockBytes must be finite numbers')
    }
    if (warnBytes < 0 || blockBytes < 0) {
      throw new Error('binaryFileLimits: warnBytes and blockBytes must be ≥ 0')
    }
    if (warnBytes > blockBytes) {
      throw new Error('binaryFileLimits: warnBytes must be ≤ blockBytes')
    }
  }
  if (partial.findings !== undefined) validateFindingsPatch(partial.findings)
}

/**
 * The findings block the Workspace Settings section sends. Rule ids are not
 * checked against the catalog on purpose: an id this version does not know may
 * belong to a newer one, and the section keeps it verbatim on save.
 */
function validateFindingsPatch(findings: unknown): void {
  if (typeof findings !== 'object' || findings === null || Array.isArray(findings)) {
    throw new Error('findings: expected an object')
  }
  const f = findings as Record<string, unknown>
  if (f.enabled !== undefined && typeof f.enabled !== 'boolean') {
    throw new Error('findings: enabled must be a boolean')
  }
  if (
    f.disabledRules !== undefined &&
    (!Array.isArray(f.disabledRules) || f.disabledRules.some((id) => typeof id !== 'string'))
  ) {
    throw new Error('findings: disabledRules must be a list of rule ids')
  }
  if (
    f.certExpiryWarnDays !== undefined &&
    !(
      typeof f.certExpiryWarnDays === 'number' &&
      Number.isInteger(f.certExpiryWarnDays) &&
      f.certExpiryWarnDays >= 0
    )
  ) {
    throw new Error('findings: certExpiryWarnDays must be an integer ≥ 0')
  }
}

export async function updateHttpSettings(
  workspacePath: string,
  partial: Partial<WorkspaceHttpSettings>
): Promise<WorkspaceHttpSettings> {
  validatePartial(partial)
  const next = await workspace.openWorkspace(workspacePath).settings.update(partial)
  cached = { workspacePath, settings: next }
  broadcast(next)
  return next
}

export function getCachedHttpSettings(workspacePath: string | null): WorkspaceHttpSettings {
  if (workspacePath && cached && cached.workspacePath === workspacePath) {
    return cached.settings
  }
  return workspace.DEFAULT_WORKSPACE_HTTP_SETTINGS
}

export function clearHttpSettingsCache(): void {
  cached = null
}

function broadcast(settings: WorkspaceHttpSettings): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('workspace:httpSettingsChanged', settings)
    }
  }
}
