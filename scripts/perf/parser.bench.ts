import { bench, describe } from 'vitest'
import { parseHttpFile } from '../../src/main/http/parser'
import { buildHttpFile } from './fixtures'

const small = buildHttpFile(1)
const medium = buildHttpFile(50)
const large = buildHttpFile(500)

describe('parseHttpFile', () => {
  bench('1 request', () => {
    parseHttpFile(small)
  })
  bench('50 requests', () => {
    parseHttpFile(medium)
  })
  bench('500 requests', () => {
    parseHttpFile(large)
  })
})
