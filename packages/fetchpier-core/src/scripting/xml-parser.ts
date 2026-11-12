// XML→object parser used by `orc.response.xml2Json()`.
//
// Runs in host code (outside the sandbox vm) and returns a plain JS object the
// script can navigate with standard property access. All scalar values are
// strings — no automatic number coercion (see REQ-40 §1 for rationale).
//
// Defaults are picked to be safe: DTDs are not expanded by `fast-xml-parser`,
// external entities throw, and entity expansion is length-bounded (inherently
// blocks billion-laughs).

import { XMLParser, XMLValidator } from 'fast-xml-parser'

export interface Xml2JsonOptions {
  /**
   * If true, strip namespace prefixes from element and attribute names:
   * `"soap:Body"` → `"Body"`, `"@_xmlns:soap"` is dropped by the underlying lib.
   * Default: false.
   *
   * Warning: when two namespaces declare tags with the same local name, the
   * last one wins (behavior of fast-xml-parser).
   */
  stripNamespaces?: boolean

  /**
   * Tags that must always be materialized as arrays, even when they appear
   * exactly once in the document.
   *
   * Each entry matches by:
   *  - loose tag name — e.g. `"role"` forces every `<role>` to be an array.
   *  - full jpath — e.g. `"Envelope.Body.LoginResponse.roles.role"` forces
   *    only that path.
   *
   * The jpath respects `stripNamespaces`: when it is true, write the jpath
   * without namespace prefixes.
   * Default: [].
   */
  alwaysArray?: string[]
}

/** Maximum XML body size this wrapper will attempt to parse. */
export const MAX_XML_BYTES = 10 * 1024 * 1024

const ATTRIBUTE_PREFIX = '@_'

function formatBytesAsMb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1)
}

function buildParser(opts: Xml2JsonOptions): XMLParser {
  const alwaysArray = opts.alwaysArray ?? []
  const alwaysArraySet = new Set(alwaysArray)
  const hasAlwaysArray = alwaysArraySet.size > 0

  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
    // XML 1.0 §4.1: character references (`&#233;`, `&#xE9;`) must be
    // replaced. The library decodes them only when `htmlEntities` is set; an
    // empty map turns that on without adding any HTML named entity (`&nbsp;`
    // stays literal). The predefined five and the expansion limits are unchanged.
    // The typings say `boolean`, but the parser takes an object as the named
    // map (fast-xml-parser 5.x, OrderedObjParser); `true` would decode HTML names.
    htmlEntities: {} as unknown as boolean,
    allowBooleanAttributes: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    removeNSPrefix: !!opts.stripNamespaces,
    jPath: true,
    isArray: (name, jPathOrMatcher) => {
      if (!hasAlwaysArray) return false
      // `jPath: true` above guarantees the callback receives a string.
      const jpath = typeof jPathOrMatcher === 'string' ? jPathOrMatcher : String(jPathOrMatcher)
      return alwaysArraySet.has(name) || alwaysArraySet.has(jpath)
    }
  })
}

/**
 * Parse an XML string into a plain JS object.
 *
 * @throws TypeError when `body` is not a string.
 * @throws Error     when `body.length > MAX_XML_BYTES`.
 * @throws Error     when the XML is malformed or unsafe (external entities,
 *                   entity-expansion limits hit) — the message is prefixed
 *                   with "xml2Json: failed to parse XML — ".
 */
export function parseXmlSafe(body: string, opts: Xml2JsonOptions = {}): unknown {
  if (typeof body !== 'string') {
    throw new TypeError('xml2Json: response.body is not a string')
  }

  if (body.length > MAX_XML_BYTES) {
    throw new Error(
      `xml2Json: response body too large (${formatBytesAsMb(body.length)} MB, max ${formatBytesAsMb(
        MAX_XML_BYTES
      )} MB). Parsing would block the main process.`
    )
  }

  // Validate first — fast-xml-parser is permissive and silently recovers from
  // many malformed inputs. We want strict "throw on bad input" behavior to
  // mirror JSON.parse / orc.response.json().
  const validation = XMLValidator.validate(body, { allowBooleanAttributes: true })
  if (validation !== true) {
    const { code, msg, line, col } = validation.err
    const where = col !== undefined ? ` at line ${line}, col ${col}` : ` at line ${line}`
    throw new Error(`xml2Json: failed to parse XML — ${code}: ${msg}${where}`)
  }

  try {
    return buildParser(opts).parse(body)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`xml2Json: failed to parse XML — ${msg}`, { cause: err })
  }
}
