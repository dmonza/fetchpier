import { workspace } from '@fetchpier/core'

/**
 * Workspace HTTP defaults now live in `@fetchpier/core/workspace`. Re-exported
 * here so existing main-process consumers keep importing from `../config/defaults`.
 */
export const DEFAULT_WORKSPACE_HTTP_SETTINGS = workspace.DEFAULT_WORKSPACE_HTTP_SETTINGS
