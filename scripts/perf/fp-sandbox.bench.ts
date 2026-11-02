import { bench, describe } from 'vitest'
import { runFpScript } from '../../src/main/scripting/fp-sandbox'
import type { HttpRequest, HttpResponse } from '../../src/shared/types'
import { buildLargeJsonBody } from './fixtures'

const baseRequest: HttpRequest = {
  method: 'GET',
  url: 'https://api.example.com/users/1',
  headers: { 'Content-Type': 'application/json', Accept: '*/*' }
}

const response: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'Content-Type': 'application/json' },
  body: buildLargeJsonBody(200),
  timingMs: 12,
  sizeBytes: 1234
}

const trivialScript = 'fp.environment.set("x", "1");'

const moderateScript = `
const n = 500;
let sum = 0;
for (let i = 0; i < n; i++) {
  sum += i;
  fp.variables.set('i_' + i, i);
}
fp.environment.set('sum', String(sum));
`

const parseJsonScript = `
const data = fp.response.json();
fp.test('array', () => fp.expect(Array.isArray(data)).toBe(true));
fp.test('length', () => fp.expect(data.length).toBe(200));
for (const item of data) {
  fp.variables.set('last_id', item.id);
}
`

describe('runFpScript (cold per-call context)', () => {
  bench('trivial pre-request', () => {
    runFpScript({
      phase: 'pre-request',
      script: trivialScript,
      request: baseRequest,
      environment: {},
      variables: {}
    })
  })

  bench('moderate loop (500 iterations)', () => {
    runFpScript({
      phase: 'pre-request',
      script: moderateScript,
      request: baseRequest,
      environment: {},
      variables: {}
    })
  })

  bench('post-response json() + tests', () => {
    runFpScript({
      phase: 'post-response',
      script: parseJsonScript,
      request: baseRequest,
      response,
      environment: {},
      variables: {}
    })
  })
})
