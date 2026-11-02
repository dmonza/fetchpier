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
}

export interface BuildBodyResult {
  /** Inner lines of `<soapenv:Body>`, already indented at `baseIndent`. */
  lines: string[]
  /** True when real structure was derived from the schema (drives a warning). */
  resolved: boolean
  /** Namespace the envelope should bind to the `tns` prefix. */
  tns: string
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

interface BuildCtx {
  registry: XsdRegistry
  /** Whether descendant local elements are namespace-qualified. */
  qualified: boolean
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
  return [`${indent}<${tag}>${value ?? ''}</${tag}>`]
}

/** Expand a single `<xsd:element>` (resolving a `ref` to a global element). */
function expandElement(el: XmlNode, indent: string, depth: number, ctx: BuildCtx): string[] {
  if (depth > MAX_DEPTH) return []

  let node = el
  let name = getAttr(el, 'name')
  const ref = getAttr(el, 'ref')
  if (ref) {
    const refLocal = stripNsPrefix(ref)
    const g = ctx.registry.elements.get(refLocal)
    if (g) {
      node = g.node
      name = getAttr(g.node, 'name') ?? refLocal
    } else {
      name = refLocal
    }
  }
  if (!name) return []

  const tag = ctx.qualified ? `${PREFIX}:${name}` : name
  return renderElement(tag, node, indent, depth, ctx)
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

/** Expand the `element` children of a sequence/all (or first branch of a choice). */
function expandParticles(
  container: XmlNode,
  indent: string,
  depth: number,
  ctx: BuildCtx
): string[] {
  const ordered = getLocal(container, 'sequence') ?? getLocal(container, 'all')
  if (ordered) {
    const out: string[] = []
    for (const el of asArray<XmlNode>(getLocal(ordered, 'element'))) {
      out.push(...expandElement(el, indent, depth + 1, ctx))
    }
    // A choice nested inside a sequence — emit just its first branch.
    const innerChoice = getLocal(ordered, 'choice')
    if (innerChoice) {
      const first = asArray<XmlNode>(getLocal(innerChoice, 'element'))[0]
      if (first) out.push(...expandElement(first, indent, depth + 1, ctx))
    }
    return out
  }

  const choice = getLocal(container, 'choice')
  if (choice) {
    const first = asArray<XmlNode>(getLocal(choice, 'element'))[0]
    return first ? expandElement(first, indent, depth + 1, ctx) : []
  }

  return []
}

export function buildSoapBodyInner(opts: BuildBodyOptions): BuildBodyResult {
  const baseIndent = opts.baseIndent
  const fallbackTns = opts.wsdlTargetNamespace ?? 'http://example.com/'

  // document/literal: expand the global wrapper element.
  if (opts.doc) {
    const g = opts.registry.elements.get(opts.doc.elementLocal)
    if (g) {
      const ctx: BuildCtx = { registry: opts.registry, qualified: g.qualified }
      const name = getAttr(g.node, 'name') ?? opts.doc.elementLocal
      // The wrapper is a global element — always namespace-qualified.
      const lines = renderElement(`${PREFIX}:${name}`, g.node, baseIndent, 0, ctx)
      return { lines, resolved: true, tns: g.schemaNs ?? fallbackTns }
    }
  }

  // rpc/literal: wrapper = operation name, children = message parts (unqualified).
  if (opts.rpc) {
    const ctx: BuildCtx = { registry: opts.registry, qualified: false }
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
    return { lines, resolved: true, tns: fallbackTns }
  }

  // Nothing resolvable — emit an empty wrapper (no TODO comment).
  const tag = `${PREFIX}:${opts.opName}`
  return {
    lines: [`${baseIndent}<${tag}></${tag}>`],
    resolved: false,
    tns: fallbackTns
  }
}
