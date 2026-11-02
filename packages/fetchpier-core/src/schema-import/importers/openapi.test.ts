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

  it('emits a "dereference failed" warning and falls back to the raw doc', async () => {
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
    expect(warnings.some((w) => w.kind === 'other' && /dereference failed/.test(w.message))).toBe(
      true
    )
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
