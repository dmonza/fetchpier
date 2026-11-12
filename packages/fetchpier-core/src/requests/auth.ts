import type { AuthConfig, HeaderEntry } from '@shared/types'
import { setHeaderUnique } from '@shared/lib/headers'
import { encodeQueryComponentPreservingMasks } from '@shared/lib/query-string'
import { resolveString } from './variables'

/**
 * Maps a string transform over every *value-bearing* field of an auth config,
 * returning a new config. `type` and `location` are structural, never text, so
 * they are carried through untouched.
 *
 * Used to render the same resolved config twice — once for the wire, once for
 * the log — mirroring how the pipeline renders the URL and body (REQ-0111 §5.5).
 */
export function mapAuthStrings(
  auth: AuthConfig | undefined,
  fn: (s: string) => string
): AuthConfig | undefined {
  if (!auth) return auth
  switch (auth.type) {
    case 'bearer':
      return { ...auth, token: fn(auth.token) }
    case 'basic':
      return { ...auth, username: fn(auth.username), password: fn(auth.password) }
    case 'api-key':
      return { ...auth, key: fn(auth.key), value: fn(auth.value) }
    default:
      return auth
  }
}

/**
 * The value-bearing field texts of an auth config, for scanning them (e.g. to
 * collect which secret markers a credential carries). Order is stable but not
 * meaningful — callers scan the whole list.
 */
export function authFieldTexts(auth: AuthConfig | undefined): string[] {
  if (!auth) return []
  switch (auth.type) {
    case 'bearer':
      return [auth.token]
    case 'basic':
      return [auth.username, auth.password]
    case 'api-key':
      return [auth.key, auth.value]
    default:
      return []
  }
}

/**
 * Resolves `{{variable}}` references inside an auth config's own fields,
 * returning the resolved config plus the names that had no value.
 *
 * This exists because materializing a credential is lossy: Basic base64-encodes
 * its pair and api-key-in-query percent-encodes its value, and either operation
 * destroys a `{{reference}}` (and a secret marker) as *characters*. Resolution
 * therefore has to happen on the fields, before materialization — `applyAuth`
 * itself stays a pure materializer.
 *
 * Unknown names follow the same warn-and-proceed rule as every other surface:
 * the reference is left literal and reported.
 */
export function resolveAuthConfig(
  auth: AuthConfig | undefined,
  variables: Record<string, string>
): { auth: AuthConfig | undefined; unresolved: string[] } {
  if (!auth || auth.type === 'none') return { auth, unresolved: [] }

  const unresolved: string[] = []
  const resolved = mapAuthStrings(auth, (s) => {
    const r = resolveString(s, variables)
    for (const name of r.unresolved) if (!unresolved.includes(name)) unresolved.push(name)
    return r.value
  })

  return { auth: resolved, unresolved }
}

/**
 * Applies an AuthConfig to an HttpRequest, returning a new request with the
 * appropriate headers or URL modifications applied.
 *
 * - Bearer Token → `Authorization: Bearer {token}`
 * - Basic Auth   → `Authorization: Basic {base64(username:password)}`
 * - API Key (header) → custom header `{key}: {value}`
 * - API Key (query)  → `{key}={value}` appended to the URL query string
 * - None         → request returned unchanged
 *
 * Pure materialization: the fields are used verbatim. Callers that support
 * `{{variables}}` resolve them first via {@link resolveAuthConfig}.
 *
 * Both encoders default to the wire rules and are unchanged for every existing
 * caller. The masked log rendering overrides them so a `{secret:<name>}` mask
 * survives materialization legibly instead of being buried inside percent-escapes
 * or base64 — the same concern `encodeQueryComponentPreservingMasks` addresses
 * for the URL.
 */
export interface AuthMaterializationOptions {
  /** Encodes a query-located key and value. Default: `encodeURIComponent`. */
  encodeQueryComponent?: (s: string) => string
  /** Encodes the Basic `user:pass` pair. Default: base64 (UTF-8 safe). */
  encodeBasicCredential?: (s: string) => string
}

/**
 * Materialization options for the masked (log / report / snapshot) rendering:
 * both encoders are replaced so a `{secret:<name>}` mask survives materialization
 * legibly instead of being buried in percent-escapes or base64.
 *
 * Exported as one constant so the send pipeline and the command-line reporter
 * share a single rule rather than each restating it — the same drift-prevention
 * idiom the token grammar uses.
 */
export const MASK_PRESERVING_MATERIALIZATION: AuthMaterializationOptions = {
  encodeQueryComponent: encodeQueryComponentPreservingMasks,
  encodeBasicCredential: (s) => s
}

/**
 * The record counterpart of `setHeaderUnique`: drops every key matching `name`
 * case-insensitively, then sets `name`. The record is what the request snapshot
 * reports (and what goes on the wire when there is no list), so a case variant
 * left beside the managed key would report a header that was never sent.
 * Mutates `record`.
 */
export function setRecordHeaderUnique(
  record: Record<string, string>,
  name: string,
  value: string
): void {
  const lower = name.toLowerCase()
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) delete record[key]
  }
  record[name] = value
}

export function applyAuth<
  T extends { url: string; headers: Record<string, string>; headerList?: HeaderEntry[] }
>(request: T, auth: AuthConfig | undefined, options: AuthMaterializationOptions = {}): T {
  const encodeQueryComponent = options.encodeQueryComponent ?? encodeURIComponent
  const encodeBasicCredential =
    options.encodeBasicCredential ?? ((s: string) => Buffer.from(s).toString('base64'))
  if (!auth || auth.type === 'none') {
    return request
  }

  const headers = { ...request.headers }
  let headerList: HeaderEntry[] | undefined = request.headerList
    ? [...request.headerList]
    : undefined
  let url = request.url

  // Materialize a managed header: the scheme owns this name, so every same-name
  // entry (including duplicates) is replaced by a single value (REQ §6.4).
  const setManaged = (name: string, value: string): void => {
    setRecordHeaderUnique(headers, name, value)
    if (headerList) headerList = setHeaderUnique(headerList, name, value)
  }

  switch (auth.type) {
    case 'bearer': {
      if (auth.token) {
        setManaged('Authorization', `Bearer ${auth.token}`)
      }
      break
    }

    case 'basic': {
      if (auth.username || auth.password) {
        const encoded = encodeBasicCredential(`${auth.username}:${auth.password}`)
        setManaged('Authorization', `Basic ${encoded}`)
      }
      break
    }

    case 'api-key': {
      if (!auth.key) break

      if (auth.location === 'header') {
        setManaged(auth.key, auth.value)
      } else {
        // Append as query parameter
        const separator = url.includes('?') ? '&' : '?'
        url = `${url}${separator}${encodeQueryComponent(auth.key)}=${encodeQueryComponent(auth.value)}`
      }
      break
    }
  }

  return { ...request, url, headers, headerList } as T
}
