// Generic helpers to navigate the object tree produced by `fast-xml-parser`
// with `removeNSPrefix: false` and `attributeNamePrefix: '@_'`. Keys keep their
// namespace prefix (e.g. `xsd:element`, `wsdl:binding`), so lookups are done by
// local name. Shared by the WSDL importer and its example-body generator.

export type XmlNode = Record<string, unknown>

/** Wrap a value as an array — `fast-xml-parser` collapses single children. */
export function asArray<T>(v: unknown): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? (v as T[]) : [v as T]
}

/** Strip a namespace prefix: `xsd:string` → `string`, `Add` → `Add`. */
export function stripNsPrefix(name: string): string {
  const idx = name.indexOf(':')
  return idx >= 0 ? name.slice(idx + 1) : name
}

function findLocalKey(obj: unknown, localName: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  return Object.keys(obj as XmlNode).find((k) => stripNsPrefix(k) === localName)
}

/** Child element by local name, ignoring its namespace prefix. */
export function getLocal(obj: unknown, localName: string): unknown {
  const key = findLocalKey(obj, localName)
  return key ? (obj as XmlNode)[key] : undefined
}

/**
 * Like `getLocal`, but also returns the matching key (with its namespace prefix
 * intact, e.g. `soap12:binding`). Needed to resolve which namespace prefix a
 * child element carries so the prefix can be mapped to its URI.
 */
export function getLocalEntry(
  obj: unknown,
  localName: string
): { key: string; value: unknown } | undefined {
  const key = findLocalKey(obj, localName)
  return key ? { key, value: (obj as XmlNode)[key] } : undefined
}

/** Namespace prefix of a qualified name: `soap12:binding` → `soap12`, `binding` → `''`. */
export function nsPrefix(name: string): string {
  const idx = name.indexOf(':')
  return idx >= 0 ? name.slice(0, idx) : ''
}

/**
 * Build a `prefix → namespace URI` map from the `xmlns`/`xmlns:*` attributes
 * declared on an element (typically the `<definitions>` root). The default
 * namespace is stored under the empty-string key.
 */
export function buildNsMap(obj: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (!obj || typeof obj !== 'object') return map
  for (const [k, v] of Object.entries(obj as XmlNode)) {
    if (typeof v !== 'string') continue
    if (k === '@_xmlns') map.set('', v)
    else if (k.startsWith('@_xmlns:')) map.set(k.slice('@_xmlns:'.length), v)
  }
  return map
}

/** Attribute value (`@_name`) as a string, or undefined. */
export function getAttr(obj: unknown, attrName: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const direct = (obj as XmlNode)[`@_${attrName}`]
  if (typeof direct === 'string') return direct
  return undefined
}
