// Shared types between main, preload, and renderer processes.

// ── Theme ──────────────────────────────────────────────────────────────────
export type Theme = 'light' | 'dark' | 'system'

/** The permitted `Theme` values, for validating what a hand-edited file holds. */
export const THEMES: readonly Theme[] = ['light', 'dark', 'system']

// ── Window ─────────────────────────────────────────────────────────────────
export type WindowPlatform = 'win32' | 'darwin' | 'linux'

/**
 * Localised strings for the native "app is not responding" close-fallback
 * dialog (REQ-0104). Pushed by the renderer to main on i18n init and on every
 * language change — main caches the latest push and shows the dialog with it
 * if a close request is never acknowledged. Not tied to any specific
 * language: main treats this as an opaque, always-current snapshot.
 */
export interface UnresponsiveCloseStrings {
  title: string
  message: string
  detail: string
  keepWaiting: string
  closeAnyway: string
}

// ── Application menu ───────────────────────────────────────────────────────
/**
 * The menu's visible vocabulary, pushed by the renderer on every language
 * resolution — same contract shape as `UnresponsiveCloseStrings` above, for the
 * same reason: main has no i18n runtime. Main holds a bootstrap default that is
 * only ever seen while the menu is disabled (REQ menu coherence §6.3, §6.6).
 */
export interface MenuLabels {
  app: {
    about: string
    checkUpdates: string
    services: string
    hide: string
    hideOthers: string
    unhide: string
    quit: string
  }
  file: {
    label: string
    newRequest: string
    newCollection: string
    openWorkspace: string
    closeWorkspace: string
    save: string
    closeTab: string
    closeAllTabs: string
    closeWindow: string
  }
  edit: {
    label: string
    undo: string
    redo: string
    cut: string
    copy: string
    paste: string
    selectAll: string
  }
  request: {
    label: string
    send: string
    focusUrl: string
  }
  view: {
    label: string
    commandPalette: string
    toggleSidebar: string
    toggleActivityPanel: string
    toggleDevTools: string
    zoomIn: string
    zoomOut: string
    resetZoom: string
  }
  window: {
    label: string
    minimize: string
    zoom: string
    front: string
  }
}

/**
 * The slice of the menu state only the interface can report. Everything else
 * (window presence, focus, workspace) main learns on its own.
 */
export interface RendererMenuState {
  hasAnyTab: boolean
  hasActiveTab: boolean
}

// ── Workspace dialogs ──────────────────────────────────────────────────────
/**
 * Localised strings shown by the native dialogs the main process raises during
 * workspace open/create. The renderer owns i18next, so it passes the resolved
 * strings down to the main on every call.
 *
 * `rootRejectDetail` receives `{{path}}` and `createMessage` receives
 * `{{name}}` — both are substituted by the renderer before sending.
 */
export interface WorkspaceOpenStrings {
  rootRejectTitle: string
  rootRejectMessage: string
  rootRejectDetail: string
  rootRejectOk: string
  createTitle: string
  createMessage: string
  createDetail: string
  createConfirm: string
  createCancel: string
}

/**
 * Result of `workspace.openPath` (opening a path from the recent list). Unlike
 * open/create, it never offers to create a workspace: the path must already be
 * an initialized workspace (has `.fetchpier/`). On failure the stale recent
 * entry is pruned by the main process.
 */
export type OpenPathResult =
  { ok: true; path: string } | { ok: false; reason: 'not-found' | 'not-a-workspace' }

/**
 * Result of `workspace.getLast` (restoring the last workspace at launch).
 *
 * REQ-0122: the same two failure reasons as {@link OpenPathResult}, because the
 * two entry points apply the same test — a folder is restorable only when it
 * exists **and** carries the `.fetchpier/` marker. They previously disagreed:
 * `openPath` refused an unmarked folder while the restore ran the idempotent
 * layout creation over it, silently rebuilding a skeleton where a workspace used
 * to be. On either failure the recent entry (and the saved pointer) is pruned.
 *
 * `'none'` is not a failure — nothing was saved to restore. It carries no message.
 */
export type RestoreResult =
  { ok: true; path: string } | { ok: false; reason: 'none' | 'not-found' | 'not-a-workspace' }

// ── Tabs ───────────────────────────────────────────────────────────────────

export interface KeyValuePair {
  id: string
  key: string
  value: string
  enabled: boolean
  /**
   * REQ-0086: set on load when this query parameter's key/value failed
   * percent-decoding (malformed sequence, e.g. `%E0`). The key and value are then
   * kept in their raw, undecoded form. The flag drives three behaviors: the wire
   * URL emits the pair verbatim (never re-encoded) so the literal author bytes are
   * transmitted; the request is marked unsaved-with-a-reason on desktop; and the
   * serializer drops the pair on save (honest removal, not repair). It is cleared
   * when the user edits the row. Only meaningful for query params.
   */
  malformed?: boolean
  /**
   * REQ-0124: set when this query parameter was authored with no `=` at all
   * (`?wsdl`, a bare flag token) rather than with an empty value (`?wsdl=`).
   * A server is free to distinguish the two, so the authored form is preserved
   * end to end: every site that rebuilds a query from structured parameters —
   * the URL bar, the serializer, the outgoing URL, the masked snapshot — emits
   * the key alone. Set only by `splitUrlAndParams` (the one place URL text is
   * interpreted), so the desktop load path, the URL-bar edit path and the CLI
   * flat-URL path cannot disagree. Cleared when the user edits the row's
   * **value** — the only surface that says a value exists — and deliberately
   * *not* when the key is edited, so renaming a flag does not add an `=`.
   * Only meaningful for query params.
   */
  valueless?: boolean
}

/**
 * One outgoing header, name + value. The ordered, duplicate-capable header
 * representation (`.http` round-trip fidelity): an HTTP message may repeat a
 * header name (`Accept`, `X-Custom`, …) and the order is significant, so the
 * wire-bound headers are carried as a list of these rather than a name→value
 * map. The name→value `Record` accessor (`HttpRequest.headers`) is retained as
 * a lossy first/last-wins convenience view; whenever both exist, `headerList`
 * is authoritative for the wire and the round-trip (mirrors how structured
 * `params` is canonical-when-present over the flat `url`). Helpers in
 * `@shared/lib/headers` convert and query this list.
 */
export interface HeaderEntry {
  name: string
  value: string
}

/** Kind of row a `# @disabled` directive carries (`.http` round-trip fidelity). */
export type DisabledKind = 'header' | 'param' | 'field'

/**
 * A disabled header / query param / form field, carried separately from the
 * wire-bound set so it round-trips in place without ever being sent. `pos` is the
 * row's index in the full author-ordered list of its kind (enabled + disabled).
 */
export interface DisabledRow {
  kind: DisabledKind
  pos: number
  key: string
  value: string
  /**
   * REQ-0124: the row is a value-less query parameter (`?wsdl`, no `=`) — see
   * `KeyValuePair.valueless`. Persisted by omitting the `=` from the directive
   * payload. Only ever set for `kind: 'param'`: form fields share the payload
   * grammar but not the distinction, because no editing gesture can create one.
   */
  valueless?: boolean
}

/**
 * REQ-0086: a non-fatal warning produced when a query parameter key/value fails
 * percent-decoding on load. Surfaced by the CLI reporter; the desktop drives its
 * advisory off `KeyValuePair.malformed` instead. The payload is limited to the
 * raw key and its position — never headers, body, or other parameter values.
 */
export interface QueryDecodeWarning {
  code: 'MALFORMED_QUERY_ENCODING'
  /** Raw, undecoded parameter key text (parameter keys are not secrets). */
  rawKey: string
  /** Zero-based position of the parameter within the request's query. */
  index: number
}

/**
 * A `{{name}}` reference the request carried but the environment had no value
 * for. Warn-and-proceed: the reference is left literal and the request is still
 * sent, so this is advisory, never fatal. One per distinct name.
 *
 * Emitted for every surface the resolver walks — URL, query, headers, body, form
 * fields, multipart, and the auth config's own fields. Auth is the reason this
 * warning exists on the result at all: a reference destroyed by base64 or
 * percent-encoding used to vanish before anything could report it, so there was
 * nothing for an adapter to show.
 *
 * The payload is the variable *name*, which is already visible in the request
 * file — never the value it would have resolved to.
 */
export interface UnresolvedVariableWarning {
  code: 'UNRESOLVED_VARIABLE'
  /** The referenced name, trimmed, without the surrounding braces. */
  name: string
}

/** Why the jar refused a cookie a response offered. */
export type CookieRejectionReason =
  /** The `Domain` attribute names a domain the offering host does not belong to. */
  | 'DOMAIN_MISMATCH'
  /** The `Domain` attribute names a public suffix, which would match every host under it. */
  | 'PUBLIC_SUFFIX'
  /** The name carries a reserved security prefix whose rules the attributes violate. */
  | 'PREFIX_VIOLATION'
  /** Would replace a stored `Secure` cookie, but arrived over an insecure connection. */
  | 'INSECURE_OVERWRITE'
  /** The header could not be parsed into a name/value pair. */
  | 'MALFORMED'
  /** The jar refused it for a reason this build does not classify. */
  | 'REJECTED'

/**
 * REQ-0115: a cookie a response offered and the jar did not store. Advisory —
 * the send completes and the remaining cookies are still processed.
 *
 * The payload names the cookie and the host that offered it, never the value:
 * a rejected cookie is still a credential someone chose.
 */
export interface CookieRejectedWarning {
  code: 'COOKIE_REJECTED'
  /** Cookie name as offered. */
  name: string
  /** Host of the hop that offered it — under a redirect chain, not the request's own host. */
  host: string
  reason: CookieRejectionReason
}

/**
 * REQ-0115: a cookie that **was** stored but carries `SameSite=None` without
 * `Secure`. A browser rejects that combination, so the same request behaves
 * differently there — which is exactly the divergence a debugging client owes
 * the user. Never used to filter what is sent (REQ-0115 §6.6).
 */
export interface CookieCrossSiteWarning {
  code: 'COOKIE_CROSS_SITE_INSECURE'
  name: string
  host: string
}

/**
 * The advisories the response viewer's Cookies section owns. Named because the
 * section renders exactly this subset and must not silently start rendering a
 * warning family that belongs somewhere else.
 */
export type CookieWarning = CookieRejectedWarning | CookieCrossSiteWarning

/**
 * The cookie jar could not be used for this send: reading the stored cookies
 * failed (the send went out without them) or persisting the captured ones failed
 * (the response is unaffected; the cookies are not stored). Carries the reason,
 * never a cookie value.
 */
export interface CookieJarUnavailableWarning {
  code: 'COOKIE_JAR_UNAVAILABLE'
  phase: 'read' | 'persist'
  reason: string
}

/**
 * TLS material configured for this send could not be applied — an unreadable CA
 * or client certificate, a passphrase reference with no value, or a resolution
 * failure. The send proceeds without that material.
 */
export interface TlsMaterialUnavailableWarning {
  code: 'TLS_MATERIAL_UNAVAILABLE'
  reason: string
}

/** The response declared a `Content-Encoding` that failed to decode; the body is kept as received. */
export interface ResponseDecodingFailedWarning {
  code: 'RESPONSE_DECODING_FAILED'
  encoding: string
  reason: string
}

/** The response declared a `Content-Encoding` outside the supported set; the body is kept as received. */
export interface UnsupportedContentEncodingWarning {
  code: 'UNSUPPORTED_CONTENT_ENCODING'
  encoding: string
}

/** HTTP/2 was requested for a plain-HTTP target; the send used HTTP/1.1. */
export interface Http2DowngradedWarning {
  code: 'HTTP2_DOWNGRADED'
}

/** A user-set `Content-Type` was replaced by the multipart encoder's own (it owns the boundary). */
export interface ContentTypeReplacedWarning {
  code: 'CONTENT_TYPE_REPLACED'
}

/**
 * A script environment write that could not be persisted to the local value
 * layer. The value is still used for the rest of the run / session.
 * - `KEY_MISSING`: a secret-named write needs the workspace key and none is available.
 * - `LOCAL_KEY_MISMATCH`: the local layer is encrypted under a different
 *   (older) workspace key; writing would make its entries unreadable.
 * Carries the variable name, never the value.
 */
export interface EnvWriteNotPersistedWarning {
  code: 'ENV_WRITE_NOT_PERSISTED'
  name: string
  reason: 'KEY_MISSING' | 'LOCAL_KEY_MISMATCH'
}

/**
 * A variable the request uses whose value came from a `{{$env.NAME}}` reference
 * that neither `.env` nor the process environment defines — so it was sent empty.
 * A name defined with an empty value is intended and produces none. Names only.
 */
export interface UndefinedEnvReferenceWarning {
  code: 'UNDEFINED_ENV_REFERENCE'
  /** The environment variable the request uses. */
  name: string
  /** The `$env` name it references (`API_TOKEN` for `{{$env.API_TOKEN}}`). */
  envName: string
}

/** Non-fatal advisories a send can produce. Consumers switch on `code`. */
export type ExecutionWarning =
  | UndefinedEnvReferenceWarning
  | QueryDecodeWarning
  | UnresolvedVariableWarning
  | CookieRejectedWarning
  | CookieCrossSiteWarning
  | CookieJarUnavailableWarning
  | TlsMaterialUnavailableWarning
  | ResponseDecodingFailedWarning
  | UnsupportedContentEncodingWarning
  | Http2DowngradedWarning
  | ContentTypeReplacedWarning
  | EnvWriteNotPersistedWarning

export type BodyType = 'none' | 'x-www-form-urlencoded' | 'raw' | 'binary' | 'multipart-form'

export type RawSubtype = 'json' | 'xml' | 'javascript' | 'text' | 'html'

export interface NoAuthConfig {
  type: 'none'
}
export interface BearerAuthConfig {
  type: 'bearer'
  token: string
}
export interface BasicAuthConfig {
  type: 'basic'
  username: string
  password: string
}
export interface ApiKeyAuthConfig {
  type: 'api-key'
  key: string
  value: string
  location: 'header' | 'query'
}
export type AuthConfig = NoAuthConfig | BearerAuthConfig | BasicAuthConfig | ApiKeyAuthConfig

/**
 * Reference to a file staged inside the workspace (under `requests/.files/`) and
 * used as the raw body for a request with `bodyType === 'binary'`. The reference
 * format is `<sha256>__<sanitized-original-name>`, content-addressed so two
 * requests attaching the same file dedupe naturally on disk.
 */
export interface BinaryFileAttachment {
  /** Filename inside `requests/.files/`. Format: `<sha256>__<sanitized-name>`. */
  ref: string
  /** Original filename at the moment of attachment (display only). */
  originalName: string
  /** Size in bytes at the moment of attachment (display only). */
  sizeBytes: number
  /** Resolved mime type at stage time; used as the fallback Content-Type when the user hasn't set one. */
  mimeType: string
}

/**
 * One row returned by `binary:list` — the picker UI uses these to let the user
 * re-attach a file already staged in the workspace without re-importing it
 * from disk. `mtimeMs` is added on top of `BinaryFileAttachment` to drive
 * recency-based sorting; the renderer strips it when constructing the
 * persisted `BinaryFileAttachment`.
 */
export interface StagedBinaryEntry extends BinaryFileAttachment {
  mtimeMs: number
}

/**
 * Multipart/form-data body parts (REQ-0066). The body of a request with
 * `bodyType === 'multipart-form'` is a list of parts of two kinds: text and
 * file. File parts reference workspace-staged files via the same
 * `<sha256>__<sanitized-name>` mechanism as binary bodies (REQ-0065).
 *
 * `id` is a local UI identifier generated at part creation. It is NOT
 * persisted to the `.http` file — it exists so React keys, drag-and-drop
 * reorder, and editor state can address parts by stable identity instead of
 * array index. The encoder and serializer ignore it.
 */
export interface MultipartTextPart {
  kind: 'text'
  id: string
  name: string
  value: string
  /** Optional per-part Content-Type. When unset, receivers default to text/plain;charset=US-ASCII per RFC 7578 §4.4. */
  contentType?: string
  /** Disabled parts are persisted but skipped on send. */
  disabled?: boolean
}

export interface MultipartFilePart {
  kind: 'file'
  id: string
  name: string
  /** Reference to a workspace-staged file. Re-uses the BinaryFileAttachment shape. */
  file: BinaryFileAttachment
  /** Optional wire-`filename` override. When unset, the encoder falls back to the file's original name. */
  filename?: string
  /** Optional per-part Content-Type. When unset, encoder uses `file.mimeType` and falls back to application/octet-stream. */
  contentType?: string
  /** Disabled parts are persisted but skipped on send. */
  disabled?: boolean
  /**
   * Populated by the parser when a part marker was parsed but failed
   * validation (e.g. missing required attribute, invalid `fileRef` shape).
   * The part is loaded as disabled with this annotation so the file
   * round-trips without data loss and the user can fix it in the UI.
   */
  parseError?: string
}

export type MultipartPart = MultipartTextPart | MultipartFilePart

export interface RequestEditorState {
  method: string
  url: string
  params: KeyValuePair[]
  headers: KeyValuePair[]
  bodyType: BodyType
  /** Subtype for raw bodies — drives syntax highlighting and auto Content-Type. */
  rawSubtype: RawSubtype
  body: string
  formFields: KeyValuePair[]
  auth: AuthConfig
  preRequestScript: string
  postResponseScript: string
  settings: RequestSettings
  /** Preserved user comments, re-emitted as a block on save (not editable). */
  comments?: string[]
  /** Staged binary file reference. Only meaningful when `bodyType === 'binary'`. */
  binaryFile?: BinaryFileAttachment
  /** Multipart parts. Only meaningful when `bodyType === 'multipart-form'`. */
  multipartParts?: MultipartPart[]
}

/** Sub-pestaña activa dentro del editor de request. */
export type RequestEditorTab = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'settings'

/** Sub-pestaña activa dentro del response viewer. */
export type ResponseViewerTab = 'body' | 'cookies' | 'headers' | 'tests'

/** Fase activa del editor de scripts (pre-request o post-response). */
export type ScriptPhase = 'pre' | 'post'

/**
 * Persisted UI state for a single request, keyed by the request's stable UUID
 * (`# @id`). Each field is optional — missing fields fall back to the editor's
 * runtime defaults so older workspaces and `.http` files created outside
 * Fetchpier behave normally.
 */
export interface RequestUiState {
  activeReqTab?: RequestEditorTab
  activeResponseTab?: ResponseViewerTab
  activeScriptPhase?: ScriptPhase
}

/** Map persisted in `<workspace>/requests/.state/ui-state.json`. */
export type RequestUiStateMap = Record<string, RequestUiState>

/**
 * Default request headers are **implicit**: applied at send time when the
 * request carries no enabled header of that name (case-insensitive), shown in
 * the editor as read-only default rows, and never written into a `.http` file.
 * A header the user writes is sent as written. Persisting a default froze it at
 * whatever version wrote it — the reason `Fetchpier/0.1.0` outlived 0.1.0.
 */
export const DEFAULT_ACCEPT_ENCODING = 'gzip, deflate, br'

/** Default `User-Agent` sent by the desktop app: `Fetchpier/<app version>`. */
export function desktopUserAgent(appVersion: string): string {
  return `Fetchpier/${appVersion}`
}

/** Default `User-Agent` sent by the command-line runner: `Fetchpier-CLI/<CLI version>`. */
export function cliUserAgent(cliVersion: string): string {
  return `Fetchpier-CLI/${cliVersion}`
}

/** Last-resort `User-Agent` for callers of the HTTP client that supply none. */
export const FALLBACK_USER_AGENT = 'Fetchpier'

export const DEFAULT_REQUEST_STATE: RequestEditorState = {
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  bodyType: 'none',
  rawSubtype: 'json',
  body: '',
  formFields: [],
  auth: { type: 'none' },
  preRequestScript: '',
  postResponseScript: '',
  settings: {}
}

/** Maps a raw subtype to the Content-Type auto-injected when the user does not set one. */
export const RAW_SUBTYPE_CONTENT_TYPE: Record<RawSubtype, string> = {
  json: 'application/json',
  xml: 'application/xml',
  javascript: 'application/javascript',
  text: 'text/plain',
  html: 'text/html'
}

/**
 * A tab's mutually-exclusive lifecycle mode. Exactly one of these holds at a time
 * — modelled as a single enum so `preview && pinned` is unrepresentable.
 */
export type TabMode = 'permanent' | 'preview' | 'pinned'

export interface Tab {
  id: string
  title: string
  filePath: string | null
  isDirty: boolean
  request: RequestEditorState
  response: HttpResponse | null
  isLoading: boolean
  error: string | null
  /** Stable UUID that identifies this request definition across sessions */
  requestId: string
  /**
   * Baseline hash of the serialized request captured at load / last save
   * (REQ-0095). `isDirty` is derived by comparing the live content's hash against
   * this. `undefined` means no baseline yet (a lazy file-backed tab not loaded
   * into the editor) — such a tab is treated as not modified.
   */
  cleanHash?: string
  /** When true, all request controls are disabled (used for history viewer tabs) */
  isReadOnly?: boolean
  /**
   * Mutually-exclusive tab mode (the three values cannot coexist):
   * - `'preview'` — ephemeral, single-click, italic, at most one per workspace; a
   *   double click or any edit promotes it. A dirty tab is never a preview.
   * - `'pinned'` — grouped at the front of the bar, pin glyph instead of the close
   *   button, spared by the bulk-close commands. Pinning a preview promotes it first.
   * - `'permanent'` — the default. Persisted per workspace (absence of a mode marker
   *   on disk restores as `'permanent'`).
   */
  mode: TabMode
  /** History entry ID — used to deduplicate history tabs */
  historyEntryId?: string
  /** ISO timestamp of the history entry — displayed in the read-only banner */
  historyTimestamp?: string
  /** Raw text content — when set the tab renders a read-only CodeMirror viewer */
  rawContent?: string
  /**
   * The backing file disappeared from its path on disk — moved or deleted by an
   * external tool (REQ open-tab-file-reconciliation). The tab stays open with its
   * content intact; its title renders struck-through in a warning colour and a
   * deliberate save re-persists the file at that path. Transient UI flag — never
   * persisted to the session.
   */
  removedOnDisk?: boolean
  /**
   * The backing file changed on disk while this tab had unsaved edits — surfaced
   * as a "changed on disk" conflict offering reload-or-keep. A save is blocked
   * until the user resolves it, so an external edit is never silently overwritten.
   * Transient UI flag — never persisted to the session.
   */
  conflict?: boolean
  /** Results of pre/post scripts executed alongside the last send */
  scriptResults?: ScriptResultsBundle
  /**
   * REQ-0115: cookies attached to, and offered by, the last send — across every
   * hop of a redirect chain. Drives the response viewer's Cookies section.
   * Transient UI state; never persisted to the session or to the `.http`.
   */
  cookies?: { sent: CookieSnapshot[]; received: CookieSnapshot[] }
  /**
   * REQ-0115: non-fatal advisories the last send produced. Today the Cookies
   * section renders the cookie-related ones; the other kinds ride along and are
   * still unsurfaced in the desktop (see the REQ's follow-up).
   */
  warnings?: ExecutionWarning[]
  /** Set while a send is in-flight — drives the Send → Cancel button toggle and `http:cancel` correlation. */
  inFlightExecutionId?: string
  /** Sub-pestaña activa del editor de request (Params/Headers/Body/...). Estado de UI, no se persiste al .http. */
  activeReqTab?: RequestEditorTab
  /** Sub-pestaña activa del response viewer (Body/Headers/Tests). UI state, persistido en `requests/.state/ui-state.json`. */
  activeResponseTab?: ResponseViewerTab
  /** Fase activa del editor de scripts (pre/post). UI state, persistido en `requests/.state/ui-state.json`. */
  activeScriptPhase?: ScriptPhase
  /**
   * `.http` round-trip fidelity: verbatim remainder of a multi-request file from
   * the first `###` separator onward. The editor edits only the first request;
   * this tail is re-emitted byte-for-byte on save so the additional requests are
   * never lost. Absent for single-request files. Transient — not persisted to
   * the session map (re-derived from disk on load).
   */
  tail?: string
  /**
   * The parsed file held content a save would normalize away (a stray line, or a
   * comment relocated out of the metadata region). Marks the tab
   * modified-with-a-reason on load; cleared on save. Transient — not persisted.
   */
  normalizedOnLoad?: boolean
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/** HTTP protocol version to negotiate with the server. */
export type HttpVersion = 'auto' | 'http1' | 'http2'

/** A per-request setting that either inherits from the workspace or overrides with a value. */
export type SettingValue<T> = { inherit: true } | { inherit: false; value: T }

/** Per-request transport settings (each field is optional; absent = inherit). */
export interface RequestSettings {
  httpVersion?: SettingValue<HttpVersion>
  verifySsl?: SettingValue<boolean>
  followRedirects?: SettingValue<boolean>
  maxRedirects?: SettingValue<number>
  followAuthorizationOnRedirect?: SettingValue<boolean>
  encodeUrl?: SettingValue<boolean>
  disableCookieJar?: SettingValue<boolean>
}

/** Stage-time size policy for binary body attachments (workspace-wide). */
export interface BinaryFileLimits {
  /** Stage-time warning threshold. Bytes. Default 50 MB (GitHub push warning). */
  warnBytes: number
  /** Stage-time block threshold. Bytes. Default 100 MB (GitHub hard block). */
  blockBytes: number
}

export const DEFAULT_BINARY_FILE_LIMITS: BinaryFileLimits = {
  warnBytes: 50 * 1024 * 1024,
  blockBytes: 100 * 1024 * 1024
}

/** Workspace-level defaults for transport settings (no inheritance). */
export interface WorkspaceHttpSettings {
  httpVersion: HttpVersion
  verifySsl: boolean
  followRedirects: boolean
  maxRedirects: number
  followAuthorizationOnRedirect: boolean
  encodeUrl: boolean
  disableCookieJar: boolean
  /** TLS material (CAs + client certs) scoped to this workspace. Optional for backward compatibility. */
  tls?: TlsScopeSettings
  /**
   * Per-workspace size policy for binary body attachments. Optional for backward
   * compatibility with `.fetchpier/settings.json` files that predate REQ-0065 —
   * absent means `DEFAULT_BINARY_FILE_LIMITS` is enforced.
   */
  binaryFileLimits?: BinaryFileLimits
}

// ── TLS Certificates ───────────────────────────────────────────────────────

export type TlsScope = 'workspace' | 'app'
export type TlsCertKind = 'ca' | 'client'

/** Metadata for an additional CA trust anchor. */
export interface CACertEntry {
  id: string
  /** Filename only (no path separators). Resolved against the canonical scope dir. */
  file: string
  label?: string
}

/** Metadata for a client certificate used in mTLS handshakes. */
export interface ClientCertEntry {
  id: string
  /** Domain pattern. Plain (`api.example.com`) or wildcard (`*.example.com`). */
  host: string
  /** Optional port; null = any port. */
  port: number | null
  type: 'pem' | 'pfx'
  /** Filename only — PEM type. */
  certFile?: string
  /** Filename only — PEM type. */
  keyFile?: string
  /** Filename only — PFX type. */
  pfxFile?: string
  /** Literal string or `{{varName}}` placeholder; null = no passphrase. */
  passphrase: string | null
  disabled: boolean
}

/** TLS material configured for one scope (workspace or app-global). */
export interface TlsScopeSettings {
  caCertificates: CACertEntry[]
  clientCertificates: ClientCertEntry[]
}

/** Result of the per-request client-cert lookup, surfaced to the renderer for preview. */
export interface ClientCertPreview {
  selected: ClientCertEntry | null
  scope: TlsScope | null
}

/** Payload for sending an HTTP request */
export interface HttpRequest {
  method: string
  url: string
  /**
   * Structured query parameters (REQ-0081). Canonical at the execution boundary
   * when present (the desktop editor passes them and keeps `url` as the base);
   * the core resolves their tokens then percent-encodes and assembles the URL.
   * When absent (the CLI parser emits a flat URL), the query is read from `url`.
   */
  params?: KeyValuePair[]
  headers: Record<string, string>
  /**
   * Ordered, duplicate-capable headers. Canonical at the execution boundary and
   * for the `.http` round-trip **when present**: the wire emits exactly these
   * entries in order (duplicates included), and the parser/serializer preserve
   * them. When absent (e.g. a request built before this field existed, or by a
   * schema importer), the wire falls back to the `headers` map. The `headers`
   * map is kept in sync (last-wins) at every write site as a lossy convenience
   * view. Holds only enabled, wire-bound headers — disabled rows travel on a
   * separate channel and are never sent.
   */
  headerList?: HeaderEntry[]
  /**
   * Disabled rows (header / param / field) parsed from `# @disabled` directives,
   * carried on a separate channel so the wire-bound set holds only enabled rows.
   * The editing surface re-interleaves them by `pos` into the unified row list;
   * they are never sent. Absent when the request has no disabled rows.
   */
  disabledRows?: DisabledRow[]
  /**
   * User comment lines (`#` / `//`, not recognized directives) preserved verbatim
   * from the metadata and header regions. Re-emitted as a block after the
   * metadata region on save (`.http` round-trip fidelity, D19). Not surfaced as
   * editable rows.
   */
  comments?: string[]
  /**
   * The parser dropped content that a save would normalize away — a stray
   * non-comment / non-header line, or a comment relocated out of the reserved
   * metadata region. Drives the modified-with-a-reason mark + advisory (D19/§6.9).
   */
  normalizedOnLoad?: boolean
  /**
   * Set by the parser when the file declares a `# @binary-file:` reference that
   * does not have the expected `<64-hex>__<name>` shape. The reference is not
   * loaded as a body, and the engine refuses to send the request — sending it
   * bodiless would silently drop the file the author attached.
   */
  invalidBinaryRef?: string
  body?: string
  /** Form field pairs for x-www-form-urlencoded — resolved and URL-encoded in main process */
  formFields?: KeyValuePair[]
  /** Original raw text of the request block (populated by the parser) */
  rawText?: string
  /** Active environment variables used to resolve {{placeholders}} in main process */
  variables?: Record<string, string>
  /** Auth configuration applied by the main process before sending */
  auth?: AuthConfig
  /** Optional pre-request script source (JavaScript, runs in ORC sandbox) */
  preRequestScript?: string
  /** Optional post-response script source (JavaScript, runs in ORC sandbox) */
  postResponseScript?: string
  /** Per-request HTTP transport settings (overrides workspace defaults). */
  settings?: RequestSettings
  /** If true, skip both cookie jar injection and capture for this request. */
  disableCookieJar?: boolean
  /** Optional raw-body subtype (parsed from `# @rawSubtype:`). Only meaningful when `bodyType === 'raw'` in the editor. */
  rawSubtype?: RawSubtype
  /** Body mode. Carried over IPC so the main process can branch on `'binary'` / `'multipart-form'` to read files. */
  bodyType?: BodyType
  /** Staged binary file reference. Only meaningful when `bodyType === 'binary'`. */
  binaryFile?: BinaryFileAttachment
  /** Multipart parts. Only meaningful when `bodyType === 'multipart-form'`. */
  multipartParts?: MultipartPart[]
}

// ── Scripts (ORC sandbox) ──────────────────────────────────────────────────

/** Sentinel placed by safeClone() when a function is encountered. */
export interface ScriptArgFunction {
  readonly __inspect: 'fn'
  name: string
}
/** Sentinel placed by safeClone() when a circular reference is detected. */
export interface ScriptArgCircular {
  readonly __inspect: 'circular'
}
/** Sentinel placed by safeClone() when max depth is exceeded. */
export interface ScriptArgTruncated {
  readonly __inspect: 'truncated'
  kind: 'array' | 'object'
}
export type ScriptArgSentinel = ScriptArgFunction | ScriptArgCircular | ScriptArgTruncated

export interface ScriptLog {
  level: 'log' | 'warn' | 'error'
  /** IPC-safe values — functions/circulars replaced with ScriptArgSentinel objects. */
  args: unknown[]
  timestamp: string
}

export interface ScriptTestResult {
  name: string
  passed: boolean
  error?: string
}

export interface EnvironmentChanges {
  set: Record<string, string>
  removed: string[]
}

export interface ScriptExecutionResult {
  success: boolean
  error?: { message: string; stack?: string }
  logs: ScriptLog[]
  testResults: ScriptTestResult[]
  /** Only populated for pre-request scripts — partial HttpRequest mutations applied. */
  modifiedRequest?: Partial<HttpRequest>
  environmentChanges?: EnvironmentChanges
}

export interface ScriptResultsBundle {
  preRequest?: ScriptExecutionResult
  postResponse?: ScriptExecutionResult
}

/**
 * Snapshot of the request as it went on the wire, after pre-request script
 * mutations, auth application, and variable interpolation. The Activity panel
 * renders this; CLI reporters embed it in JSON / JUnit / HTML outputs. Never
 * contains file bytes — file parts surface only as `fileRef` + `sizeBytes`.
 */
export interface ResolvedRequestSnapshot {
  method: string
  url: string
  headers: Record<string, string>
  /** The wire body for string bodies. Undefined for binary / multipart. */
  body?: string
  /**
   * Stable summary of the encoded multipart parts (disabled parts excluded —
   * the wire does not carry them). Present only when `bodyType === 'multipart-form'`.
   */
  multipartParts?: Array<{
    kind: 'text' | 'file'
    name: string
    disabled: boolean
    contentType?: string
    /** Text parts only. */
    value?: string
    /** File parts only. */
    fileRef?: string
    /** File parts only. */
    filename?: string
    /** File parts only. */
    sizeBytes?: number
  }>
  /**
   * REQ-0070: secret variable names whose values were masked in this snapshot
   * (rendered as `{secret:<name>}`). Drives the activity log's
   * `# @secrets-masked:` directive. Absent when no secret was interpolated.
   */
  secretsMasked?: string[]
}

/** Result of `http:send` — response plus any script outputs. */
export interface ExecutedRequestResult {
  /**
   * Undefined when the request was aborted before being sent (e.g. pre-request script failure).
   * Always masked: every secret value the send knows — the ones it resolved and the
   * ones a script wrote under a secret name — reads `{secret:<name>}`. This is what
   * logs, history and reports consume.
   */
  response?: HttpResponse
  /**
   * The response as received, present only when the adapter asked for it
   * (`revealResponse`) and masking changed something. Display only — never logged.
   */
  unmaskedResponse?: HttpResponse
  scriptResults?: ScriptResultsBundle
  environmentChanges?: EnvironmentChanges
  /** Populated when the request could not be sent (e.g. pre-request script error). */
  error?: string
  /**
   * Set when the engine refused to send before anything went on the wire — a
   * failed pre-request script, a multipart part that could not be encoded, a
   * missing or invalid binary file. Absent when a send was attempted (even one
   * that then failed in transport). Lets every surface say "not run" instead of
   * "no response" without guessing.
   */
  notSent?: true
  /**
   * REQ-0070: contractual error code when the send failed a secret precondition
   * (`SECRETS_KEY_MISSING` / `SECRETS_VALUE_UNSET` / `SECRETS_VALUE_CORRUPT` /
   * `SECRETS_KEY_INVALID`). Lets the renderer offer the right remedy (e.g. an
   * enter-key prompt) instead of a generic error toast.
   */
  errorCode?: string
  /** Fully resolved HTTP transport settings used for this send. */
  resolvedSettings?: WorkspaceHttpSettings
  /** Cookies effectively attached and captured during this send. */
  cookies?: {
    sent: CookieSnapshot[]
    received: CookieSnapshot[]
  }
  /**
   * The request as it went on the wire (post-script, post-auth, post-interpolation).
   * Used by the Activity panel and CLI reporters. Optional for backwards
   * compatibility with consumers that reconstruct from the input HttpRequest.
   */
  request?: ResolvedRequestSnapshot
  /**
   * Remote server address resolved by the HTTP client (REQ-0068). Used by the
   * activity log's `# @remote-ip` directive. Absent when the lookup is not
   * available (e.g. cached / mocked transport).
   */
  remoteIp?: string
  /**
   * Non-fatal advisories from the send — a malformed percent-encoded query
   * parameter kept raw (REQ-0086), or a `{{reference}}` with no value (REQ-0111).
   * The send is not failed by these; the CLI surfaces them via the reporter.
   * Empty/absent when there is nothing to report.
   */
  warnings?: ExecutionWarning[]
}

/** Result of parsing a .http file */
export interface ParsedHttpFile {
  requests: HttpRequest[]
  /** List of unique variable names found (e.g. "baseUrl" from {{baseUrl}}) */
  variablesUsed: string[]
  /** UUID extracted from the `# @id <uuid>` metadata comment, if present */
  requestId?: string
  /**
   * `.http` round-trip fidelity: when the file holds more than one request, the
   * verbatim (LF-normalized) remainder from the first confirmed `###` separator
   * to end-of-file. The editing surface edits the first request and re-emits
   * this tail byte-for-byte on save; both surfaces execute only the first
   * request. Absent for single-request files.
   */
  tail?: string
  /**
   * Load-time diagnostics (a malformed `# @auth` block, an invalid
   * `# @binary-file:` reference, an unknown or invalid `# @settings` entry, …).
   * Informational: the file still loads. The parser reports here instead of the
   * process console so an adapter can surface them. Absent when there are none.
   */
  warnings?: string[]
}

/**
 * Outcome of decoding a response body against its `Content-Encoding`.
 * - `decoded`: a supported coding was decoded.
 * - `not-required`: no coding (or `identity`), or no body.
 * - `unsupported`: a coding outside the supported set; body kept as received.
 * - `failed`: decoding errored; body kept as received.
 */
export type DecodingStatus = 'decoded' | 'not-required' | 'unsupported' | 'failed'

/** Result of an executed HTTP request */
export interface HttpResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  timingMs: number
  /** Byte length of `body` as read (i.e. after decoding). Unchanged meaning. */
  sizeBytes: number
  /** Body bytes as received on the wire. Absent on responses rebuilt from history. */
  compressedBytes?: number
  /** Body bytes after decoding; equals `compressedBytes` when nothing was decoded. */
  decompressedBytes?: number
  /** Absent on responses rebuilt from history (treated as `not-required`). */
  decodingStatus?: DecodingStatus
}

// ── Filesystem ─────────────────────────────────────────────────────────────

/** Node in the workspace file/folder tree */
export interface WorkspaceTree {
  name: string
  path: string
  type: 'folder' | 'file'
  /**
   * Finer-grained classification, additive to `type` (which stays
   * `'folder' | 'file'` for backward compatibility). A `'file'` is either a
   * regular request (`'request'`) or an instance file (`'instance'`,
   * `*.instance.http`). Instance nodes are grouped as `children` of their
   * parent request when one exists in the same directory.
   */
  kind?: 'folder' | 'request' | 'instance'
  children?: WorkspaceTree[]
}

/** Old→new absolute paths of one instance file cascaded alongside its parent. */
export interface InstanceCascadePair {
  from: string
  to: string
}

/**
 * Result of a rename/move that may cascade instance (`*.instance.http`) files.
 * `instances` lists the instance files actually moved alongside the parent
 * (a per-instance name collision is skipped and omitted here).
 */
export interface FsCascadeResult {
  newPath: string
  instances: InstanceCascadePair[]
}

/**
 * Input of the read-only name-availability check (REQ case-insensitive tree
 * name uniqueness). `entry` covers requests and collections — `name` may carry
 * the `.http` suffix or not; `selfPath`, when given, is the element being
 * renamed, whose own name (in any casing) is not a collision. `instance`
 * checks the instance filename derived from `parentPath` (a parent request
 * or a source instance) plus `instanceName`.
 */
export type NameCheckInput =
  | { kind: 'entry'; parentPath: string; name: string; selfPath?: string }
  | { kind: 'instance'; parentPath: string; instanceName: string }

/** Verdict of the name-availability check. Never thrown — always answered. */
export interface NameCheckResult {
  available: boolean
  /** What occupies the name when `available` is false. */
  conflict?: 'request' | 'collection' | 'instance'
}

/** Result of a delete that may cascade instance files. */
export interface FsDeleteResult {
  /** Absolute paths of instance files deleted alongside the parent. */
  deletedInstances: string[]
}

// ── Environments ───────────────────────────────────────────────────────────

/**
 * A named set of variables used for interpolation in .http files.
 *
 * REQ-0076: one unified `variables` map holds plain and secret values alike,
 * classified by value *shape*:
 *  - any plain string → a plain variable;
 *  - an `enc:v1:` string → an encrypted secret;
 *  - `null` → a secret in the needs-value state (its existence and secrecy travel
 *    through Git, its material does not).
 * `enc:` is a reserved prefix: a plain value may never start with it (rejected at
 * every write surface). There is no separate `secrets` map and no disjointness
 * rule — a name appears once, and its shape decides its secrecy.
 */
export interface Environment {
  /**
   * Opaque, stable identifier. Generated once at creation and **never** changes —
   * not on rename, not on a folder move. It is what the personal workspace state
   * records as the active environment and what every consumer holding an
   * environment across an operation carries. It is **never** used as a path
   * segment: callers resolve it to {@link Environment.folder} first. Legacy
   * workspaces keep their slug-shaped identifiers verbatim — nothing reads meaning
   * out of the shape.
   */
  id: string
  /** Display name, verbatim as typed — including characters the filesystem rejects. */
  name: string
  variables: Record<string, string | null>
  /**
   * The folder the environment lives in under `environments/`: its name in
   * filesystem-safe form (`@shared/lib/env-folder-name`). This is the unit of
   * uniqueness, what version control tracks, and what a CLI run names with
   * `--env`. **Not a field of `config.json`** — it is derived from the path the
   * config was read from, so there is exactly one source of truth for it.
   */
  folder: string
}

// ── Local value layer (REQ-0074) ─────────────────────────────────────────────

/**
 * Per-variable local-layer state for the editor's Shared | Local view. The
 * renderer renders the Shared column from the {@link Environment} it already
 * holds; this describes only the Local column and the cross-layer flags. Secret
 * plaintext never crosses this boundary — `localDisplay` is set only for
 * plain/local-only names.
 */
export interface EnvironmentLocalViewRow {
  name: string
  /** How the shared layer classifies the name. `absent` ⇒ local-only. */
  sharedKind: 'plain' | 'secret' | 'absent'
  /** A local entry exists and is applied (wins over shared). */
  hasLocalOverride: boolean
  /** The name exists only in the local layer (no shared entry). */
  localOnly: boolean
  /** A secret-named local value under a stale keyId — lost after rotation. */
  orphan: boolean
  /** A secret-named local value that is plaintext (hand-edited) — rejected. */
  invalid: boolean
  /**
   * REQ-0075: the applied local override resolves to a value *different* from the
   * current shared value. Drives the re-check confirmation (divergent ⇒ confirm,
   * identical ⇒ silent). Computed in the main process so secret plaintext never
   * crosses the boundary; `false` for synced / local-only / orphan / invalid rows.
   * Secrets that cannot be compared (locked workspace) are reported divergent.
   */
  divergent: boolean
  /** The local value to display, for plain/local-only names only (never secret plaintext). */
  localDisplay?: string
}

/** The editor's view of an environment's local value layer. */
export interface EnvironmentLocalView {
  environmentId: string
  rows: EnvironmentLocalViewRow[]
  /** Present when a load discarded orphaned encrypted overrides (one-time notice). */
  orphanNotice?: { environmentId: string; variables: string[] }
}

// ── Secrets (REQ-0070) ───────────────────────────────────────────────────────

/** Which key-custody backend the app is using (REQ-0070 §6.5). */
export type KeystoreBackend = 'os-keychain' | 'session-only'

/** Snapshot of the workspace's secret-encryption state for the renderer. */
export interface SecretsStatus {
  /** A `.fetchpier/secrets.json` manifest exists (the workspace uses secrets). */
  hasManifest: boolean
  /** A valid workspace key is available in this session (can decrypt/reveal). */
  unlocked: boolean
  /** The active custody backend; `session-only` shows the degraded-mode notice. */
  backend: KeystoreBackend
  /** The keyId the workspace expects (16 hex), when a manifest exists. */
  keyId?: string
}

/** Result of generating or rotating the workspace key — shown once for backup. */
export interface SecretsSetupResult {
  /** The `FPK1-…` key. Displayed exactly once (§6.2); never re-served. */
  key: string
  keyId: string
}

/** Result of submitting a key to the enter-key dialog. */
export interface SecretsEnterKeyResult {
  ok: boolean
  keyId?: string
  /** Why the key was rejected, when `ok` is false. */
  reason?: 'invalid-format' | 'wrong-key' | 'no-manifest'
}

// ── Workspace keys management (REQ-0073) ─────────────────────────────────────

/**
 * Metadata for one keystore entry, surfaced by the Workspace keys tab.
 * NEVER includes key material in any form (wrapped or raw).
 */
export interface WorkspaceKeyMetadata {
  /** 16-hex key identity. */
  keyId: string
  /** Display-only hint (workspace folder basename), when present. */
  workspaceHint?: string
  /** ISO timestamp the entry was first stored. */
  createdAt: string
  /** ISO timestamp of last use. */
  lastUsedAt: string
  /** `os-keychain` = persisted ("Stored"); `session-only` = this session only. */
  backing: KeystoreBackend
}

/**
 * Reference mark inputs, computed fresh on tab open against the manifests of
 * known (recent) workspaces.
 */
export interface WorkspaceKeyReferences {
  /** keyId → display names of known workspaces whose manifest references it. */
  byKeyId: Record<string, string[]>
  /** A known workspace was unreadable during computation ("could not check"). */
  incomplete: boolean
}

/** Full listing returned by `secrets:listKeys` (metadata + reference marks). */
export interface WorkspaceKeysListing {
  entries: WorkspaceKeyMetadata[]
  references: WorkspaceKeyReferences
}

/**
 * Result of a proactive add (REQ-0073 §6.3). Carries no key material back.
 * - `added`/`updated`/`noop` → the resulting (or unchanged) entry's metadata.
 * - `conflict` → an entry with the same keyId but a different key exists; the
 *   caller proposes replacement showing `existing` and may retry with replace.
 * - `invalid-format` → the pasted key failed structure/CRC validation.
 */
export type SecretsAddKeyResult =
  | { status: 'added' | 'updated' | 'noop'; entry: WorkspaceKeyMetadata }
  | { status: 'conflict'; existing: WorkspaceKeyMetadata }
  | { status: 'invalid-format' }

// ── Cookies ────────────────────────────────────────────────────────────────

export type CookieSameSite = 'Strict' | 'Lax' | 'None'

export interface Cookie {
  id: string
  name: string
  value: string
  domain: string
  path: string
  /** ISO 8601 timestamp — null means session cookie. */
  expires: string | null
  /** Seconds; takes precedence over `expires` when present. */
  maxAge: number | null
  secure: boolean
  httpOnly: boolean
  sameSite: CookieSameSite | null
  /**
   * REQ-0115: `true` when the cookie is bound to `domain` exactly; `false` when it
   * also applies to its subdomains. Set from the presence of a `Domain` attribute
   * on capture, and from the form control when authored by hand.
   *
   * Records written before REQ-0115 lack the field and are read as `true` — the
   * restrictive reading. The information needed to be accurate was never stored,
   * and the worst case of being wrong this way is one re-login, against a leak
   * that would otherwise persist for every cookie already on disk.
   */
  hostOnly: boolean
  createdAt: string
  updatedAt: string
  source: 'response' | 'manual'
}

export interface CookieJar {
  /**
   * Stable id of the environment that owns this jar. Matches the environment's
   * folder name under `environments/`. Used as the key in
   * `environments/<id>/.state/cookies.json`.
   */
  environmentId: string
  cookies: Cookie[]
}

/**
 * A cookie as it appeared on one send — attached to the request, or offered by
 * the response.
 *
 * For the received direction this describes **what the response actually sent**,
 * parsed from its `Set-Cookie` headers, independent of what the jar then did with
 * it. That distinction matters: a cookie the jar refused, or that arrived while
 * the jar was not running at all, is still something the server sent and the user
 * is entitled to see it. `stored` carries the jar's verdict; the send's warnings
 * carry the reason.
 */
export interface CookieSnapshot {
  name: string
  value: string
  domain: string
  path: string
  /**
   * Effective expiry as an ISO timestamp, already resolved from `Expires` /
   * `Max-Age` (which is relative and needs the receipt time to mean anything).
   * `null` is a session cookie. Resolved in the engine so no consumer has to
   * re-derive the specification's precedence rules.
   */
  expires: string | null
  secure: boolean
  httpOnly: boolean
  sameSite: CookieSameSite | null
  /** `false` when the cookie also covers subdomains (it carried a `Domain`). */
  hostOnly: boolean
  /**
   * REQ-0115: the hop this cookie belongs to — the URL that offered it (received)
   * or that it was attached to (sent). A redirect chain can touch several hosts,
   * and `domain` only equals the offering host when the response carried no
   * `Domain` attribute, so it cannot stand in for this.
   */
  url: string
  /**
   * Received direction only: whether the jar stored it. `false` means the server
   * sent it and the jar refused — the matching warning says why. `undefined` when
   * the jar was not running for this send, so nothing decided either way.
   */
  stored?: boolean
}

// ── History ────────────────────────────────────────────────────────────────

/** A single entry in the request history */
export interface HistoryEntry {
  id: string
  timestamp: string
  /**
   * Editor-side request used for replay semantics (Repeat, `@path-raw` directive).
   * Carries `{{variables}}` unresolved so they can be re-interpolated against
   * the current environment when the user re-sends.
   */
  request: HttpRequest
  /**
   * Snapshot of the request as it actually went on the wire — post-script,
   * post-auth, post-`{{variable}}` interpolation, with the multipart boundary
   * injected and the cookie jar's Cookie header attached. When present, the
   * history writer renders the raw HTTP message from this (and only uses
   * `request` for replay metadata like `@path-raw`). Optional only for
   * backwards compatibility with older `history.save` callers.
   */
  wireRequest?: ResolvedRequestSnapshot
  response: HttpResponse
  sourceFile: string | null
  /** UUID of the request that generated this entry */
  requestId?: string
  /** Results of pre/post scripts executed with this request */
  scriptResults?: ScriptResultsBundle
  /** Fully resolved HTTP transport settings used for this send. */
  resolvedSettings?: WorkspaceHttpSettings
  /** Cookies effectively sent and received for this request. */
  cookies?: {
    sent: CookieSnapshot[]
    received: CookieSnapshot[]
  }
  /** Remote server address resolved for this send (REQ-0068 — optional). */
  remoteIp?: string
}

/**
 * Lightweight projection used by `window.api.history.list` (REQ-0068).
 *
 * The list reader scans each `.http` only as far as the response status line,
 * so bodies, request/response headers and script tail blocks are NOT
 * populated. Consumers that need the full entry call `window.api.history.get`
 * (raw `.http` text) and rebuild via `activityLogToHistoryEntry`.
 */
export interface HistoryEntryListItem {
  id: string
  timestamp: string
  requestId?: string
  sourceFile: string | null
  /** Summarized pre/post script outcomes (`ok` / `failed (...)` / `skipped`). */
  scriptSummary?: { pre?: string; post?: string }
  /** Send duration in milliseconds (from `@duration-ms`); undefined if absent. */
  durationMs?: number
  request: { method: string; url: string }
  response: { status: number; statusText: string }
}

// ── Workspace state (per-user, workspace-local) ─────────────────────────────

/**
 * One persisted tab entry in the session. `kind` is a discriminator so future
 * tab types (mock servers, flows, …) extend the same format; `"request"` is the
 * only kind today. `path` is workspace-relative with forward slashes on disk
 * (see {@link WorkspaceState}) and absolute at the IPC boundary (see
 * {@link WorkspaceStateView}).
 */
export interface WorkspaceSessionTab {
  kind: string
  path: string
  /**
   * Persisted tab mode. Only the non-default modes are written; **absence is read
   * as `'permanent'`**. The reader also accepts the legacy `preview: true` marker
   * (written before this enum existed) and maps it to `'preview'`, so older
   * sessions restore exactly as before.
   */
  mode?: 'preview' | 'pinned'
}

/** The open-tab session: tab-bar order plus the active tab (`-1` = none). */
export interface WorkspaceSessionState {
  tabs: WorkspaceSessionTab[]
  activeTabIndex: number
}

/**
 * On-disk shape of `<workspace>/.fetchpier/.state/workspace-state.json`. Tab
 * paths are workspace-relative with forward slashes. `schemaVersion` identifies
 * the file format (not the app version); it is `1` and unused by logic, present
 * so a future incompatible change is detectable by inspection.
 */
export interface WorkspaceState {
  schemaVersion: 1
  activeEnvironmentId: string | null
  session: WorkspaceSessionState
}

/**
 * Renderer-boundary view of {@link WorkspaceState}: identical shape but tab
 * paths are absolute (the main process converts to/from workspace-relative).
 * Already reconciled — every tab is path-safe and its backing file exists.
 */
export interface WorkspaceStateView {
  activeEnvironmentId: string | null
  session: WorkspaceSessionState
}

// ── App Settings ───────────────────────────────────────────────────────────

/** Global application settings stored in userData/appsettings.json */
export interface ProxyConfig {
  enabled: boolean
  url: string
  username: string
  password: string
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}

export interface AppSettings {
  zoomFactor: number
  language: string
  requestTimeoutSeconds: number
  proxy: ProxyConfig
  windowState?: WindowState
  /**
   * The user's theme preference. Read before the main window is created, so it
   * decides the window's initial background and the platform theme applied to
   * native decorations — not just the in-app palette. Absent or unrecognised
   * values resolve to `'system'`.
   */
  theme: Theme
  /**
   * Show `{secret:<name>}` instead of a secret value in the response viewer
   * (default `true`; anything but an explicit `false` reads as `true`). When
   * `false`, the response of a send crosses to the renderer as received — the
   * documented exception to renderer containment. The activity log always records
   * the masked response either way.
   */
  hideSecretsInResponses: boolean
  /**
   * Last app version for which the About dialog was shown. `null` on a fresh
   * install and on settings files written before this field existed, which is
   * what makes the About appear once after every version change.
   */
  lastVersion: string | null
  updates: UpdatesSettings
  /** App-global TLS material (CAs + client certs) stored under userData. Optional for backward compatibility. */
  tls?: TlsScopeSettings
  /** Persisted UI state for the activity panel. Optional — missing on first run, missing on old files. */
  activityPanel?: ActivityPanelSettings
}

// ── Activity Panel ─────────────────────────────────────────────────────────

/**
 * Persisted UI state for the activity panel.
 * Only the height persists across sessions; open/closed and popout state are not restored.
 */
export interface ActivityPanelSettings {
  /** Height in CSS pixels when docked. Default is computed (~50% of window) on first run. */
  heightPx: number
}

/**
 * Tabs available in the activity panel. v1 ships only 'requests'; future tab ids land here.
 */
export type ActivityTabId = 'requests'

/**
 * Broadcast from main → renderer when the popout window state changes.
 */
export interface ActivityPanelPopoutEvent {
  /** True if a popout window was just created; false if it was closed/docked back. */
  detached: boolean
  /** When detached=false, whether the docked panel should auto-open after redocking. */
  openAfter?: boolean
}

// ── Updates ────────────────────────────────────────────────────────────────

/** Global update-check preferences stored inside `AppSettings.updates`. */
export interface UpdatesSettings {
  /** Auto-prompt interval in days. Clamped to [1, 365]. */
  intervalDays: number
  /** ISO timestamp of the last successful fetch; `null` if never. */
  lastCheckAt: string | null
  /** Master toggle for the auto-prompt. Manual checks always work. */
  autoCheckEnabled: boolean
}

export const DEFAULT_UPDATES_SETTINGS: UpdatesSettings = {
  intervalDays: 15,
  lastCheckAt: null,
  autoCheckEnabled: true
}

/** Product website, linked from the About dialog. */
export const PRODUCT_WEBSITE_URL = 'https://fetchpier.com'

/** Where installers are downloaded: the repository's GitHub Releases page. */
export const PRODUCT_RELEASES_URL = 'https://github.com/dmonza/fetchpier/releases'

// ── License ────────────────────────────────────────────────────────────────

/** The packaged LICENSE file, prepared for display. See `shared/lib/license.ts`. */
export interface LicenseText {
  /** First line starting with `Copyright`, verbatim. `null` when absent. */
  copyright: string | null
  /** The whole file (copyright line included), blank-trimmed at both ends. */
  body: string
}

/** Shape returned by the updates checker on success. */
export interface UpdateCheckResult {
  currentVersion: string
  publishedVersion: string | null
  isNewer: boolean
  fetchedAt: string
}

export type UpdateCheckErrorKind =
  'network' | 'timeout' | 'invalid-json' | 'product-not-found' | 'invalid-version'

export type UpdateCheckResponse =
  | { ok: true; data: UpdateCheckResult }
  | { ok: false; errorKind: UpdateCheckErrorKind; message?: string }

// ── Schema Import ──────────────────────────────────────────────────────────

export type SchemaFormat =
  'openapi' | 'swagger' | 'graphql-sdl' | 'graphql-introspection' | 'wsdl' | 'postman'

export type SchemaSourceKind = 'file' | 'url' | 'text'
// 'replace' (whole-folder wipe) was removed for write-safety: it destroyed
// hand-authored requests the schema never touched. Use 'merge' (skip colliding
// requests) or 'abort'; delete the collection explicitly for a clean slate.
export type SchemaConflictStrategy = 'merge' | 'abort'

/** Options specific to Postman collection imports. */
export interface PostmanImportOptions {
  /** 'none' → do not create env; 'new' → create a fresh env file; 'merge' → merge into active env */
  environmentStrategy: 'none' | 'new' | 'merge'
  /** Name used when creating a new env (defaults to the sanitized schema name) */
  environmentName?: string
  /** Id of the active environment to merge into (required when strategy='merge') */
  mergeEnvironmentId?: string
}

export interface SchemaImportRequest {
  source: { kind: SchemaSourceKind; value: string }
  format: SchemaFormat | 'auto'
  targetFolder: string
  collectionName?: string
  conflictStrategy: SchemaConflictStrategy
  /** Postman-specific options (only read when format resolves to 'postman') */
  postman?: PostmanImportOptions
}

export type SchemaImportWarningKind =
  | 'unsupported-auth'
  | 'missing-example'
  | 'skipped-operation'
  | 'name-collision'
  | 'script-copied-asis'
  | 'path-param-converted'
  | 'response-example-ignored'
  | 'variable-collected'
  | 'body-binary-placeholder'
  | 'unknown-field'
  | 'other'

export interface SchemaImportWarning {
  kind: SchemaImportWarningKind
  message: string
  location?: string
}

export interface SchemaImportResult {
  collectionPath: string
  operationsCreated: number
  foldersCreated: number
  warnings: SchemaImportWarning[]
  detectedFormat: SchemaFormat
  schemaTitle: string
  /** Id (file stem) of the environment that was created, when applicable. */
  environmentCreated?: string
  /** Id of the environment that was merged into, when applicable. */
  environmentMerged?: string
}

export interface SchemaImportProgress {
  phase: 'parsing' | 'generating' | 'writing' | 'done'
  current: number
  total: number
  message?: string
}

export interface IntermediateOperation {
  id: string
  name: string
  displayName: string
  folderPath: string[]
  request: HttpRequest
  editorState: RequestEditorState
  comment?: string
  /** WSDL import only: SOAP binding(s) that exposed this operation. The first is
   *  the one used to generate the request; the rest were collapsed into it. */
  sourceBindings?: string[]
}

export interface IntermediateSchema {
  title: string
  format: SchemaFormat
  baseUrl?: string
  operations: IntermediateOperation[]
  globalHeaders?: Record<string, string>
  notes?: string[]
  /** Variables harvested from the source (e.g. Postman `variable[]` at collection/folder level). */
  envVariables?: Record<string, string>
}

// ── File dialogs ────────────────────────────────────────────────────────────

export interface SaveDialogArgs {
  defaultName: string
  content: string
  filters: { name: string; extensions: string[] }[]
}

export interface SaveDialogResult {
  canceled: boolean
  path?: string
}
