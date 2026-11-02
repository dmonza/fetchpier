import { describe, it, expect } from 'vitest'
import { toJson, toJUnitXml } from './test-results-export'
import type { ScriptResultsBundle } from '../../shared/types'

const ctx = {
  requestName: 'My Request',
  url: 'https://api.example.com/users',
  timestamp: '2026-04-17T12:00:00.000Z'
}

function makeBundle(opts: {
  pre?: { passed: boolean; name: string; error?: string }[]
  post?: { passed: boolean; name: string; error?: string }[]
}): ScriptResultsBundle {
  const makePhase = (tests: { passed: boolean; name: string; error?: string }[]) => ({
    success: true,
    logs: [],
    testResults: tests.map((t) => ({ name: t.name, passed: t.passed, error: t.error }))
  })
  return {
    preRequest: opts.pre ? makePhase(opts.pre) : undefined,
    postResponse: opts.post ? makePhase(opts.post) : undefined
  }
}

describe('toJson', () => {
  it('serializes pre-only bundle', () => {
    const bundle = makeBundle({ pre: [{ name: 'status is 200', passed: true }] })
    const json = JSON.parse(toJson(bundle, ctx))
    expect(json.preRequest.tests).toHaveLength(1)
    expect(json.preRequest.summary.passed).toBe(1)
    expect(json.preRequest.summary.failed).toBe(0)
    expect(json.postResponse).toBeUndefined()
    expect(json.summary.total).toBe(1)
  })

  it('serializes post-only bundle', () => {
    const bundle = makeBundle({
      post: [{ name: 'body has id', passed: false, error: 'id is missing' }]
    })
    const json = JSON.parse(toJson(bundle, ctx))
    expect(json.postResponse.tests[0].passed).toBe(false)
    expect(json.postResponse.summary.failed).toBe(1)
    expect(json.preRequest).toBeUndefined()
  })

  it('serializes both phases and computes combined summary', () => {
    const bundle = makeBundle({
      pre: [{ name: 'auth header set', passed: true }],
      post: [
        { name: 'status 200', passed: true },
        { name: 'body valid', passed: false, error: 'missing field' }
      ]
    })
    const json = JSON.parse(toJson(bundle, ctx))
    expect(json.summary.total).toBe(3)
    expect(json.summary.passed).toBe(2)
    expect(json.summary.failed).toBe(1)
  })

  it('produces valid JSON', () => {
    const bundle = makeBundle({ pre: [], post: [] })
    expect(() => JSON.parse(toJson(bundle, ctx))).not.toThrow()
  })
})

describe('toJUnitXml', () => {
  it('produces well-formed XML with passing tests', () => {
    const bundle = makeBundle({ pre: [{ name: 'status ok', passed: true }] })
    const xml = toJUnitXml(bundle, ctx)
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain('<testsuites')
    expect(xml).toContain('<testsuite')
    expect(xml).toContain('name="status ok"')
    expect(xml).not.toContain('<failure')
  })

  it('includes failure element for failed tests', () => {
    const bundle = makeBundle({ post: [{ name: 'check id', passed: false, error: 'id is null' }] })
    const xml = toJUnitXml(bundle, ctx)
    expect(xml).toContain('<failure')
    expect(xml).toContain('id is null')
  })

  it('escapes XML special characters in names and errors', () => {
    const bundle = makeBundle({
      pre: [{ name: 'res & data <ok>', passed: false, error: 'expected "a" got \'b\'' }]
    })
    const xml = toJUnitXml(bundle, ctx)
    expect(xml).toContain('res &amp; data &lt;ok&gt;')
    expect(xml).toContain('expected &quot;a&quot; got &apos;b&apos;')
  })

  it('counts failures in testsuites attributes', () => {
    const bundle = makeBundle({
      pre: [
        { name: 'ok', passed: true },
        { name: 'fail', passed: false, error: 'oops' }
      ]
    })
    const xml = toJUnitXml(bundle, ctx)
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('failures="1"')
  })

  it('handles both phases producing two testsuite elements', () => {
    const bundle = makeBundle({
      pre: [{ name: 'pre test', passed: true }],
      post: [{ name: 'post test', passed: true }]
    })
    const xml = toJUnitXml(bundle, ctx)
    const matches = xml.match(/<testsuite[^s]/g)
    expect(matches).toHaveLength(2)
  })
})
