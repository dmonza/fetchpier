import {
  buildSchema,
  buildClientSchema,
  printSchema,
  GraphQLSchema,
  GraphQLField,
  isObjectType,
  isNonNullType,
  isListType,
  isScalarType,
  isEnumType,
  GraphQLType,
  isInputObjectType,
  isInterfaceType,
  isUnionType,
  GraphQLArgument
} from 'graphql'
import type { IntrospectionQuery } from 'graphql'
import { randomUUID } from 'crypto'
import type {
  IntermediateSchema,
  IntermediateOperation,
  SchemaImportWarning,
  RequestEditorState,
  KeyValuePair,
  HttpRequest
} from '@shared/types'
import { DEFAULT_REQUEST_STATE } from '@shared/types'
import { sanitizeName } from '../sanitize'
import { prettyJson } from '../example-generator'

type OperationKind = 'query' | 'mutation' | 'subscription'

function buildFromRaw(raw: string): GraphQLSchema {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as { data?: IntrospectionQuery } & IntrospectionQuery
    const introspection = (parsed.data ?? parsed) as IntrospectionQuery
    return buildClientSchema(introspection)
  }
  return buildSchema(trimmed)
}

function unwrapType(t: GraphQLType): GraphQLType {
  if (isNonNullType(t) || isListType(t)) return unwrapType(t.ofType)
  return t
}

function sampleForScalar(name: string): unknown {
  switch (name) {
    case 'Int':
    case 'Float':
      return 0
    case 'Boolean':
      return false
    case 'ID':
      return '1'
    case 'String':
    default:
      return 'string'
  }
}

function sampleForType(type: GraphQLType, depth = 0): unknown {
  if (depth > 3) return null
  if (isNonNullType(type)) return sampleForType(type.ofType, depth)
  if (isListType(type)) {
    const inner = sampleForType(type.ofType, depth + 1)
    return inner === null ? [] : [inner]
  }
  const bare = unwrapType(type)
  if (isScalarType(bare)) return sampleForScalar(bare.name)
  if (isEnumType(bare)) {
    const values = bare.getValues()
    return values.length > 0 ? values[0].name : null
  }
  if (isInputObjectType(bare)) {
    const fields = bare.getFields()
    const out: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(fields)) {
      out[name] = sampleForType(field.type, depth + 1)
    }
    return out
  }
  return null
}

function renderTypeRef(type: GraphQLType): string {
  if (isNonNullType(type)) return `${renderTypeRef(type.ofType)}!`
  if (isListType(type)) return `[${renderTypeRef(type.ofType)}]`
  const bare = unwrapType(type)
  if (
    isScalarType(bare) ||
    isEnumType(bare) ||
    isInputObjectType(bare) ||
    isObjectType(bare) ||
    isInterfaceType(bare) ||
    isUnionType(bare)
  ) {
    return bare.name
  }
  return 'Unknown'
}

function renderSelectionSet(type: GraphQLType, depth = 0): string {
  if (depth > 3) return ''
  const bare = unwrapType(type)
  if (isScalarType(bare) || isEnumType(bare)) return ''
  if (isObjectType(bare) || isInterfaceType(bare)) {
    const fields = bare.getFields()
    const entries = Object.values(fields).slice(0, 10)
    const parts: string[] = []
    for (const f of entries) {
      const inner = renderSelectionSet(f.type, depth + 1)
      parts.push(inner ? `${f.name} ${inner}` : f.name)
    }
    if (parts.length === 0) return ''
    return `{\n${parts.map((p) => `  ${p}`).join('\n')}\n}`
  }
  if (isUnionType(bare)) {
    const types = bare.getTypes()
    if (types.length === 0) return ''
    const inner = types
      .slice(0, 2)
      .map((t) => `... on ${t.name} { __typename }`)
      .join('\n')
    return `{\n  __typename\n  ${inner}\n}`
  }
  return ''
}

function renderArgsInSignature(args: readonly GraphQLArgument[]): string {
  if (args.length === 0) return ''
  return `(${args.map((a) => `$${a.name}: ${renderTypeRef(a.type)}`).join(', ')})`
}

function renderArgsInvocation(args: readonly GraphQLArgument[]): string {
  if (args.length === 0) return ''
  return `(${args.map((a) => `${a.name}: $${a.name}`).join(', ')})`
}

function buildVariables(args: readonly GraphQLArgument[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const a of args) vars[a.name] = sampleForType(a.type)
  return vars
}

function operationString(
  kind: OperationKind,
  opName: string,
  field: GraphQLField<unknown, unknown>
): string {
  const args = field.args
  const signature = renderArgsInSignature(args)
  const invocation = renderArgsInvocation(args)
  const selection = renderSelectionSet(field.type)
  const body = selection ? `${field.name}${invocation} ${selection}` : `${field.name}${invocation}`
  return `${kind} ${opName}${signature} {\n  ${body.split('\n').join('\n  ')}\n}\n`
}

function buildOperation(args: {
  kind: OperationKind
  field: GraphQLField<unknown, unknown>
  usedNames: Set<string>
  endpointUrl: string
}): IntermediateOperation {
  const { kind, field, usedNames, endpointUrl } = args
  const opName = field.name.charAt(0).toUpperCase() + field.name.slice(1)
  const queryString = operationString(kind, opName, field)
  const variables = buildVariables(field.args)

  const bodyObj = { query: queryString, variables }
  const bodyText = prettyJson(bodyObj)

  const headers: KeyValuePair[] = [
    { id: 'h-content-type', key: 'Content-Type', value: 'application/json', enabled: true }
  ]

  const editorState: RequestEditorState = {
    ...DEFAULT_REQUEST_STATE,
    method: 'POST',
    url: endpointUrl,
    headers,
    bodyType: 'raw',
    rawSubtype: 'json',
    body: bodyText
  }

  const request: HttpRequest = {
    method: 'POST',
    url: endpointUrl,
    headers: {
      'Content-Type': 'application/json'
    },
    body: bodyText
  }

  const desired = sanitizeName(field.name, `${kind}-op`)
  let finalName = desired
  if (usedNames.has(finalName)) {
    let i = 2
    while (usedNames.has(`${finalName}-${i}`)) i++
    finalName = `${finalName}-${i}`
  }
  usedNames.add(finalName)

  const folder = kind === 'query' ? 'queries' : kind === 'mutation' ? 'mutations' : 'subscriptions'

  return {
    id: randomUUID(),
    name: finalName,
    displayName: field.name,
    folderPath: [folder],
    request,
    editorState,
    comment: field.description ?? undefined
  }
}

export function importGraphQL(
  raw: string,
  endpointUrl = 'https://example.com/graphql'
): {
  schema: IntermediateSchema
  warnings: SchemaImportWarning[]
} {
  const warnings: SchemaImportWarning[] = []
  const gqlSchema = buildFromRaw(raw)
  const looksLikeIntrospection = raw.trim().startsWith('{')
  const format = looksLikeIntrospection ? 'graphql-introspection' : 'graphql-sdl'

  const operations: IntermediateOperation[] = []
  const query = gqlSchema.getQueryType()
  const mutation = gqlSchema.getMutationType()
  const subscription = gqlSchema.getSubscriptionType()

  const usedByFolder = new Map<string, Set<string>>()
  const getUsed = (folder: string): Set<string> => {
    if (!usedByFolder.has(folder)) usedByFolder.set(folder, new Set())
    return usedByFolder.get(folder)!
  }

  const processRoot = (
    kind: OperationKind,
    type: ReturnType<typeof gqlSchema.getQueryType>
  ): void => {
    if (!type) return
    const folder =
      kind === 'query' ? 'queries' : kind === 'mutation' ? 'mutations' : 'subscriptions'
    const used = getUsed(folder)
    const fields = type.getFields()
    for (const field of Object.values(fields)) {
      try {
        operations.push(buildOperation({ kind, field, usedNames: used, endpointUrl }))
      } catch (err) {
        warnings.push({
          kind: 'skipped-operation',
          message: (err as Error).message,
          location: `${kind} ${field.name}`
        })
      }
    }
  }

  processRoot('query', query)
  processRoot('mutation', mutation)
  processRoot('subscription', subscription)

  // Title: derive from description or use generic label
  const title = (gqlSchema.description ?? '').trim() || 'graphql'

  // Ensure the schema is printable (validates the build)
  try {
    printSchema(gqlSchema)
  } catch {
    /* ignore */
  }

  return {
    schema: {
      title,
      format,
      baseUrl: endpointUrl,
      operations
    },
    warnings
  }
}
