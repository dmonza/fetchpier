// Requests domain — .http parsing, variable resolution, auth, settings
// resolution, the undici HTTP client, the cookie jar, and the full send
// pipeline (`execute`). Pure: no Electron. The cookie jar takes the workspace
// path explicitly on every call — there is no per-process active-workspace
// pointer (it was removed with the core-owned workspace handle).
export * from './variables'
export * from './parser'
export * from './auth'
export * from './settings-resolver'
export * from './client'
export * from './cookie-jar'
export * from './execute'
export * from './binary-store'
export * from './multipart-encoder'
export * from './multipart-parser'
