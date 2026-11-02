// Workspace domain — path safety, atomic writes, workspace creation, the HTTP
// defaults, the environment-config reader, and the workspace **handle**
// (`openWorkspace`). All pure: every function takes the workspace path explicitly.
//
// The public surface is intentionally the handle plus the primitives still
// consumed cross-package. The per-path functions the handle wraps — request-tree
// read/mutations, environment CRUD/enumeration/merge-save, run history, the secrets
// manifest, dotenv, and the HTTP-settings I/O — are reached through the handle and
// are **not** re-exported here; they stay importable within the package (and from
// their own unit tests) via their modules. `readEnvFile`/`ENV_CONFIG_FILE` remain
// public because `env:read` resolves an arbitrary in-workspace config path that the
// handle's id-keyed `environments.read` cannot express.
export * from './safe-path'
export * from './atomic-write'
export * from './create'
export * from './defaults'
export { ENV_CONFIG_FILE, readEnvFile } from './environments'
export { openWorkspace } from './handle'
export type {
  Workspace,
  WorkspaceSettingsOps,
  WorkspaceEnvironmentsOps,
  WorkspaceTreeOps,
  WorkspaceHistoryOps,
  WorkspaceSecretsOps,
  WorkspaceDotenvOps,
  WorkspaceBinaryOps
} from './handle'
