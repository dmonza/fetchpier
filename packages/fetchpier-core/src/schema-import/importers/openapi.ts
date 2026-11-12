import yaml from 'js-yaml'
import { randomUUID } from 'crypto'
import type {
  IntermediateSchema,
  IntermediateOperation,
  SchemaImportWarning,
  HttpRequest,
  KeyValuePair,
  RequestEditorState,
  BodyType,
  RawSubtype,
  AuthConfig
} from '@shared/types'
import { DEFAULT_REQUEST_STATE } from '@shared/types'
import { sanitizeName, sanitizeSegments } from '../sanitize'
import {
  generateExampleFromJsonSchema,
  prettyJson,
  type ExampleRefContext
} from '../example-generator'
import {
  TOO_DEEP_MARKER,
  createRefResolver,
  isReference,
  notFoundMarker,
  pathItemLocation,
  type RefResolver
} from '../ref-resolver'

type AnyDoc = Record<string, unknown>

/**
 * Reference access bound to the place that needs it (an operation, or a path
 * item's pointer). Every read of an object the importer might find written as
 * a `$ref` goes through here — resolution is on demand (see ref-resolver.ts).
 */
interface Refs {
  /** Structural position: the resolved object, or `undefined` when it is absent. */
  object(node: unknown): AnyDoc | undefined
  /** Value position: the resolved schema, or the marker string to emit instead. */
  schema(node: unknown): { schema: Record<string, unknown> | undefined } | { marker: string }
  /** Context for the example generator (markers, per-branch recursion). */
  generator: ExampleRefContext
}

function bindRefs(resolver: RefResolver, location: string): Refs {
  return {
    object(node) {
      const value = resolver.resolveObject(node, location)
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as AnyDoc)
        : undefined
    },
    schema(node) {
      const result = resolver.resolve(node, location)
      if (result.status === 'unresolved') return { marker: notFoundMarker(result.ref) }
      if (result.status === 'too-deep') return { marker: TOO_DEEP_MARKER }
      const value = result.value
      return {
        schema: value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
      }
    },
    generator: { resolve: (node) => resolver.resolve(node, location) }
  }
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

/**
 * Whether `openapi` names a 3.x version. An unquoted two-part version (`3.0`,
 * `3.1`) is a number once parsed, so it is accepted as `swagger: 2.0` is.
 */
export function isOpenApiV3Version(version: unknown): boolean {
  if (typeof version === 'number') return Math.trunc(version) === 3
  return typeof version === 'string' && version.startsWith('3')
}

function isOpenAPIv3(doc: AnyDoc): boolean {
  return isOpenApiV3Version(doc['openapi'])
}

/**
 * YAML loads with the core schema plus merge keys: no timestamp type, so an
 * unquoted `2024-01-15` stays the string the author wrote (OpenAPI's YAML is
 * JSON-compatible), while `<<: *anchor` merges keep working. js-yaml exports
 * `types` at runtime; its typings leave it out.
 */
const YAML_SCHEMA = yaml.CORE_SCHEMA.extend({
  implicit: [(yaml as unknown as { types: { merge: yaml.Type } }).types.merge]
})

function isSwaggerV2(doc: AnyDoc): boolean {
  return doc['swagger'] === '2.0' || doc['swagger'] === 2
}

export function parseSchemaText(raw: string): AnyDoc {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as AnyDoc
  }
  const loaded = yaml.load(trimmed, { schema: YAML_SCHEMA })
  if (!loaded || typeof loaded !== 'object') {
    throw new Error('Schema is not a JSON/YAML object')
  }
  return loaded as AnyDoc
}

function getBaseUrlV3(doc: AnyDoc): string | undefined {
  const servers = doc['servers'] as Array<{ url?: string }> | undefined
  return servers && servers[0]?.url ? servers[0].url : undefined
}

function getBaseUrlV2(doc: AnyDoc): string | undefined {
  const host = doc['host'] as string | undefined
  const basePath = (doc['basePath'] as string | undefined) ?? ''
  const schemes = doc['schemes'] as string[] | undefined
  const scheme = schemes && schemes.length > 0 ? schemes[0] : 'https'
  if (!host) return undefined
  return `${scheme}://${host}${basePath}`
}

function joinUrl(base: string | undefined, path: string): string {
  if (!base) return path
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

interface ParamInfo {
  name: string
  in: 'query' | 'header' | 'path' | 'cookie' | 'body' | 'formData'
  required?: boolean
  schema?: Record<string, unknown>
  example?: unknown
  type?: string
}

function normalizeParams(raw: unknown, refs: Refs): ParamInfo[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((p) => refs.object(p) as ParamInfo | undefined)
    .filter((p): p is ParamInfo => !!p && !!p.in && !!p.name)
}

/** Value for a query / header / form parameter: its example, a marker, or a type placeholder. */
function paramValue(p: ParamInfo, refs: Refs): string {
  if (p.example !== undefined) return String(p.example)
  if (p.schema === undefined) return examplePrimitive(p.type)
  const resolved = refs.schema(p.schema)
  if ('marker' in resolved) return resolved.marker
  return examplePrimitive((resolved.schema?.type as string | undefined) ?? p.type)
}

/**
 * Value inlined into the URL path. Never a marker — markers contain spaces and
 * `#`, which would break the URL — so an unresolvable schema falls back to the
 * type placeholder (the warning carries the signal).
 */
function pathParamValue(p: ParamInfo, refs: Refs): string {
  if (p.example !== undefined) return String(p.example)
  if (p.schema === undefined) return examplePrimitive(p.type)
  const resolved = refs.schema(p.schema)
  const type = 'marker' in resolved ? undefined : (resolved.schema?.type as string | undefined)
  return examplePrimitive(type ?? p.type)
}

function examplePrimitive(type?: string): string {
  switch (type) {
    case 'integer':
    case 'number':
      return '0'
    case 'boolean':
      return 'false'
    default:
      return 'string'
  }
}

function buildUrlWithPathParams(url: string, pathParams: ParamInfo[], refs: Refs): string {
  let out = url
  for (const p of pathParams) {
    const placeholder = `{${p.name}}`
    out = out.split(placeholder).join(pathParamValue(p, refs))
  }
  return out
}

function paramsToKeyValuePairs(
  params: ParamInfo[],
  kind: 'query' | 'header',
  refs: Refs
): KeyValuePair[] {
  return params
    .filter((p) => p.in === kind)
    .map((p) => ({
      id: `${kind}-${p.name}`,
      key: p.name,
      value: paramValue(p, refs),
      enabled: p.required !== false
    }))
}

function pickRequestBodyContent(
  requestBody: unknown,
  warnings: SchemaImportWarning[],
  location: string,
  refs: Refs
): { contentType?: string; bodyText?: string; bodyType?: BodyType; formFields?: KeyValuePair[] } {
  const resolvedBody = refs.object(requestBody)
  if (!resolvedBody) return {}
  const content = resolvedBody['content'] as Record<string, unknown> | undefined
  if (!content || typeof content !== 'object') return {}

  const order = [
    'application/json',
    'application/x-www-form-urlencoded',
    'text/xml',
    'application/xml',
    'text/plain',
    'multipart/form-data'
  ]

  let chosen: string | undefined
  for (const candidate of order) {
    if (content[candidate]) {
      chosen = candidate
      break
    }
  }
  if (!chosen) chosen = Object.keys(content)[0]
  if (!chosen) return {}

  const entry = refs.object(content[chosen]) as
    { schema?: Record<string, unknown>; example?: unknown } | undefined
  if (!entry) return {}
  if (chosen === 'application/json') {
    const example =
      entry.example ?? generateExampleFromJsonSchema(entry.schema as never, 0, refs.generator)
    return {
      contentType: chosen,
      bodyType: 'raw',
      bodyText: prettyJson(example ?? {})
    }
  }
  if (chosen === 'application/x-www-form-urlencoded') {
    const schema = refs.object(entry.schema)
    const props = (schema?.['properties'] as Record<string, unknown> | undefined) ?? {}
    const formFields: KeyValuePair[] = Object.entries(props).map(([k, raw]) => {
      const field = refs.schema(raw)
      const value =
        'marker' in field
          ? field.marker
          : field.schema?.['example'] !== undefined
            ? String(field.schema['example'])
            : examplePrimitive(field.schema?.['type'] as string | undefined)
      return { id: `form-${k}`, key: k, value, enabled: true }
    })
    return { contentType: chosen, bodyType: 'x-www-form-urlencoded', formFields }
  }
  if (chosen === 'multipart/form-data') {
    warnings.push({
      kind: 'missing-example',
      message: 'multipart/form-data body not fully supported; using raw placeholder',
      location
    })
    return { contentType: chosen, bodyType: 'raw', bodyText: '' }
  }
  // xml / text / unknown
  const example =
    entry.example ?? generateExampleFromJsonSchema(entry.schema as never, 0, refs.generator)
  const body = typeof example === 'string' ? example : prettyJson(example ?? null)
  return { contentType: chosen, bodyType: 'raw', bodyText: body }
}

function buildSwaggerFormBody(params: ParamInfo[], refs: Refs): KeyValuePair[] {
  return params
    .filter((p) => p.in === 'formData')
    .map((p) => ({
      id: `form-${p.name}`,
      key: p.name,
      value: paramValue(p, refs),
      enabled: p.required !== false
    }))
}

function buildSwaggerBody(
  params: ParamInfo[],
  consumes: string[] | undefined,
  warnings: SchemaImportWarning[],
  location: string,
  refs: Refs
): { contentType?: string; bodyType?: BodyType; bodyText?: string; formFields?: KeyValuePair[] } {
  const bodyParam = params.find((p) => p.in === 'body')
  const hasForm = params.some((p) => p.in === 'formData')
  const contentType =
    (consumes && consumes[0]) ??
    (bodyParam ? 'application/json' : hasForm ? 'application/x-www-form-urlencoded' : undefined)

  if (hasForm && (contentType === 'application/x-www-form-urlencoded' || !contentType)) {
    return {
      contentType: 'application/x-www-form-urlencoded',
      bodyType: 'x-www-form-urlencoded',
      formFields: buildSwaggerFormBody(params, refs)
    }
  }
  if (bodyParam) {
    const example =
      bodyParam.example ??
      generateExampleFromJsonSchema(bodyParam.schema as never, 0, refs.generator)
    if (contentType === 'application/json' || contentType === undefined) {
      return {
        contentType: contentType ?? 'application/json',
        bodyType: 'raw',
        bodyText: prettyJson(example ?? {})
      }
    }
    const bodyText = typeof example === 'string' ? example : prettyJson(example ?? null)
    return { contentType, bodyType: 'raw', bodyText }
  }
  if (hasForm) {
    warnings.push({
      kind: 'missing-example',
      message: 'multipart/form-data not fully supported',
      location
    })
    return { contentType, bodyType: 'raw', bodyText: '' }
  }
  return {}
}

function detectAuthFromSecurity(
  doc: AnyDoc,
  security: unknown,
  warnings: SchemaImportWarning[],
  location: string,
  refs: Refs
): AuthConfig {
  if (!Array.isArray(security) || security.length === 0) return { type: 'none' }
  const firstRequirement = security[0] as Record<string, unknown>
  const schemes =
    (doc['components'] as { securitySchemes?: Record<string, unknown> } | undefined)
      ?.securitySchemes ?? (doc['securityDefinitions'] as Record<string, unknown> | undefined)
  if (!schemes) return { type: 'none' }
  const [schemeKey] = Object.keys(firstRequirement)
  const scheme = Object.prototype.hasOwnProperty.call(schemes, schemeKey)
    ? refs.object(schemes[schemeKey])
    : undefined
  if (!scheme) return { type: 'none' }
  const type = String(scheme['type'])
  const schemeName = (scheme['scheme'] as string | undefined)?.toLowerCase()
  const inLoc = scheme['in'] as string | undefined
  const name = scheme['name'] as string | undefined

  if (type === 'http' && schemeName === 'bearer') return { type: 'bearer', token: '' }
  // `type: basic` is how Swagger 2.0 writes the OAS3 `http` + `basic` scheme.
  if ((type === 'http' && schemeName === 'basic') || type === 'basic')
    return { type: 'basic', username: '', password: '' }
  if (type === 'apiKey' && (inLoc === 'header' || inLoc === 'query') && name) {
    return { type: 'api-key', key: name, value: '', location: inLoc }
  }
  if (type === 'oauth2') {
    warnings.push({
      kind: 'unsupported-auth',
      message: 'OAuth2 not yet supported — using bearer placeholder',
      location
    })
    return { type: 'bearer', token: '' }
  }
  // A declared scheme with no mapping (openIdConnect, an apiKey in a cookie,
  // another http scheme, an unknown type) is reported, never dropped silently.
  const detail =
    type === 'apiKey'
      ? `apiKey in ${inLoc ?? 'an unknown location'}`
      : type === 'http'
        ? `http ${schemeName ?? ''}`.trim()
        : type
  warnings.push({
    kind: 'unsupported-auth',
    message: `Security scheme "${schemeKey}" (${detail}) is not supported — imported without auth`,
    location
  })
  return { type: 'none' }
}

function buildOperation(args: {
  method: string
  pathKey: string
  op: AnyDoc
  baseUrl: string | undefined
  isSwagger: boolean
  /** The path item's `parameters`, as written (resolved here, per operation). */
  pathParameters: unknown
  doc: AnyDoc
  consumes?: string[]
  warnings: SchemaImportWarning[]
  usedNames: Map<string, Set<string>>
  location: string
  refs: Refs
}): IntermediateOperation {
  const {
    method,
    pathKey,
    op,
    baseUrl,
    isSwagger,
    pathParameters,
    doc,
    consumes,
    warnings,
    usedNames,
    location,
    refs
  } = args

  const inheritedParams = normalizeParams(pathParameters, refs)
  const opParams = normalizeParams(op['parameters'], refs)
  const allParams: ParamInfo[] = [
    ...inheritedParams.filter(
      (ip) => !opParams.some((op) => op.name === ip.name && op.in === ip.in)
    ),
    ...opParams
  ]

  const pathParams = allParams.filter((p) => p.in === 'path')
  const substitutedPath = buildUrlWithPathParams(pathKey, pathParams, refs)
  const fullUrl = joinUrl(baseUrl, substitutedPath)

  const headers = paramsToKeyValuePairs(allParams, 'header', refs)
  const params = paramsToKeyValuePairs(allParams, 'query', refs)

  let bodyType: BodyType = 'none'
  let body = ''
  let formFields: KeyValuePair[] = []
  let contentType: string | undefined

  if (isSwagger) {
    const opConsumes = (op['consumes'] as string[] | undefined) ?? consumes
    const b = buildSwaggerBody(allParams, opConsumes, warnings, location, refs)
    if (b.bodyType) {
      bodyType = b.bodyType
      body = b.bodyText ?? ''
      formFields = b.formFields ?? []
      contentType = b.contentType
    }
  } else {
    const b = pickRequestBodyContent(op['requestBody'], warnings, location, refs)
    if (b.bodyType) {
      bodyType = b.bodyType
      body = b.bodyText ?? ''
      formFields = b.formFields ?? []
      contentType = b.contentType
    }
  }

  if (contentType) {
    headers.push({
      id: 'content-type',
      key: 'Content-Type',
      value: contentType,
      enabled: true
    })
  }

  // No User-Agent row: the default is implicit and applied at send time by the
  // sending surface (never written into the generated `.http` file).

  const security = op['security'] ?? doc['security']
  const auth = detectAuthFromSecurity(doc, security, warnings, location, refs)

  const tag = ((op['tags'] as string[] | undefined) ?? [])[0] ?? 'default'
  const folderSegments = sanitizeSegments([tag])

  const opId = op['operationId'] as string | undefined
  const rawName = opId ?? `${method}-${pathKey.replace(/\W+/g, '-')}`
  const desiredName = sanitizeName(rawName, `${method}-op`)

  const folderKey = folderSegments.join('/')
  if (!usedNames.has(folderKey)) usedNames.set(folderKey, new Set())
  const folderUsed = usedNames.get(folderKey)!
  let finalName = desiredName
  if (folderUsed.has(finalName)) {
    let i = 2
    while (folderUsed.has(`${finalName}-${i}`)) i++
    finalName = `${finalName}-${i}`
  }
  folderUsed.add(finalName)

  const headerRecord: Record<string, string> = {}
  for (const h of headers) {
    if (h.enabled && h.key.trim()) headerRecord[h.key] = h.value
  }

  let rawSubtype: RawSubtype = 'json'
  if (bodyType === 'raw' && contentType) {
    const ct = contentType.toLowerCase()
    if (ct.includes('application/json')) rawSubtype = 'json'
    else if (ct.includes('xml')) rawSubtype = 'xml'
    else if (ct.includes('javascript')) rawSubtype = 'javascript'
    else if (ct.includes('text/html') || ct.includes('application/html')) rawSubtype = 'html'
    else if (ct.includes('text/')) rawSubtype = 'text'
  }

  const editorState: RequestEditorState = {
    ...DEFAULT_REQUEST_STATE,
    method: method.toUpperCase(),
    url: fullUrl,
    params,
    headers,
    bodyType,
    rawSubtype,
    body,
    formFields,
    auth
  }

  const request: HttpRequest = {
    method: method.toUpperCase(),
    url: fullUrl,
    headers: headerRecord,
    body: body || undefined,
    formFields: bodyType === 'x-www-form-urlencoded' ? formFields : undefined
  }

  const summary = op['summary'] as string | undefined
  const description = op['description'] as string | undefined
  const comment = summary ?? description

  return {
    id: randomUUID(),
    name: finalName,
    displayName: summary ?? opId ?? `${method.toUpperCase()} ${pathKey}`,
    folderPath: folderSegments,
    request,
    editorState,
    comment
  }
}

export async function importOpenApi(raw: string): Promise<{
  schema: IntermediateSchema
  warnings: SchemaImportWarning[]
}> {
  const warnings: SchemaImportWarning[] = []
  const doc = parseSchemaText(raw)
  // References are resolved on demand, at each point below that reads an
  // object; the document itself is never rewritten.
  const resolver = createRefResolver(doc)

  const isV3 = isOpenAPIv3(doc)
  const isV2 = isSwaggerV2(doc)
  if (!isV3 && !isV2) {
    throw new Error('Not a recognizable OpenAPI/Swagger document')
  }

  const info = (doc['info'] as { title?: string } | undefined) ?? {}
  const title = info.title ?? 'api'
  const baseUrl = isV3 ? getBaseUrlV3(doc) : getBaseUrlV2(doc)
  const consumes = isV2 ? ((doc['consumes'] as string[] | undefined) ?? undefined) : undefined

  const paths = (doc['paths'] as Record<string, unknown> | undefined) ?? {}
  const operations: IntermediateOperation[] = []
  const usedNames = new Map<string, Set<string>>()

  for (const [pathKey, rawPathItem] of Object.entries(paths)) {
    if (!rawPathItem || typeof rawPathItem !== 'object') continue
    // A path item is needed before any of its operations exist, so a broken
    // path-item reference is located by its pointer rather than an operation.
    const pathItem = bindRefs(resolver, pathItemLocation(pathKey)).object(rawPathItem)
    if (!pathItem) continue
    for (const method of HTTP_METHODS) {
      const rawOp = pathItem[method]
      if (!rawOp) continue
      const location = `${method.toUpperCase()} ${pathKey}`
      const refs = bindRefs(resolver, location)
      const op = isReference(rawOp) ? refs.object(rawOp) : (rawOp as AnyDoc)
      if (!op) continue
      try {
        const operation = buildOperation({
          method,
          pathKey,
          op,
          baseUrl,
          isSwagger: isV2,
          pathParameters: pathItem['parameters'],
          doc,
          consumes,
          warnings,
          usedNames,
          location,
          refs
        })
        operations.push(operation)
      } catch (err) {
        warnings.push({
          kind: 'skipped-operation',
          message: (err as Error).message,
          location
        })
      }
    }
  }

  warnings.push(...resolver.warnings())

  return {
    schema: {
      title,
      format: isV3 ? 'openapi' : 'swagger',
      baseUrl,
      operations
    },
    warnings
  }
}
