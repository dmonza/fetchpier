// TLS domain — client/CA certificate store (factory with injected host
// collaborators for CRUD), path-keyed send-time resolution (core-owned, reads
// workspace content from the path; app-global is adapter-injected), URL→cert
// matcher, PEM/PFX import validation, and canonical path helpers. All
// Electron-free.
export { createTlsStore } from './store'
export type {
  TlsStore,
  TlsStoreDeps,
  AddCAArgs,
  AddClientArgs,
  UpdateCAArgs,
  UpdateClientArgs,
  RemoveArgs
} from './store'
export { resolveRequestTls, previewRequestCert } from './resolve'
export type {
  ResolvedTlsMaterial,
  ResolveTlsContext,
  AppGlobalTlsMaterial,
  RunTlsMaterial
} from './resolve'
export { matchClientCertificate } from './matcher'
export type { CandidateScope, ClientCertCandidate, ClientCertMatch } from './matcher'
export { readPemCertFile, readPemKeyFile, readPfxFile, TlsImportError } from './import'
export type { ImportedFile } from './import'
export {
  workspaceCertsDir,
  sanitiseFilename,
  shortContentHash,
  canonicalCertFilename
} from './paths'
