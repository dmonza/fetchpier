// PLAN-0132 (REQ: Core-owned workspace handle) — Phase F0 scaffolding.
//
// `openWorkspace(path)` returns a stateless **handle**: a domain-grouped façade
// over the existing pure workspace functions, capturing the workspace path once
// so callers stop threading it through every call. The handle holds no cache —
// every method hits disk — and construction performs no eager I/O (it only
// normalizes the path), so it is cheap and safe at process start.
//
// This is the additive foundation of the requirement: F0 exposes only the
// already-pure domains. Tree mutations, environment list/delete/concurrent-merge
// save, cookies, and the state stores are relocated into the business layer in
// later phases and *added* to this interface then (it grows additively).
//
// The HTTP execution pipeline is intentionally NOT a handle method — it receives
// the handle (or its path) as input (single-responsibility).

import { resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import type {
  Cookie,
  Environment,
  FsCascadeResult,
  FsDeleteResult,
  HistoryEntry,
  HistoryEntryListItem,
  NameCheckInput,
  NameCheckResult,
  WorkspaceHttpSettings,
  WorkspaceTree
} from '@shared/types'
import type { SecretsManifest } from '../secrets'
import {
  clear as clearCookies,
  deleteJar as deleteCookieJar,
  list as listCookies,
  remove as removeCookie,
  update as updateCookie,
  upsert as upsertCookie
} from '../requests/cookie-jar'
import {
  listBinaries,
  readBinary,
  removeBinary,
  resolveBinaryRef,
  stageBinary,
  statBinary,
  type StagedBinaryFile,
  type StagedBinaryListEntry
} from '../requests/binary-store'
import {
  localValuesPath,
  readLocalValues,
  writeLocalValues,
  type LocalValuesFile
} from '../secrets/local-values'
import { atomicWriteFile, atomicWriteFileSync } from './atomic-write'
import { createWorkspace, type CreateWorkspaceOptions, type CreateWorkspaceResult } from './create'
import {
  createEnvironmentFile,
  deleteEnvironment,
  envConfigPath,
  envDirPath,
  envFolderPath,
  duplicateEnvironment,
  listEnvironmentFolders,
  listEnvironments,
  renameEnvironment,
  resolveEnvFolder,
  readEnvFile,
  saveEnvironment,
  writeEnvFile
} from './environments'
import { readDotenv, resolveEnvReferences } from './env-source'
import * as history from './history'
import { resolveInsideWorkspace } from './safe-path'
import { readManifest, secretsManifestPath, writeManifest } from './secrets-store'
import { loadHttpSettings, updateHttpSettings } from './settings-store'
import { collectRequestIds, readTree, requestsRootPath } from './tree'
import {
  checkNameAvailable,
  createCollection,
  createInstance,
  createRequest,
  deleteEntry,
  duplicateEntry,
  duplicateInstance,
  findAvailableUntitledPath,
  moveEntry,
  renameEntry
} from './tree-mutations'

/** Workspace HTTP defaults (`.fetchpier/settings.json`). */
export interface WorkspaceSettingsOps {
  load(): Promise<WorkspaceHttpSettings>
  update(partial: Partial<WorkspaceHttpSettings>): Promise<WorkspaceHttpSettings>
}

/**
 * Environments domain (`environments/<folder>/config.json`): CRUD, enumeration,
 * merge-save.
 *
 * **Identity.** An environment's `id` is opaque and never a path segment; its
 * `folder` is its name in filesystem-safe form and is what addresses it on disk.
 * Every operation below that takes an `environmentId` resolves it through
 * {@link WorkspaceEnvironmentsOps.resolveFolder} first, and fails with
 * `ENVIRONMENT_NOT_FOUND` when no folder holds it. The two sync path helpers are
 * the exception: they take a **folder name**, because a sync accessor cannot
 * resolve.
 */
export interface WorkspaceEnvironmentsOps {
  /** Map an opaque identifier to the folder that holds it. Throws `ENVIRONMENT_NOT_FOUND`. */
  resolveFolder(environmentId: string): Promise<string>
  read(environmentId: string): Promise<Environment>
  /** Write `env` into `env.folder` (only `{ id, name, variables }` is serialized). */
  write(env: Environment): Promise<void>
  create(name: string, variables?: Record<string, string | null>): Promise<Environment>
  /** Rename: moves the folder (with its `.state/`) and updates the display name; the id is untouched. */
  rename(environmentId: string, newName: string): Promise<Environment>
  /** Duplicate: same variables verbatim, fresh identifier, no machine-local state. */
  duplicate(sourceEnvironmentId: string, newName: string): Promise<Environment>
  /** Every environment with a readable config.json, each carrying its folder. */
  list(): Promise<Environment[]>
  /** Folder names under `environments/` (lightweight; no config read). */
  listFolders(): Promise<string[]>
  /** Remove an environment's whole folder (incl. `.state/`). */
  delete(environmentId: string): Promise<void>
  /** Persist with the concurrent-edit merge (REQ-0076/0079). */
  save(env: Environment, baseline?: Record<string, string | null>): Promise<void>
  dirPath(): string
  /** Keyed by **folder name**, not by identifier. */
  folderPath(folderName: string): string
  /** Keyed by **folder name**, not by identifier. */
  configPath(folderName: string): string
}

/** Request tree (`requests/`): read, plus mutations with name-conflict + instance cascade. */
export interface WorkspaceTreeOps {
  read(): Promise<WorkspaceTree[]>
  requestsRoot(): string
  createCollection(parentPath: string, name: string): Promise<void>
  createRequest(parentPath: string, name: string): Promise<string>
  createInstance(parentPath: string, instanceName: string): Promise<string>
  rename(oldPath: string, newName: string): Promise<FsCascadeResult>
  delete(targetPath: string): Promise<FsDeleteResult>
  move(sourcePath: string, targetFolder: string): Promise<FsCascadeResult>
  duplicate(filePath: string): Promise<string>
  /** Copy an instance into a sibling instance of the same parent, under `instanceName`. */
  duplicateInstance(sourcePath: string, instanceName: string): Promise<string>
  /** Read-only name-availability verdict (case-insensitive, self-excluded). Never throws on collision. */
  checkName(input: NameCheckInput): Promise<NameCheckResult>
  findAvailableUntitled(startN: number): Promise<{ filePath: string; name: string }>
  /** The `# @id` of every request under `requests/` (for UI-state GC). */
  collectRequestIds(): Promise<Set<string>>
}

/** Run history (`requests/.runs/*.http`). */
export interface WorkspaceHistoryOps {
  save(entry: HistoryEntry): Promise<void>
  list(filter?: { requestId?: string; limit?: number }): Promise<HistoryEntryListItem[]>
  get(entryId: string): Promise<string>
  updateSourceFile(oldRelPath: string, newRelPath: string, isFolder: boolean): Promise<void>
  countForPath(relPath: string, isFolder: boolean): Promise<number>
  deleteForPath(relPath: string, isFolder: boolean): Promise<void>
  remove(entryId: string): Promise<void>
  clear(): Promise<void>
}

/**
 * Workspace-resident secret material: the manifest (`.fetchpier/secrets.json`)
 * and per-machine local values (`environments/<id>/.state/localvalues.json`).
 * This is the workspace **I/O** only — keystore custody, encrypt/decrypt, and the
 * reveal gate stay in the adapter (they are not workspace concerns).
 */
export interface WorkspaceSecretsOps {
  manifestPath(): string
  readManifest(): Promise<SecretsManifest | null>
  writeManifest(manifest: SecretsManifest): Promise<void>
  /** Keyed by **folder name** (sync accessors cannot resolve an identifier). */
  localValuesPath(folderName: string): string
  /** Identifier-keyed path, resolved through the environments domain. */
  resolveLocalValuesPath(environmentId: string): Promise<string>
  readLocalValues(environmentId: string): Promise<LocalValuesFile>
  writeLocalValues(environmentId: string, file: LocalValuesFile): Promise<void>
}

/** Workspace-root dotenv (`.env`) source + `{{$env.NAME}}` resolution. */
export interface WorkspaceDotenvOps {
  read(): Promise<Record<string, string> | null>
  resolveReferences(
    variables: Record<string, string>,
    processEnv?: NodeJS.ProcessEnv
  ): Promise<Record<string, string>>
}

/** Cookie jar, scoped per environment (`environments/<id>/.state/cookies.json`). */
export interface WorkspaceCookiesOps {
  list(environmentId: string): Promise<Cookie[]>
  upsert(
    environmentId: string,
    cookie: Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Cookie>
  update(environmentId: string, cookieId: string, changes: Partial<Cookie>): Promise<Cookie>
  remove(environmentId: string, cookieId: string): Promise<void>
  clear(environmentId: string): Promise<void>
  deleteJar(environmentId: string): Promise<void>
}

/** Binary body attachments (`requests/.files/`). */
export interface WorkspaceBinaryOps {
  stage(sourcePath: string): Promise<StagedBinaryFile>
  stat(ref: string): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }>
  list(): Promise<StagedBinaryListEntry[]>
  remove(ref: string): Promise<boolean>
  resolveRef(ref: string): string
  /** Read a staged file's bytes (throws `ENOENT` when absent). */
  read(ref: string): Promise<Buffer>
}

/**
 * A handle to a single workspace. All operations target the path the handle was
 * opened with. Stateless: nothing is cached between calls.
 */
export interface Workspace {
  /** The resolved (absolute, normalized) workspace path this handle represents. */
  readonly path: string
  readonly settings: WorkspaceSettingsOps
  readonly environments: WorkspaceEnvironmentsOps
  readonly tree: WorkspaceTreeOps
  readonly history: WorkspaceHistoryOps
  readonly secrets: WorkspaceSecretsOps
  readonly dotenv: WorkspaceDotenvOps
  readonly cookies: WorkspaceCookiesOps
  readonly binary: WorkspaceBinaryOps
  /** Resolve `segments` inside the workspace, throwing if they escape it. */
  resolveInside(...segments: string[]): string
  /** Whether a workspace-relative path exists (false if it escapes the workspace). */
  fileExists(relativePath: string): Promise<boolean>
  /** Read a workspace-relative text file (UTF-8); confined to the workspace. */
  readTextFile(relativePath: string): Promise<string>
  /** Atomically write to a workspace-relative path (confined to the workspace). */
  atomicWrite(relativePath: string, data: string | Uint8Array): Promise<void>
  /** Synchronous atomic write (for before-quit flush paths). */
  atomicWriteSync(relativePath: string, data: string | Uint8Array): void
  /** Initialize the on-disk workspace layout (idempotent). */
  create(options?: CreateWorkspaceOptions): Promise<CreateWorkspaceResult>
}

/**
 * Open a handle for the workspace at `workspacePath`. Cheap and synchronous:
 * the path is resolved once and no disk read happens until a method is called.
 */
export function openWorkspace(workspacePath: string): Workspace {
  const path = resolve(workspacePath)

  return {
    path,

    settings: {
      load: () => loadHttpSettings(path),
      update: (partial) => updateHttpSettings(path, partial)
    },

    environments: {
      resolveFolder: (environmentId) => resolveEnvFolder(path, environmentId),
      read: async (environmentId) =>
        readEnvFile(envConfigPath(path, await resolveEnvFolder(path, environmentId))),
      write: (env) => writeEnvFile(path, env),
      create: (name, variables) => createEnvironmentFile(path, name, variables),
      rename: (environmentId, newName) => renameEnvironment(path, environmentId, newName),
      duplicate: (sourceEnvironmentId, newName) =>
        duplicateEnvironment(path, sourceEnvironmentId, newName),
      list: () => listEnvironments(path),
      listFolders: () => listEnvironmentFolders(path),
      delete: (environmentId) => deleteEnvironment(path, environmentId),
      save: (env, baseline) => saveEnvironment(path, env, baseline),
      dirPath: () => envDirPath(path),
      folderPath: (folderName) => envFolderPath(path, folderName),
      configPath: (folderName) => envConfigPath(path, folderName)
    },

    tree: {
      read: () => readTree(requestsRootPath(path)),
      requestsRoot: () => requestsRootPath(path),
      createCollection: (parentPath, name) => createCollection(path, parentPath, name),
      createRequest: (parentPath, name) => createRequest(path, parentPath, name),
      createInstance: (parentPath, instanceName) => createInstance(path, parentPath, instanceName),
      rename: (oldPath, newName) => renameEntry(path, oldPath, newName),
      delete: (targetPath) => deleteEntry(path, targetPath),
      move: (sourcePath, targetFolder) => moveEntry(path, sourcePath, targetFolder),
      duplicate: (filePath) => duplicateEntry(path, filePath),
      duplicateInstance: (sourcePath, instanceName) =>
        duplicateInstance(path, sourcePath, instanceName),
      checkName: (input) => checkNameAvailable(path, input),
      findAvailableUntitled: (startN) => findAvailableUntitledPath(path, startN),
      collectRequestIds: () => collectRequestIds(path)
    },

    history: {
      save: (entry) => history.save(path, entry),
      list: (filter) => history.list(path, filter),
      get: (entryId) => history.get(path, entryId),
      updateSourceFile: (oldRelPath, newRelPath, isFolder) =>
        history.updateSourceFile(path, oldRelPath, newRelPath, isFolder),
      countForPath: (relPath, isFolder) => history.countForPath(path, relPath, isFolder),
      deleteForPath: (relPath, isFolder) => history.deleteForPath(path, relPath, isFolder),
      remove: (entryId) => history.remove(path, entryId),
      clear: () => history.clear(path)
    },

    secrets: {
      manifestPath: () => secretsManifestPath(path),
      readManifest: () => readManifest(path),
      writeManifest: (manifest) => writeManifest(path, manifest),
      localValuesPath: (folderName) => localValuesPath(path, folderName),
      resolveLocalValuesPath: async (environmentId) =>
        localValuesPath(path, await resolveEnvFolder(path, environmentId)),
      readLocalValues: (environmentId) => readLocalValues(path, environmentId),
      writeLocalValues: (environmentId, file) => writeLocalValues(path, environmentId, file)
    },

    dotenv: {
      read: () => readDotenv(path),
      resolveReferences: (variables, processEnv) =>
        resolveEnvReferences(
          variables,
          processEnv ? { workspacePath: path, processEnv } : { workspacePath: path }
        )
    },

    cookies: {
      list: (environmentId) => listCookies(path, environmentId),
      upsert: (environmentId, cookie) => upsertCookie(path, environmentId, cookie),
      update: (environmentId, cookieId, changes) =>
        updateCookie(path, environmentId, cookieId, changes),
      remove: (environmentId, cookieId) => removeCookie(path, environmentId, cookieId),
      clear: (environmentId) => clearCookies(path, environmentId),
      deleteJar: (environmentId) => deleteCookieJar(path, environmentId)
    },

    binary: {
      stage: (sourcePath) => stageBinary(path, sourcePath),
      stat: (ref) => statBinary(path, ref),
      list: () => listBinaries(path),
      remove: (ref) => removeBinary(path, ref),
      resolveRef: (ref) => resolveBinaryRef(path, ref),
      read: (ref) => readBinary(path, ref)
    },

    resolveInside: (...segments) => resolveInsideWorkspace(path, ...segments),
    fileExists: async (relativePath) => {
      let resolved: string
      try {
        resolved = resolveInsideWorkspace(path, relativePath)
      } catch {
        return false
      }
      try {
        await fs.access(resolved)
        return true
      } catch {
        return false
      }
    },
    readTextFile: (relativePath) =>
      fs.readFile(resolveInsideWorkspace(path, relativePath), 'utf-8'),
    atomicWrite: (relativePath, data) =>
      atomicWriteFile(resolveInsideWorkspace(path, relativePath), data),
    atomicWriteSync: (relativePath, data) =>
      atomicWriteFileSync(resolveInsideWorkspace(path, relativePath), data),
    create: (options) => createWorkspace(path, options)
  }
}
