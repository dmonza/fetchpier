import { workspace } from '@fetchpier/core'
import type { Environment } from '@shared/types'

/**
 * List every environment in a workspace, through the core handle. Folders without
 * a `config.json` are skipped, and a missing `environments/` directory yields
 * `[]` — the same rules the desktop's `env:list` applies, sourced from the single
 * `workspace.environments.list()` so the two surfaces cannot drift.
 */
export async function listEnvironments(workspacePath: string): Promise<Environment[]> {
  return workspace.openWorkspace(workspacePath).environments.list()
}

/**
 * The same listing, also reporting the folders whose `config.json` exists but
 * cannot be read — the command line names them instead of letting the
 * environment look absent.
 */
export async function listEnvironmentsWithErrors(workspacePath: string): Promise<{
  environments: Environment[]
  unreadable: { folder: string; file: string; reason: string }[]
}> {
  return workspace.openWorkspace(workspacePath).environments.listWithErrors()
}
