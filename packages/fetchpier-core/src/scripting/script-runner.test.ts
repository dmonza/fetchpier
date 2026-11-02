import { describe, it, expect } from 'vitest'
import { executePreRequest, executePostResponse } from './script-runner'
import type { HttpRequest, HttpResponse } from '@shared/types'

const req: HttpRequest = {
  method: 'GET',
  url: 'https://api.example.com/x',
  headers: {}
}

const res: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'Content-Type': 'application/json' },
  body: '{"ok":true}',
  timingMs: 1,
  sizeBytes: 11
}

describe('script-runner', () => {
  it('pre-request: modifies headers and returns updated request', () => {
    const outcome = executePreRequest(`fp.request.headers.set("X-Trace", "123");`, {
      request: req,
      environment: {},
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.request.headers['X-Trace']).toBe('123')
  })

  it('post-response: test results are captured', () => {
    const outcome = executePostResponse(
      `fp.test("200", () => { fp.expect(fp.response.status).to.equal(200); });`,
      { request: req, response: res, environment: {}, variables: {} }
    )
    expect(outcome.result.testResults[0].passed).toBe(true)
  })

  it('carries variables across pre and post', () => {
    const pre = executePreRequest(`fp.variables.set("n", 7);`, {
      request: req,
      environment: {},
      variables: {}
    })
    const post = executePostResponse(
      `fp.test("n", () => { fp.expect(fp.variables.get("n")).to.equal(7); });`,
      { request: req, response: res, environment: {}, variables: pre.variables }
    )
    expect(post.result.testResults[0].passed).toBe(true)
  })
})
