/**
 * Integration tests for the schema-import pipeline (`importSchema`): importer →
 * writer → files on disk. Higher-level cases are catalogued in docs/TESTS.md §15;
 * each `describe` names its case ID, and the Given/When/Then lives in the catalog.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsSync, { promises as fs } from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import tls from 'tls'
import { pathToFileURL } from 'url'
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp'
import { detectFormat, importSchema, type ImportSchemaOptions } from './index'
import type { SchemaImportResult } from '@shared/types'

const FIXTURES = path.join(__dirname, '__fixtures__', 'openapi-parity')
const PARITY_DOCS = [
  'oas30-store.json',
  'oas30-catalog.yaml',
  'oas31-events.yaml',
  'swagger2-pets.yaml'
]

let workspace: string

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-schema-import-'))
  await fs.mkdir(path.join(workspace, 'requests'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

async function importText(text: string, collectionName: string): Promise<SchemaImportResult> {
  return importSchema(
    {
      source: { kind: 'text', value: text },
      format: 'auto',
      targetFolder: path.join(workspace, 'requests'),
      collectionName,
      conflictStrategy: 'abort'
    },
    workspace
  )
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(root, child)))
    else out.push(child)
  }
  return out.sort()
}

/** Request ids are random per import; everything else must be byte-stable. */
function normalizeIds(content: string): string {
  return content.replace(/^# @id .*$/gm, '# @id <id>')
}

describe('SCHEMA-002 — OpenAPI import output matches the pre-change reference corpus', () => {
  it.each(PARITY_DOCS)('%s', async (doc) => {
    const text = await fs.readFile(path.join(FIXTURES, doc), 'utf8')
    const result = await importText(text, 'parity')
    const files = await listFiles(result.collectionPath)
    const golden = path.join(FIXTURES, 'golden', doc.replace(/\.(json|yaml)$/, ''))

    const summary = {
      detectedFormat: result.detectedFormat,
      schemaTitle: result.schemaTitle,
      operationsCreated: result.operationsCreated,
      foldersCreated: result.foldersCreated,
      warnings: result.warnings,
      files
    }
    await expect(JSON.stringify(summary, null, 2) + '\n').toMatchFileSnapshot(
      path.join(golden, '_result.json')
    )
    for (const file of files) {
      const content = await fs.readFile(path.join(result.collectionPath, file), 'utf8')
      await expect(normalizeIds(content)).toMatchFileSnapshot(path.join(golden, file))
    }
  })
})

const notFound = (ref: string): string => `reference ${ref} not found in the OpenAPI spec`

/** One POST operation per entry, each with a JSON body schema `{ $ref }`. */
function docWithBodyRefs(refs: Record<string, string>, components: object = {}): string {
  const paths: Record<string, unknown> = {}
  for (const [name, ref] of Object.entries(refs)) {
    paths[`/${name}`] = {
      post: {
        operationId: name,
        requestBody: { content: { 'application/json': { schema: { $ref: ref } } } },
        responses: { '200': { description: 'ok' } }
      }
    }
  }
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'External refs', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
    components
  })
}

async function requestBody(result: SchemaImportResult, name: string): Promise<string> {
  const content = await fs.readFile(
    path.join(result.collectionPath, 'default', `${name}.http`),
    'utf8'
  )
  return content.slice(content.indexOf('\n\n') + 2).trim()
}

const unresolvedMessages = (result: SchemaImportResult): string[] =>
  result.warnings.filter((w) => w.kind === 'unresolved-ref').map((w) => w.message)

describe('SCHEMA-003 — external references never read the filesystem', () => {
  const originalCwd = process.cwd()
  let cwdDir: string

  beforeEach(async () => {
    // A valid `common.yaml` both in the process working directory and next to
    // the imported schema: if anything resolved external refs from disk, the
    // body would carry `fromDisk` instead of the marker.
    const common = 'Ok:\n  type: object\n  properties:\n    fromDisk:\n      type: string\n'
    cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-cwd-'))
    await fs.writeFile(path.join(cwdDir, 'common.yaml'), common)
    await fs.mkdir(path.join(workspace, 'specs'))
    await fs.writeFile(path.join(workspace, 'specs', 'common.yaml'), common)
    process.chdir(cwdDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
    await fs.rm(cwdDir, { recursive: true, force: true })
  })

  it('imports a file-sourced schema without opening any referenced file', async () => {
    const sibling = path.join(workspace, 'specs', 'common.yaml')
    const refs = {
      relative: './common.yaml#/Ok',
      bare: 'common.yaml#/Ok',
      absolute: `${sibling}#/Ok`,
      fileUri: `${pathToFileURL(sibling).href}#/Ok`
    }
    await fs.writeFile(path.join(workspace, 'specs', 'api.json'), docWithBodyRefs(refs))

    const touched: string[] = []
    const watch = (args: unknown[]): void => {
      const target = String(args[0])
      if (target.includes('common.yaml')) touched.push(target)
    }
    for (const name of [
      'readFileSync',
      'readFile',
      'openSync',
      'open',
      'createReadStream',
      'statSync'
    ] as const) {
      const original = fsSync[name] as (...a: unknown[]) => unknown
      vi.spyOn(fsSync, name).mockImplementation(((...a: unknown[]) => {
        watch(a)
        return original.apply(fsSync, a)
      }) as never)
    }
    for (const name of ['readFile', 'open', 'stat'] as const) {
      const original = fsSync.promises[name] as (...a: unknown[]) => unknown
      vi.spyOn(fsSync.promises, name).mockImplementation(((...a: unknown[]) => {
        watch(a)
        return original.apply(fsSync.promises, a)
      }) as never)
    }

    const result = await importSchema(
      {
        source: { kind: 'file', value: path.join(workspace, 'specs', 'api.json') },
        format: 'auto',
        targetFolder: path.join(workspace, 'requests'),
        collectionName: 'ext',
        conflictStrategy: 'abort'
      },
      workspace
    )

    expect(touched).toEqual([])
    for (const [name, ref] of Object.entries(refs)) {
      expect(await requestBody(result, name)).toBe(JSON.stringify(notFound(ref)))
    }
    expect(unresolvedMessages(result)).toEqual(
      Object.values(refs).map((ref) => `${ref} — external references are not resolved`)
    )
  })
})

describe('SCHEMA-004 — external references never reach the network', () => {
  let server: http.Server
  let hits: number

  beforeEach(async () => {
    hits = 0
    server = http.createServer((_req, res) => {
      hits++
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({ Ok: { type: 'object', properties: { fromNetwork: { type: 'string' } } } })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('does not request a reachable URL nor connect to an unreachable host', async () => {
    const { port } = server.address() as net.AddressInfo
    const refs = {
      reachable: `http://127.0.0.1:${port}/common.json#/Ok`,
      unreachable: 'https://unreachable.invalid/common.yaml#/Ok'
    }
    const connect = vi.spyOn(net, 'connect')
    const createConnection = vi.spyOn(net, 'createConnection')
    const tlsConnect = vi.spyOn(tls, 'connect')

    const result = await importSchema(
      {
        source: { kind: 'text', value: docWithBodyRefs(refs) },
        format: 'auto',
        targetFolder: path.join(workspace, 'requests'),
        collectionName: 'net',
        conflictStrategy: 'abort'
      },
      workspace
    )

    expect(hits).toBe(0)
    expect(connect).not.toHaveBeenCalled()
    expect(createConnection).not.toHaveBeenCalled()
    expect(tlsConnect).not.toHaveBeenCalled()
    for (const [name, ref] of Object.entries(refs)) {
      expect(await requestBody(result, name)).toBe(JSON.stringify(notFound(ref)))
    }
    expect(unresolvedMessages(result)).toEqual(
      Object.values(refs).map((ref) => `${ref} — external references are not resolved`)
    )
  })
})

describe('SCHEMA-005 — end-to-end import writes markers and reports warnings', () => {
  it('recursive, missing and external refs degrade only their own locations', async () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Mixed', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/tree': {
          post: {
            operationId: 'postTree',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } }
            },
            responses: { '200': { description: 'ok' } }
          }
        },
        '/owner': {
          post: {
            operationId: 'postOwner',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      pet: { $ref: '#/components/schemas/Missing' },
                      extra: { $ref: './common.yaml#/Extra' },
                      name: { type: 'string' }
                    }
                  }
                }
              }
            },
            responses: { '200': { description: 'ok' } }
          }
        },
        '/plain': {
          get: {
            operationId: 'getPlain',
            parameters: [
              { name: 'q', in: 'query', schema: { $ref: '#/components/schemas/Count' } }
            ],
            responses: { '200': { description: 'ok' } }
          }
        }
      },
      components: {
        schemas: {
          Count: { type: 'integer' },
          Node: {
            type: 'object',
            properties: { label: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } }
          }
        }
      }
    })

    const result = await importText(text, 'mixed')

    expect(result.operationsCreated).toBe(3)
    expect(JSON.parse(await requestBody(result, 'postTree'))).toEqual({
      label: 'string',
      child: '<Circular reference to #/components/schemas/Node detected>'
    })
    expect(JSON.parse(await requestBody(result, 'postOwner'))).toEqual({
      pet: notFound('#/components/schemas/Missing'),
      extra: notFound('./common.yaml#/Extra'),
      name: 'string'
    })
    const plain = await fs.readFile(
      path.join(result.collectionPath, 'default', 'getPlain.http'),
      'utf8'
    )
    expect(plain).toContain('GET https://api.example.com/plain?q=0')
    expect(result.warnings.filter((w) => w.kind === 'unresolved-ref')).toEqual([
      {
        kind: 'unresolved-ref',
        message: '#/components/schemas/Missing — not found in the document',
        location: 'POST /owner'
      },
      {
        kind: 'unresolved-ref',
        message: './common.yaml#/Extra — external references are not resolved',
        location: 'POST /owner'
      }
    ])
  })
})

// IMP-08: a URL import went out on undici's default dispatcher — no redirects,
// no app proxy, no imported CA.
describe('SCHEMA-006 — URL import takes the same network path as a send', () => {
  const DOC = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Remote', version: '1' },
    paths: {
      '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } }
    }
  })

  function importUrl(url: string, options?: ImportSchemaOptions): Promise<SchemaImportResult> {
    return importSchema(
      {
        source: { kind: 'url', value: url },
        format: 'auto',
        targetFolder: path.join(workspace, 'requests'),
        collectionName: 'remote',
        conflictStrategy: 'abort'
      },
      workspace,
      undefined,
      options
    )
  }

  describe('against a local server', () => {
    let server: http.Server
    let origin: string
    let hops: number

    beforeEach(async () => {
      hops = 0
      server = http.createServer((req, res) => {
        if (req.url === '/v1/openapi.json') {
          res.setHeader('content-type', 'application/json')
          res.end(DOC)
        } else if (req.url === '/latest/openapi.json') {
          res.writeHead(302, { location: '/v1/openapi.json' }).end()
        } else if (req.url?.startsWith('/hop/')) {
          // An endless chain of distinct URLs: only the redirect bound stops it.
          hops++
          res.writeHead(302, { location: `/hop/${Number(req.url.slice(5)) + 1}` }).end()
        } else {
          res.writeHead(404).end()
        }
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('follows a redirect with a relative Location', async () => {
      const result = await importUrl(`${origin}/latest/openapi.json`)
      expect(result.operationsCreated).toBe(1)
      expect(result.schemaTitle).toBe('Remote')
    })

    it('stops an endless redirect chain at the bound and fails naming the status', async () => {
      await expect(importUrl(`${origin}/hop/0`)).rejects.toThrow(/^FETCH_FAILED: HTTP 302$/)
      expect(hops).toBe(11)
    })

    it('fails naming a non-2xx status', async () => {
      await expect(importUrl(`${origin}/missing`)).rejects.toThrow(/^FETCH_FAILED: HTTP 404$/)
    })
  })

  it('a connection failure leads with FETCH_FAILED and keeps its cause', async () => {
    // A port that was just free: nothing listens on it.
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    await expect(importUrl(`http://127.0.0.1:${port}/openapi.json`)).rejects.toThrow(
      /^FETCH_FAILED: .+/
    )
  })

  it.each(['file:///etc/hosts', 'ftp://example.com/openapi.json', 'not a url'])(
    'rejects %s without reaching the network or the filesystem',
    async (url) => {
      const connect = vi.spyOn(net, 'connect')
      const readFile = vi.spyOn(fs, 'readFile')
      try {
        await expect(importUrl(url)).rejects.toThrow(/Schema URL must be an http or https URL/)
        expect(connect).not.toHaveBeenCalled()
        expect(readFile).not.toHaveBeenCalled()
      } finally {
        vi.restoreAllMocks()
      }
    }
  )

  describe('with the app transport', () => {
    let ca: { key: string; cert: string }
    let target: Mockttp
    let proxy: Mockttp

    beforeAll(async () => {
      ca = await generateCACertificate()
      target = getLocal({ https: ca })
      await target.start()
      await target.forGet('/openapi.json').thenReply(200, DOC)
      proxy = getLocal()
      await proxy.start()
      await proxy.forGet('http://schemas.invalid/openapi.json').thenReply(200, DOC)
    }, 60_000)

    afterAll(async () => {
      await target.stop()
      await proxy.stop()
    })

    it('goes through the configured proxy', async () => {
      const result = await importUrl('http://schemas.invalid/openapi.json', {
        transport: {
          proxy: { enabled: true, url: proxy.url, username: '', password: '' }
        }
      })
      expect(result.operationsCreated).toBe(1)
    })

    it('trusts the CA bundle it is given, and only then', async () => {
      const url = `https://localhost:${target.port}/openapi.json`
      await expect(importUrl(url)).rejects.toThrow()
      const tlsFor = vi.fn(async () => ({ ca: [Buffer.from(ca.cert)] }))
      const result = await importUrl(url, { transport: { tls: tlsFor } })
      expect(result.operationsCreated).toBe(1)
      expect(tlsFor).toHaveBeenCalledWith(url)
    })
  })
})

// IMP-28: the renderer maps these leading codes to translated messages.
describe('SCHEMA-007 — Import failures lead with a stable code', () => {
  function importAs(text: string, format: 'auto' | 'postman' | 'openapi'): Promise<unknown> {
    return importSchema(
      {
        source: { kind: 'text', value: text },
        format,
        targetFolder: path.join(workspace, 'requests'),
        collectionName: 'c',
        conflictStrategy: 'abort'
      },
      workspace
    )
  }

  it('content no format matches → FORMAT_UNDETECTED', async () => {
    await expect(importAs('just some words', 'auto')).rejects.toThrow(/^FORMAT_UNDETECTED/)
  })

  it.each([
    ['malformed Postman JSON', '{ "info": ', 'postman'],
    ['an OpenAPI document that is not YAML', 'openapi: [unclosed', 'openapi']
  ] as const)('%s → PARSE_FAILED with the parser detail', async (_label, text, format) => {
    await expect(importAs(text, format)).rejects.toThrow(/^PARSE_FAILED: .+/)
  })

  it('an existing collection under the abort strategy → TARGET_EXISTS, no absolute path', async () => {
    await fs.mkdir(path.join(workspace, 'requests', 'c'), { recursive: true })
    const doc = JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} })
    const err = (await importAs(doc, 'auto').catch((e: Error) => e)) as Error
    expect(err.message).toMatch(/^TARGET_EXISTS: .*"c"/)
    expect(err.message).not.toContain(workspace)
  })
})

// IMP-26: a JSON document whose version is a number is detected as OpenAPI.
describe('detectFormat — numeric OpenAPI version', () => {
  it.each([
    ['{"openapi": 3.0, "paths": {}}', 'openapi'],
    ['{"openapi": 3.1, "paths": {}}', 'openapi'],
    ['{"openapi": 2.5, "paths": {}}', null]
  ])('%s → %s', (text, expected) => {
    expect(detectFormat(text)).toBe(expected)
  })
})
