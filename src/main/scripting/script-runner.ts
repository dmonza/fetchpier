import { scripting } from '@fetchpier/core'

/**
 * The `fp` sandbox and script runners now live in `@fetchpier/core/scripting`.
 * Re-exported here so existing main-process consumers keep importing from
 * `../scripting/script-runner`.
 */
export const executePreRequest = scripting.executePreRequest
export const executePostResponse = scripting.executePostResponse
export type ScriptContext = scripting.ScriptContext
export type ScriptRunOutcome = scripting.ScriptRunOutcome
