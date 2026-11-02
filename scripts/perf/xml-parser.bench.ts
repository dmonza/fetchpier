import { bench, describe } from 'vitest'
import { parseXmlSafe } from '../../src/main/scripting/xml-parser'
import { buildXml } from './fixtures'

const small = buildXml(10)
const medium = buildXml(200)
const large = buildXml(2000)

describe('parseXmlSafe (default options)', () => {
  bench('10 items', () => {
    parseXmlSafe(small)
  })
  bench('200 items', () => {
    parseXmlSafe(medium)
  })
  bench('2000 items', () => {
    parseXmlSafe(large)
  })
})

describe('parseXmlSafe with stripNamespaces + alwaysArray', () => {
  bench('200 items', () => {
    parseXmlSafe(medium, { stripNamespaces: true, alwaysArray: ['Item', 'Tag'] })
  })
})
