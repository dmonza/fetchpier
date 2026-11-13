import { describe, it, expect } from 'vitest'
import { buildSoapBodyInner, xsdPlaceholder, type XsdRegistry } from './wsdl-example'
import type { XmlNode } from './xml-node'

function emptyRegistry(): XsdRegistry {
  return { elements: new Map(), types: new Map() }
}

describe('xsdPlaceholder', () => {
  it('maps XSD built-ins to representative sample values', () => {
    expect(xsdPlaceholder('string')).toBe('string')
    expect(xsdPlaceholder('int')).toBe('0')
    expect(xsdPlaceholder('long')).toBe('0')
    expect(xsdPlaceholder('decimal')).toBe('0.0')
    expect(xsdPlaceholder('boolean')).toBe('false')
    expect(xsdPlaceholder('dateTime')).toBe('2026-01-01T00:00:00Z')
    expect(xsdPlaceholder('date')).toBe('2026-01-01')
  })

  it('falls back to an empty string for unknown/binary types', () => {
    expect(xsdPlaceholder('base64Binary')).toBe('')
    expect(xsdPlaceholder(undefined)).toBe('')
    expect(xsdPlaceholder('SomethingCustom')).toBe('')
  })
})

describe('buildSoapBodyInner — document/literal', () => {
  it('expands a global element into qualified child elements with placeholders', () => {
    const registry: XsdRegistry = {
      elements: new Map([
        [
          'Echo',
          {
            node: {
              '@_name': 'Echo',
              'xsd:complexType': {
                'xsd:sequence': {
                  'xsd:element': [
                    { '@_name': 'msg', '@_type': 'xsd:string' },
                    { '@_name': 'count', '@_type': 'xsd:int' }
                  ]
                }
              }
            } as XmlNode,
            schemaNs: 'http://example.org/',
            qualified: true
          }
        ]
      ]),
      types: new Map()
    }

    const res = buildSoapBodyInner({
      registry,
      wsdlTargetNamespace: 'http://wsdl-ns/',
      opName: 'Echo',
      baseIndent: '    ',
      doc: { elementLocal: 'Echo' }
    })

    expect(res.resolved).toBe(true)
    expect(res.tns).toBe('http://example.org/')
    const body = res.lines.join('\n')
    expect(body).toContain('    <tns:Echo>')
    expect(body).toContain('      <tns:msg>string</tns:msg>')
    expect(body).toContain('      <tns:count>0</tns:count>')
    expect(body).toContain('    </tns:Echo>')
  })

  it('leaves child elements unqualified when elementFormDefault is not qualified', () => {
    const registry: XsdRegistry = {
      elements: new Map([
        [
          'Echo',
          {
            node: {
              '@_name': 'Echo',
              'xsd:complexType': {
                'xsd:sequence': { 'xsd:element': { '@_name': 'msg', '@_type': 'xsd:string' } }
              }
            } as XmlNode,
            schemaNs: 'http://example.org/',
            qualified: false
          }
        ]
      ]),
      types: new Map()
    }

    const res = buildSoapBodyInner({
      registry,
      opName: 'Echo',
      baseIndent: '    ',
      doc: { elementLocal: 'Echo' }
    })
    const body = res.lines.join('\n')
    // Wrapper is always qualified (global element); the child is not.
    expect(body).toContain('<tns:Echo>')
    expect(body).toContain('<msg>string</msg>')
  })

  it('resolves a named complexType referenced by an element', () => {
    const registry: XsdRegistry = {
      elements: new Map([
        [
          'Create',
          {
            node: {
              '@_name': 'Create',
              'xsd:complexType': {
                'xsd:sequence': { 'xsd:element': { '@_name': 'order', '@_type': 'tns:Order' } }
              }
            } as XmlNode,
            schemaNs: 'http://example.org/',
            qualified: true
          }
        ]
      ]),
      types: new Map([
        [
          'Order',
          {
            kind: 'complex',
            node: {
              'xsd:sequence': {
                'xsd:element': [
                  { '@_name': 'id', '@_type': 'xsd:int' },
                  { '@_name': 'ref', '@_type': 'xsd:string' }
                ]
              }
            } as XmlNode
          }
        ]
      ])
    }

    const res = buildSoapBodyInner({
      registry,
      opName: 'Create',
      baseIndent: '    ',
      doc: { elementLocal: 'Create' }
    })
    const body = res.lines.join('\n')
    expect(body).toContain('<tns:order>')
    expect(body).toContain('<tns:id>0</tns:id>')
    expect(body).toContain('<tns:ref>string</tns:ref>')
    expect(body).toContain('</tns:order>')
  })

  it('qualifies an element reached through ref= with its own namespace and schema form', () => {
    const registry: XsdRegistry = {
      elements: new Map([
        [
          'Req',
          {
            node: {
              '@_name': 'Req',
              'xsd:complexType': {
                'xsd:sequence': {
                  'xsd:element': [{ '@_ref': 'tns:Customer' }, { '@_ref': 'tns:Unknown' }]
                }
              }
            } as XmlNode,
            schemaNs: 'http://example.org/',
            qualified: false
          }
        ],
        [
          'Customer',
          {
            node: {
              '@_name': 'Customer',
              'xsd:complexType': {
                'xsd:sequence': { 'xsd:element': { '@_name': 'id', '@_type': 'xsd:int' } }
              }
            } as XmlNode,
            schemaNs: 'http://example.org/',
            qualified: true
          }
        ]
      ]),
      types: new Map()
    }

    const res = buildSoapBodyInner({
      registry,
      opName: 'Req',
      baseIndent: '',
      doc: { elementLocal: 'Req' }
    })
    expect(res.namespaces).toEqual([])
    expect(res.lines).toEqual([
      '<tns:Req>',
      '  <tns:Customer>',
      '    <tns:id>0</tns:id>',
      '  </tns:Customer>',
      // An unresolved ref keeps the referencing context's rule.
      '  <Unknown></Unknown>',
      '</tns:Req>'
    ])
  })

  it('escapes an enumeration sample value placed in element text', () => {
    const registry: XsdRegistry = {
      elements: new Map([
        [
          'Req',
          {
            node: {
              '@_name': 'Req',
              'xsd:simpleType': {
                'xsd:restriction': { 'xsd:enumeration': { '@_value': `a&b<c>"d'` } }
              }
            } as XmlNode,
            schemaNs: 'http://example.org/',
            qualified: true
          }
        ]
      ]),
      types: new Map()
    }
    const res = buildSoapBodyInner({
      registry,
      opName: 'Req',
      baseIndent: '',
      doc: { elementLocal: 'Req' }
    })
    expect(res.lines).toEqual([`<tns:Req>a&amp;b&lt;c&gt;&quot;d'</tns:Req>`])
  })

  it('falls back to an empty wrapper when the element is not in the registry', () => {
    const res = buildSoapBodyInner({
      registry: emptyRegistry(),
      wsdlTargetNamespace: 'http://wsdl-ns/',
      opName: 'Missing',
      baseIndent: '    ',
      doc: { elementLocal: 'NotThere' }
    })
    expect(res.resolved).toBe(false)
    expect(res.tns).toBe('http://wsdl-ns/')
    expect(res.lines).toEqual(['    <tns:Missing></tns:Missing>'])
  })
})

describe('buildSoapBodyInner — rpc/literal', () => {
  it('wraps the operation name around unqualified part elements', () => {
    const res = buildSoapBodyInner({
      registry: emptyRegistry(),
      wsdlTargetNamespace: 'http://rpc-ns/',
      opName: 'Multiply',
      baseIndent: '    ',
      rpc: {
        parts: [
          { name: 'x', type: 'xsd:int' },
          { name: 'y', type: 'xsd:int' }
        ]
      }
    })
    expect(res.resolved).toBe(true)
    expect(res.tns).toBe('http://rpc-ns/')
    const body = res.lines.join('\n')
    expect(body).toContain('<tns:Multiply>')
    expect(body).toContain('<x>0</x>')
    expect(body).toContain('<y>0</y>')
    expect(body).toContain('</tns:Multiply>')
  })
})

describe('buildSoapBodyInner — fallback', () => {
  it('emits an empty wrapper without a TODO comment when nothing resolves', () => {
    const res = buildSoapBodyInner({
      registry: emptyRegistry(),
      opName: 'NoInput',
      baseIndent: '    '
    })
    expect(res.resolved).toBe(false)
    expect(res.lines.join('\n')).not.toContain('TODO')
    expect(res.lines).toEqual(['    <tns:NoInput></tns:NoInput>'])
  })
})
