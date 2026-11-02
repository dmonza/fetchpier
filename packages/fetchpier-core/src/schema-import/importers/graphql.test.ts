import { describe, it, expect } from 'vitest'
import { introspectionFromSchema, buildSchema } from 'graphql'
import { importGraphQL } from './graphql'

const SDL = `
type Query {
  users(limit: Int): [User!]!
  user(id: ID!): User
}

type Mutation {
  createUser(name: String!, email: String!): User!
}

type Subscription {
  userCreated: User
}

type User {
  id: ID!
  name: String!
  email: String!
}
`

describe('importGraphQL', () => {
  it('parses SDL and builds POST operations', () => {
    const { schema } = importGraphQL(SDL, 'https://api.example.com/graphql')
    expect(schema.format).toBe('graphql-sdl')
    expect(schema.baseUrl).toBe('https://api.example.com/graphql')

    const users = schema.operations.find((o) => o.name === 'users')
    expect(users?.editorState.method).toBe('POST')
    expect(users?.folderPath).toEqual(['queries'])
    expect(users?.editorState.body).toContain('query Users')
    expect(users?.editorState.body).toContain('"limit"')

    const mutation = schema.operations.find((o) => o.name === 'createUser')
    expect(mutation?.folderPath).toEqual(['mutations'])
    expect(mutation?.editorState.body).toContain('mutation CreateUser')

    const sub = schema.operations.find((o) => o.name === 'userCreated')
    expect(sub?.folderPath).toEqual(['subscriptions'])
  })

  it('parses introspection JSON', () => {
    const built = buildSchema(SDL)
    const introspection = introspectionFromSchema(built)
    const raw = JSON.stringify({ data: introspection })
    const { schema } = importGraphQL(raw, 'https://api.example.com/graphql')
    expect(schema.format).toBe('graphql-introspection')
    expect(schema.operations.length).toBeGreaterThan(0)
  })
})

// ── Coverage-gap additions (REQ-0055 §4.3.5) ───────────────────────────────

describe('importGraphQL — malformed and edge inputs', () => {
  it('throws on malformed SDL', () => {
    expect(() => importGraphQL('type Query { unterminated', 'https://x/graphql')).toThrow()
  })

  it('throws on invalid JSON when input looks like introspection', () => {
    expect(() => importGraphQL('{ not valid json', 'https://x/graphql')).toThrow()
  })

  it('treats SDL with neither Query nor Mutation nor Subscription as zero operations', () => {
    const { schema } = importGraphQL('type Foo { id: ID! }', 'https://x/graphql')
    expect(schema.operations).toHaveLength(0)
  })

  it('uses the default endpoint URL when caller omits it', () => {
    const sdl = `type Query { ping: String }`
    const { schema } = importGraphQL(sdl)
    expect(schema.baseUrl).toBe('https://example.com/graphql')
  })

  it('uses generic "graphql" title when the SDL has no description', () => {
    const sdl = `type Query { ping: String }`
    const { schema } = importGraphQL(sdl, 'https://x/')
    expect(schema.title).toBe('graphql')
  })

  it('handles introspection JSON wrapped without a top-level "data" key', () => {
    const built = buildSchema('type Query { ping: String }')
    const introspection = introspectionFromSchema(built)
    const raw = JSON.stringify(introspection)
    const { schema, warnings } = importGraphQL(raw, 'https://x/')
    expect(schema.format).toBe('graphql-introspection')
    expect(schema.operations.length).toBeGreaterThan(0)
    expect(Array.isArray(warnings)).toBe(true)
  })

  it('renders enum + list + non-null variable types in the operation body', () => {
    const sdl = `
      enum Role { ADMIN USER }
      type Query {
        usersByRole(roles: [Role!]!): [String!]!
      }
    `
    const { schema } = importGraphQL(sdl, 'https://x/')
    const op = schema.operations[0]
    expect(op.editorState.body).toContain('[Role!]!')
    expect(op.editorState.body).toContain('ADMIN')
  })

  it('emits a POST request with application/json content-type', () => {
    const sdl = `type Query { ping: String }`
    const { schema } = importGraphQL(sdl, 'https://x/')
    const op = schema.operations[0]
    expect(op.editorState.method).toBe('POST')
    const ct = op.editorState.headers.find((h) => h.key.toLowerCase() === 'content-type')
    expect(ct?.value).toBe('application/json')
  })
})
