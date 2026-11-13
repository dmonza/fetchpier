import { randomUUID } from 'crypto'
import type {
  IntermediateSchema,
  IntermediateOperation,
  SchemaImportWarning,
  RequestEditorState,
  KeyValuePair,
  HttpRequest,
  BodyType,
  RawSubtype,
  AuthConfig
} from '@shared/types'
import { DEFAULT_REQUEST_STATE } from '@shared/types'
import { splitUrlAndParams } from '@shared/lib/query-string'
import { mapTokenLiteralsSafe } from '@shared/lib/token-grammar'
import { sanitizeName } from '../sanitize'

// ── Types that model the subset of the Postman schema we consume ──────────
interface PostmanVariable {
  key?: string
  /** The schema allows any JSON value (a number, a boolean…). */
  value?: unknown
  disabled?: boolean
}

interface PostmanKeyValue {
  key: string
  /** `null` in a `url.query[]` entry marks a bare flag (`?wsdl`). */
  value?: string | null
  disabled?: boolean
}

type PostmanUrlQuery = PostmanKeyValue

interface PostmanUrl {
  raw?: string
  protocol?: string
  host?: string[] | string
  path?: Array<string | { value?: string }> | string
  port?: string
  query?: PostmanUrlQuery[]
  variable?: PostmanVariable[]
}

type PostmanHeader = PostmanKeyValue

interface PostmanFormDataEntry {
  key: string
  value?: string
  type?: 'text' | 'file'
  src?: string | string[] | null
  disabled?: boolean
}

interface PostmanBody {
  mode?: 'raw' | 'urlencoded' | 'formdata' | 'graphql' | 'file' | 'binary' | string
  raw?: string
  urlencoded?: PostmanKeyValue[]
  formdata?: PostmanFormDataEntry[]
  graphql?: { query?: string; variables?: string }
  file?: { src?: string | null }
  options?: { raw?: { language?: string } }
}

interface PostmanAuth {
  type?: string
  [k: string]: unknown
}

interface PostmanScript {
  type?: string
  exec?: string[] | string
}

interface PostmanEvent {
  listen?: string
  script?: PostmanScript
  disabled?: boolean
}

interface PostmanRequest {
  method?: string
  url?: PostmanUrl | string
  /** v2.x: a header list, or the headers as one `Name: value`-per-line string. */
  header?: PostmanHeader[] | string
  body?: PostmanBody
  auth?: PostmanAuth | null
  description?: string | { content?: string }
}

interface PostmanItem {
  name?: string
  item?: PostmanItem[]
  request?: PostmanRequest | string
  event?: PostmanEvent[]
  auth?: PostmanAuth | null
  variable?: PostmanVariable[]
  response?: unknown[]
  description?: string
}

interface PostmanCollection {
  info?: { name?: string; schema?: string; description?: string | { content?: string } }
  item?: PostmanItem[]
  auth?: PostmanAuth | null
  event?: PostmanEvent[]
  variable?: PostmanVariable[]
}

// ── Detection ─────────────────────────────────────────────────────────────

export function isPostmanCollection(parsed: unknown): parsed is PostmanCollection {
  if (!parsed || typeof parsed !== 'object') return false
  const obj = parsed as { info?: { schema?: unknown } }
  const schema = obj.info?.schema
  if (typeof schema !== 'string') return false
  return /\/collection\/v2\./i.test(schema)
}

// ── Normalization (v2.0 → v2.1) ───────────────────────────────────────────

function normalizeAuth(auth: PostmanAuth | null | undefined): PostmanAuth | null {
  if (!auth || typeof auth !== 'object') return auth ?? null
  const type = typeof auth.type === 'string' ? auth.type : undefined

  // v2.0 may store under auth.<type> as array of {key, value}; normalize to kv lookup.
  // v2.1 already uses that shape, so we leave it as-is.
  if (type && type !== 'noauth') {
    const block = auth[type]
    // If it's an object like { username: '...' } (flat v2.0 variant), convert to array
    if (block && !Array.isArray(block) && typeof block === 'object') {
      const entries = Object.entries(block as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: String(value ?? '')
      }))
      return { ...auth, [type]: entries }
    }
  }
  return auth
}

function normalizeRequest(r: PostmanRequest | string | undefined): PostmanRequest {
  if (!r) return {}
  if (typeof r === 'string') {
    return { method: 'GET', url: r, header: [] }
  }
  const out: PostmanRequest = { ...r }
  if (typeof out.url === 'string') {
    out.url = { raw: out.url }
  }
  if (out.auth) out.auth = normalizeAuth(out.auth)
  return out
}

function normalizeItem(item: PostmanItem): PostmanItem {
  const out: PostmanItem = { ...item }
  if (out.request) out.request = normalizeRequest(out.request)
  if (out.auth) out.auth = normalizeAuth(out.auth)
  if (Array.isArray(out.item)) out.item = out.item.map(normalizeItem)
  return out
}

// ── Helpers ───────────────────────────────────────────────────────────────

function authValue(auth: PostmanAuth, kind: string, key: string): string {
  const block = auth[kind]
  if (!Array.isArray(block)) return ''
  const entry = (block as PostmanKeyValue[]).find((e) => e.key === key)
  return entry?.value ?? ''
}

function hostToString(host: PostmanUrl['host']): string {
  if (!host) return ''
  if (typeof host === 'string') return host
  return host.join('.')
}

function pathToString(path: PostmanUrl['path']): string {
  if (!path) return ''
  if (typeof path === 'string') return path
  const segments = path.map((p) => (typeof p === 'string' ? p : (p.value ?? '')))
  return segments.join('/')
}

function reconstructUrl(url: PostmanUrl): string {
  const protocol = url.protocol ? `${url.protocol}://` : ''
  const host = hostToString(url.host)
  const port = url.port ? `:${url.port}` : ''
  const pathStr = pathToString(url.path)
  const pathPart = pathStr
    ? `${pathStr.startsWith('/') || host.endsWith('/') ? '' : '/'}${pathStr}`
    : ''
  return `${protocol}${host}${port}${pathPart}`
}

/** Strip query string from URL and return just the base portion. */
function stripQuery(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

/**
 * Parse `?a=1&b=2` from a URL (when `query[]` is absent) with the shared
 * token-aware splitter, so params hold decoded values as the editor model does.
 */
function parseQueryString(url: string): KeyValuePair[] {
  return splitUrlAndParams(url).params
}

function convertPathParams(url: string): { url: string; converted: boolean } {
  // Replace :name with {{name}} (only when preceded by /, //, or start-of-string)
  const re = /(^|\/)(:)([A-Za-z_][A-Za-z0-9_-]*)/g
  let converted = false
  const next = url.replace(re, (_m, pre: string, _colon: string, name: string) => {
    converted = true
    return `${pre}{{${name}}}`
  })
  return { url: next, converted }
}

function getUrl(u: PostmanRequest['url']): PostmanUrl {
  if (!u) return {}
  if (typeof u === 'string') return { raw: u }
  return u
}

function headersFromPostman(headers: PostmanHeader[] | string | undefined): KeyValuePair[] {
  if (typeof headers === 'string') return headersFromString(headers)
  if (!Array.isArray(headers)) return []
  return headers
    .filter((h) => h && typeof h.key === 'string')
    .map((h, i) => ({
      id: `h-${i}`,
      key: h.key,
      value: h.value ?? '',
      enabled: !h.disabled
    }))
}

/** One `Name: value` per line, split at the first `:`; empty or nameless lines are skipped. */
function headersFromString(text: string): KeyValuePair[] {
  const out: KeyValuePair[] = []
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    if (!key) continue
    out.push({ id: `h-${out.length}`, key, value: line.slice(colon + 1).trim(), enabled: true })
  }
  return out
}

/**
 * Postman keeps query keys and values in their wire form, so each is decoded
 * once, token-aware, the way `splitUrlAndParams` reads a stored URL. A pair
 * that fails to decode is kept raw and flagged `malformed`; a `null` value is
 * a bare flag (`?wsdl`) and is kept `valueless`.
 */
function queryFromPostman(query: PostmanUrlQuery[] | undefined): KeyValuePair[] {
  if (!query) return []
  return query
    .filter((q) => q && typeof q.key === 'string')
    .map((q, i) => {
      const rawValue = q.value ?? ''
      const key = mapTokenLiteralsSafe(q.key, decodeURIComponent)
      const value = mapTokenLiteralsSafe(rawValue, decodeURIComponent)
      const malformed = key.failed || value.failed
      const valueless = q.value == null && q.key !== ''
      return {
        id: `q-${i}`,
        key: malformed ? q.key : key.text,
        value: malformed ? rawValue : value.text,
        enabled: !q.disabled,
        ...(malformed && { malformed }),
        ...(valueless && { valueless })
      }
    })
}

// ── Body mapping ──────────────────────────────────────────────────────────

interface MappedBody {
  bodyType: BodyType
  rawSubtype?: RawSubtype
  body: string
  formFields: KeyValuePair[]
  extraContentType?: string
}

function mapBody(
  body: PostmanBody | undefined,
  warnings: SchemaImportWarning[],
  location: string
): MappedBody {
  if (!body || !body.mode) {
    return { bodyType: 'none', body: '', formFields: [] }
  }
  switch (body.mode) {
    case 'raw': {
      const language = body.options?.raw?.language?.toLowerCase()
      const raw = body.raw ?? ''
      switch (language) {
        case 'json':
          return {
            bodyType: 'raw',
            rawSubtype: 'json',
            body: raw,
            formFields: [],
            extraContentType: 'application/json'
          }
        case 'xml':
          return {
            bodyType: 'raw',
            rawSubtype: 'xml',
            body: raw,
            formFields: [],
            extraContentType: 'application/xml'
          }
        case 'javascript':
          return {
            bodyType: 'raw',
            rawSubtype: 'javascript',
            body: raw,
            formFields: [],
            extraContentType: 'application/javascript'
          }
        case 'html':
          return {
            bodyType: 'raw',
            rawSubtype: 'html',
            body: raw,
            formFields: [],
            extraContentType: 'text/html'
          }
        case 'text':
          return {
            bodyType: 'raw',
            rawSubtype: 'text',
            body: raw,
            formFields: [],
            extraContentType: 'text/plain'
          }
        default:
          return { bodyType: 'raw', rawSubtype: 'text', body: raw, formFields: [] }
      }
    }
    case 'urlencoded': {
      const fields: KeyValuePair[] = (body.urlencoded ?? [])
        .filter((f) => f && typeof f.key === 'string')
        .map((f, i) => ({
          id: `f-${i}`,
          key: f.key,
          value: f.value ?? '',
          enabled: !f.disabled
        }))
      return {
        bodyType: 'x-www-form-urlencoded',
        body: '',
        formFields: fields,
        extraContentType: 'application/x-www-form-urlencoded'
      }
    }
    case 'formdata': {
      const lines: string[] = []
      for (const entry of body.formdata ?? []) {
        if (!entry || typeof entry.key !== 'string') continue
        const prefix = entry.disabled ? '# disabled: ' : ''
        if (entry.type === 'file') {
          warnings.push({
            kind: 'body-binary-placeholder',
            message: `Field "${entry.key}" is a file upload; replaced with <binary> placeholder`,
            location
          })
          lines.push(`${prefix}${entry.key}=<binary>`)
        } else {
          lines.push(`${prefix}${entry.key}=${entry.value ?? ''}`)
        }
      }
      return { bodyType: 'raw', body: lines.join('\n'), formFields: [] }
    }
    case 'graphql': {
      const g = body.graphql ?? {}
      let vars: unknown = undefined
      if (typeof g.variables === 'string' && g.variables.trim()) {
        try {
          vars = JSON.parse(g.variables)
        } catch {
          vars = g.variables
        }
      }
      const payload = { query: g.query ?? '', variables: vars ?? {} }
      return {
        bodyType: 'raw',
        rawSubtype: 'json',
        body: JSON.stringify(payload, null, 2),
        formFields: [],
        extraContentType: 'application/json'
      }
    }
    case 'file':
    case 'binary': {
      warnings.push({
        kind: 'body-binary-placeholder',
        message: `Binary/file body not supported; using placeholder`,
        location
      })
      return { bodyType: 'binary', body: '', formFields: [] }
    }
    default: {
      warnings.push({
        kind: 'unknown-field',
        message: `Unknown body.mode "${body.mode}"; body ignored`,
        location
      })
      return { bodyType: 'none', body: '', formFields: [] }
    }
  }
}

// ── Auth mapping ──────────────────────────────────────────────────────────

function mapAuth(
  auth: PostmanAuth | null | undefined,
  warnings: SchemaImportWarning[],
  location: string
): AuthConfig {
  if (!auth || !auth.type) return { type: 'none' }
  switch (auth.type) {
    case 'noauth':
      return { type: 'none' }
    case 'basic':
      return {
        type: 'basic',
        username: authValue(auth, 'basic', 'username'),
        password: authValue(auth, 'basic', 'password')
      }
    case 'bearer':
      return { type: 'bearer', token: authValue(auth, 'bearer', 'token') }
    case 'apikey': {
      const key = authValue(auth, 'apikey', 'key')
      const value = authValue(auth, 'apikey', 'value')
      const inRaw = authValue(auth, 'apikey', 'in')
      const location: 'header' | 'query' = inRaw === 'query' ? 'query' : 'header'
      return { type: 'api-key', key, value, location }
    }
    default:
      warnings.push({
        kind: 'unsupported-auth',
        message: `Auth type "${auth.type}" not supported — leaving as none`,
        location
      })
      return { type: 'none' }
  }
}

// ── Scripts ───────────────────────────────────────────────────────────────

function execToString(exec: PostmanScript['exec']): string {
  if (!exec) return ''
  if (typeof exec === 'string') return exec
  return exec.join('\n')
}

function mapScripts(
  events: PostmanEvent[] | undefined,
  warnings: SchemaImportWarning[],
  location: string
): { preRequest: string; postResponse: string } {
  let preRequest = ''
  let postResponse = ''
  if (!Array.isArray(events)) return { preRequest, postResponse }
  for (const ev of events) {
    if (!ev || ev.disabled) continue
    const code = execToString(ev.script?.exec).trim()
    if (!code) continue
    if (ev.listen === 'prerequest') {
      preRequest = code
      warnings.push({
        kind: 'script-copied-asis',
        message: 'Pre-request script copied as-is — pm.* calls may need manual adaptation',
        location
      })
    } else if (ev.listen === 'test') {
      postResponse = code
      warnings.push({
        kind: 'script-copied-asis',
        message:
          'Test script copied as-is to post-response — pm.* calls may need manual adaptation',
        location
      })
    }
  }
  return { preRequest, postResponse }
}

// ── Variable collection ───────────────────────────────────────────────────

function collectVariables(vars: PostmanVariable[] | undefined, into: Record<string, string>): void {
  if (!Array.isArray(vars)) return
  for (const v of vars) {
    if (!v || typeof v.key !== 'string' || !v.key.trim()) continue
    // A disabled variable is not active in Postman, so it is not imported.
    if (v.disabled === true) continue
    // First occurrence wins (collection root comes first when we walk breadth).
    if (!(v.key in into)) {
      // Environment values are text; a number or boolean keeps its spelling.
      into[v.key] = typeof v.value === 'string' ? v.value : v.value == null ? '' : String(v.value)
    }
  }
}

// ── Main visitor ──────────────────────────────────────────────────────────

interface VisitContext {
  warnings: SchemaImportWarning[]
  operations: IntermediateOperation[]
  usedByFolder: Map<string, Set<string>>
  envVariables: Record<string, string>
  pathParamConversions: { count: number; locations: string[] }
  responseExamplesIgnored: number
}

function getUsedSet(usedByFolder: Map<string, Set<string>>, key: string): Set<string> {
  if (!usedByFolder.has(key)) usedByFolder.set(key, new Set())
  return usedByFolder.get(key)!
}

function uniqueName(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired)
    return desired
  }
  let i = 2
  while (used.has(`${desired}-${i}`)) i++
  const out = `${desired}-${i}`
  used.add(out)
  return out
}

function descriptionText(
  desc: PostmanItem['description'] | PostmanRequest['description'] | undefined
): string | undefined {
  if (!desc) return undefined
  if (typeof desc === 'string') return desc.trim() || undefined
  if (typeof desc === 'object' && typeof desc.content === 'string') {
    const t = desc.content.trim()
    return t || undefined
  }
  return undefined
}

function buildOperation(
  item: PostmanItem,
  folderPath: string[],
  inheritedAuth: PostmanAuth | null,
  ctx: VisitContext
): IntermediateOperation | null {
  const request = item.request as PostmanRequest | undefined
  if (!request) return null

  const fallbackName = item.name?.trim() || `${request.method ?? 'GET'}-request`
  const location = `${folderPath.join('/')}/${fallbackName}`

  // URL
  const url = getUrl(request.url)
  const rawUrl = url.raw ?? reconstructUrl(url)
  const baseUrl = stripQuery(rawUrl)
  const { url: urlWithVars, converted } = convertPathParams(baseUrl)
  if (converted) {
    ctx.pathParamConversions.count++
    if (ctx.pathParamConversions.locations.length < 5) {
      ctx.pathParamConversions.locations.push(location)
    }
  }

  // Headers + query — prefer structured query[], fall back to parsing raw
  const headers = headersFromPostman(request.header)
  const params =
    url.query && url.query.length > 0 ? queryFromPostman(url.query) : parseQueryString(rawUrl)
  // The writer drops a malformed pair on save (it cannot be re-encoded
  // faithfully), so the drop is reported instead of happening silently.
  for (const p of params) {
    if (!p.malformed) continue
    ctx.warnings.push({
      kind: 'other',
      message: `Query parameter "${p.key}" has malformed percent-encoding and was not imported`,
      location
    })
  }

  // Body
  const body = mapBody(request.body, ctx.warnings, location)
  if (body.extraContentType) {
    const hasCT = headers.some((h) => h.enabled && h.key.toLowerCase() === 'content-type')
    if (!hasCT) {
      headers.push({
        id: `h-ct-${headers.length}`,
        key: 'Content-Type',
        value: body.extraContentType,
        enabled: true
      })
    }
  }
  // No User-Agent row: the default is implicit (applied at send time).

  // Auth (inheritance: request.auth beats parent; noauth cuts the chain)
  const effectiveAuth = request.auth ?? inheritedAuth ?? null
  const authConfig = mapAuth(effectiveAuth, ctx.warnings, location)

  // Scripts (item-level events override folder-level in Postman; we only look at item's events here)
  const { preRequest, postResponse } = mapScripts(item.event, ctx.warnings, location)

  // Responses → warning (aggregate once per operation that has examples)
  if (Array.isArray(item.response) && item.response.length > 0) {
    ctx.responseExamplesIgnored += item.response.length
  }

  // Description preserved as comment
  const comment = descriptionText(item.description) ?? descriptionText(request.description)

  const headerRecord: Record<string, string> = {}
  for (const h of headers) {
    if (h.enabled && h.key.trim()) headerRecord[h.key] = h.value
  }

  const method = (request.method ?? 'GET').toUpperCase()

  const editorState: RequestEditorState = {
    ...DEFAULT_REQUEST_STATE,
    method,
    url: urlWithVars,
    params,
    headers,
    bodyType: body.bodyType,
    rawSubtype: body.rawSubtype ?? 'json',
    body: body.body,
    formFields: body.formFields,
    auth: authConfig,
    preRequestScript: preRequest,
    postResponseScript: postResponse
  }

  const httpRequest: HttpRequest = {
    method,
    url: urlWithVars,
    headers: headerRecord,
    body: body.body || undefined,
    formFields: body.bodyType === 'x-www-form-urlencoded' ? body.formFields : undefined
  }

  const folderKey = folderPath.join('/')
  const usedSet = getUsedSet(ctx.usedByFolder, folderKey)
  const desired = sanitizeName(fallbackName, 'request')
  const finalName = uniqueName(desired, usedSet)

  return {
    id: randomUUID(),
    name: finalName,
    displayName: item.name?.trim() || fallbackName,
    folderPath,
    request: httpRequest,
    editorState,
    comment
  }
}

function visitItems(
  items: PostmanItem[] | undefined,
  folderPath: string[],
  inheritedAuth: PostmanAuth | null,
  ctx: VisitContext
): void {
  if (!Array.isArray(items)) return
  for (const rawItem of items) {
    if (!rawItem) continue
    const item = rawItem
    // Collect folder-level variables
    collectVariables(item.variable, ctx.envVariables)
    const itemAuth = item.auth ?? null
    const effectiveAuth = itemAuth ?? inheritedAuth

    if (Array.isArray(item.item)) {
      // Folder
      const folderName = item.name?.trim() || 'folder'
      const nextPath = [...folderPath, folderName]
      visitItems(item.item, nextPath, effectiveAuth, ctx)
    } else if (item.request) {
      // Request
      try {
        const op = buildOperation(item, folderPath, effectiveAuth, ctx)
        if (op) ctx.operations.push(op)
      } catch (err) {
        ctx.warnings.push({
          kind: 'skipped-operation',
          message: (err as Error).message,
          location: `${folderPath.join('/')}/${item.name ?? '?'}`
        })
      }
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────

export function importPostman(raw: string): {
  schema: IntermediateSchema
  warnings: SchemaImportWarning[]
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid Postman JSON: ${(err as Error).message}`, { cause: err })
  }

  if (!isPostmanCollection(parsed)) {
    throw new Error(
      'Not a recognizable Postman collection (expected info.schema with /collection/v2.x.0/)'
    )
  }

  const schemaUrl = parsed.info?.schema ?? ''
  const isV20 = /\/collection\/v2\.0\./i.test(schemaUrl)
  const isV21 = /\/collection\/v2\.1\./i.test(schemaUrl)
  if (!isV20 && !isV21) {
    // Unknown minor — attempt v2.1 parsing but warn.
    // (Return value of this is a warnings array inside the returned schema.)
  }

  // Normalize items recursively for both versions
  const root: PostmanCollection = {
    ...parsed,
    auth: parsed.auth ? normalizeAuth(parsed.auth) : null,
    item: Array.isArray(parsed.item) ? parsed.item.map(normalizeItem) : []
  }

  const warnings: SchemaImportWarning[] = []
  const operations: IntermediateOperation[] = []
  const envVariables: Record<string, string> = {}

  // Collection-level variables
  collectVariables(root.variable, envVariables)

  if (!isV20 && !isV21) {
    warnings.push({
      kind: 'unknown-field',
      message: `Unrecognized Postman schema "${schemaUrl}" — parsing as v2.1`
    })
  }

  const ctx: VisitContext = {
    warnings,
    operations,
    usedByFolder: new Map(),
    envVariables,
    pathParamConversions: { count: 0, locations: [] },
    responseExamplesIgnored: 0
  }

  visitItems(root.item, [], root.auth ?? null, ctx)

  if (ctx.pathParamConversions.count > 0) {
    warnings.push({
      kind: 'path-param-converted',
      message: `Converted ${ctx.pathParamConversions.count} path parameter(s) from :name to {{name}}`,
      location: ctx.pathParamConversions.locations.slice(0, 3).join('; ') || undefined
    })
  }
  if (ctx.responseExamplesIgnored > 0) {
    warnings.push({
      kind: 'response-example-ignored',
      message: `Ignored ${ctx.responseExamplesIgnored} saved response example(s)`
    })
  }
  const varCount = Object.keys(envVariables).length
  if (varCount > 0) {
    warnings.push({
      kind: 'variable-collected',
      message: `Collected ${varCount} collection variable(s)`
    })
  }

  const title = parsed.info?.name?.trim() || 'postman-collection'

  return {
    schema: {
      title,
      format: 'postman',
      operations,
      envVariables: varCount > 0 ? envVariables : undefined
    },
    warnings
  }
}
