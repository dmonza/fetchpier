/**
 * REQ-0089 — Path-keyed workspace TLS resolution (pure, shared by desktop + CLI).
 *
 * Core owns workspace TLS resolution: given the workspace path it reads the
 * `.fetchpier/settings.json` `tls` block and the certificate files under
 * `.fetchpier/certs/` itself. App-global material has an origin core cannot know
 * (per-user app data), so the desktop injects it via `ctx.appGlobal`; the CLI
 * passes none. Both adapters call the same resolver keyed off the workspace path,
 * which is what makes the command-line runner reach desktop parity without
 * mirrored wiring.
 *
 * The resolver never holds the workspace key. A passphrase that references a
 * secret is decrypted through the adapter-bound `resolvePassphraseSecrets`
 * callback, lazily (only after a workspace certificate with a secret passphrase
 * is matched). Contractual `SECRETS_*` errors thrown by that callback propagate
 * so the adapter surfaces them before the TLS handshake.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as tls from 'node:tls'
import type { ClientCertPreview, TlsScope, TlsScopeSettings } from '@shared/types'
import { assertSafeIdentifier } from '../workspace/safe-path'
import { loadHttpSettings } from '../workspace/settings-store'
import { extractVariableNames, resolveString } from '../requests/variables'
import { workspaceCertsDir } from './paths'
import {
  matchClientCertificate,
  type CandidateScope,
  type ClientCertCandidate,
  type ClientCertMatch
} from './matcher'
import { describeError } from '../shared/describe-error'

const EMPTY_TLS: TlsScopeSettings = { caCertificates: [], clientCertificates: [] }

/** Composed TLS material handed to the transport for an outgoing request. */
export interface ResolvedTlsMaterial {
  ca?: Buffer[]
  cert?: Buffer
  key?: Buffer
  pfx?: Buffer
  passphrase?: string
}

/**
 * App-global TLS material the desktop injects (the only externally-sourced
 * input). The CLI never sees app-global certificates, so it omits this.
 */
export interface AppGlobalTlsMaterial {
  /** Absolute directory holding app-global cert files (desktop: `<userData>/certs`). */
  certsDir: string
  /** The app-scope `tls` settings block. */
  settings: TlsScopeSettings
}

/**
 * Material given for one command-line run (`--tls-config` / `FETCHPIER_TLS_CONFIG`):
 * a `tls` block in the workspace format, whose files sit in `certsDir` (the folder
 * of the file the operator named). Never persisted. Its certificates win a
 * specificity tie with the workspace's, and its passphrases follow the workspace
 * rules (literal or `{{name}}`).
 */
export interface RunTlsMaterial {
  certsDir: string
  settings: TlsScopeSettings
}

export interface ResolveTlsContext {
  /** Active workspace path, or null when no workspace is open. */
  workspacePath: string | null
  /** App-global material (desktop only). Omitted ⇒ no app-scope candidates. */
  appGlobal?: AppGlobalTlsMaterial
  /** Material given for this run (command line only). Omitted ⇒ no run candidates. */
  run?: RunTlsMaterial
  /**
   * Decrypt the workspace secrets referenced by a workspace-scope passphrase.
   * Key custody stays adapter-side. Returns plaintext only for names that are
   * secrets; throws the contractual `SECRETS_*` `CoreError` on key-missing /
   * unset / corrupt. Omitted ⇒ secret passphrases stay unresolved (warn-and-proceed).
   */
  resolvePassphraseSecrets?: (names: string[]) => Promise<Record<string, string>>
  /**
   * Receives a plain-language reason whenever configured material cannot be
   * applied (an unreadable CA or client certificate, a passphrase reference with
   * no value). The send proceeds without it. The resolver never writes to the
   * process console — the adapter turns this into an advisory.
   */
  onWarning?: (reason: string) => void
}

function normaliseTls(value: TlsScopeSettings | undefined): TlsScopeSettings {
  if (!value) return { caCertificates: [], clientCertificates: [] }
  return {
    caCertificates: value.caCertificates ?? [],
    clientCertificates: value.clientCertificates ?? []
  }
}

/** Read the workspace `tls` block straight from the workspace path. */
async function loadWorkspaceScope(workspacePath: string | null): Promise<TlsScopeSettings> {
  if (!workspacePath) return { ...EMPTY_TLS }
  const settings = await loadHttpSettings(workspacePath)
  return normaliseTls(settings.tls)
}

function loadAppScope(ctx: ResolveTlsContext): TlsScopeSettings {
  return normaliseTls(ctx.appGlobal?.settings)
}

function scopeCertsDir(scope: CandidateScope, ctx: ResolveTlsContext): string | null {
  if (scope === 'app') return ctx.appGlobal?.certsDir ?? null
  if (scope === 'run') return ctx.run?.certsDir ?? null
  return ctx.workspacePath ? workspaceCertsDir(ctx.workspacePath) : null
}

async function readCertFile(dir: string, filename: string): Promise<Buffer> {
  assertSafeIdentifier(filename, 'certificate file')
  return fs.readFile(join(dir, filename))
}

/**
 * Compose the CA list for outgoing requests: Node's bundled Mozilla roots plus
 * every enabled CA from both scopes. Errors loading individual files are logged
 * and skipped — one bad CA must not break unrelated requests.
 */
async function buildCaBundle(
  workspaceScope: TlsScopeSettings,
  appScope: TlsScopeSettings,
  runScope: TlsScopeSettings,
  ctx: ResolveTlsContext
): Promise<Buffer[]> {
  const bundle: Buffer[] = []
  for (const root of tls.rootCertificates) bundle.push(Buffer.from(root))

  for (const { scope, list } of [
    { scope: 'app' as CandidateScope, list: appScope.caCertificates },
    { scope: 'workspace' as CandidateScope, list: workspaceScope.caCertificates },
    { scope: 'run' as CandidateScope, list: runScope.caCertificates }
  ]) {
    const dir = scopeCertsDir(scope, ctx)
    if (!dir) continue
    for (const ca of list) {
      try {
        bundle.push(await readCertFile(dir, ca.file))
      } catch (err) {
        ctx.onWarning?.(
          `CA certificate "${ca.file}" could not be read and was skipped (${describeError(err)})`
        )
      }
    }
  }
  return bundle
}

function buildClientCandidates(
  workspaceScope: TlsScopeSettings,
  appScope: TlsScopeSettings,
  runScope: TlsScopeSettings = EMPTY_TLS
): ClientCertCandidate[] {
  return [
    ...runScope.clientCertificates.map((entry, index) => ({
      entry,
      scope: 'run' as CandidateScope,
      index
    })),
    ...workspaceScope.clientCertificates.map((entry, index) => ({
      entry,
      scope: 'workspace' as TlsScope,
      index
    })),
    ...appScope.clientCertificates.map((entry, index) => ({
      entry,
      scope: 'app' as TlsScope,
      index
    }))
  ]
}

/**
 * Resolve a matched client certificate's passphrase.
 *
 * - App-global: used verbatim — never interpolated, never decrypted (a `{{...}}`
 *   reference is rejected at save time, so a stored value has none).
 * - Workspace: `{{name}}` references resolve against the active environment;
 *   secret references are decrypted lazily via `resolvePassphraseSecrets` (which
 *   the seeded plaintext takes precedence over any secret-shaped env value);
 *   unresolved references are left literal and the send proceeds.
 */
async function resolvePassphrase(
  match: ClientCertMatch,
  environment: Record<string, string>,
  ctx: ResolveTlsContext
): Promise<string | undefined> {
  const pass = match.selected.passphrase
  if (!pass) return undefined
  if (match.scope === 'app') return pass

  let env = environment
  const refs = extractVariableNames(pass)
  if (refs.length > 0 && ctx.resolvePassphraseSecrets) {
    // Throws the contractual SECRETS_* CoreError when a referenced secret cannot
    // be decrypted — propagated so the adapter fails before the handshake.
    const seeded = await ctx.resolvePassphraseSecrets(refs)
    if (Object.keys(seeded).length > 0) env = { ...environment, ...seeded }
  }
  const resolved = resolveString(pass, env)
  if (resolved.unresolved.length > 0) {
    ctx.onWarning?.(
      `the client certificate passphrase references ${resolved.unresolved
        .map((n) => `"${n}"`)
        .join(', ')}, which has no value in this environment`
    )
  }
  return resolved.value
}

/**
 * Resolve the TLS material for an outgoing request URL: composed CA bundle plus
 * the best-matching client certificate (loaded into Buffers) and its resolved
 * passphrase. Workspace content is read from `ctx.workspacePath`; app-global
 * content comes from `ctx.appGlobal` (desktop only). A non-https URL gets the
 * CA bundle only (for an https proxy in front of it); one that cannot be
 * parsed gets nothing.
 */
export async function resolveRequestTls(
  rawUrl: string,
  environment: Record<string, string>,
  ctx: ResolveTlsContext
): Promise<ResolvedTlsMaterial> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return {}
  }
  const [workspaceScope, appScope] = [
    await loadWorkspaceScope(ctx.workspacePath),
    loadAppScope(ctx)
  ]

  const runScope = normaliseTls(ctx.run?.settings)
  const material: ResolvedTlsMaterial = {
    ca: await buildCaBundle(workspaceScope, appScope, runScope, ctx)
  }
  // The CAs do not depend on the target: a plain-http target reached through an
  // https proxy still needs them to trust the proxy. A client certificate
  // identifies the client to an https server, so it is chosen for https only.
  // With no CA of its own the bundle is just Node's roots: an explicit `ca` would
  // then only drop the default store (NODE_EXTRA_CA_CERTS) the proxy relied on.
  if (url.protocol !== 'https:') {
    return (material.ca?.length ?? 0) > tls.rootCertificates.length ? material : {}
  }

  const match = matchClientCertificate(
    url,
    buildClientCandidates(workspaceScope, appScope, runScope),
    ctx.onWarning
  )
  if (!match) return material

  const dir = scopeCertsDir(match.scope, ctx)
  if (!dir) return material
  try {
    if (match.selected.type === 'pem') {
      if (match.selected.certFile) material.cert = await readCertFile(dir, match.selected.certFile)
      if (match.selected.keyFile) material.key = await readCertFile(dir, match.selected.keyFile)
    } else if (match.selected.type === 'pfx') {
      if (match.selected.pfxFile) material.pfx = await readCertFile(dir, match.selected.pfxFile)
    }
  } catch (err) {
    ctx.onWarning?.(
      `the client certificate for ${url.host} could not be read and was not presented (${describeError(err)})`
    )
    return material
  }

  // Resolution runs before the material is handed to the transport; a contractual
  // SECRETS_* error short-circuits the send here, never as an opaque handshake error.
  const passphrase = await resolvePassphrase(match, environment, ctx)
  if (passphrase !== undefined) material.passphrase = passphrase

  return material
}

/**
 * Metadata-only preview: which certificate would be picked for this URL and from
 * which scope, without loading file buffers or resolving the passphrase. Used by
 * the per-request Settings tab; works with the workspace locked.
 */
export async function previewRequestCert(
  rawUrl: string,
  ctx: ResolveTlsContext
): Promise<ClientCertPreview> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { selected: null, scope: null }
  }
  if (url.protocol !== 'https:') return { selected: null, scope: null }

  const [workspaceScope, appScope] = [
    await loadWorkspaceScope(ctx.workspacePath),
    loadAppScope(ctx)
  ]
  const match = matchClientCertificate(url, buildClientCandidates(workspaceScope, appScope))
  // The preview is a desktop surface: it never sees run material.
  if (!match || match.scope === 'run') return { selected: null, scope: null }
  return { selected: match.selected, scope: match.scope }
}
