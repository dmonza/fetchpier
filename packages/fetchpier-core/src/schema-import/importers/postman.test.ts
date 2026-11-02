import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { importPostman, isPostmanCollection } from './postman'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, '__fixtures__', 'postman')

const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

describe('isPostmanCollection', () => {
  it('recognizes v2.1 schema URLs', () => {
    expect(
      isPostmanCollection({
        info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }
      })
    ).toBe(true)
  })
  it('recognizes v2.0 schema URLs', () => {
    expect(
      isPostmanCollection({
        info: { schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' }
      })
    ).toBe(true)
  })
  it('rejects OpenAPI-style docs', () => {
    expect(isPostmanCollection({ openapi: '3.0.0' })).toBe(false)
  })
  it('rejects v1.x schemas', () => {
    expect(
      isPostmanCollection({
        info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' }
      })
    ).toBe(false)
  })
})

describe('importPostman — basic collection', () => {
  const { schema, warnings } = importPostman(readFixture('basic.json'))

  it('returns 4 operations matching the file order', () => {
    expect(schema.operations).toHaveLength(4)
    expect(schema.operations.map((o) => o.displayName)).toEqual([
      'Get data',
      'Post data',
      'Update data',
      'Delete data'
    ])
  })

  it('places operations at the collection root (no folder)', () => {
    for (const op of schema.operations) {
      expect(op.folderPath).toEqual([])
    }
  })

  it('preserves method and url with postman variables intact', () => {
    const get = schema.operations[0]
    expect(get.editorState.method).toBe('GET')
    expect(get.editorState.url).toBe('{{base_url}}info')
    // `?id={{id}}` becomes a structured param
    expect(get.editorState.params).toEqual([
      expect.objectContaining({ key: 'id', value: '{{id}}', enabled: true })
    ])
  })

  it('maps raw+json bodies to bodyType=raw + rawSubtype=json', () => {
    const post = schema.operations[1]
    expect(post.editorState.bodyType).toBe('raw')
    expect(post.editorState.rawSubtype).toBe('json')
    expect(post.editorState.body).toContain('"name"')
    const ct = post.editorState.headers.find((h) => h.key.toLowerCase() === 'content-type')
    expect(ct?.value).toBe('application/json')
  })

  it('copies test scripts to postResponseScript with a warning', () => {
    const get = schema.operations[0]
    expect(get.editorState.postResponseScript).toContain('pm.test')
    expect(warnings.some((w) => w.kind === 'script-copied-asis')).toBe(true)
  })

  it('collects collection variables into envVariables', () => {
    expect(schema.envVariables).toEqual({
      base_url: 'https://postman-rest-api-learner.glitch.me/',
      id: '1'
    })
    expect(warnings.some((w) => w.kind === 'variable-collected')).toBe(true)
  })

  it('sets schema title from info.name and format=postman', () => {
    expect(schema.title).toBe('RESTful API Basics #blueprint')
    expect(schema.format).toBe('postman')
  })
})

describe('importPostman — nested collection', () => {
  const { schema, warnings } = importPostman(readFixture('nested.json'))

  it('creates subfolders mirroring postman folder hierarchy', () => {
    const listUsers = schema.operations.find((o) => o.displayName === 'List users')!
    expect(listUsers.folderPath).toEqual(['Users'])

    const upload = schema.operations.find((o) => o.displayName === 'Upload avatar')!
    expect(upload.folderPath).toEqual(['Admin'])
  })

  it('inherits collection-level bearer auth into requests', () => {
    const listUsers = schema.operations.find((o) => o.displayName === 'List users')!
    expect(listUsers.editorState.auth).toEqual({ type: 'bearer', token: 'collection-token' })
  })

  it('noauth at the request level cuts the inheritance chain', () => {
    const login = schema.operations.find((o) => o.displayName === 'Public login')!
    expect(login.editorState.auth).toEqual({ type: 'none' })
  })

  it('converts :userId path param to {{userId}}', () => {
    const getUser = schema.operations.find((o) => o.displayName === 'Get user by id')!
    expect(getUser.editorState.url).toBe('{{base_url}}/users/{{userId}}')
    expect(warnings.some((w) => w.kind === 'path-param-converted')).toBe(true)
  })

  it('maps urlencoded bodies to form fields', () => {
    const login = schema.operations.find((o) => o.displayName === 'Public login')!
    expect(login.editorState.bodyType).toBe('x-www-form-urlencoded')
    expect(login.editorState.formFields.map((f) => f.key)).toEqual(['username', 'password'])
  })

  it('emits binary placeholder warning for formdata file fields', () => {
    const upload = schema.operations.find((o) => o.displayName === 'Upload avatar')!
    expect(upload.editorState.bodyType).toBe('raw')
    expect(upload.editorState.body).toContain('avatar=<binary>')
    expect(warnings.some((w) => w.kind === 'body-binary-placeholder')).toBe(true)
  })

  it('normalizes graphql bodies to json payloads', () => {
    const search = schema.operations.find((o) => o.displayName === 'Search')!
    expect(search.editorState.bodyType).toBe('raw')
    expect(search.editorState.rawSubtype).toBe('json')
    expect(JSON.parse(search.editorState.body)).toEqual({
      query: 'query Ping { ping }',
      variables: { x: 1 }
    })
  })

  it('harvests collection + folder-level variables', () => {
    expect(schema.envVariables).toMatchObject({
      base_url: 'https://api.example.com',
      admin_role: 'superuser'
    })
  })

  it('copies prerequest scripts separately', () => {
    const listUsers = schema.operations.find((o) => o.displayName === 'List users')!
    expect(listUsers.editorState.preRequestScript).toContain('before list')
  })
})

describe('importPostman — v2.0 collection', () => {
  const { schema } = importPostman(readFixture('v2_0.json'))

  it('normalizes string request to {method, url}', () => {
    const ping = schema.operations.find((o) => o.displayName === 'Ping')!
    expect(ping.editorState.method).toBe('GET')
    expect(ping.editorState.url).toBe('https://api.example.com/ping')
  })

  it('handles raw body without language', () => {
    const echo = schema.operations.find((o) => o.displayName === 'Echo')!
    expect(echo.editorState.bodyType).toBe('raw')
    expect(echo.editorState.body).toBe('hello')
  })

  it('maps collection-level basic auth across all requests', () => {
    for (const op of schema.operations) {
      expect(op.editorState.auth).toEqual({
        type: 'basic',
        username: 'alice',
        password: 'wonder'
      })
    }
  })
})

describe('importPostman — error handling', () => {
  it('throws on invalid JSON', () => {
    expect(() => importPostman('not json')).toThrow(/Invalid Postman JSON/)
  })
  it('throws when info.schema is not a postman URL', () => {
    const payload = JSON.stringify({
      info: { name: 'x', schema: 'https://example.com/other.json' },
      item: []
    })
    expect(() => importPostman(payload)).toThrow(/Not a recognizable Postman collection/)
  })
})

// ── Coverage-gap additions (REQ-0055 §4.3.5) ───────────────────────────────

const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

function makeMinimalCollection(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    info: { name: 'minimal', schema: POSTMAN_V21_SCHEMA },
    item: [],
    ...extra
  })
}

describe('importPostman — malformed and edge inputs', () => {
  it('rejects an empty string with the "invalid JSON" path', () => {
    expect(() => importPostman('')).toThrow(/Invalid Postman JSON/)
  })

  it('warns when info.schema points to an unknown postman minor version', () => {
    const payload = JSON.stringify({
      info: {
        name: 'X',
        schema: 'https://schema.getpostman.com/json/collection/v2.5.0/collection.json'
      },
      item: []
    })
    const { warnings } = importPostman(payload)
    expect(
      warnings.some(
        (w) => w.kind === 'unknown-field' && /Unrecognized Postman schema/.test(w.message)
      )
    ).toBe(true)
  })

  it('handles a missing item array gracefully', () => {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA }
    })
    const { schema } = importPostman(payload)
    expect(schema.operations).toEqual([])
  })

  it('tolerates a request given as a bare URL string', () => {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA },
      item: [{ name: 'String request', request: 'https://example.com/ping' }]
    })
    const { schema } = importPostman(payload)
    expect(schema.operations).toHaveLength(1)
    expect(schema.operations[0].editorState.method).toBe('GET')
    expect(schema.operations[0].editorState.url).toBe('https://example.com/ping')
  })

  it('skips items with no request at all', () => {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA },
      item: [{ name: 'Just a folder', item: [] }, { name: 'No request here' }]
    })
    const { schema } = importPostman(payload)
    expect(schema.operations).toHaveLength(0)
  })

  it('converts ":pathParam" Postman style to "{{pathParam}}" with a warning', () => {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA },
      item: [
        {
          name: 'Get user',
          request: {
            method: 'GET',
            header: [],
            url: {
              raw: 'https://api.example.com/users/:userId',
              host: ['api', 'example', 'com'],
              path: ['users', ':userId']
            }
          }
        }
      ]
    })
    const { schema, warnings } = importPostman(payload)
    expect(schema.operations[0].editorState.url).toContain('{{userId}}')
    expect(warnings.some((w) => w.kind === 'path-param-converted')).toBe(true)
  })

  it('ignores Postman saved response examples and reports the count', () => {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA },
      item: [
        {
          name: 'GET',
          request: { method: 'GET', url: 'https://x/y' },
          response: [{ name: 'sample-1' }, { name: 'sample-2' }]
        }
      ]
    })
    const { warnings } = importPostman(payload)
    expect(warnings.some((w) => w.kind === 'response-example-ignored' && /2/.test(w.message))).toBe(
      true
    )
  })

  it('imports a v2.0 collection without warnings about minor version', () => {
    const payload = JSON.stringify({
      info: {
        name: 'X',
        schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json'
      },
      item: [{ name: 'GET', request: { method: 'GET', url: 'https://x/' } }]
    })
    const { warnings, schema } = importPostman(payload)
    expect(schema.operations).toHaveLength(1)
    expect(
      warnings.some(
        (w) => w.kind === 'unknown-field' && /Unrecognized Postman schema/.test(w.message)
      )
    ).toBe(false)
  })

  it('treats empty info object as a valid collection (schema field absent)', () => {
    expect(() => importPostman(makeMinimalCollection({ info: {} as never }))).toThrow(
      /Not a recognizable Postman collection/
    )
  })
})
