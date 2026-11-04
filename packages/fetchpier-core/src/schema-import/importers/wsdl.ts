import { XMLParser } from 'fast-xml-parser'
import { randomUUID } from 'crypto'
import type {
  IntermediateSchema,
  IntermediateOperation,
  SchemaImportWarning,
  RequestEditorState,
  HttpRequest,
  KeyValuePair
} from '@shared/types'
import { DEFAULT_REQUEST_STATE } from '@shared/types'
import { sanitizeName, uniqueName } from '../sanitize'
import {
  asArray,
  buildNsMap,
  getAttr,
  getLocal,
  getLocalEntry,
  nsPrefix,
  stripNsPrefix,
  type XmlNode
} from './xml-node'
import {
  buildSoapBodyInner,
  type GlobalElement,
  type NamedType,
  type XsdRegistry
} from './wsdl-example'

const SOAP11_NS = 'http://schemas.xmlsoap.org/wsdl/soap/'
const SOAP12_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/'
const HTTP_NS = 'http://schemas.xmlsoap.org/wsdl/http/'

type BindingKind =
  | { kind: 'soap'; version: '1.1' | '1.2' }
  | { kind: 'http'; verb?: string }
  | { kind: 'unsupported'; ext?: string }

/** Classify a `<binding>` by the namespace URI of its extension child element. */
function classifyBinding(binding: XmlNode, nsMap: Map<string, string>): BindingKind {
  const entry = getLocalEntry(binding, 'binding')
  if (!entry) return { kind: 'unsupported' }
  const uri = nsMap.get(nsPrefix(entry.key)) ?? ''
  if (uri === SOAP11_NS) return { kind: 'soap', version: '1.1' }
  if (uri === SOAP12_NS) return { kind: 'soap', version: '1.2' }
  if (uri === HTTP_NS) return { kind: 'http', verb: getAttr(entry.value, 'verb') }
  return { kind: 'unsupported', ext: entry.key }
}

function buildEnvelope(tns: string, bodyLines: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${tns}">`,
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    ...bodyLines,
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
    ''
  ].join('\n')
}

/** Collect global elements and named types from every `<xsd:schema>` in `<types>`. */
function buildXsdRegistry(definitions: XmlNode): XsdRegistry {
  const elements = new Map<string, GlobalElement>()
  const types = new Map<string, NamedType>()

  const typesRoot = getLocal(definitions, 'types')
  for (const schema of asArray<XmlNode>(getLocal(typesRoot, 'schema'))) {
    const schemaNs = getAttr(schema, 'targetNamespace')
    const qualified = getAttr(schema, 'elementFormDefault') === 'qualified'

    for (const el of asArray<XmlNode>(getLocal(schema, 'element'))) {
      const name = getAttr(el, 'name')
      if (name && !elements.has(name)) elements.set(name, { node: el, schemaNs, qualified })
    }
    for (const ct of asArray<XmlNode>(getLocal(schema, 'complexType'))) {
      const name = getAttr(ct, 'name')
      if (name && !types.has(name)) types.set(name, { node: ct, kind: 'complex' })
    }
    for (const st of asArray<XmlNode>(getLocal(schema, 'simpleType'))) {
      const name = getAttr(st, 'name')
      if (name && !types.has(name)) types.set(name, { node: st, kind: 'simple' })
    }
  }

  return { elements, types }
}

interface MessagePart {
  name?: string
  element?: string
  type?: string
}

/** `<wsdl:message>` name → its parts. */
function buildMessages(definitions: XmlNode): Map<string, MessagePart[]> {
  const messages = new Map<string, MessagePart[]>()
  for (const msg of asArray<XmlNode>(getLocal(definitions, 'message'))) {
    const name = getAttr(msg, 'name')
    if (!name) continue
    const parts = asArray<XmlNode>(getLocal(msg, 'part')).map((p) => ({
      name: getAttr(p, 'name'),
      element: getAttr(p, 'element'),
      type: getAttr(p, 'type')
    }))
    messages.set(name, parts)
  }
  return messages
}

/** `<wsdl:portType>` name → (operation name → input message local name). */
function buildPortTypes(definitions: XmlNode): Map<string, Map<string, string>> {
  const portTypes = new Map<string, Map<string, string>>()
  for (const pt of asArray<XmlNode>(getLocal(definitions, 'portType'))) {
    const ptName = getAttr(pt, 'name')
    if (!ptName) continue
    const opMap = new Map<string, string>()
    for (const op of asArray<XmlNode>(getLocal(pt, 'operation'))) {
      const opName = getAttr(op, 'name')
      const inputMessage = getAttr(getLocal(op, 'input'), 'message')
      if (opName && inputMessage) opMap.set(opName, stripNsPrefix(inputMessage))
    }
    portTypes.set(ptName, opMap)
  }
  return portTypes
}

interface RawOperation {
  opName: string
  /** Local name of the portType the binding implements — half of the dedup key. */
  portTypeLocal: string
  bindingName: string
  bindingUrl: string
  soapAction: string
  soapVersion: '1.1' | '1.2'
  bodyText: string
  resolved: boolean
}

interface IgnoredBinding {
  name: string
  verb?: string
  ext?: string
}

export function importWsdl(raw: string): {
  schema: IntermediateSchema
  warnings: SchemaImportWarning[]
} {
  const warnings: SchemaImportWarning[] = []
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: false,
    trimValues: true,
    removeNSPrefix: false
  })

  const parsed = parser.parse(raw) as XmlNode
  const defsKey = Object.keys(parsed).find((k) => stripNsPrefix(k) === 'definitions')
  if (!defsKey) throw new Error('WSDL: <definitions> root not found')
  const definitions = parsed[defsKey] as XmlNode

  // prefix → namespace URI, used to classify each binding by its extension element.
  const nsMap = buildNsMap(definitions)

  const targetNamespace = getAttr(definitions, 'targetNamespace')
  const serviceName = (() => {
    const service = asArray<XmlNode>(getLocal(definitions, 'service'))[0]
    return getAttr(service, 'name')
  })()

  const title = sanitizeName(serviceName ?? 'wsdl-service', 'wsdl-service')

  // Extract endpoint URL: service → port → address.location
  let endpoint: string | undefined
  const services = asArray<XmlNode>(getLocal(definitions, 'service'))
  const portBindingEndpoints = new Map<string, string>()
  for (const svc of services) {
    const ports = asArray<XmlNode>(getLocal(svc, 'port'))
    for (const port of ports) {
      const address = getLocal(port, 'address')
      const location = getAttr(address, 'location')
      const bindingAttr = getAttr(port, 'binding')
      if (location) {
        if (!endpoint) endpoint = location
        if (bindingAttr) portBindingEndpoints.set(stripNsPrefix(bindingAttr), location)
      }
    }
  }

  // Schema/message/portType registries used to derive example request bodies.
  const registry = buildXsdRegistry(definitions)
  const messages = buildMessages(definitions)
  const portTypes = buildPortTypes(definitions)

  // First pass: collect operations from SOAP bindings only. Non-SOAP HTTP bindings
  // (and any other extension) are recorded so we can warn instead of silently
  // generating a bogus SOAP envelope for them.
  const bindings = asArray<XmlNode>(getLocal(definitions, 'binding'))
  const rawOps: RawOperation[] = []
  const ignoredBindings: IgnoredBinding[] = []

  for (const binding of bindings) {
    const bindingName = getAttr(binding, 'name') ?? 'binding'
    const cls = classifyBinding(binding, nsMap)
    if (cls.kind === 'http') {
      ignoredBindings.push({ name: bindingName, verb: cls.verb })
      continue
    }
    if (cls.kind === 'unsupported') {
      ignoredBindings.push({ name: bindingName, ext: cls.ext })
      continue
    }

    const bindingUrl = portBindingEndpoints.get(bindingName) ?? endpoint ?? ''
    const portTypeLocal = stripNsPrefix(getAttr(binding, 'type') ?? '')
    const opMap = portTypes.get(portTypeLocal)
    const bindingStyle = getAttr(getLocal(binding, 'binding'), 'style')

    for (const op of asArray<XmlNode>(getLocal(binding, 'operation'))) {
      const opName = getAttr(op, 'name')
      if (!opName) continue
      const soapOp = getLocal(op, 'operation')
      const soapAction = getAttr(soapOp, 'soapAction') ?? ''
      const opStyle = getAttr(soapOp, 'style') ?? bindingStyle ?? 'document'

      // Resolve the input message parts to drive document vs rpc body generation.
      const inputMessageLocal = opMap?.get(opName)
      const parts = inputMessageLocal ? messages.get(inputMessageLocal) : undefined

      let doc: { elementLocal: string } | undefined
      let rpc: { parts: { name: string; type?: string }[] } | undefined
      if (opStyle === 'rpc' && parts) {
        rpc = { parts: parts.map((p) => ({ name: p.name ?? 'arg', type: p.type })) }
      } else {
        const elementPart = parts?.find((p) => p.element)
        if (elementPart?.element) doc = { elementLocal: stripNsPrefix(elementPart.element) }
      }

      const body = buildSoapBodyInner({
        registry,
        wsdlTargetNamespace: targetNamespace,
        opName,
        baseIndent: '    ',
        doc,
        rpc
      })

      rawOps.push({
        opName,
        portTypeLocal,
        bindingName,
        bindingUrl,
        soapAction,
        soapVersion: cls.version,
        bodyText: buildEnvelope(body.tns, body.lines),
        resolved: body.resolved
      })
    }
  }

  // Group operations by their abstract identity (portType + operation name). The
  // same operation exposed over SOAP 1.1 and 1.2 bindings produces an identical
  // envelope, so it collapses into a single flat request; the binding dimension is
  // preserved in `sourceBindings` and surfaced as a warning rather than as folders.
  const groups = new Map<string, RawOperation[]>()
  const groupOrder: string[] = []
  for (const r of rawOps) {
    const key = `${r.portTypeLocal}\u0000${r.opName}`
    if (!groups.has(key)) {
      groups.set(key, [])
      groupOrder.push(key)
    }
    groups.get(key)!.push(r)
  }

  // Second pass: one flat request per abstract operation. `uniqueName` only kicks
  // in for genuinely distinct operations (different portTypes) sharing a name.
  const usedNames = new Set<string>()
  const operations: IntermediateOperation[] = []

  for (const key of groupOrder) {
    const group = groups.get(key)!
    // Prefer the SOAP 1.1 binding — the envelope/headers we emit are SOAP 1.1 style.
    const chosen = group.find((r) => r.soapVersion === '1.1') ?? group[0]
    const sourceBindings = [
      chosen.bindingName,
      ...group.map((r) => r.bindingName).filter((b) => b !== chosen.bindingName)
    ]
    const finalName = uniqueName(sanitizeName(chosen.opName, 'op'), usedNames)

    const headers: KeyValuePair[] = [
      {
        id: 'h-content-type',
        key: 'Content-Type',
        value: 'text/xml; charset=utf-8',
        enabled: true
      },
      { id: 'h-soap-action', key: 'SOAPAction', value: chosen.soapAction, enabled: true }
    ]

    const editorState: RequestEditorState = {
      ...DEFAULT_REQUEST_STATE,
      method: 'POST',
      url: chosen.bindingUrl,
      headers,
      bodyType: 'raw',
      rawSubtype: 'xml',
      body: chosen.bodyText
    }

    const request: HttpRequest = {
      method: 'POST',
      url: chosen.bindingUrl,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: chosen.soapAction
      },
      body: chosen.bodyText
    }

    const commentLines: string[] = []
    if (chosen.soapAction) commentLines.push(`SOAPAction: ${chosen.soapAction}`)
    if (sourceBindings.length > 1) commentLines.push(`Bindings: ${sourceBindings.join(', ')}`)

    operations.push({
      id: randomUUID(),
      name: finalName,
      displayName: chosen.opName,
      folderPath: [],
      request,
      editorState,
      comment: commentLines.length > 0 ? commentLines.join('\n') : undefined,
      sourceBindings
    })

    if (!chosen.resolved) {
      warnings.push({
        kind: 'other',
        message: `Could not derive a request body for "${chosen.opName}" from the WSDL schema; left empty`
      })
    }
    if (group.length > 1) {
      warnings.push({
        kind: 'other',
        message: `Operation "${chosen.opName}" is exposed by ${group.length} SOAP bindings (${sourceBindings.join(', ')}); collapsed into a single SOAP 1.1 request.`
      })
    }
    if (chosen.soapVersion === '1.2') {
      warnings.push({
        kind: 'other',
        message: `Operation "${chosen.opName}" is only available over a SOAP 1.2 binding (${chosen.bindingName}); a SOAP 1.1-style envelope (text/xml + SOAPAction) was generated and may need adjustment for a SOAP 1.2 endpoint (application/soap+xml).`
      })
    }
  }

  // Surface every binding we deliberately left out.
  for (const ig of ignoredBindings) {
    const what = ig.verb ? `HTTP ${ig.verb}` : ig.ext ? `unsupported (${ig.ext})` : 'non-SOAP'
    warnings.push({
      kind: 'other',
      location: ig.name,
      message: `Ignored ${what} binding "${ig.name}"; Fetchpier generates SOAP envelopes only. Operations remain available via the SOAP binding(s).`
    })
  }

  if (operations.length === 0) {
    warnings.push({
      kind: 'other',
      message: 'No operations found in WSDL bindings'
    })
  }

  return {
    schema: {
      title,
      format: 'wsdl',
      baseUrl: endpoint,
      operations
    },
    warnings
  }
}
