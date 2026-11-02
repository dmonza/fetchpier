import { requests } from '@fetchpier/core'

/**
 * The cookie jar lives in `@fetchpier/core/requests`. Re-exported here so existing
 * main-process consumers keep importing from `../http/cookie-jar`. Every function
 * takes the workspace path explicitly (REQ Core-owned workspace handle, F5): there
 * is no per-process active-workspace pointer anymore — callers pass the path (the
 * adapter via the session handle, the CLI per invocation).
 */
// REQ-0115: `parseSetCookieHeader` is gone from the surface. It handed back a
// cookie the jar would refuse, with no verdict attached — the shape that let a
// response set a cookie for an unrelated domain. Capture through
// `captureFromResponse`, which decides and reports.
export const matchesRequest = requests.matchesRequest
export const captureFromResponse = requests.captureFromResponse
export const getMatchingCookies = requests.getMatchingCookies
export const list = requests.list
export const clear = requests.clear
export const deleteJar = requests.deleteJar
export const upsert = requests.upsert
export const update = requests.update
export const remove = requests.remove
