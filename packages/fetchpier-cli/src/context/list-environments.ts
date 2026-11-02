import { workspace } from '@fetchpier/core'
import type { Environment } from '@shared/types'

/**
 * List every environment in a workspace, through the core handle. Folders without
 * a readable `config.json` are skipped, and a missing `environments/` directory
 * yields `[]` — the same rules the desktop's `env:list` applies, now sourced from
 * the single `workspace.environments.list()` so the two surfaces cannot drift.
 */
export async function listEnvironments(workspacePath: string): Promise<Environment[]> {
  return workspace.openWorkspace(workspacePath).environments.list()
}
