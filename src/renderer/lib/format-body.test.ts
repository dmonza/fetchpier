import { describe, it, expect } from 'vitest'
import { prettyPrintJson, prettyPrintXml, sniffLanguage } from './format-body'

describe('prettyPrintJson', () => {
  it('re-indents valid JSON with 2 spaces', () => {
    expect(prettyPrintJson('{"a":1,"b":[2,3]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}'
    )
  })

  it('returns the input unchanged when it is not valid JSON', () => {
    expect(prettyPrintJson('not json')).toBe('not json')
    expect(prettyPrintJson('<root/>')).toBe('<root/>')
  })
})

describe('prettyPrintXml', () => {
  it('indents nested elements', () => {
    const input = '<root><a><b>1</b></a><c/></root>'
    expect(prettyPrintXml(input)).toBe(
      ['<root>', '  <a>', '    <b>1</b>', '  </a>', '  <c/>', '</root>'].join('\n')
    )
  })

  it('keeps the XML declaration and attributes on their own line', () => {
    const input = '<?xml version="1.0" encoding="UTF-8"?><note id="1"><to>Tove</to></note>'
    expect(prettyPrintXml(input)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<note id="1">',
        '  <to>Tove</to>',
        '</note>'
      ].join('\n')
    )
  })

  it('handles comments and CDATA that contain ">"', () => {
    const input = '<root><!-- a > b --><data><![CDATA[x > y]]></data></root>'
    expect(prettyPrintXml(input)).toBe(
      [
        '<root>',
        '  <!-- a > b -->',
        '  <data>',
        '    <![CDATA[x > y]]>',
        '  </data>',
        '</root>'
      ].join('\n')
    )
  })

  it('collapses whitespace between tags and is idempotent on pretty input', () => {
    const ugly = '<root>\n\n   <a>1</a>\t\n</root>'
    const pretty = ['<root>', '  <a>1</a>', '</root>'].join('\n')
    expect(prettyPrintXml(ugly)).toBe(pretty)
    expect(prettyPrintXml(pretty)).toBe(pretty)
  })

  it('renders an empty element on a single line', () => {
    expect(prettyPrintXml('<root><a></a></root>')).toBe(
      ['<root>', '  <a></a>', '</root>'].join('\n')
    )
  })

  it('returns the input unchanged when the XML is unbalanced', () => {
    expect(prettyPrintXml('<root><a></root>')).toBe('<root><a></root>')
    expect(prettyPrintXml('</root>')).toBe('</root>')
    expect(prettyPrintXml('plain text')).toBe('plain text')
    expect(prettyPrintXml('<!-- never closed')).toBe('<!-- never closed')
  })
})

describe('sniffLanguage', () => {
  it('detects xml', () => {
    expect(sniffLanguage('<?xml version="1.0"?><root/>')).toBe('xml')
    expect(sniffLanguage('  <root><a/></root>')).toBe('xml')
  })

  it('detects html', () => {
    expect(sniffLanguage('<!DOCTYPE html><html></html>')).toBe('html')
    expect(sniffLanguage('<html lang="en"></html>')).toBe('html')
  })

  it('detects json', () => {
    expect(sniffLanguage('  {"a":1}')).toBe('json')
    expect(sniffLanguage('[1,2,3]')).toBe('json')
  })

  it('returns null for anything else', () => {
    expect(sniffLanguage('hello world')).toBeNull()
    expect(sniffLanguage('')).toBeNull()
    expect(sniffLanguage('   ')).toBeNull()
  })
})
