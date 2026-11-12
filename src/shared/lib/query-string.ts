import type { KeyValuePair, QueryDecodeWarning } from '../types'
import { mapTokenLiterals, mapTokenLiteralsSafe } from './token-grammar'

/**
 * URL ↔ structured-query primitives shared by the renderer (load path), the
 * request serializer, and the execution core (REQ-0081).
 *
 * Two responsibilities live here:
 *
 * - **Split** a flat URL into its base and a structured, token-aware query list.
 *   This is the load/CLI path: the renderer hydrates the Params tab from it, and
 *   the core uses it for adapters (the CLI parser) that hand it a flat URL.
 * - **Assemble** the outgoing query string from a structured list of *resolved*
 *   parameters, percent-encoding each component (gated by `encodeUrl`).
 *
 * The split keeps `{{variable}}` tokens verbatim (it reuses the shared token
 * grammar via `mapTokenLiterals`); the assembly runs on values that have already
 * been resolved, so it does not deal with tokens at all.
 */

/**
 * Parses a URL into its base (scheme/host/path) and an array of `KeyValuePair`
 * query params.
 *
 * Token-aware decode (REQ-0080 §6.4): only literal segments are percent-decoded;
 * `{{variable}}` tokens pass through verbatim, so a token containing a literal
 * `%` (e.g. `{{a%41b}}` / `{{a%b}}`) is never mangled or made to throw on load.
 *
 * Tolerant decode (REQ-0086): a literal segment with a *malformed* percent
 * sequence (e.g. `%E0`) makes `decodeURIComponent` throw. The failure is
 * contained at this single decode seam — shared byte-identically by the desktop
 * load path and the CLI execution path — so a malformed key never aborts a load
 * or a run. The offending pair is kept in its raw, undecoded form, flagged
 * `malformed: true`, and reported as a `MALFORMED_QUERY_ENCODING` warning.
 * Containment is per-parameter: sibling params decode normally.
 */
export function splitUrlAndParams(rawUrl: string): {
  baseUrl: string
  params: KeyValuePair[]
  warnings: QueryDecodeWarning[]
} {
  const qIdx = rawUrl.indexOf('?')
  if (qIdx === -1) return { baseUrl: rawUrl, params: [], warnings: [] }

  const baseUrl = rawUrl.slice(0, qIdx)
  const queryString = rawUrl.slice(qIdx + 1)

  // Bare '?' with no query string → one empty placeholder param
  if (queryString === '') {
    return { baseUrl, params: [{ id: 'param-0', key: '', value: '', enabled: true }], warnings: [] }
  }

  let idx = 0
  const warnings: QueryDecodeWarning[] = []
  const params: KeyValuePair[] = queryString
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const position = idx++
      const eqIdx = pair.indexOf('=')
      const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx)
      const rawValue = eqIdx === -1 ? '' : pair.slice(eqIdx + 1)
      // REQ-0113 §6.6: the grammar no longer throws — it reports. The degradation
      // this function drives is unchanged; only the signal it reads is. Note the
      // fallback is `rawKey`/`rawValue`, never the returned `text`: containment
      // is per literal segment, so `text` can be partially decoded, and REQ-0086
      // requires the *exact author bytes* to round-trip on the wire.
      const decodedKey = mapTokenLiteralsSafe(rawKey, decodeURIComponent)
      const decodedValue =
        eqIdx === -1
          ? { text: '', failed: false }
          : mapTokenLiteralsSafe(rawValue, decodeURIComponent)

      // REQ-0124: `?wsdl` and `?wsdl=` are different requests to a server that
      // dispatches on a bare flag token, but both decode to an empty value. The
      // separator's absence is the only thing that tells them apart, and this is
      // the one place it is still visible — so it is recorded here and carried on
      // the pair from now on. Only for a non-empty key: a key-less segment is
      // dropped by every assembler anyway, so the distinction is meaningless.
      const valueless = eqIdx === -1 && rawKey !== ''

      if (decodedKey.failed || decodedValue.failed) {
        // Malformed percent-encoding in the key or the value. Keep the whole pair
        // raw so the exact author bytes round-trip on the wire (REQ-0086 §6.2).
        warnings.push({ code: 'MALFORMED_QUERY_ENCODING', rawKey, index: position })
        return {
          id: `param-${position}`,
          key: rawKey,
          value: rawValue,
          enabled: true,
          malformed: true,
          ...(valueless && { valueless })
        }
      }

      return {
        id: `param-${position}`,
        key: decodedKey.text,
        value: decodedValue.text,
        enabled: true,
        ...(valueless && { valueless })
      }
    })

  return { baseUrl, params, warnings }
}

/** Decodes one literal form segment: `+` is a space, then percent-decoding. */
function decodeFormLiteral(literal: string): string {
  return decodeURIComponent(literal.replace(/\+/g, ' '))
}

/**
 * Splits an `application/x-www-form-urlencoded` body into enabled fields: on `&`
 * (empty pairs dropped), then on the first `=`. The one form decoder, shared by
 * the desktop load path, the history Open builder and the core's fallback for a
 * raw form body (the CLI shape) — the form-body twin of {@link splitUrlAndParams}.
 *
 * Token-aware, form semantics: only literal segments are decoded (`+` → space,
 * then percent-decode); `{{variable}}` tokens pass through verbatim. A literal
 * with a malformed escape keeps its author bytes (containment only — the
 * `malformed` flag and advisory stay exclusive to query parameters, REQ-0113).
 * Never throws.
 */
export function splitFormBody(body: string): KeyValuePair[] {
  let fieldId = 0
  return body
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=')
      const key = mapTokenLiterals(eqIdx === -1 ? pair : pair.slice(0, eqIdx), decodeFormLiteral)
      const value = eqIdx === -1 ? '' : mapTokenLiterals(pair.slice(eqIdx + 1), decodeFormLiteral)
      return { id: `f-${fieldId++}`, key, value, enabled: true }
    })
}

/**
 * Percent-encodes one resolved query component (a key or a value).
 *
 * REQ-0081 Q1: the encode set is `encodeURIComponent`'s — space→`%20`, `&`→`%26`,
 * `=`→`%3D`, `+`→`%2B`, `%`→`%25`, leaving `A-Za-z0-9-_.~` (and `!'()*`) as-is.
 * Both key and value use the same encoder: encoding `=` in a value is cosmetic
 * (it decodes identically), while encoding `&` ensures a value can never be read
 * as a parameter separator. This runs on *resolved* values, in the core, after
 * variable substitution — never in the renderer and never before resolution.
 */
export function encodeQueryComponent(component: string): string {
  return encodeURIComponent(component)
}

/**
 * Percent-encodes the literal segments of one **template** query component (an
 * unresolved key or value) and keeps `{{variable}}` tokens verbatim, through the
 * shared token grammar — the form a `.http` file stores, and the one
 * {@link splitUrlAndParams} reads back to the authored values. Pass it to
 * {@link assembleQuery} to rebuild a template URL from structured parameters
 * (the activity log's `# @path-raw`).
 */
export function encodeTemplateComponent(component: string): string {
  return mapTokenLiterals(component, encodeURIComponent)
}

/** Secret log mask shape (`{secret:<name>}`, from `createSecretMasker().logRender`). */
const SECRET_MASK_PATTERN = /\{secret:[^{}]+\}/g

/**
 * Like {@link encodeQueryComponent} but leaves secret **log masks**
 * (`{secret:<name>}`) verbatim, percent-encoding only the literal segments around
 * them. Used solely to build the **masked snapshot** URL (activity log, `.runs/`,
 * reporters) so a masked secret reads as `apiKey={secret:apiKey}` rather than
 * `apiKey=%7Bsecret%3AapiKey%7D`. The wire URL never uses this — it encodes the
 * resolved plaintext.
 */
export function encodeQueryComponentPreservingMasks(component: string): string {
  const re = new RegExp(SECRET_MASK_PATTERN) // fresh instance — own lastIndex
  let out = ''
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(component)) !== null) {
    if (match.index > lastIndex) {
      out += encodeQueryComponent(component.slice(lastIndex, match.index))
    }
    out += match[0] // mask verbatim
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < component.length) {
    out += encodeQueryComponent(component.slice(lastIndex))
  }
  return out
}

/**
 * Assembles the outgoing URL from a base and a structured list of *resolved*
 * query parameters, and returns the full URL string.
 *
 * - Disabled parameters and parameters with an empty key are dropped.
 * - When `encodeUrl` is on, each resolved key/value is percent-encoded with
 *   `encodeFn` (defaults to {@link encodeQueryComponent}); when off, values pass
 *   through raw (the user's deliberate escape hatch — the string is built by hand,
 *   never normalized via `new URL()`). The masked-snapshot caller passes
 *   {@link encodeQueryComponentPreservingMasks} so `{secret:…}` masks stay legible.
 * - The query is appended with `?` (or `&` if the base already has a `?`, which
 *   happens when an api-key-in-query was applied to the base upstream).
 *
 * Side-effect-free.
 */
export function assembleQuery(
  baseUrl: string,
  params: KeyValuePair[],
  encodeUrl: boolean,
  encodeFn: (component: string) => string = encodeQueryComponent
): string {
  const pairs = params
    .filter((p) => p.enabled && p.key.trim() !== '')
    // A malformed pair (REQ-0086) carries the raw author bytes; emit it verbatim
    // even when `encodeUrl` is on, so the literal sequence reaches the wire
    // instead of being double-encoded (e.g. `%E0` → `%25E0`).
    .map((p) => {
      const key = encodeUrl && !p.malformed ? encodeFn(p.key) : p.key
      // REQ-0124: a value-less parameter is the key alone. The separator is what
      // the user withheld, so withholding it is the whole behavior — encoding
      // still applies to the key, and a malformed key is still emitted verbatim.
      if (p.valueless) return key
      const value = encodeUrl && !p.malformed ? encodeFn(p.value) : p.value
      return `${key}=${value}`
    })
  if (pairs.length === 0) return baseUrl
  const qs = pairs.join('&')
  return baseUrl.includes('?') ? `${baseUrl}&${qs}` : `${baseUrl}?${qs}`
}
