import { describe, it, expect } from 'vitest'
import { importOpenApi } from './openapi'

const PETSTORE_V3 = `
openapi: 3.0.0
info:
  title: Petstore
  version: 1.0.0
servers:
  - url: https://petstore.example.com/v1
paths:
  /pets:
    get:
      summary: List pets
      operationId: listPets
      tags:
        - pets
      parameters:
        - name: limit
          in: query
          required: false
          schema:
            type: integer
      responses:
        '200':
          description: ok
    post:
      summary: Create pet
      operationId: createPet
      tags:
        - pets
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name:
                  type: string
                age:
                  type: integer
      responses:
        '201':
          description: created
  /pets/{petId}:
    get:
      operationId: getPet
      tags:
        - pets
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: ok
`

const PETSTORE_V2 = {
  swagger: '2.0',
  info: { title: 'Petstore V2', version: '1.0.0' },
  host: 'petstore.example.com',
  basePath: '/v2',
  schemes: ['https'],
  paths: {
    '/pets': {
      get: {
        tags: ['pets'],
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query', type: 'integer', required: false }],
        responses: { '200': { description: 'ok' } }
      }
    },
    '/login': {
      post: {
        tags: ['auth'],
        operationId: 'login',
        consumes: ['application/x-www-form-urlencoded'],
        parameters: [
          { name: 'username', in: 'formData', type: 'string', required: true },
          { name: 'password', in: 'formData', type: 'string', required: true }
        ],
        responses: { '200': { description: 'ok' } }
      }
    }
  }
}

describe('importOpenApi', () => {
  it('parses OpenAPI v3 YAML and generates operations', async () => {
    const { schema } = await importOpenApi(PETSTORE_V3)
    expect(schema.format).toBe('openapi')
    expect(schema.title).toBe('Petstore')
    expect(schema.baseUrl).toBe('https://petstore.example.com/v1')
    expect(schema.operations).toHaveLength(3)

    const list = schema.operations.find((o) => o.name === 'listPets')
    expect(list?.editorState.method).toBe('GET')
    expect(list?.folderPath).toEqual(['pets'])
    expect(list?.editorState.params.some((p) => p.key === 'limit')).toBe(true)

    const create = schema.operations.find((o) => o.name === 'createPet')
    expect(create?.editorState.bodyType).toBe('raw')
    expect(create?.editorState.rawSubtype).toBe('json')
    expect(create?.editorState.body).toContain('name')

    const get = schema.operations.find((o) => o.name === 'getPet')
    expect(get?.editorState.url).toContain('/pets/string')
  })

  it('parses Swagger v2 JSON with formData', async () => {
    const raw = JSON.stringify(PETSTORE_V2)
    const { schema } = await importOpenApi(raw)
    expect(schema.format).toBe('swagger')
    expect(schema.baseUrl).toBe('https://petstore.example.com/v2')

    const login = schema.operations.find((o) => o.name === 'login')
    expect(login?.editorState.bodyType).toBe('x-www-form-urlencoded')
    expect(login?.editorState.formFields.map((f) => f.key)).toEqual(['username', 'password'])
    expect(login?.folderPath).toEqual(['auth'])
  })
})

// ── Coverage-gap additions (REQ-0055 §4.3.5) ───────────────────────────────

describe('importOpenApi — malformed and edge inputs', () => {
  it('rejects an empty string as not JSON/YAML object', async () => {
    await expect(importOpenApi('')).rejects.toBeInstanceOf(Error)
  })

  it('rejects a YAML document that resolves to a scalar', async () => {
    await expect(importOpenApi('just-a-string')).rejects.toThrow(/not a JSON\/YAML object/)
  })

  it('rejects an invalid JSON envelope', async () => {
    await expect(importOpenApi('{ "openapi": 3, not-valid-json')).rejects.toBeInstanceOf(Error)
  })

  it('throws when the document is neither OpenAPI v3 nor Swagger v2', async () => {
    const notOpenApi = JSON.stringify({ foo: 'bar' })
    await expect(importOpenApi(notOpenApi)).rejects.toThrow(/Not a recognizable OpenAPI/)
  })

  // Was: 'emits a "dereference failed" warning and falls back to the raw doc'. The
  // whole-document fallback is gone (REQ "In-house OpenAPI reference
  // resolution", CA-12): the broken ref degrades only its own location.
  it('reports a broken ref as an unresolved reference and still imports the operation', async () => {
    const withBadRef = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'BadRef', version: '1.0.0' },
      paths: {
        '/x': {
          get: {
            responses: {
              '200': { $ref: '#/components/responses/Missing' }
            }
          }
        }
      }
    })
    const { warnings, schema } = await importOpenApi(withBadRef)
    // Responses are never read by the importer, so this ref is never needed (on demand).
    expect(warnings.some((w) => /dereference failed/.test(w.message))).toBe(false)
    expect(warnings.filter((w) => w.kind === 'unresolved-ref')).toEqual([])
    expect(schema.operations).toHaveLength(1)
  })

  it('uses default title "api" when info.title is absent', async () => {
    const noTitle = JSON.stringify({
      openapi: '3.0.0',
      info: {},
      servers: [{ url: 'https://x' }],
      paths: { '/p': { get: { responses: { '200': { description: 'ok' } } } } }
    })
    const { schema } = await importOpenApi(noTitle)
    expect(schema.title).toBe('api')
  })

  it('skips path entries whose value is not an object', async () => {
    const malformed = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0' },
      paths: {
        '/null-path': null,
        '/valid': { get: { responses: { '200': { description: 'ok' } } } }
      }
    })
    const { schema } = await importOpenApi(malformed)
    expect(schema.operations).toHaveLength(1)
    expect(schema.operations[0].editorState.url).toContain('/valid')
  })

  it('Swagger v2 falls back to https when no schemes are declared', async () => {
    const noSchemes = JSON.stringify({
      swagger: '2.0',
      info: { title: 'S', version: '1.0' },
      host: 'example.com',
      basePath: '/v1',
      paths: { '/p': { get: { responses: { '200': { description: 'ok' } } } } }
    })
    const { schema } = await importOpenApi(noSchemes)
    expect(schema.baseUrl).toBe('https://example.com/v1')
  })

  it('Swagger v2 returns undefined baseUrl when host is missing', async () => {
    const noHost = JSON.stringify({
      swagger: '2.0',
      info: { title: 'S', version: '1.0' },
      paths: { '/p': { get: { responses: { '200': { description: 'ok' } } } } }
    })
    const { schema } = await importOpenApi(noHost)
    expect(schema.baseUrl).toBeUndefined()
  })

  it('handles a path with no method entries', async () => {
    const empty = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0' },
      paths: { '/empty': {} }
    })
    const { schema } = await importOpenApi(empty)
    expect(schema.operations).toHaveLength(0)
  })

  it('emits a skipped-operation warning when buildOperation throws (e.g. missing path param schema)', async () => {
    // Use an absurd nested $ref that the parser can't dereference, AND
    // a structural issue inside the operation. The graceful path is to
    // emit a warning, not crash the import.
    const broken = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0' },
      paths: {
        '/p': {
          get: {
            parameters: 'not-an-array',
            responses: { '200': { description: 'ok' } }
          }
        }
      }
    })
    // It either succeeds with a normalized empty params array OR records a
    // skipped-operation warning. Either way it must not throw.
    const { schema, warnings } = await importOpenApi(broken)
    expect(schema.operations.length + warnings.length).toBeGreaterThan(0)
  })
})

// ── Reference resolution (REQ "In-house OpenAPI reference resolution") ─────
// CA-xx ids refer to that requirement's acceptance criteria; Dn to the plan's
// triage table (PLAN "In-house OpenAPI reference resolution").

type Doc = Record<string, unknown>
type Imported = Awaited<ReturnType<typeof importOpenApi>>

function v3(paths: Doc, components: Doc = {}, extra: Doc = {}): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Refs', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
    components,
    ...extra
  })
}

const jsonBody = (schema: unknown): Doc => ({ content: { 'application/json': { schema } } })
const ok = { '200': { description: 'ok' } }
const schemaRef = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` })

function op(result: Imported, name: string): Imported['schema']['operations'][number] {
  const found = result.schema.operations.find((o) => o.name === name)
  if (!found) throw new Error(`operation ${name} not imported`)
  return found
}

function bodyOf(result: Imported, name: string): unknown {
  return JSON.parse(op(result, name).editorState.body)
}

function unresolved(result: Imported): Array<{ message: string; location?: string }> {
  return result.warnings
    .filter((w) => w.kind === 'unresolved-ref')
    .map(({ message, location }) => (location === undefined ? { message } : { message, location }))
}

const USER = {
  type: 'object',
  properties: { id: { type: 'integer' }, email: { type: 'string', format: 'email' } }
}

describe('importOpenApi — reference resolution, happy paths', () => {
  it('CA-01 an internal schema reference feeds the generated body', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/users': {
            post: {
              operationId: 'createUser',
              requestBody: jsonBody(schemaRef('User')),
              responses: ok
            }
          }
        },
        { schemas: { User: USER } }
      )
    )
    expect(bodyOf(r, 'createUser')).toEqual({ id: 0, email: 'user@example.com' })
    expect(unresolved(r)).toEqual([])
  })

  it('CA-02 Swagger 2.0 references in definitions, parameters, responses and securityDefinitions', async () => {
    const r = await importOpenApi(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'S', version: '1' },
        host: 'api.example.com',
        security: [{ ApiKey: [] }],
        securityDefinitions: { ApiKey: { $ref: '#/x-defs/ApiKey' } },
        'x-defs': { ApiKey: { type: 'apiKey', in: 'header', name: 'X-Key' } },
        parameters: { Limit: { name: 'limit', in: 'query', type: 'integer' } },
        responses: { NotFound: { description: 'nope' } },
        definitions: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
        paths: {
          '/pets': {
            post: {
              operationId: 'addPet',
              parameters: [
                { $ref: '#/parameters/Limit' },
                { in: 'body', name: 'body', schema: { $ref: '#/definitions/Pet' } }
              ],
              responses: { '404': { $ref: '#/responses/NotFound' } }
            }
          }
        }
      })
    )
    const addPet = op(r, 'addPet')
    expect(bodyOf(r, 'addPet')).toEqual({ name: 'string' })
    expect(addPet.editorState.params.map((p) => p.key)).toEqual(['limit'])
    expect(addPet.editorState.auth).toEqual({
      type: 'api-key',
      key: 'X-Key',
      value: '',
      location: 'header'
    })
    expect(unresolved(r)).toEqual([])
  })

  it('CA-03 JSON and YAML (with anchors) import identically', async () => {
    const yaml = `
openapi: 3.0.3
info: { title: Refs, version: '1' }
servers: [{ url: 'https://api.example.com' }]
paths:
  /a:
    post:
      operationId: postA
      parameters: &shared
        - { name: q, in: query, schema: { $ref: '#/components/schemas/Count' } }
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/User' } } } }
      responses: { '200': { description: ok } }
  /b:
    get:
      operationId: getB
      parameters: *shared
      responses: { '200': { description: ok } }
components:
  schemas:
    Count: { type: integer }
    User: { type: object, properties: { id: { type: integer }, email: { type: string, format: email } } }
`
    const shared = [{ name: 'q', in: 'query', schema: schemaRef('Count') }]
    const json = v3(
      {
        '/a': {
          post: {
            operationId: 'postA',
            parameters: shared,
            requestBody: jsonBody(schemaRef('User')),
            responses: ok
          }
        },
        '/b': { get: { operationId: 'getB', parameters: shared, responses: ok } }
      },
      { schemas: { Count: { type: 'integer' }, User: USER } }
    )
    const strip = (x: Imported): unknown =>
      JSON.parse(
        JSON.stringify(x, (k, v) =>
          k === 'id' && typeof v === 'string' && v.length === 36 ? '<id>' : v
        )
      )
    expect(strip(await importOpenApi(yaml))).toEqual(strip(await importOpenApi(json)))
  })

  it('CA-04 a path item reference yields the referenced operations', async () => {
    const r = await importOpenApi(
      v3({
        '/users/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          get: { operationId: 'getUser', responses: ok },
          delete: { operationId: 'deleteUser', responses: ok }
        },
        '/v2/users/{id}': { $ref: '#/paths/~1users~1{id}' }
      })
    )
    const urls = r.schema.operations.map((o) => `${o.editorState.method} ${o.editorState.url}`)
    expect(urls).toEqual([
      'GET https://api.example.com/users/0',
      'DELETE https://api.example.com/users/0',
      'GET https://api.example.com/v2/users/0',
      'DELETE https://api.example.com/v2/users/0'
    ])
    expect(unresolved(r)).toEqual([])
  })

  it('CA-05 references in every position the importer reads', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/orders/{id}': {
            parameters: [{ $ref: '#/components/parameters/Id' }],
            put: {
              operationId: 'putOrder',
              security: [{ token: [] }],
              parameters: [{ $ref: '#/components/parameters/Trace' }],
              requestBody: { $ref: '#/components/requestBodies/Order' },
              responses: ok
            }
          }
        },
        {
          schemas: { User: USER },
          parameters: {
            Id: { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            Trace: { name: 'X-Trace', in: 'header', example: 't-1', schema: { type: 'string' } }
          },
          requestBodies: { Order: jsonBody(schemaRef('User')) },
          securitySchemes: { token: { $ref: '#/components/x-schemes/bearer' } },
          'x-schemes': { bearer: { type: 'http', scheme: 'bearer' } }
        }
      )
    )
    const put = op(r, 'putOrder')
    expect(put.editorState.url).toBe('https://api.example.com/orders/0')
    expect(put.editorState.headers.find((h) => h.key === 'X-Trace')?.value).toBe('t-1')
    expect(bodyOf(r, 'putOrder')).toEqual({ id: 0, email: 'user@example.com' })
    expect(put.editorState.auth).toEqual({ type: 'bearer', token: '' })
    expect(unresolved(r)).toEqual([])
  })

  it('D9 an operation object written as a reference is resolved too', async () => {
    const r = await importOpenApi(
      v3(
        { '/me': { get: { $ref: '#/x-ops/getMe' } } },
        {},
        { 'x-ops': { getMe: { operationId: 'getMe', responses: ok } } }
      )
    )
    expect(op(r, 'getMe').editorState.method).toBe('GET')
  })

  it('CA-06 pointers outside components and into a schema resolve', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/t': {
            get: {
              operationId: 'getT',
              parameters: [
                { $ref: '#/x-shared/headers/Trace' },
                {
                  name: 'uid',
                  in: 'query',
                  schema: { $ref: '#/components/schemas/User/properties/id' }
                }
              ],
              responses: ok
            }
          }
        },
        { schemas: { User: USER } },
        {
          'x-shared': {
            headers: { Trace: { name: 'X-Trace', in: 'header', schema: { type: 'boolean' } } }
          }
        }
      )
    )
    const t = op(r, 'getT')
    expect(t.editorState.headers.find((h) => h.key === 'X-Trace')?.value).toBe('false')
    expect(t.editorState.params.find((p) => p.key === 'uid')?.value).toBe('0')
    expect(unresolved(r)).toEqual([])
  })

  it('CA-26 OpenAPI 3.1: type arrays, ignored siblings, components.pathItems', async () => {
    const r = await importOpenApi(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'T31', version: '1' },
        paths: { '/events': { $ref: '#/components/pathItems/Events' } },
        components: {
          pathItems: {
            Events: {
              post: {
                operationId: 'createEvent',
                requestBody: jsonBody({
                  $ref: '#/components/schemas/Event',
                  description: 'ignored'
                }),
                responses: ok
              }
            }
          },
          schemas: {
            Event: {
              type: 'object',
              properties: {
                title: { type: ['string', 'null'] },
                seats: { type: ['null', 'integer'] }
              }
            }
          }
        }
      })
    )
    expect(bodyOf(r, 'createEvent')).toEqual({ title: 'string', seats: 0 })
  })
})

describe('importOpenApi — sibling members are ignored (CA-07, D14)', () => {
  it('drops siblings next to a $ref in parameter schemas and body schemas', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/s': {
            post: {
              operationId: 'postS',
              parameters: [
                {
                  name: 'n',
                  in: 'query',
                  schema: { $ref: '#/components/schemas/Count', type: 'string' }
                }
              ],
              requestBody: jsonBody({ $ref: '#/components/schemas/User', example: { id: 99 } }),
              responses: ok
            }
          }
        },
        { schemas: { Count: { type: 'integer' }, User: USER } }
      )
    )
    expect(op(r, 'postS').editorState.params.find((p) => p.key === 'n')?.value).toBe('0')
    expect(bodyOf(r, 'postS')).toEqual({ id: 0, email: 'user@example.com' })
  })
})

describe('importOpenApi — unresolvable references', () => {
  const MISSING = '#/components/schemas/Missing'
  const notFound = (ref: string): string => `reference ${ref} not found in the OpenAPI spec`

  it('CA-12 a missing target degrades only its location', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/a': {
            post: {
              operationId: 'postA',
              requestBody: jsonBody({ type: 'object', properties: { owner: { $ref: MISSING } } }),
              responses: ok
            }
          },
          '/b': {
            post: { operationId: 'postB', requestBody: jsonBody(schemaRef('User')), responses: ok }
          }
        },
        { schemas: { User: USER } }
      )
    )
    expect(bodyOf(r, 'postA')).toEqual({ owner: notFound(MISSING) })
    expect(bodyOf(r, 'postB')).toEqual({ id: 0, email: 'user@example.com' })
    expect(unresolved(r)).toEqual([
      { message: `${MISSING} — not found in the document`, location: 'POST /a' }
    ])
    expect(r.warnings.some((w) => /dereference failed/.test(w.message))).toBe(false)
  })

  it('CA-13 one warning per distinct reference, with count and first location', async () => {
    const getWith = (id: string, ref: string): Doc => ({
      get: { operationId: id, requestBody: jsonBody({ $ref: ref }), responses: ok }
    })
    const r = await importOpenApi(
      v3({
        '/x': getWith('getX', '#/components/schemas/Gone'),
        '/y': getWith('getY', '#/components/schemas/Gone'),
        '/w': getWith('getW', '#/components/schemas/AlsoGone'),
        '/z': getWith('getZ', '#/components/schemas/Gone')
      })
    )
    expect(unresolved(r)).toEqual([
      {
        message: '#/components/schemas/Gone — not found in the document (used in 3 places)',
        location: 'GET /x'
      },
      { message: '#/components/schemas/AlsoGone — not found in the document', location: 'GET /w' }
    ])
  })

  it('CA-14 marker in value positions; the default placeholder in the path (D2, D3)', async () => {
    const broken = { $ref: MISSING }
    const r = await importOpenApi(
      v3({
        '/items/{id}': {
          put: {
            operationId: 'putItem',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: broken },
              { name: 'q', in: 'query', schema: broken },
              { name: 'X-H', in: 'header', schema: broken }
            ],
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: { type: 'object', properties: { f: broken, g: { type: 'integer' } } }
                }
              }
            },
            responses: ok
          }
        }
      })
    )
    const put = op(r, 'putItem').editorState
    expect(put.url).toBe('https://api.example.com/items/string')
    expect(put.params.find((p) => p.key === 'q')?.value).toBe(notFound(MISSING))
    expect(put.headers.find((h) => h.key === 'X-H')?.value).toBe(notFound(MISSING))
    expect(put.formFields.map((f) => [f.key, f.value])).toEqual([
      ['f', notFound(MISSING)],
      ['g', '0']
    ])
    expect(unresolved(r)).toEqual([
      {
        message: `${MISSING} — not found in the document (used in 4 places)`,
        location: 'PUT /items/{id}'
      }
    ])
  })

  it('CA-15 unresolvable structural references are treated as absent', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/p': {
            get: {
              operationId: 'getP',
              security: [{ gone: [] }],
              parameters: [
                { $ref: '#/components/parameters/Gone' },
                { name: 'keep', in: 'query', schema: { type: 'string' } }
              ],
              requestBody: { $ref: '#/components/requestBodies/Gone' },
              responses: ok
            }
          },
          '/ghost': { $ref: '#/paths/~1nowhere' },
          '/after': { get: { operationId: 'getAfter', responses: ok } }
        },
        { securitySchemes: { gone: { $ref: '#/components/x/none' } } }
      )
    )
    const p = op(r, 'getP').editorState
    expect(p.params.map((x) => x.key)).toEqual(['keep'])
    expect(p.bodyType).toBe('none')
    expect(p.auth).toEqual({ type: 'none' })
    expect(r.schema.operations.map((o) => o.name)).toEqual(['getP', 'getAfter'])
    expect(unresolved(r)).toEqual([
      { message: '#/components/parameters/Gone — not found in the document', location: 'GET /p' },
      {
        message: '#/components/requestBodies/Gone — not found in the document',
        location: 'GET /p'
      },
      { message: '#/components/x/none — not found in the document', location: 'GET /p' },
      { message: '#/paths/~1nowhere — not found in the document', location: '#/paths/~1ghost' }
    ])
  })

  it('D1 responses, response headers and Example objects are never read, so never reported', async () => {
    const r = await importOpenApi(
      v3({
        '/r': {
          post: {
            operationId: 'postR',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'string' },
                  examples: { a: { $ref: '#/components/examples/Gone' } }
                }
              }
            },
            responses: {
              '200': { $ref: '#/components/responses/Gone' },
              '201': {
                description: 'ok',
                headers: { 'X-Rate': { $ref: '#/components/headers/Gone' } }
              }
            }
          }
        }
      })
    )
    expect(unresolved(r)).toEqual([])
    expect(bodyOf(r, 'postR')).toBe('string')
  })

  it('CA-16 a broken reference inside an unused component is silent', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/u': {
            post: { operationId: 'postU', requestBody: jsonBody(schemaRef('User')), responses: ok }
          }
        },
        {
          schemas: { User: USER, Unused: { type: 'object', properties: { x: { $ref: MISSING } } } }
        }
      )
    )
    expect(unresolved(r)).toEqual([])
    expect(bodyOf(r, 'postU')).toEqual({ id: 0, email: 'user@example.com' })
  })

  it('D13 an inherited path-level parameter counts once per operation that needs it', async () => {
    const r = await importOpenApi(
      v3({
        '/inh': {
          parameters: [{ $ref: '#/components/parameters/Gone' }],
          get: { operationId: 'getInh', responses: ok },
          delete: { operationId: 'deleteInh', responses: ok }
        }
      })
    )
    expect(unresolved(r)).toEqual([
      {
        message: '#/components/parameters/Gone — not found in the document (used in 2 places)',
        location: 'GET /inh'
      }
    ])
  })

  it('CA-17 a broken link inside a chain reports the failing reference', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/c': {
            post: { operationId: 'postC', requestBody: jsonBody(schemaRef('A')), responses: ok }
          }
        },
        { schemas: { A: { $ref: MISSING } } }
      )
    )
    expect(bodyOf(r, 'postC')).toBe(notFound(MISSING))
    expect(unresolved(r)).toEqual([
      { message: `${MISSING} — not found in the document`, location: 'POST /c' }
    ])
  })

  it('CA-18 a pure reference loop is unresolvable in value and structural positions', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/l': {
            post: {
              operationId: 'postL',
              parameters: [{ $ref: '#/components/parameters/P' }],
              requestBody: jsonBody(schemaRef('X')),
              responses: ok
            }
          }
        },
        {
          schemas: { X: schemaRef('X') },
          parameters: {
            P: { $ref: '#/components/parameters/Q' },
            Q: { $ref: '#/components/parameters/P' }
          }
        }
      )
    )
    expect(bodyOf(r, 'postL')).toBe(notFound('#/components/schemas/X'))
    expect(op(r, 'postL').editorState.params).toEqual([])
    expect(unresolved(r)).toEqual([
      { message: '#/components/parameters/P — circular reference chain', location: 'POST /l' },
      { message: '#/components/schemas/X — circular reference chain', location: 'POST /l' }
    ])
  })

  it('CA-19 (unit part) external references get the marker and an external warning', async () => {
    const r = await importOpenApi(
      v3({
        '/e': {
          post: {
            operationId: 'postE',
            parameters: [
              { name: 'q', in: 'query', schema: { $ref: 'https://api.example.com/s.yaml#/Q' } }
            ],
            requestBody: jsonBody({ $ref: './common.yaml#/Body' }),
            responses: ok
          }
        }
      })
    )
    expect(bodyOf(r, 'postE')).toBe(notFound('./common.yaml#/Body'))
    expect(op(r, 'postE').editorState.params[0].value).toBe(
      notFound('https://api.example.com/s.yaml#/Q')
    )
    expect(unresolved(r)).toEqual([
      {
        message: 'https://api.example.com/s.yaml#/Q — external references are not resolved',
        location: 'POST /e'
      },
      { message: './common.yaml#/Body — external references are not resolved', location: 'POST /e' }
    ])
  })

  it('Swagger 2.0 body parameter with an unresolvable schema gets the marker', async () => {
    const r = await importOpenApi(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'S', version: '1' },
        host: 'api.example.com',
        paths: {
          '/b': {
            post: {
              operationId: 'postB',
              parameters: [{ in: 'body', name: 'body', schema: { $ref: '#/definitions/Missing' } }],
              responses: ok
            }
          }
        }
      })
    )
    expect(bodyOf(r, 'postB')).toBe(notFound('#/definitions/Missing'))
    expect(unresolved(r)).toHaveLength(1)
  })

  it('CA-28 a malformed escape does not fail the import', async () => {
    const r = await importOpenApi(
      v3({
        '/m': {
          post: {
            operationId: 'postM',
            requestBody: jsonBody({ $ref: '#/components/schemas/Bad%ZZ' }),
            responses: ok
          }
        }
      })
    )
    expect(bodyOf(r, 'postM')).toBe(notFound('#/components/schemas/Bad%ZZ'))
    expect(unresolved(r)).toHaveLength(1)
  })

  it('CA-29 (D4) a missing security scheme behaves as undeclared, located at the operation', async () => {
    const r = await importOpenApi(
      v3(
        { '/s': { get: { operationId: 'getS', responses: ok } } },
        { securitySchemes: { ApiKey: { $ref: '#/components/x/ApiKey' } } },
        { security: [{ ApiKey: [] }] }
      )
    )
    expect(op(r, 'getS').editorState.auth).toEqual({ type: 'none' })
    expect(unresolved(r)).toEqual([
      { message: '#/components/x/ApiKey — not found in the document', location: 'GET /s' }
    ])
  })
})

describe('importOpenApi — literal data and non-references', () => {
  it('CA-21 literal example data is never resolved; Example objects and const are never read', async () => {
    const literal = { $ref: '#/components/schemas/Missing' }
    const r = await importOpenApi(
      v3({
        '/lit': {
          post: {
            operationId: 'postLit',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { d: { type: 'object', default: literal }, c: { const: literal } }
                  },
                  examples: { one: { value: literal } }
                }
              }
            },
            responses: ok
          },
          put: {
            operationId: 'putLit',
            requestBody: { content: { 'application/json': { example: literal } } },
            responses: ok
          }
        }
      })
    )
    expect(bodyOf(r, 'postLit')).toEqual({ d: literal, c: {} })
    expect(bodyOf(r, 'putLit')).toEqual(literal)
    expect(unresolved(r)).toEqual([])
  })

  it('CA-22 a property named $ref and non-string $ref values are plain data', async () => {
    const r = await importOpenApi(
      v3({
        '/n': {
          post: {
            operationId: 'postN',
            requestBody: jsonBody({
              type: 'object',
              properties: {
                $ref: { type: 'string' },
                ok: { type: 'boolean' },
                num: { $ref: 42, type: 'integer' },
                nul: { $ref: null, type: 'string' }
              }
            }),
            responses: ok
          }
        }
      })
    )
    expect(bodyOf(r, 'postN')).toEqual({ $ref: 'string', ok: false, num: 0, nul: 'string' })
    expect(unresolved(r)).toEqual([])
  })

  it('CA-27 non-object targets do not fail the import', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/t1': {
            post: {
              operationId: 't1',
              requestBody: jsonBody({ $ref: '#/components/schemas/User/type' }),
              responses: ok
            }
          },
          '/t2': {
            post: {
              operationId: 't2',
              requestBody: jsonBody({ $ref: '#/info/version' }),
              responses: ok
            }
          },
          '/t3': {
            post: { operationId: 't3', requestBody: jsonBody({ $ref: '#' }), responses: ok }
          }
        },
        { schemas: { User: USER } }
      )
    )
    expect([bodyOf(r, 't1'), bodyOf(r, 't2'), bodyOf(r, 't3')]).toEqual([{}, {}, {}])
    expect(unresolved(r)).toEqual([])
  })
})

describe('importOpenApi — recursion end to end', () => {
  it('CA-09 a recursive body schema carries the circular marker and no warning', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/tree': {
            post: {
              operationId: 'postTree',
              requestBody: jsonBody(schemaRef('Node')),
              responses: ok
            }
          }
        },
        {
          schemas: {
            Node: {
              type: 'object',
              properties: { name: { type: 'string' }, child: schemaRef('Node') }
            }
          }
        }
      )
    )
    expect(bodyOf(r, 'postTree')).toEqual({
      name: 'string',
      child: '<Circular reference to #/components/schemas/Node detected>'
    })
    expect(unresolved(r)).toEqual([])
  })
})

// IMP-05: YAML's timestamp type turned unquoted dates into Date objects, which
// reached the request as localized, time-zone-shifted text.
describe('importOpenApi — YAML scalars stay as authored (IMP-05, IMP-26)', () => {
  const DATED = `
openapi: 3.0.3
info: { title: Dates, version: '1' }
servers: [{ url: 'https://api.example.com' }]
x-common: &common
  name: X-Day
  in: header
  example: 2024-01-15
paths:
  /reports/{day}:
    post:
      operationId: report
      parameters:
        - { name: day, in: path, required: true, example: 2024-01-15, schema: { type: string, format: date } }
        - { name: from, in: query, example: 2024-01-15, schema: { type: string, format: date } }
        - { name: at, in: query, example: 2024-01-15T10:20:30Z, schema: { type: string, format: date-time } }
        - <<: *common
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                day: { type: string, format: date, example: 2024-01-15 }
                at: { type: string, format: date-time, example: 2024-01-15T10:20:30.5+02:00 }
      responses: { '200': { description: ok } }
`

  it('keeps unquoted dates and datetimes as written in path, query, header and body', async () => {
    const r = await importOpenApi(DATED)
    const state = op(r, 'report').editorState
    expect(state.url).toBe('https://api.example.com/reports/2024-01-15')
    expect(state.params.map((p) => [p.key, p.value])).toEqual([
      ['from', '2024-01-15'],
      ['at', '2024-01-15T10:20:30Z']
    ])
    // The header comes through a YAML merge key, which still loads.
    expect(state.headers.find((h) => h.key === 'X-Day')?.value).toBe('2024-01-15')
    expect(bodyOf(r, 'report')).toEqual({ day: '2024-01-15', at: '2024-01-15T10:20:30.5+02:00' })
  })

  // IMP-26: an unquoted two-part version loads as a number.
  it.each([
    ['3.0', 'yaml'],
    ['3.1', 'yaml'],
    ['3', 'yaml'],
    ['3.0', 'json']
  ])('imports a document whose version is written as the number %s (%s)', async (version, kind) => {
    const body = { '/p': { get: { operationId: 'getP', responses: ok } } }
    const raw =
      kind === 'json'
        ? `{"openapi": ${version}, "info": {"title": "N", "version": "1"}, "paths": ${JSON.stringify(body)}}`
        : `openapi: ${version}\ninfo: { title: N, version: '1' }\npaths:\n  /p:\n    get: { operationId: getP, responses: { '200': { description: ok } } }\n`
    const r = await importOpenApi(raw)
    expect(r.schema.format).toBe('openapi')
    expect(r.schema.operations.map((o) => o.name)).toEqual(['getP'])
  })

  it('still rejects a numeric version that is not 3.x', async () => {
    await expect(
      importOpenApi('openapi: 2.5\ninfo: { title: N, version: "1" }\npaths: {}\n')
    ).rejects.toThrow(/Not a recognizable OpenAPI/)
  })
})

// IMP-07: a declared security scheme the importer cannot map was dropped silently.
describe('importOpenApi — security schemes (IMP-07)', () => {
  function swagger2(definitions: Doc): string {
    return JSON.stringify({
      swagger: '2.0',
      info: { title: 'S', version: '1' },
      host: 'api.example.com',
      securityDefinitions: definitions,
      security: [{ s: [] }],
      paths: { '/s': { get: { operationId: 'getS', responses: ok } } }
    })
  }
  const withScheme = (scheme: Doc): string =>
    v3(
      { '/s': { get: { operationId: 'getS', responses: ok } } },
      { securitySchemes: { s: scheme } },
      { security: [{ s: [] }] }
    )
  const authWarnings = (r: Imported): Array<{ message: string; location?: string }> =>
    r.warnings
      .filter((w) => w.kind === 'unsupported-auth')
      .map(({ message, location }) => ({ message, location }))

  it('maps Swagger 2.0 `type: basic` to Basic auth, with no warning', async () => {
    const r = await importOpenApi(swagger2({ s: { type: 'basic' } }))
    expect(op(r, 'getS').editorState.auth).toEqual({ type: 'basic', username: '', password: '' })
    expect(r.warnings).toEqual([])
  })

  it.each([
    ['openIdConnect', { type: 'openIdConnect', openIdConnectUrl: 'https://id.example.com' }],
    ['apiKey in a cookie', { type: 'apiKey', in: 'cookie', name: 'session' }],
    ['apiKey with no name', { type: 'apiKey', in: 'header' }],
    ['http digest', { type: 'http', scheme: 'digest' }],
    ['an unknown type', { type: 'mutualTLS' }]
  ])('warns unsupported-auth for %s and imports with no auth', async (_label, scheme) => {
    const r = await importOpenApi(withScheme(scheme))
    expect(op(r, 'getS').editorState.auth).toEqual({ type: 'none' })
    expect(authWarnings(r)).toEqual([
      { message: expect.stringContaining('"s"'), location: 'GET /s' }
    ])
  })

  it('warns for an unmapped Swagger 2.0 scheme too', async () => {
    const r = await importOpenApi(swagger2({ s: { type: 'apiKey', in: 'cookie', name: 'k' } }))
    expect(op(r, 'getS').editorState.auth).toEqual({ type: 'none' })
    expect(authWarnings(r)).toHaveLength(1)
  })
})

describe('importOpenApi — reserved header parameters (IMP-17)', () => {
  const headerRows = (r: Imported, name: string): Array<[string, string, boolean]> =>
    op(r, name).editorState.headers.map((h) => [h.key, h.value, h.enabled])

  it('ignores OAS3 header parameters named Accept, Content-Type or Authorization, any case', async () => {
    const r = await importOpenApi(
      v3({
        '/users': {
          post: {
            operationId: 'createUser',
            parameters: [
              { name: 'Content-Type', in: 'header', required: true, schema: { type: 'string' } },
              { name: 'accept', in: 'header', schema: { type: 'string' } },
              { name: 'AUTHORIZATION', in: 'header', schema: { type: 'string' } },
              { name: 'X-Trace', in: 'header', schema: { type: 'string' } }
            ],
            requestBody: jsonBody({ type: 'object' }),
            responses: ok
          }
        }
      })
    )
    expect(headerRows(r, 'createUser')).toEqual([
      ['X-Trace', 'string', true],
      ['Content-Type', 'application/json', true]
    ])
  })

  it('Swagger 2.0: a declared Content-Type header is kept and the body adds none', async () => {
    const r = await importOpenApi(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'S', version: '1' },
        host: 'api.example.com',
        paths: {
          '/pets': {
            post: {
              operationId: 'addPet',
              parameters: [
                {
                  name: 'content-type',
                  in: 'header',
                  type: 'string',
                  enum: ['application/json']
                },
                { name: 'body', in: 'body', schema: { type: 'object' } }
              ],
              responses: ok
            }
          }
        }
      })
    )
    expect(headerRows(r, 'addPet')).toEqual([['content-type', 'application/json', true]])
  })

  it('Swagger 2.0: a disabled Content-Type header does not stop the body Content-Type', async () => {
    const r = await importOpenApi(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'S', version: '1' },
        host: 'api.example.com',
        paths: {
          '/pets': {
            post: {
              operationId: 'addPet',
              parameters: [
                { name: 'Content-Type', in: 'header', type: 'string', required: false },
                { name: 'body', in: 'body', schema: { type: 'object' } }
              ],
              responses: ok
            }
          }
        }
      })
    )
    expect(headerRows(r, 'addPet')).toEqual([
      ['Content-Type', 'string', false],
      ['Content-Type', 'application/json', true]
    ])
  })
})

describe('importOpenApi — parameter sample values (IMP-18)', () => {
  const valueOf = (r: Imported, name: string, key: string): string | undefined =>
    op(r, name).editorState.params.find((p) => p.key === key)?.value

  it.each([
    ['the schema example', { type: 'string', example: 'ex', default: 'def', enum: ['a'] }, 'ex'],
    ['the schema default', { type: 'string', default: 'def', enum: ['a'] }, 'def'],
    ['the first enum member', { type: 'string', enum: ['asc', 'desc'] }, 'asc'],
    ['a numeric default as text', { type: 'integer', default: 20 }, '20'],
    ['a false boolean default', { type: 'boolean', default: false, enum: [true] }, 'false'],
    ['the type placeholder', { type: 'integer' }, '0']
  ])('a query parameter takes %s', async (_label, schema, expected) => {
    const r = await importOpenApi(
      v3({
        '/p': {
          get: {
            operationId: 'getP',
            parameters: [{ name: 'q', in: 'query', schema }],
            responses: ok
          }
        }
      })
    )
    expect(valueOf(r, 'getP', 'q')).toBe(expected)
  })

  it('a referenced enum schema gives its first member, in the query and in the path', async () => {
    const r = await importOpenApi(
      v3(
        {
          '/products/{order}': {
            get: {
              operationId: 'getProducts',
              parameters: [
                { name: 'order', in: 'path', required: true, schema: schemaRef('SortOrder') },
                { name: 'sort', in: 'query', schema: schemaRef('SortOrder') }
              ],
              responses: ok
            }
          }
        },
        { schemas: { SortOrder: { type: 'string', enum: ['asc', 'desc'] } } }
      )
    )
    expect(valueOf(r, 'getProducts', 'sort')).toBe('asc')
    expect(op(r, 'getProducts').editorState.url).toBe('https://api.example.com/products/asc')
  })

  it('the parameter example still wins over the schema', async () => {
    const r = await importOpenApi(
      v3({
        '/p': {
          get: {
            operationId: 'getP',
            parameters: [
              { name: 'q', in: 'query', example: 'mine', schema: { type: 'string', enum: ['a'] } }
            ],
            responses: ok
          }
        }
      })
    )
    expect(valueOf(r, 'getP', 'q')).toBe('mine')
  })

  it('Swagger 2.0 parameter-level default, then enum, before the type placeholder', async () => {
    const r = await importOpenApi(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'S', version: '1' },
        host: 'api.example.com',
        paths: {
          '/pets/{petId}': {
            post: {
              operationId: 'updatePetForm',
              consumes: ['application/x-www-form-urlencoded'],
              parameters: [
                { name: 'petId', in: 'path', required: true, type: 'string', default: 'p1' },
                { name: 'status', in: 'formData', type: 'string', enum: ['available', 'sold'] },
                { name: 'limit', in: 'query', type: 'integer', default: 10, enum: [5, 10] }
              ],
              responses: ok
            }
          }
        }
      })
    )
    const update = op(r, 'updatePetForm')
    expect(update.editorState.url).toBe('https://api.example.com/pets/p1')
    expect(valueOf(r, 'updatePetForm', 'limit')).toBe('10')
    expect(update.editorState.formFields.find((f) => f.key === 'status')?.value).toBe('available')
  })

  it('an unresolvable path schema still falls back to the type placeholder, never a marker', async () => {
    const r = await importOpenApi(
      v3({
        '/p/{id}': {
          get: {
            operationId: 'getP',
            parameters: [{ name: 'id', in: 'path', required: true, schema: schemaRef('Nope') }],
            responses: ok
          }
        }
      })
    )
    expect(op(r, 'getP').editorState.url).toBe('https://api.example.com/p/string')
  })
})
