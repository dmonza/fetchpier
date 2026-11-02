import { workspace } from '@fetchpier/core'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'

/**
 * Pure path-safety helpers live in `@fetchpier/core/workspace`. Re-exported here
 * so existing main-process consumers keep importing from `../fs/safe-path`.
 */
export const resolveInsideWorkspace = workspace.resolveInsideWorkspace
export const assertSafeIdentifier = workspace.assertSafeIdentifier

/** Same as `resolveInsideWorkspace` but uses the active workspace handle. */
export function resolveInsideActiveWorkspace(...segments: string[]): string {
  return requireActiveWorkspaceHandle().resolveInside(...segments)
}
