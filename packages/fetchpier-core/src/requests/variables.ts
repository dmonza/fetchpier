/**
 * Variable resolution for .http files.
 *
 * Replaces all occurrences of {{variableName}} with the corresponding value
 * from the active environment. Variables without a matching value are left
 * as-is and reported in the returned `unresolved` list.
 */

import type { HeaderEntry, KeyValuePair, MultipartPart } from '@shared/types'
import { createTokenRegex } from '@shared/lib/token-grammar'
import { RESERVED_VARIABLE_NAME_PREFIX } from '@shared/lib/dynamic-variables'
import { generateDynamicVariable } from './dynamic-variables'

export interface ResolveResult {
  value: string
  /** Names of variables that were referenced but not found in the environment. */
  unresolved: string[]
}

/**
 * Replaces {{variable}} placeholders in a string.
 *
 * @param text       The source string (URL, header value, or body).
 * @param variables  Key-value map from the active environment.
 * @returns          Resolved string and list of unresolved variable names.
 */
export function resolveString(text: string, variables: Record<string, string>): ResolveResult {
  const unresolved: string[] = []

  const value = text.replace(createTokenRegex(), (_match, name: string) => {
    const trimmed = name.trim()
    // REQ-0087: the whole `$` prefix is the system namespace. A `$`-prefixed
    // token is matched against the dynamic-variable registry (never the
    // environment, which can hold no `$` name). On a match it is replaced by a
    // freshly generated value — independently per textual occurrence. On no
    // match (an unknown system token, or a `$env.*` reference that is only
    // interpreted inside environment values) it follows the unresolved path:
    // left literal and reported, exactly like a missing user variable.
    if (trimmed.startsWith(RESERVED_VARIABLE_NAME_PREFIX)) {
      const generated = generateDynamicVariable(trimmed)
      if (generated !== undefined) return generated
      unresolved.push(trimmed)
      return _match
    }
    if (Object.prototype.hasOwnProperty.call(variables, trimmed)) {
      return variables[trimmed]
    }
    unresolved.push(trimmed)
    return _match // leave original placeholder intact
  })

  return { value, unresolved }
}

/**
 * Collect the distinct `{{name}}` references in a single string (trimmed,
 * de-duplicated, document order). Used to scope lazy secret decryption to the
 * variables a value actually references — e.g. a client-cert passphrase
 * (REQ-0089). System (`$`-prefixed) tokens are included verbatim; callers that
 * only resolve user/secret variables simply find no match for them.
 */
export function extractVariableNames(text: string): string[] {
  if (!text) return []
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(createTokenRegex())) {
    const trimmed = match[1].trim()
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      names.push(trimmed)
    }
  }
  return names
}

export interface ResolvedRequest {
  method: string
  url: string
  headers: Record<string, string>
  /**
   * Resolved ordered, duplicate-capable headers. Present iff the input request
   * carried a `headerList`; authoritative for the wire. Each entry's name and
   * value have variables substituted, preserving order and duplicates.
   */
  headerList?: HeaderEntry[]
  body?: string
  /**
   * Resolved query parameters (keys and values have variables substituted).
   * REQ-0081: these are assembled into the outgoing URL by the core after
   * resolution, with contextual percent-encoding gated by `encodeUrl`.
   */
  params?: KeyValuePair[]
  /** Resolved form fields (keys and values have variables substituted). */
  formFields?: KeyValuePair[]
  /**
   * Resolved multipart parts. For each enabled part: name, text value,
   * contentType, and (file only) the wire-filename override are
   * interpolated against the environment. `fileRef` is NEVER interpolated
   * (REQ §6.5) — variables in `file=` are rejected at parse time.
   */
  multipartParts?: MultipartPart[]
  /** All variable names that appeared in the request but had no value. */
  unresolvedVariables: string[]
}

/**
 * Resolves all {{variables}} in a request (URL, query params, header keys+values,
 * body, and formFields). The method is never interpolated.
 *
 * @param request    Serialised HTTP request (from the renderer).
 * @param variables  Active environment variables. Pass `{}` for no environment.
 */
export function resolveRequestVariables(
  request: {
    method: string
    url: string
    params?: KeyValuePair[]
    headers: Record<string, string>
    headerList?: HeaderEntry[]
    body?: string
    formFields?: KeyValuePair[]
    multipartParts?: MultipartPart[]
  },
  variables: Record<string, string>
): ResolvedRequest {
  const allUnresolved = new Set<string>()

  // Resolve URL
  const urlResult = resolveString(request.url, variables)
  urlResult.unresolved.forEach((v) => allUnresolved.add(v))

  // Resolve query param keys and values (REQ-0081). Mirrors form fields: each
  // enabled/disabled pair's key and value is interpolated; assembly + encoding
  // happen later in the core, gated by `encodeUrl`.
  let resolvedParams: KeyValuePair[] | undefined
  if (request.params && request.params.length > 0) {
    resolvedParams = request.params.map((p) => {
      const keyResult = resolveString(p.key, variables)
      const valResult = resolveString(p.value, variables)
      keyResult.unresolved.forEach((v) => allUnresolved.add(v))
      valResult.unresolved.forEach((v) => allUnresolved.add(v))
      return { ...p, key: keyResult.value, value: valResult.value }
    })
  }

  // Resolve header keys AND values. When the request carries the ordered
  // `headerList`, that is authoritative: resolve each entry preserving order and
  // duplicates, and derive the lossy record from it. Otherwise resolve the
  // record directly (legacy / importer-built requests).
  const resolvedHeaders: Record<string, string> = {}
  let resolvedHeaderList: HeaderEntry[] | undefined
  if (request.headerList) {
    resolvedHeaderList = request.headerList.map((h) => {
      const keyResult = resolveString(h.name, variables)
      const valResult = resolveString(h.value, variables)
      keyResult.unresolved.forEach((v) => allUnresolved.add(v))
      valResult.unresolved.forEach((v) => allUnresolved.add(v))
      return { name: keyResult.value, value: valResult.value }
    })
    for (const h of resolvedHeaderList) resolvedHeaders[h.name] = h.value
  } else {
    for (const [key, value] of Object.entries(request.headers)) {
      const keyResult = resolveString(key, variables)
      const valResult = resolveString(value, variables)
      keyResult.unresolved.forEach((v) => allUnresolved.add(v))
      valResult.unresolved.forEach((v) => allUnresolved.add(v))
      resolvedHeaders[keyResult.value] = valResult.value
    }
  }

  // Resolve body
  let resolvedBody: string | undefined
  if (request.body !== undefined) {
    const bodyResult = resolveString(request.body, variables)
    bodyResult.unresolved.forEach((v) => allUnresolved.add(v))
    resolvedBody = bodyResult.value
  }

  // Resolve form field keys and values
  let resolvedFormFields: KeyValuePair[] | undefined
  if (request.formFields && request.formFields.length > 0) {
    resolvedFormFields = request.formFields.map((field) => {
      const keyResult = resolveString(field.key, variables)
      const valResult = resolveString(field.value, variables)
      keyResult.unresolved.forEach((v) => allUnresolved.add(v))
      valResult.unresolved.forEach((v) => allUnresolved.add(v))
      return { ...field, key: keyResult.value, value: valResult.value }
    })
  }

  // Resolve multipart parts. For each part: interpolate name, contentType,
  // and (text) value or (file) filename. NEVER touch file.ref — the hash is
  // the file's identity, not a value field (REQ §6.5).
  let resolvedMultipartParts: MultipartPart[] | undefined
  if (request.multipartParts && request.multipartParts.length > 0) {
    resolvedMultipartParts = request.multipartParts.map((part) => {
      const nameResult = resolveString(part.name, variables)
      nameResult.unresolved.forEach((v) => allUnresolved.add(v))

      const resolvedContentType = part.contentType
        ? (() => {
            const r = resolveString(part.contentType!, variables)
            r.unresolved.forEach((v) => allUnresolved.add(v))
            return r.value
          })()
        : undefined

      if (part.kind === 'text') {
        const vResult = resolveString(part.value, variables)
        vResult.unresolved.forEach((v) => allUnresolved.add(v))
        return {
          ...part,
          name: nameResult.value,
          value: vResult.value,
          contentType: resolvedContentType
        }
      }

      const resolvedFilename = part.filename
        ? (() => {
            const r = resolveString(part.filename!, variables)
            r.unresolved.forEach((v) => allUnresolved.add(v))
            return r.value
          })()
        : undefined

      return {
        ...part,
        name: nameResult.value,
        filename: resolvedFilename,
        contentType: resolvedContentType
        // file.ref intentionally untouched.
      }
    })
  }

  return {
    method: request.method,
    url: urlResult.value,
    params: resolvedParams,
    headers: resolvedHeaders,
    headerList: resolvedHeaderList,
    body: resolvedBody,
    formFields: resolvedFormFields,
    multipartParts: resolvedMultipartParts,
    unresolvedVariables: [...allUnresolved]
  }
}
