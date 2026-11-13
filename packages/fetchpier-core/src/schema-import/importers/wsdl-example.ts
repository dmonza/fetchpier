// Builds an example SOAP request body from the XSD schema embedded in a WSDL.
// Pure module: `wsdl.ts` collects the type/message/portType registries from the
// parsed document and delegates the XML generation here so it can be tested in
// isolation. No I/O, no Electron.

import { asArray, getAttr, getLocal, stripNsPrefix, type XmlNode } from './xml-node'

/** A global `<xsd:element>` plus the schema context it was declared in. */
export interface GlobalElement {
  node: XmlNode
  /** targetNamespace of the schema that declared it. */
  schemaNs?: string
  /** elementFormDefault="qualified" → descendant locals carry the prefix. */
  qualified: boolean
}

/** A named `<xsd:complexType>` / `<xsd:simpleType>`. */
export interface NamedType {
  node: XmlNode
  kind: 'complex' | 'simple'
}

/** All global elements and named types reachable from `<wsdl:types>`. */
export interface XsdRegistry {
  /** local name → global element */
  elements: Map<string, GlobalElement>
  /** local name → named type */
  types: Map<string, NamedType>
  /** local name → named model group (`<xsd:group name>`) */
  groups?: Map<string, XmlNode>
}

/**
 * Key under which the WSDL parser stores a node's element children in document
 * order. The grouped `getLocal` view loses the order between different child
 * names; XSD particles need it. A symbol, so `Object.keys` never sees it.
 */
export const CHILD_ORDER: unique symbol = Symbol('xmlChildOrder')

/** One element child of a parsed node: its prefixed name and its value. */
export interface OrderedChild {
  key: string
  node: unknown
}

/** A node as built by the WSDL parser: grouped children plus their order. */
export type OrderedXmlNode = XmlNode & { [CHILD_ORDER]?: OrderedChild[] }

export interface BuildBodyResult {
  /** Inner lines of `<soapenv:Body>`, already indented at `baseIndent`. */
  lines: string[]
  /** True when real structure was derived from the schema (drives a warning). */
  resolved: boolean
  /** Namespace the envelope should bind to the `tns` prefix. */
  tns: string
  /** Further prefixes the body uses (`ns1`, `ns2`, …), in allocation order. */
  namespaces: { prefix: string; uri: string }[]
}

/** Escape text for an XML element body or a double-quoted attribute value. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface BuildBodyOptions {
  registry: XsdRegistry
  /** WSDL `<definitions targetNamespace>`, used as the default `tns` binding. */
  wsdlTargetNamespace?: string
  /** Operation name — wrapper element name in rpc style and the fallback. */
  opName: string
  /** Indentation for the wrapper element (4 spaces to match the envelope). */
  baseIndent: string
  /** document/literal: the global element wrapping the request. */
  doc?: { elementLocal: string }
  /** rpc/literal: the operation's input message parts. */
  rpc?: { parts: { name: string; type?: string }[] }
}

const MAX_DEPTH = 6
const PREFIX = 'tns'

/** Namespace → prefix bindings the body needs; `tns` is the wrapper's namespace. */
interface NsBindings {
  tns: string
  extra: Map<string, string>
}

interface BuildCtx {
  registry: XsdRegistry
  /** Whether descendant local elements are namespace-qualified. */
  qualified: boolean
  /** Prefix that qualified descendant locals carry. */
  prefix: string
  namespaces: NsBindings
}

function prefixFor(ns: NsBindings, uri: string): string {
  if (uri === ns.tns) return PREFIX
  let prefix = ns.extra.get(uri)
  if (!prefix) {
    prefix = `ns${ns.extra.size + 1}`
    ns.extra.set(uri, prefix)
  }
  return prefix
}

function newCtx(registry: XsdRegistry, tns: string, qualified: boolean): BuildCtx {
  return { registry, qualified, prefix: PREFIX, namespaces: { tns, extra: new Map() } }
}

function extraNamespaces(ctx: BuildCtx): { prefix: string; uri: string }[] {
  return [...ctx.namespaces.extra].map(([uri, prefix]) => ({ prefix, uri }))
}

/** Placeholder text for an XSD built-in type (by local name). */
export function xsdPlaceholder(localType: string | undefined): string {
  switch ((localType ?? '').toLowerCase()) {
    case 'string':
    case 'normalizedstring':
    case 'token':
    case 'language':
    case 'name':
    case 'ncname':
    case 'anyuri':
    case 'qname':
      return 'string'
    case 'int':
    case 'integer':
    case 'long':
    case 'short':
    case 'byte':
    case 'unsignedint':
    case 'unsignedlong':
    case 'unsignedshort':
    case 'unsignedbyte':
    case 'nonnegativeinteger':
    case 'positiveinteger':
    case 'negativeinteger':
    case 'nonpositiveinteger':
      return '0'
    case 'decimal':
    case 'float':
    case 'double':
      return '0.0'
    case 'boolean':
      return 'false'
    case 'datetime':
      return '2026-01-01T00:00:00Z'
    case 'date':
      return '2026-01-01'
    case 'time':
      return '00:00:00'
    case 'duration':
      return 'P0D'
    case 'base64binary':
    case 'hexbinary':
    default:
      return ''
  }
}

function placeholderForSimpleType(st: XmlNode): string {
  const restriction = getLocal(st, 'restriction')
  if (restriction) {
    const enums = asArray<XmlNode>(getLocal(restriction, 'enumeration'))
    for (const e of enums) {
      const v = getAttr(e, 'value')
      if (v !== undefined) return v
    }
    return xsdPlaceholder(stripNsPrefix(getAttr(restriction, 'base') ?? ''))
  }
  // <list>/<union> or anything else → a plain string is the safest sample.
  return 'string'
}

/** Resolve an element's content: nested children or a leaf placeholder value. */
function resolveContent(
  node: XmlNode,
  childIndent: string,
  depth: number,
  ctx: BuildCtx
): { children: string[]; value?: string } {
  if (depth > MAX_DEPTH) return { children: [] }

  const inlineComplex = getLocal(node, 'complexType')
  if (inlineComplex) {
    return { children: expandComplexType(inlineComplex as XmlNode, childIndent, depth + 1, ctx) }
  }

  const inlineSimple = getLocal(node, 'simpleType')
  if (inlineSimple) {
    return { children: [], value: placeholderForSimpleType(inlineSimple as XmlNode) }
  }

  const typeAttr = getAttr(node, 'type')
  if (typeAttr) {
    const local = stripNsPrefix(typeAttr)
    const named = ctx.registry.types.get(local)
    if (named) {
      if (named.kind === 'complex') {
        return { children: expandComplexType(named.node, childIndent, depth + 1, ctx) }
      }
      return { children: [], value: placeholderForSimpleType(named.node) }
    }
    return { children: [], value: xsdPlaceholder(local) }
  }

  return { children: [] }
}

function renderElement(
  tag: string,
  node: XmlNode,
  indent: string,
  depth: number,
  ctx: BuildCtx
): string[] {
  const { children, value } = resolveContent(node, indent + '  ', depth, ctx)
  if (children.length > 0) {
    return [`${indent}<${tag}>`, ...children, `${indent}</${tag}>`]
  }
  return [`${indent}<${tag}>${escapeXml(value ?? '')}</${tag}>`]
}

/** Expand a single `<xsd:element>` (resolving a `ref` to a global element). */
function expandElement(el: XmlNode, indent: string, depth: number, ctx: BuildCtx): string[] {
  if (depth > MAX_DEPTH) return []

  let node = el
  let name = getAttr(el, 'name')
  let tag: string | undefined
  let childCtx = ctx
  const ref = getAttr(el, 'ref')
  if (ref) {
    const refLocal = stripNsPrefix(ref)
    const g = ctx.registry.elements.get(refLocal)
    if (g) {
      node = g.node
      name = getAttr(g.node, 'name') ?? refLocal
      // A global element belongs to its schema's targetNamespace whatever
      // elementFormDefault says; its locals follow the declaring schema.
      if (g.schemaNs) {
        const prefix = prefixFor(ctx.namespaces, g.schemaNs)
        tag = `${prefix}:${name}`
        childCtx = { ...ctx, qualified: g.qualified, prefix }
      } else {
        tag = name
        childCtx = { ...ctx, qualified: false }
      }
    } else {
      name = refLocal
    }
  }
  if (!name) return []

  tag ??= ctx.qualified ? `${ctx.prefix}:${name}` : name
  return renderElement(tag, node, indent, depth, childCtx)
}

/** Collect the element particles of a complexType (sequence/all/choice/extension). */
function expandComplexType(ct: XmlNode, indent: string, depth: number, ctx: BuildCtx): string[] {
  if (depth > MAX_DEPTH) return []

  // complexContent → extension/restriction(base): include base type then own particles.
  const complexContent = getLocal(ct, 'complexContent')
  if (complexContent) {
    const derived =
      (getLocal(complexContent, 'extension') as XmlNode | undefined) ??
      (getLocal(complexContent, 'restriction') as XmlNode | undefined)
    if (derived) {
      const out: string[] = []
      const base = getAttr(derived, 'base')
      if (base) {
        const baseType = ctx.registry.types.get(stripNsPrefix(base))
        if (baseType && baseType.kind === 'complex') {
          out.push(...expandComplexType(baseType.node, indent, depth + 1, ctx))
        }
      }
      out.push(...expandParticles(derived, indent, depth, ctx))
      return out
    }
  }

  return expandParticles(ct, indent, depth, ctx)
}

/**
 * Element children of a node in document order. A node built by the WSDL
 * parser carries the order; a hand-built tree falls back to its key order.
 */
function childrenInOrder(node: unknown): OrderedChild[] {
  if (!node || typeof node !== 'object') return []
  const ordered = (node as OrderedXmlNode)[CHILD_ORDER]
  if (ordered) return ordered
  const out: OrderedChild[] = []
  for (const [key, value] of Object.entries(node as XmlNode)) {
    if (key.startsWith('@_') || key === '#text') continue
    for (const child of asArray<unknown>(value)) out.push({ key, node: child })
  }
  return out
}

/** XSD particles that can appear in a model group (annotations are skipped). */
const PARTICLES = new Set(['element', 'sequence', 'all', 'choice', 'group', 'any'])
/** Content-model children of a complexType / extension / group definition. */
const MODEL_GROUPS = new Set(['sequence', 'all', 'choice', 'group'])

/** Expand the content model (sequence/all/choice/group) of a container. */
function expandParticles(
  container: XmlNode,
  indent: string,
  depth: number,
  ctx: BuildCtx
): string[] {
  const model = childrenInOrder(container).find((c) => MODEL_GROUPS.has(stripNsPrefix(c.key)))
  return model ? expandParticle(model, indent, depth, ctx) : []
}

/**
 * Expand one particle in declared order: an element, every particle of a
 * sequence/all, the first branch of a choice, or a referenced model group.
 */
function expandParticle(p: OrderedChild, indent: string, depth: number, ctx: BuildCtx): string[] {
  if (depth > MAX_DEPTH) return []
  switch (stripNsPrefix(p.key)) {
    case 'element':
      return expandElement(p.node as XmlNode, indent, depth + 1, ctx)
    case 'sequence':
    case 'all': {
      const out: string[] = []
      for (const child of childrenInOrder(p.node)) {
        out.push(...expandParticle(child, indent, depth, ctx))
      }
      return out
    }
    case 'choice': {
      const first = childrenInOrder(p.node).find((c) => PARTICLES.has(stripNsPrefix(c.key)))
      return first ? expandParticle(first, indent, depth, ctx) : []
    }
    case 'group': {
      const ref = getAttr(p.node, 'ref')
      const def = ref ? ctx.registry.groups?.get(stripNsPrefix(ref)) : (p.node as XmlNode)
      return def ? expandParticles(def, indent, depth + 1, ctx) : []
    }
    default:
      // `any` and anything unknown: nothing to sample.
      return []
  }
}

export function buildSoapBodyInner(opts: BuildBodyOptions): BuildBodyResult {
  const baseIndent = opts.baseIndent
  const fallbackTns = opts.wsdlTargetNamespace ?? 'http://example.com/'

  // document/literal: expand the global wrapper element.
  if (opts.doc) {
    const g = opts.registry.elements.get(opts.doc.elementLocal)
    if (g) {
      const tns = g.schemaNs ?? fallbackTns
      const ctx = newCtx(opts.registry, tns, g.qualified)
      const name = getAttr(g.node, 'name') ?? opts.doc.elementLocal
      // The wrapper is a global element — always namespace-qualified.
      const lines = renderElement(`${PREFIX}:${name}`, g.node, baseIndent, 0, ctx)
      return { lines, resolved: true, tns, namespaces: extraNamespaces(ctx) }
    }
  }

  // rpc/literal: wrapper = operation name, children = message parts (unqualified).
  if (opts.rpc) {
    const ctx = newCtx(opts.registry, fallbackTns, false)
    const childIndent = baseIndent + '  '
    const children: string[] = []
    for (const p of opts.rpc.parts) {
      const partNode: XmlNode = { '@_name': p.name }
      if (p.type) partNode['@_type'] = p.type
      children.push(...expandElement(partNode, childIndent, 0, ctx))
    }
    const tag = `${PREFIX}:${opts.opName}`
    const lines =
      children.length > 0
        ? [`${baseIndent}<${tag}>`, ...children, `${baseIndent}</${tag}>`]
        : [`${baseIndent}<${tag}></${tag}>`]
    return { lines, resolved: true, tns: fallbackTns, namespaces: extraNamespaces(ctx) }
  }

  // Nothing resolvable — emit an empty wrapper (no TODO comment).
  const tag = `${PREFIX}:${opts.opName}`
  return {
    lines: [`${baseIndent}<${tag}></${tag}>`],
    resolved: false,
    tns: fallbackTns,
    namespaces: []
  }
}
