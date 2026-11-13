import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { importPostman, isPostmanCollection } from './postman'
import { serializeRequest } from '@shared/lib/http-serializer'
import { splitUrlAndParams } from '@shared/lib/query-string'
import { parseHttpFile } from '../../requests/parser'

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

  // IMP-24: the v2.x schema allows `header` to be a plain string.
  it('parses a string header line by line and keeps the rest of the collection', () => {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA },
      item: [
        {
          name: 'r1',
          request: {
            method: 'GET',
            url: 'https://example.com/a',
            header: 'Accept: application/json\r\nX-Trace: a:b \n\nno colon here\n: empty name\n'
          }
        },
        { name: 'r2', request: { method: 'GET', url: 'https://example.com/b' } }
      ]
    })
    const { schema, warnings } = importPostman(payload)
    expect(schema.operations.map((o) => o.name)).toEqual(['r1', 'r2'])
    expect(
      schema.operations[0].editorState.headers.map((h) => [h.key, h.value, h.enabled])
    ).toEqual([
      ['Accept', 'application/json', true],
      ['X-Trace', 'a:b', true]
    ])
    expect(warnings.filter((w) => w.kind === 'skipped-operation')).toEqual([])
  })

  it.each([
    ['an object', { key: 'A', value: '1' }],
    ['a number', 42]
  ])('a header given as %s is no headers, not a dropped request', (_label, header) => {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA },
      item: [{ name: 'r1', request: { method: 'GET', url: 'https://example.com/a', header } }]
    })
    const { schema } = importPostman(payload)
    expect(schema.operations).toHaveLength(1)
    expect(schema.operations[0].editorState.headers).toEqual([])
  })

  // IMP-25: Postman semantics — a disabled variable is not active; values are text.
  it('skips disabled variables and turns non-string values into text', () => {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA },
      variable: [
        { key: 'off', value: 'x', disabled: true },
        { key: 'port', value: 8080 },
        { key: 'flag', value: false },
        { key: 'nothing', value: null },
        { key: 'missing' },
        { key: 'on', value: 'y', disabled: false }
      ],
      item: [
        {
          name: 'f',
          variable: [{ key: 'off', value: 'from-folder' }],
          item: []
        }
      ]
    })
    const { schema } = importPostman(payload)
    expect(schema.envVariables).toEqual({
      port: '8080',
      flag: 'false',
      nothing: '',
      missing: '',
      on: 'y',
      // A disabled root variable does not claim the key: the enabled folder one is used.
      off: 'from-folder'
    })
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

describe('importPostman — query parameters', () => {
  const RAW =
    'https://api.example.com/search?q=hello%20world&redirect=https%3A%2F%2Fx.example.com&wsdl'

  function importUrl(url: unknown) {
    const payload = JSON.stringify({
      info: { name: 'X', schema: POSTMAN_V21_SCHEMA },
      item: [{ name: 'Search', request: { method: 'GET', url } }]
    })
    return importPostman(payload)
  }

  /** import → serialize → load: the URL the .http file stores, and its params read back. */
  function roundTrip(url: unknown) {
    const { schema } = importUrl(url)
    const state = schema.operations[0].editorState
    const loaded = parseHttpFile(serializeRequest(state)).requests[0].url
    return { state, loaded, reloaded: splitUrlAndParams(loaded).params }
  }

  const structured = {
    raw: RAW,
    protocol: 'https',
    host: ['api', 'example', 'com'],
    path: ['search'],
    query: [
      { key: 'q', value: 'hello%20world' },
      { key: 'redirect', value: 'https%3A%2F%2Fx.example.com' },
      { key: 'wsdl', value: null }
    ]
  }

  it.each([
    ['structured query[]', structured],
    ['raw string URL', RAW]
  ])('decodes each key and value once and keeps a bare flag valueless (%s)', (_label, url) => {
    const { state, loaded, reloaded } = roundTrip(url)
    expect(state.params.map(({ key, value, valueless }) => ({ key, value, valueless }))).toEqual([
      { key: 'q', value: 'hello world', valueless: undefined },
      { key: 'redirect', value: 'https://x.example.com', valueless: undefined },
      { key: 'wsdl', value: '', valueless: true }
    ])
    expect(loaded).toBe(
      'https://api.example.com/search?q=hello%20world&redirect=https%3A%2F%2Fx.example.com&wsdl'
    )
    expect(reloaded.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: 'q', value: 'hello world' },
      { key: 'redirect', value: 'https://x.example.com' },
      { key: 'wsdl', value: '' }
    ])
  })

  it('keeps {{tokens}} verbatim while decoding the literal around them', () => {
    const { state } = roundTrip({
      raw: 'https://x/y?k={{a%b}}%20tail',
      query: [{ key: 'k', value: '{{a%b}}%20tail' }]
    })
    expect(state.params[0]).toMatchObject({ key: 'k', value: '{{a%b}} tail' })
    expect(state.params[0].malformed).toBeUndefined()
  })

  it.each([
    [
      'structured query[]',
      {
        raw: 'https://x/y?bad=%E0&ok=1',
        query: [
          { key: 'bad', value: '%E0' },
          { key: 'ok', value: '1' }
        ]
      }
    ],
    ['raw string URL', 'https://x/y?bad=%E0&ok=1']
  ])('keeps a malformed pair raw, flags it, and warns (%s)', (_label, url) => {
    const { schema, warnings } = importUrl(url)
    const params = schema.operations[0].editorState.params
    expect(params[0]).toMatchObject({ key: 'bad', value: '%E0', malformed: true })
    expect(params[1]).toMatchObject({ key: 'ok', value: '1' })
    expect(params[1].malformed).toBeUndefined()
    expect(warnings.some((w) => w.kind === 'other' && /bad/.test(w.message))).toBe(true)
  })
})
