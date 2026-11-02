// @fetchpier/core/atomic-write — secondary entry point.
//
// Re-exports the durable-write helpers on their own, for callers that need them
// *before* the rest of the business layer may be loaded. Pulling the main entry
// (`@fetchpier/core`) drags in the request domain and with it the network
// client — ~200 ms of module evaluation on the desktop's startup path, where the
// window cannot be created until it finishes (REQ deferred cold-path
// dependencies). The app-global settings are read and written on that path, so
// they reach the helpers through this subpath instead of the barrel.
//
// The underlying module imports nothing but `node:fs` and `node:path`, and the
// package is built with code splitting off, so this output cannot share a chunk
// that would smuggle the barrel's dependencies back in — the same guarantee the
// schema-import entry relies on.
//
// The main entry still re-exports these under `workspace.*`; this subpath is an
// additional way in, not a replacement.

export { atomicWriteFile, atomicWriteBatch, atomicWriteFileSync } from './workspace/atomic-write'
