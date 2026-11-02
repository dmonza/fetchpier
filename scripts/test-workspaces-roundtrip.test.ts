import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { requests } from '@fetchpier/core'
import { importPostman } from '@fetchpier/core/schema-import'
import type { Environment } from '../src/shared/types'

const { parseHttpFile } = requests

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACES_ROOT = join(REPO_ROOT, 'test', 'workspaces')

function walk(dir: string, predicate: (file: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      out.push(...walk(full, predicate))
    } else if (predicate(full)) {
      out.push(full)
    }
  }
  return out
}

const httpFiles = walk(WORKSPACES_ROOT, (f) => f.endsWith('.http'))
const envFiles = walk(WORKSPACES_ROOT, (f) =>
  /[\\/]environments[\\/][^\\/]+[\\/]config\.json$/.test(f)
)
const postmanFiles = walk(join(WORKSPACES_ROOT, 'postman-import'), (f) => f.endsWith('.json'))

describe('test workspaces — canonical fixtures parse cleanly', () => {
  it('found .http and environment fixtures to validate', () => {
    expect(httpFiles.length).toBeGreaterThan(0)
    expect(envFiles.length).toBeGreaterThan(0)
    expect(postmanFiles.length).toBeGreaterThan(0)
  })

  for (const file of httpFiles) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    it(`parses ${rel}`, () => {
      const content = readFileSync(file, 'utf-8')
      const parsed = parseHttpFile(content)
      expect(parsed.requests.length, `${rel} should contain at least one request`).toBeGreaterThan(
        0
      )
      const req = parsed.requests[0]
      expect(req.method, `${rel} request line method`).toMatch(/^[A-Z]+$/)
      expect(req.url, `${rel} request URL`).not.toBe('')
    })
  }

  for (const file of envFiles) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    it(`loads environment ${rel}`, () => {
      const env = JSON.parse(readFileSync(file, 'utf-8')) as Environment
      expect(env.id).toBeTruthy()
      expect(env.name).toBeTruthy()
      expect(env.variables).toBeTypeOf('object')
    })
  }

  for (const file of postmanFiles) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    it(`imports postman fixture ${rel}`, () => {
      const result = importPostman(readFileSync(file, 'utf-8'))
      expect(result.schema.format).toBe('postman')
      expect(result.schema.operations.length).toBeGreaterThan(0)
    })
  }
})

describe('default workspace — canonical GET + environment', () => {
  it('exposes baseUrl in the default environment', () => {
    const config = JSON.parse(
      readFileSync(
        join(WORKSPACES_ROOT, 'default', 'environments', 'default', 'config.json'),
        'utf-8'
      )
    ) as Environment
    expect(config.variables.baseUrl).toBe('https://httpbin.org')
  })

  it('has a single GET request to {{baseUrl}}/get', () => {
    const parsed = parseHttpFile(
      readFileSync(join(WORKSPACES_ROOT, 'default', 'requests', 'get-httpbin.http'), 'utf-8')
    )
    expect(parsed.requests).toHaveLength(1)
    expect(parsed.requests[0].method).toBe('GET')
    expect(parsed.requests[0].url).toBe('{{baseUrl}}/get')
    expect(parsed.variablesUsed).toContain('baseUrl')
  })
})

describe('default workspace — scripted requests survive serializer round-trip', () => {
  it('pre-request script is recognized', () => {
    const parsed = parseHttpFile(
      readFileSync(
        join(WORKSPACES_ROOT, 'default', 'requests', 'scripts', 'pre-script-sets-var.http'),
        'utf-8'
      )
    )
    expect(parsed.requests[0].preRequestScript).toContain("fp.variables.set('runId'")
  })

  it('post-response script is recognized', () => {
    const parsed = parseHttpFile(
      readFileSync(
        join(WORKSPACES_ROOT, 'default', 'requests', 'scripts', 'post-script-tests-status.http'),
        'utf-8'
      )
    )
    expect(parsed.requests[0].postResponseScript).toContain("fp.test('status is 200'")
  })

  it('settings block on 301-moved disables followRedirects', () => {
    const parsed = parseHttpFile(
      readFileSync(
        join(WORKSPACES_ROOT, 'default', 'requests', 'status', '301-moved.http'),
        'utf-8'
      )
    )
    expect(parsed.requests[0].settings?.followRedirects).toEqual({
      inherit: false,
      value: false
    })
  })
})

describe('postman fixtures — warnings reflect their intent', () => {
  it('collection-with-env-vars emits a variable-collected warning', () => {
    const { warnings } = importPostman(
      readFileSync(
        join(WORKSPACES_ROOT, 'postman-import', 'collection-with-env-vars.json'),
        'utf-8'
      )
    )
    expect(warnings.some((w) => w.kind === 'variable-collected')).toBe(true)
  })

  it('collection-with-scripts emits a script-copied-asis warning', () => {
    const { warnings } = importPostman(
      readFileSync(join(WORKSPACES_ROOT, 'postman-import', 'collection-with-scripts.json'), 'utf-8')
    )
    expect(warnings.some((w) => w.kind === 'script-copied-asis')).toBe(true)
  })

  it('tiny-collection imports without warnings beyond informational', () => {
    const { warnings, schema } = importPostman(
      readFileSync(join(WORKSPACES_ROOT, 'postman-import', 'tiny-collection.json'), 'utf-8')
    )
    expect(schema.operations).toHaveLength(6)
    expect(warnings.some((w) => w.kind === 'variable-collected')).toBe(false)
    expect(warnings.some((w) => w.kind === 'script-copied-asis')).toBe(false)
  })
})
