/**
 * Run variable session (CLI readiness for CI) — the single owner of a run's
 * variables, shared by the desktop send handler and the command-line runner.
 *
 * It layers the environment exactly as both adapters used to do by hand —
 * shared plain values (with `{{$env.NAME}}` resolved) → the per-machine local
 * layer → adapter overrides (the CLI's `--env-var`) — and then carries every
 * script-written change (`fp.environment.set` / `unset`) forward to the requests
 * that follow, so a token a login captures reaches the next call.
 *
 * Persistence is the adapter's choice, made once per session:
 *  - `memory`: changes live for the session only (the CLI default — CI runs stay
 *    reproducible and never write to the workspace);
 *  - `persist`: changes are also written into the local value layer through the
 *    core's single writer (the desktop always; the CLI with `--persist-env`).
 *
 * Key custody stays with the adapter: the key is asked for lazily, only when a
 * referenced secret must be decrypted or a secret-named write encrypted.
 */

import type {
  EnvironmentChanges,
  EnvWriteNotPersistedWarning,
  HttpRequest,
  UndefinedEnvReferenceWarning
} from '@shared/types'
import type { Workspace } from '../workspace/handle'
import {
  classifyLocalWrite,
  mergeEnvironmentLayers,
  persistScriptEnvChanges
} from '../secrets/local-values'
import { collectReferencedVariableNames, resolveSecrets } from '../secrets/resolver'
import { createSecretMasker, mintExecutionNonce, type SecretMasker } from '../secrets/markers'
import { decryptValue } from '../secrets/crypto'

export type EnvPersistence = 'persist' | 'memory'

export interface VariableSessionOptions {
  workspace: Workspace
  /** The environment in use, or `null` (no environment: no secrets, nothing to persist). */
  environmentId: string | null
  /**
   * The plain variables to layer from, instead of the shared values read from
   * disk. The desktop passes what the renderer sent; the CLI omits it.
   */
  basePlainVariables?: Record<string, string>
  /** Highest-precedence adapter overrides (the CLI's `--env-var`), below script writes. */
  overrides?: Record<string, string>
  /** Process environment for `{{$env.NAME}}` resolution. */
  processEnv?: NodeJS.ProcessEnv
  /** Lazy provider of the current workspace key (`null` when none is available). */
  getKey: () => Promise<Uint8Array | null>
  persistence: EnvPersistence
}

export interface PreparedSend {
  /** The request with `variables` populated (and secret markers seeded). */
  request: HttpRequest
  /** Masker for this send, when it references a secret. */
  masker?: SecretMasker
  /** Every name that is a secret in this environment (for masking script writes). */
  secretNames: string[]
  /**
   * Advisories about this send's variables, known before it goes out: a used
   * variable whose value came from a `{{$env.NAME}}` no source defines.
   */
  warnings: UndefinedEnvReferenceWarning[]
  /** Decrypt the secrets a client-certificate passphrase references (lazy). */
  resolvePassphraseSecrets(names: string[]): Promise<Record<string, string>>
}

export interface VariableSession {
  /** Secret-named local overrides written under a different key — ignored (resolution falls back to shared). */
  readonly orphans: string[]
  prepare(request: HttpRequest): Promise<PreparedSend>
  /** Apply a send's environment changes to every later send; persist them per the policy. */
  apply(changes: EnvironmentChanges | undefined): Promise<EnvWriteNotPersistedWarning[]>
}

export async function createVariableSession(
  options: VariableSessionOptions
): Promise<VariableSession> {
  const { workspace: ws, environmentId, getKey, persistence } = options

  let shared: Record<string, string | null> = {}
  if (environmentId) {
    try {
      shared = (await ws.environments.read(environmentId)).variables ?? {}
    } catch {
      // A missing or unreadable environment file degrades to "no shared
      // variables" — the local layer and the overrides are still meaningful.
      shared = {}
    }
  }
  // An unreadable manifest (locked by an antivirus or a sync client, restrictive
  // ACLs) degrades like an unreadable environment file: sends that need no secret
  // go on, and only a send that needs one fails, with the read error.
  let manifestError: unknown
  let manifest: Awaited<ReturnType<typeof ws.secrets.readManifest>> = null
  try {
    manifest = await ws.secrets.readManifest()
  } catch (err) {
    manifestError = err
  }
  const currentKeyId = manifest?.encryption.keyId
  const local = environmentId
    ? await ws.secrets.readLocalValues(environmentId)
    : { version: 1 as const, variables: {} }
  const merged = mergeEnvironmentLayers({ variables: shared }, local, currentKeyId)

  // `{{$env.*}}` is resolved in the shared plain values only, before the local
  // layer (literal) and the overrides (literal) — the order both adapters used.
  const sharedPlain: Record<string, string> = {}
  for (const [name, value] of Object.entries(shared)) {
    if (typeof value === 'string' && classifyLocalWrite(name, shared) === 'plain') {
      sharedPlain[name] = value
    }
  }
  const { values: resolvedBase, undefinedByVariable: envUndefined } =
    await ws.dotenv.resolveReferencesDetailed(
      options.basePlainVariables ?? sharedPlain,
      options.processEnv
    )
  const localPlain: Record<string, string> = {}
  for (const [name, value] of Object.entries(local.variables)) {
    if (classifyLocalWrite(name, shared) === 'plain') localPlain[name] = value
  }
  const layeredPlain: Record<string, string> = {
    ...resolvedBase,
    ...localPlain,
    ...(options.overrides ?? {})
  }

  const isSecretName = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(merged.secretsMap, name) ||
    classifyLocalWrite(name, shared) === 'secret'
  const secretNames = [
    ...new Set([
      ...Object.keys(merged.secretsMap),
      ...Object.keys(shared).filter((n) => classifyLocalWrite(n, shared) === 'secret')
    ])
  ]

  // Script writes carried forward, newest wins. Secret-named values are kept as
  // plaintext here and reach the wire through a marker like any other secret.
  const overlaySet: Record<string, string> = {}
  const overlayRemoved = new Set<string>()

  let cachedKey: Uint8Array | null | undefined
  const key = async (): Promise<Uint8Array | null> => {
    if (cachedKey === undefined) cachedKey = await getKey()
    return cachedKey
  }

  const effectiveSecretsMap = (): Record<string, string | null> => {
    const out: Record<string, string | null> = {}
    for (const [name, value] of Object.entries(merged.secretsMap)) {
      if (overlayRemoved.has(name) || name in overlaySet) continue
      out[name] = value
    }
    return out
  }

  const resolveSecretNames = async (names: Iterable<string>): Promise<Record<string, string>> => {
    if (!environmentId) return {}
    const wanted = [...new Set(names)]
    if (manifestError !== undefined && wanted.some(isSecretName)) throw manifestError
    const fromOverlay: Record<string, string> = {}
    for (const name of wanted) {
      if (name in overlaySet && isSecretName(name)) fromOverlay[name] = overlaySet[name]
    }
    const map = effectiveSecretsMap()
    const needsDecryption = wanted.some(
      (n) => Object.prototype.hasOwnProperty.call(map, n) && map[n] !== null
    )
    const k = needsDecryption ? await key() : null
    const decrypted = await resolveSecrets({
      environmentId,
      secretsMap: map,
      neededNames: wanted,
      hasKey: k !== null,
      decrypt: (name, enc) => decryptValue(k as Uint8Array, name, enc)
    })
    return { ...decrypted, ...fromOverlay }
  }

  return {
    orphans: merged.orphans,

    async prepare(request: HttpRequest): Promise<PreparedSend> {
      const plain: Record<string, string> = { ...layeredPlain }
      for (const name of overlayRemoved) delete plain[name]
      for (const [name, value] of Object.entries(overlaySet)) {
        if (!isSecretName(name)) plain[name] = value
      }

      const referenced = collectReferencedVariableNames(request)
      const plaintextByName = await resolveSecretNames(referenced)
      const masker =
        Object.keys(plaintextByName).length > 0
          ? createSecretMasker({ nonce: mintExecutionNonce(), plaintextByName })
          : undefined

      // A variable the request uses whose value is still the one an undefined
      // `{{$env.NAME}}` emptied — not replaced by a local value, an override or
      // a script write. Variables the request does not use stay silent.
      const warnings: UndefinedEnvReferenceWarning[] = []
      for (const name of referenced) {
        const missing = envUndefined[name]
        if (!missing) continue
        if (name in localPlain || name in (options.overrides ?? {}) || name in overlaySet) continue
        if (overlayRemoved.has(name)) continue
        for (const envName of missing) {
          warnings.push({ code: 'UNDEFINED_ENV_REFERENCE', name, envName })
        }
      }

      return {
        request: { ...request, variables: { ...plain, ...(masker?.markerVariables ?? {}) } },
        ...(masker ? { masker } : {}),
        warnings,
        secretNames,
        resolvePassphraseSecrets: async (names) => {
          if (names.length === 0 || !names.some(isSecretName)) return {}
          return resolveSecretNames(names.filter(isSecretName))
        }
      }
    },

    async apply(changes: EnvironmentChanges | undefined): Promise<EnvWriteNotPersistedWarning[]> {
      if (!changes) return []
      for (const [name, value] of Object.entries(changes.set)) {
        overlaySet[name] = value
        overlayRemoved.delete(name)
      }
      for (const name of changes.removed) {
        delete overlaySet[name]
        overlayRemoved.add(name)
      }
      if (persistence !== 'persist' || !environmentId) return []
      return persistScriptEnvChanges({
        workspacePath: ws.path,
        environmentId,
        changes,
        sharedVariables: shared,
        currentKeyId,
        getKey: key
      })
    }
  }
}
