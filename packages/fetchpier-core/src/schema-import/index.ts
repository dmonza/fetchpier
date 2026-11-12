import { promises as fs } from 'fs'
import type {
  SchemaFormat,
  SchemaImportRequest,
  SchemaImportResult,
  SchemaImportWarning,
  IntermediateSchema,
  WorkspaceHttpSettings
} from '@shared/types'
import { sendRequest, type ProxyOption, type TlsOption } from '../requests/client'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { importOpenApi, isOpenApiV3Version } from './importers/openapi'
import { importGraphQL } from './importers/graphql'
import { importWsdl } from './importers/wsdl'
import { importPostman } from './importers/postman'
import { writeSchemaToDisk } from './writer'
import { resolveInsideWorkspace } from '../workspace/safe-path'

// Re-export the individual importers and helpers so consumers (and the future
// CLI) can reach them without deep imports into a single bundled entry.
export { importOpenApi } from './importers/openapi'
export { importGraphQL } from './importers/graphql'
export { importWsdl } from './importers/wsdl'
export { importPostman } from './importers/postman'
export { sanitizeName, sanitizeSegments, uniqueName } from './sanitize'
export { generateExampleFromJsonSchema, prettyJson } from './example-generator'
export { writeSchemaToDisk } from './writer'

export function detectFormat(content: string): SchemaFormat | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('<')) {
    if (/<(\w+:)?definitions\b/i.test(trimmed)) return 'wsdl'
    return null
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown> & {
        data?: Record<string, unknown>
        info?: { schema?: unknown }
      }
      const payload = (parsed.data as Record<string, unknown> | undefined) ?? parsed
      if (payload.__schema) return 'graphql-introspection'
      if (isOpenApiV3Version(payload.openapi)) return 'openapi'
      if (payload.swagger === '2.0' || payload.swagger === 2) return 'swagger'
      const postmanSchema = parsed.info?.schema
      if (typeof postmanSchema === 'string' && /\/collection\/v2\./i.test(postmanSchema)) {
        return 'postman'
      }
    } catch {
      return null
    }
    return null
  }

  if (/\bopenapi\s*:/i.test(trimmed) && /\bpaths\s*:/i.test(trimmed)) return 'openapi'
  if (/\bswagger\s*:\s*["']?2\.0/i.test(trimmed)) return 'swagger'
  if (
    /\btype\s+Query\b/.test(trimmed) ||
    /\btype\s+Mutation\b/.test(trimmed) ||
    /\bschema\s*\{/.test(trimmed)
  ) {
    return 'graphql-sdl'
  }
  return null
}

/**
 * How a URL source reaches the network: the same transport inputs a send takes,
 * supplied by the adapter (the desktop passes the app proxy, the composed TLS
 * material and the workspace's HTTP settings). Absent, the fetch goes direct
 * with the default settings and no extra TLS material.
 */
export interface SchemaFetchTransport {
  proxy?: ProxyOption
  /** Resolved per origin a redirect reaches, as for a send. */
  tls?: TlsOption
  /** `verifySsl` and `httpVersion` apply; redirects are always followed (bounded). */
  settings?: WorkspaceHttpSettings
  userAgent?: string
}

export interface ImportSchemaOptions {
  transport?: SchemaFetchTransport
}

async function fetchSchemaText(rawUrl: string, transport: SchemaFetchTransport): Promise<string> {
  const url = rawUrl.trim()
  let protocol: string | undefined
  try {
    protocol = new URL(url).protocol
  } catch {
    protocol = undefined
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('Schema URL must be an http or https URL')
  }
  // The request client's own path: its dispatcher per origin (proxy, CAs, the
  // client certificate only for the host it was chosen for), its redirect
  // interceptor and relative-Location handling. A schema link is often an alias
  // that redirects, so redirects are followed whatever the workspace says,
  // bounded by the default limit.
  const settings = transport.settings ?? DEFAULT_WORKSPACE_HTTP_SETTINGS
  const response = await sendRequest(
    { method: 'GET', url, headers: {} },
    {
      settings: {
        ...settings,
        followRedirects: true,
        maxRedirects: DEFAULT_WORKSPACE_HTTP_SETTINGS.maxRedirects
      },
      ...(transport.proxy ? { proxy: transport.proxy } : {}),
      ...(transport.tls ? { tls: transport.tls } : {}),
      ...(transport.userAgent ? { userAgent: transport.userAgent } : {})
    }
  )
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch schema: HTTP ${response.status}`)
  }
  return response.body
}

async function loadSourceText(
  source: SchemaImportRequest['source'],
  workspacePath: string,
  transport: SchemaFetchTransport
): Promise<string> {
  if (source.kind === 'text') return source.value
  if (source.kind === 'file') {
    // Confine the file read to the workspace — without this, the renderer (or a
    // saved import preset planted by a malicious workspace) could exfiltrate any
    // user-readable file via the import warnings/result.
    const safePath = resolveInsideWorkspace(workspacePath, source.value)
    return fs.readFile(safePath, 'utf8')
  }
  // url — egress through the request client (REQ-0061 network egress invariant).
  return fetchSchemaText(source.value, transport)
}

async function runImporter(
  format: SchemaFormat,
  raw: string
): Promise<{ schema: IntermediateSchema; warnings: SchemaImportWarning[] }> {
  switch (format) {
    case 'openapi':
    case 'swagger':
      return importOpenApi(raw)
    case 'graphql-sdl':
    case 'graphql-introspection':
      return importGraphQL(raw)
    case 'wsdl':
      return importWsdl(raw)
    case 'postman':
      return importPostman(raw)
  }
}

export type SchemaImportProgressCallback = (
  phase: 'parsing' | 'generating' | 'writing' | 'done',
  current: number,
  total: number,
  message?: string
) => void

export async function importSchema(
  req: SchemaImportRequest,
  workspacePath: string,
  onProgress?: SchemaImportProgressCallback,
  options: ImportSchemaOptions = {}
): Promise<SchemaImportResult> {
  onProgress?.('parsing', 0, 1)
  const raw = await loadSourceText(req.source, workspacePath, options.transport ?? {})

  let effectiveFormat: SchemaFormat
  if (req.format === 'auto') {
    const detected = detectFormat(raw)
    if (!detected) {
      throw new Error('Could not auto-detect schema format')
    }
    effectiveFormat = detected
  } else {
    effectiveFormat = req.format
  }

  onProgress?.('generating', 0, 1)
  const { schema, warnings: parseWarnings } = await runImporter(effectiveFormat, raw)

  const collectionName = req.collectionName?.trim() || schema.title || 'api-schema'

  // targetFolder comes from the caller — confine it to the workspace.
  const safeTargetFolder = resolveInsideWorkspace(workspacePath, req.targetFolder)

  const writeResult = await writeSchemaToDisk(schema, {
    targetFolder: safeTargetFolder,
    collectionName,
    workspacePath,
    conflictStrategy: req.conflictStrategy,
    postman: effectiveFormat === 'postman' ? req.postman : undefined,
    onProgress: (current, total, message) => onProgress?.('writing', current, total, message)
  })

  onProgress?.('done', schema.operations.length, schema.operations.length)

  return {
    collectionPath: writeResult.collectionPath,
    operationsCreated: writeResult.operationsCreated,
    foldersCreated: writeResult.foldersCreated,
    warnings: [...parseWarnings, ...writeResult.warnings],
    detectedFormat: effectiveFormat,
    schemaTitle: schema.title,
    environmentCreated: writeResult.environmentCreated,
    environmentMerged: writeResult.environmentMerged
  }
}
