import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { CACertEntry, ClientCertEntry, TlsScope, TlsScopeSettings } from '@shared/types'
import { CoreError } from '../shared/context'
import { assertSafeIdentifier } from '../workspace/safe-path'
import { canonicalCertFilename, workspaceCertsDir } from './paths'
import { normalizeHostPattern } from './matcher'
import { readPemCertFile, readPemKeyFile, readPfxFile, TlsImportError } from './import'
import { atomicWriteFile } from '../workspace/atomic-write'

/**
 * Host-provided collaborators for the TLS certificate *store* (CRUD). The
 * desktop adapter wires these to Electron (`app.getPath`), the active-workspace
 * singleton, and the app/workspace settings persistence layers (which carry the
 * renderer broadcast + per-session cache). Core stays Electron-free.
 *
 * Send-time *resolution* no longer lives here — it is path-keyed and core-owned
 * in `./resolve` (REQ-0089). This factory keeps only the certificate-management
 * surface, whose workspace write path stays adapter-injected (the settings cache
 * + broadcast relocation is deferred debt).
 */
export interface TlsStoreDeps {
  /** Absolute directory for app-global certs (desktop: `<userData>/certs`). */
  appCertsDir(): string
  /** Active workspace path, or null when no workspace is open. */
  getWorkspacePath(): string | null
  /** Read the app-scope `tls` settings block (may be undefined). */
  readAppTls(): TlsScopeSettings | undefined
  /** Persist the app-scope `tls` block; returns the stored value (may be undefined). */
  writeAppTls(next: TlsScopeSettings): TlsScopeSettings | undefined
  /** Read the workspace-scope `tls` block (may be undefined). */
  readWorkspaceTls(workspacePath: string): Promise<TlsScopeSettings | undefined>
  /** Persist the workspace-scope `tls` block; returns the stored value (may be undefined). */
  writeWorkspaceTls(
    workspacePath: string,
    next: TlsScopeSettings
  ): Promise<TlsScopeSettings | undefined>
}

export interface AddCAArgs {
  scope: TlsScope
  sourcePath: string
  label?: string
}

export interface AddClientArgs {
  scope: TlsScope
  host: string
  port?: number | null
  type: 'pem' | 'pfx'
  sourcePaths: { certPath?: string; keyPath?: string; pfxPath?: string }
  passphrase?: string | null
}

export interface UpdateCAArgs {
  scope: TlsScope
  id: string
  patch: { label?: string | null }
}

export interface UpdateClientArgs {
  scope: TlsScope
  id: string
  patch: {
    host?: string
    port?: number | null
    passphrase?: string | null
    disabled?: boolean
  }
}

export interface RemoveArgs {
  scope: TlsScope
  id: string
  kind: 'ca' | 'client'
}

export interface TlsStore {
  loadScopeSettings(scope: TlsScope): Promise<TlsScopeSettings>
  addCA(args: AddCAArgs): Promise<CACertEntry>
  addClient(args: AddClientArgs): Promise<ClientCertEntry>
  updateCA(args: UpdateCAArgs): Promise<CACertEntry>
  updateClient(args: UpdateClientArgs): Promise<ClientCertEntry>
  remove(args: RemoveArgs): Promise<{ removed: true }>
}

const VARIABLE_REFERENCE = /\{\{[^{}]+\}\}/

/** True when the value carries a `{{...}}` reference anywhere within it. */
function hasVariableReference(value: string | null | undefined): boolean {
  return typeof value === 'string' && VARIABLE_REFERENCE.test(value)
}

/**
 * REQ-0089: an app-global certificate passphrase is literal-only. A `{{...}}`
 * reference is rejected at save time — it cannot resolve (environments and the
 * workspace key are workspace-scoped), so allowing it would guarantee a handshake
 * failure later. Workspace-scope passphrases accept references (resolved at send
 * time); a literal one is valid but surfaces a non-blocking warning in the UI.
 */
function assertPassphraseAllowed(scope: TlsScope, passphrase: string | null | undefined): void {
  if (scope === 'app' && hasVariableReference(passphrase)) {
    throw new CoreError(
      'CLIENT_CERT_PASSPHRASE_VARIABLE_NOT_ALLOWED',
      'A global certificate passphrase cannot use a {{variable}} reference. Use a literal passphrase, or move the certificate to workspace scope to use a variable.'
    )
  }
}

/**
 * An entry written by hand (or moved from a CLI run file) may have no id. It
 * gets one derived from its position and content, so every load of the same
 * file yields the same id (the panel's row and the next mutation agree on it);
 * the next write persists it.
 */
function withStableId<T extends { id: string }>(entry: T, prefix: string, index: number): T {
  if (typeof entry.id === 'string' && entry.id !== '') return entry
  const digest = createHash('sha256')
    .update(`${prefix}:${index}:${JSON.stringify(entry)}`)
    .digest('hex')
    .slice(0, 32)
  return { ...entry, id: `${prefix}-${digest}` }
}

function normaliseTls(value: TlsScopeSettings | undefined): TlsScopeSettings {
  if (!value) return { caCertificates: [], clientCertificates: [] }
  return {
    caCertificates: (value.caCertificates ?? []).map((e, i) => withStableId(e, 'ca', i)),
    clientCertificates: (value.clientCertificates ?? []).map((e, i) => withStableId(e, 'cc', i))
  }
}

/**
 * The host pattern as it is stored: normalized to the form the matcher compares
 * (TLS-09), so what the panel lists is what a request is matched against.
 */
function normaliseHostArg(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw new TlsImportError('TLS_HOST_REQUIRED', 'Host pattern is required')
  const host = normalizeHostPattern(raw)
  if (host === null) {
    throw new TlsImportError(
      'TLS_HOST_INVALID',
      'Host pattern must be a host name, an IP address or *.domain, with no port or path'
    )
  }
  return host
}

/** The rule of the CLI's `--tls-config` validator: an integer from 1 to 65535, or none. */
function assertPortArg(port: unknown): void {
  if (port === null || port === undefined) return
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new TlsImportError(
      'TLS_PORT_INVALID',
      'Port must be a number from 1 to 65535, or empty for any port'
    )
  }
}

/** A missing or empty id would match an id-less entry instead of naming one. */
function assertEntryId(id: unknown): void {
  if (typeof id !== 'string' || id === '') {
    throw new Error('A certificate id is required')
  }
}

/**
 * Build a TLS certificate store bound to the supplied host collaborators. A
 * single instance is created per process by the adapter.
 */
/**
 * Write `content` under `dir/filename` without ever clobbering a *different*
 * certificate's bytes (REQ write-safety §6.7). The canonical filename derives
 * from a short content hash, so two different materials can collide on it:
 * - the slot is free → write and use `filename`;
 * - the slot holds identical bytes → reuse it (no write, no duplication);
 * - the slot holds different bytes → disambiguate (`stem-2.ext`, `stem-3.ext`, …)
 *   until a free-or-identical slot is found, preserving the existing file.
 * Returns the filename actually used (which the caller records in metadata).
 */
export async function writeCertFileNoOverwrite(
  dir: string,
  filename: string,
  content: Buffer
): Promise<string> {
  const dot = filename.lastIndexOf('.')
  const stem = dot === -1 ? filename : filename.slice(0, dot)
  const ext = dot === -1 ? '' : filename.slice(dot)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? filename : `${stem}-${n}${ext}`
    const full = join(dir, candidate)
    let existing: Buffer | null
    try {
      existing = await fs.readFile(full)
    } catch {
      existing = null
    }
    if (existing === null) {
      await atomicWriteFile(full, content)
      return candidate
    }
    if (existing.equals(content)) return candidate // identical material — reuse
    // Different bytes under this name: keep them, try the next disambiguated name.
  }
}

export function createTlsStore(deps: TlsStoreDeps): TlsStore {
  // ── Scope-aware paths and metadata access ────────────────────────────────

  function scopeCertsDir(scope: TlsScope): string | null {
    if (scope === 'app') return deps.appCertsDir()
    const ws = deps.getWorkspacePath()
    return ws ? workspaceCertsDir(ws) : null
  }

  function loadAppTlsScope(): TlsScopeSettings {
    return normaliseTls(deps.readAppTls())
  }

  async function loadWorkspaceTlsScope(): Promise<TlsScopeSettings> {
    const ws = deps.getWorkspacePath()
    if (!ws) return { caCertificates: [], clientCertificates: [] }
    return normaliseTls(await deps.readWorkspaceTls(ws))
  }

  async function writeScopeSettings(
    scope: TlsScope,
    next: TlsScopeSettings
  ): Promise<TlsScopeSettings> {
    if (scope === 'app') {
      return normaliseTls(deps.writeAppTls(next))
    }
    const ws = deps.getWorkspacePath()
    if (!ws) throw new Error('No active workspace — cannot write workspace TLS settings')
    return normaliseTls(await deps.writeWorkspaceTls(ws, next))
  }

  async function loadScopeSettings(scope: TlsScope): Promise<TlsScopeSettings> {
    if (scope === 'app') return loadAppTlsScope()
    return loadWorkspaceTlsScope()
  }

  // ── Add ──────────────────────────────────────────────────────────────────

  async function addCA(args: AddCAArgs): Promise<CACertEntry> {
    const { content } = await readPemCertFile(args.sourcePath)
    const dir = scopeCertsDir(args.scope)
    if (!dir) throw new Error('No active workspace — cannot add workspace CA')

    const prefix = (args.label && args.label.trim()) || 'ca'
    const canonical = canonicalCertFilename(
      prefix.startsWith('ca-') ? prefix : `ca-${prefix}`,
      content,
      'pem'
    )
    await fs.mkdir(dir, { recursive: true })
    const filename = await writeCertFileNoOverwrite(dir, canonical, content)

    const entry: CACertEntry = {
      id: `ca-${randomUUID()}`,
      file: filename,
      ...(args.label && args.label.trim() ? { label: args.label.trim() } : {})
    }

    const current = await loadScopeSettings(args.scope)
    const next: TlsScopeSettings = {
      caCertificates: [...current.caCertificates, entry],
      clientCertificates: current.clientCertificates
    }
    await writeScopeSettings(args.scope, next)
    return entry
  }

  async function addClient(args: AddClientArgs): Promise<ClientCertEntry> {
    const host = normaliseHostArg(args.host)
    assertPortArg(args.port)
    // Reject an invalid app-global passphrase before anything is written to disk.
    assertPassphraseAllowed(args.scope, args.passphrase)

    const dir = scopeCertsDir(args.scope)
    if (!dir) throw new Error('No active workspace — cannot add workspace client cert')
    await fs.mkdir(dir, { recursive: true })

    let entry: ClientCertEntry
    if (args.type === 'pem') {
      if (!args.sourcePaths.certPath || !args.sourcePaths.keyPath) {
        throw new TlsImportError(
          'TLS_FILES_REQUIRED',
          'PEM type requires both certPath and keyPath'
        )
      }
      const cert = await readPemCertFile(args.sourcePaths.certPath)
      const key = await readPemKeyFile(args.sourcePaths.keyPath)
      const certFile = await writeCertFileNoOverwrite(
        dir,
        canonicalCertFilename(`client-${host}`, cert.content, 'crt'),
        cert.content
      )
      const keyFile = await writeCertFileNoOverwrite(
        dir,
        canonicalCertFilename(`client-${host}`, key.content, 'key'),
        key.content
      )
      entry = {
        id: `cc-${randomUUID()}`,
        host,
        port: args.port ?? null,
        type: 'pem',
        certFile,
        keyFile,
        passphrase: args.passphrase ?? null,
        disabled: false
      }
    } else {
      if (!args.sourcePaths.pfxPath) {
        throw new TlsImportError('TLS_FILES_REQUIRED', 'PFX type requires pfxPath')
      }
      const pfx = await readPfxFile(args.sourcePaths.pfxPath)
      const pfxFile = await writeCertFileNoOverwrite(
        dir,
        canonicalCertFilename(`client-${host}`, pfx.content, 'pfx'),
        pfx.content
      )
      entry = {
        id: `cc-${randomUUID()}`,
        host,
        port: args.port ?? null,
        type: 'pfx',
        pfxFile,
        passphrase: args.passphrase ?? null,
        disabled: false
      }
    }

    const current = await loadScopeSettings(args.scope)
    const next: TlsScopeSettings = {
      caCertificates: current.caCertificates,
      clientCertificates: [...current.clientCertificates, entry]
    }
    await writeScopeSettings(args.scope, next)
    return entry
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async function updateCA(args: UpdateCAArgs): Promise<CACertEntry> {
    assertEntryId(args.id)
    const current = await loadScopeSettings(args.scope)
    const idx = current.caCertificates.findIndex((c) => c.id === args.id)
    if (idx < 0) throw new Error(`CA certificate not found: ${args.id}`)
    const existing = current.caCertificates[idx]
    const updated: CACertEntry = {
      ...existing,
      ...(args.patch.label !== undefined
        ? args.patch.label === null || args.patch.label.trim() === ''
          ? { label: undefined }
          : { label: args.patch.label.trim() }
        : {})
    }
    // Drop the key entirely when label is cleared (keeps JSON tidy).
    if (updated.label === undefined) delete (updated as Partial<CACertEntry>).label
    const list = [...current.caCertificates]
    list[idx] = updated
    await writeScopeSettings(args.scope, { ...current, caCertificates: list })
    return updated
  }

  async function updateClient(args: UpdateClientArgs): Promise<ClientCertEntry> {
    assertEntryId(args.id)
    // Reject an invalid app-global passphrase before any persistence.
    if (args.patch.passphrase !== undefined) {
      assertPassphraseAllowed(args.scope, args.patch.passphrase)
    }
    const current = await loadScopeSettings(args.scope)
    const idx = current.clientCertificates.findIndex((c) => c.id === args.id)
    if (idx < 0) throw new Error(`Client certificate not found: ${args.id}`)
    const existing = current.clientCertificates[idx]

    // Host and port are the matching metadata — validate them as addClient does.
    const nextHost = args.patch.host !== undefined ? normaliseHostArg(args.patch.host) : undefined
    if (args.patch.port !== undefined) assertPortArg(args.patch.port)

    const updated: ClientCertEntry = {
      ...existing,
      ...(nextHost !== undefined ? { host: nextHost } : {}),
      ...(args.patch.port !== undefined ? { port: args.patch.port } : {}),
      ...(args.patch.passphrase !== undefined ? { passphrase: args.patch.passphrase } : {}),
      ...(args.patch.disabled !== undefined ? { disabled: args.patch.disabled } : {})
    }
    const list = [...current.clientCertificates]
    list[idx] = updated
    await writeScopeSettings(args.scope, { ...current, clientCertificates: list })
    return updated
  }

  // ── Remove ─────────────────────────────────────────────────────────────────

  async function safeUnlink(dir: string, filename: string): Promise<void> {
    try {
      assertSafeIdentifier(filename, 'certificate file')
      await fs.unlink(join(dir, filename))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[tls.store] failed to unlink ${filename}:`, err)
      }
    }
  }

  /** Every file an entry of the scope points at. */
  function referencedFiles(settings: TlsScopeSettings): Set<string> {
    const files = new Set<string>()
    for (const ca of settings.caCertificates) if (ca.file) files.add(ca.file)
    for (const cc of settings.clientCertificates) {
      for (const f of [cc.certFile, cc.keyFile, cc.pfxFile]) if (f) files.add(f)
    }
    return files
  }

  async function remove(args: RemoveArgs): Promise<{ removed: true }> {
    assertEntryId(args.id)
    const current = await loadScopeSettings(args.scope)
    const dir = scopeCertsDir(args.scope)

    let targetFiles: (string | undefined)[]
    let next: TlsScopeSettings
    if (args.kind === 'ca') {
      const target = current.caCertificates.find((c) => c.id === args.id)
      if (!target) return { removed: true }
      targetFiles = [target.file]
      next = {
        caCertificates: current.caCertificates.filter((c) => c.id !== args.id),
        clientCertificates: current.clientCertificates
      }
    } else {
      const target = current.clientCertificates.find((c) => c.id === args.id)
      if (!target) return { removed: true }
      targetFiles = [target.certFile, target.keyFile, target.pfxFile]
      next = {
        caCertificates: current.caCertificates,
        clientCertificates: current.clientCertificates.filter((c) => c.id !== args.id)
      }
    }

    // The metadata goes first: when it cannot be saved the call rejects with the
    // entry and its files intact. Unlinking afterwards is best-effort (a file
    // left behind is unreferenced, never an entry pointing at nothing).
    await writeScopeSettings(args.scope, next)

    // Identical imports share one file (writeCertFileNoOverwrite): a file another
    // remaining entry of the scope still uses stays on disk.
    if (dir) {
      const stillUsed = referencedFiles(next)
      for (const file of targetFiles) {
        if (file && !stillUsed.has(file)) await safeUnlink(dir, file)
      }
    }

    return { removed: true }
  }

  return {
    loadScopeSettings,
    addCA,
    addClient,
    updateCA,
    updateClient,
    remove
  }
}
