import { dereference } from '@readme/openapi-parser'
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
import { DEFAULT_REQUEST_STATE, DEFAULT_USER_AGENT } from '@shared/types'
import { sanitizeName, sanitizeSegments } from '../sanitize'
import { generateExampleFromJsonSchema, prettyJson } from '../example-generator'

type AnyDoc = Record<string, unknown>

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

function isOpenAPIv3(doc: AnyDoc): boolean {
  return typeof doc['openapi'] === 'string' && String(doc['openapi']).startsWith('3')
}

function isSwaggerV2(doc: AnyDoc): boolean {
  return doc['swagger'] === '2.0' || doc['swagger'] === 2
}

export function parseSchemaText(raw: string): AnyDoc {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as AnyDoc
  }
  const loaded = yaml.load(trimmed)
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

function normalizeParams(raw: unknown): ParamInfo[] {
  if (!Array.isArray(raw)) return []
  return raw.map((p) => p as ParamInfo).filter((p) => p && p.in && p.name)
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

function buildUrlWithPathParams(url: string, pathParams: ParamInfo[]): string {
  let out = url
  for (const p of pathParams) {
    const placeholder = `{${p.name}}`
    const value =
      p.example !== undefined
        ? String(p.example)
        : examplePrimitive((p.schema?.type as string | undefined) ?? p.type)
    out = out.split(placeholder).join(value)
  }
  return out
}

function paramsToKeyValuePairs(params: ParamInfo[], kind: 'query' | 'header'): KeyValuePair[] {
  return params
    .filter((p) => p.in === kind)
    .map((p) => ({
      id: `${kind}-${p.name}`,
      key: p.name,
      value:
        p.example !== undefined
          ? String(p.example)
          : examplePrimitive((p.schema?.type as string | undefined) ?? p.type),
      enabled: p.required !== false
    }))
}

function pickRequestBodyContent(
  requestBody: unknown,
  warnings: SchemaImportWarning[],
  location: string
): { contentType?: string; bodyText?: string; bodyType?: BodyType; formFields?: KeyValuePair[] } {
  if (!requestBody || typeof requestBody !== 'object') return {}
  const content = (
    requestBody as {
      content?: Record<string, { schema?: Record<string, unknown>; example?: unknown }>
    }
  ).content
  if (!content) return {}

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

  const entry = content[chosen]
  if (chosen === 'application/json') {
    const example = entry.example ?? generateExampleFromJsonSchema(entry.schema as never)
    return {
      contentType: chosen,
      bodyType: 'raw',
      bodyText: prettyJson(example ?? {})
    }
  }
  if (chosen === 'application/x-www-form-urlencoded') {
    const schema = entry.schema as
      { properties?: Record<string, { type?: string; example?: unknown }> } | undefined
    const props = schema?.properties ?? {}
    const formFields: KeyValuePair[] = Object.entries(props).map(([k, v]) => ({
      id: `form-${k}`,
      key: k,
      value: v?.example !== undefined ? String(v.example) : examplePrimitive(v?.type),
      enabled: true
    }))
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
  const example = entry.example ?? generateExampleFromJsonSchema(entry.schema as never)
  const body = typeof example === 'string' ? example : prettyJson(example ?? null)
  return { contentType: chosen, bodyType: 'raw', bodyText: body }
}

function buildSwaggerFormBody(params: ParamInfo[]): KeyValuePair[] {
  return params
    .filter((p) => p.in === 'formData')
    .map((p) => ({
      id: `form-${p.name}`,
      key: p.name,
      value:
        p.example !== undefined
          ? String(p.example)
          : examplePrimitive((p.schema?.type as string | undefined) ?? p.type),
      enabled: p.required !== false
    }))
}

function buildSwaggerBody(
  params: ParamInfo[],
  consumes: string[] | undefined,
  warnings: SchemaImportWarning[],
  location: string
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
      formFields: buildSwaggerFormBody(params)
    }
  }
  if (bodyParam) {
    if (contentType === 'application/json' || contentType === undefined) {
      const example = bodyParam.example ?? generateExampleFromJsonSchema(bodyParam.schema as never)
      return {
        contentType: contentType ?? 'application/json',
        bodyType: 'raw',
        bodyText: prettyJson(example ?? {})
      }
    }
    const example = bodyParam.example ?? generateExampleFromJsonSchema(bodyParam.schema as never)
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
  location: string
): AuthConfig {
  if (!Array.isArray(security) || security.length === 0) return { type: 'none' }
  const firstRequirement = security[0] as Record<string, unknown>
  const schemes =
    (doc['components'] as { securitySchemes?: Record<string, Record<string, unknown>> } | undefined)
      ?.securitySchemes ??
    (doc['securityDefinitions'] as Record<string, Record<string, unknown>> | undefined)
  if (!schemes) return { type: 'none' }
  const [schemeKey] = Object.keys(firstRequirement)
  const scheme = schemes[schemeKey]
  if (!scheme) return { type: 'none' }
  const type = String(scheme['type'])
  const schemeName = (scheme['scheme'] as string | undefined)?.toLowerCase()
  const inLoc = scheme['in'] as string | undefined
  const name = scheme['name'] as string | undefined

  if (type === 'http' && schemeName === 'bearer') return { type: 'bearer', token: '' }
  if (type === 'http' && schemeName === 'basic')
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
  return { type: 'none' }
}

function buildOperation(args: {
  method: string
  pathKey: string
  op: AnyDoc
  baseUrl: string | undefined
  isSwagger: boolean
  inheritedParams: ParamInfo[]
  doc: AnyDoc
  consumes?: string[]
  warnings: SchemaImportWarning[]
  usedNames: Map<string, Set<string>>
}): IntermediateOperation {
  const {
    method,
    pathKey,
    op,
    baseUrl,
    isSwagger,
    inheritedParams,
    doc,
    consumes,
    warnings,
    usedNames
  } = args

  const location = `${method.toUpperCase()} ${pathKey}`
  const opParams = normalizeParams(op['parameters'])
  const allParams: ParamInfo[] = [
    ...inheritedParams.filter(
      (ip) => !opParams.some((op) => op.name === ip.name && op.in === ip.in)
    ),
    ...opParams
  ]

  const pathParams = allParams.filter((p) => p.in === 'path')
  const substitutedPath = buildUrlWithPathParams(pathKey, pathParams)
  const fullUrl = joinUrl(baseUrl, substitutedPath)

  const headers = paramsToKeyValuePairs(allParams, 'header')
  const params = paramsToKeyValuePairs(allParams, 'query')

  let bodyType: BodyType = 'none'
  let body = ''
  let formFields: KeyValuePair[] = []
  let contentType: string | undefined

  if (isSwagger) {
    const opConsumes = (op['consumes'] as string[] | undefined) ?? consumes
    const b = buildSwaggerBody(allParams, opConsumes, warnings, location)
    if (b.bodyType) {
      bodyType = b.bodyType
      body = b.bodyText ?? ''
      formFields = b.formFields ?? []
      contentType = b.contentType
    }
  } else {
    const b = pickRequestBodyContent(op['requestBody'], warnings, location)
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

  // User-Agent as per DEFAULT_REQUEST_STATE
  headers.unshift({
    id: 'h-ua-default',
    key: 'User-Agent',
    value: DEFAULT_USER_AGENT,
    enabled: true
  })

  const security = op['security'] ?? doc['security']
  const auth = detectAuthFromSecurity(doc, security, warnings, location)

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
  const rawDoc = parseSchemaText(raw)

  let doc: AnyDoc
  try {
    doc = (await dereference(rawDoc as never)) as unknown as AnyDoc
  } catch (err) {
    warnings.push({
      kind: 'other',
      message: `dereference failed: ${(err as Error).message}. Continuing with raw doc.`
    })
    doc = rawDoc
  }

  const isV3 = isOpenAPIv3(doc)
  const isV2 = isSwaggerV2(doc)
  if (!isV3 && !isV2) {
    throw new Error('Not a recognizable OpenAPI/Swagger document')
  }

  const info = (doc['info'] as { title?: string } | undefined) ?? {}
  const title = info.title ?? 'api'
  const baseUrl = isV3 ? getBaseUrlV3(doc) : getBaseUrlV2(doc)
  const consumes = isV2 ? ((doc['consumes'] as string[] | undefined) ?? undefined) : undefined

  const paths = (doc['paths'] as Record<string, AnyDoc> | undefined) ?? {}
  const operations: IntermediateOperation[] = []
  const usedNames = new Map<string, Set<string>>()

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue
    const inheritedParams = normalizeParams(pathItem['parameters'])
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as AnyDoc | undefined
      if (!op) continue
      try {
        const operation = buildOperation({
          method,
          pathKey,
          op,
          baseUrl,
          isSwagger: isV2,
          inheritedParams,
          doc,
          consumes,
          warnings,
          usedNames
        })
        operations.push(operation)
      } catch (err) {
        warnings.push({
          kind: 'skipped-operation',
          message: (err as Error).message,
          location: `${method.toUpperCase()} ${pathKey}`
        })
      }
    }
  }

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
