import { bench, describe } from 'vitest'
import { resolveRequestVariables, resolveString } from '../../src/main/http/variables'
import { buildEnvironment, buildLargeJsonBody } from './fixtures'

const env = buildEnvironment(200)
const smallBody = '{"x":"{{token_1}}"}'
const mediumBody = JSON.stringify(
  Array.from({ length: 100 }, (_, i) => ({ k: `{{env_${i}}}`, v: `{{token_${i}}}` }))
)
const largeBody = (() => {
  // Interleave placeholders into a large json-ish payload
  const base = buildLargeJsonBody(500)
  const chunks: string[] = []
  for (let i = 0; i < 200; i++) chunks.push(`{{env_${i}}}-{{token_${i}}}`)
  return base + chunks.join('|')
})()

const headers = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [`X-Header-${i}`, `v-{{env_${i}}}`])
)

describe('resolveString', () => {
  bench('short with 1 var', () => {
    resolveString(smallBody, env)
  })
  bench('medium with 200 vars', () => {
    resolveString(mediumBody, env)
  })
  bench('large with 400 vars', () => {
    resolveString(largeBody, env)
  })
})

describe('resolveRequestVariables', () => {
  bench('20 headers + medium body', () => {
    resolveRequestVariables(
      {
        method: 'POST',
        url: '{{baseUrl}}/users/1?token={{token_5}}',
        headers,
        body: mediumBody
      },
      env
    )
  })
})
