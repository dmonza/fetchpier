import { requests } from '@fetchpier/core'

/**
 * Variable resolution now lives in `@fetchpier/core/requests`. Re-exported here
 * so existing main-process consumers keep importing from `../http/variables`.
 */
export const resolveString = requests.resolveString
export const resolveRequestVariables = requests.resolveRequestVariables
export type ResolveResult = requests.ResolveResult
export type ResolvedRequest = requests.ResolvedRequest
