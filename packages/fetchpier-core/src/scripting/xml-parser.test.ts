import { describe, it, expect } from 'vitest'
import { parseXmlSafe, MAX_XML_BYTES } from './xml-parser'

describe('parseXmlSafe — shape', () => {
  it('element with text only', () => {
    expect(parseXmlSafe('<a>hi</a>')).toEqual({ a: 'hi' })
  })

  it('element with attribute only', () => {
    expect(parseXmlSafe('<a id="1"/>')).toEqual({ a: { '@_id': '1' } })
  })

  it('element with attribute + text (mixed content)', () => {
    expect(parseXmlSafe('<a id="1">hi</a>')).toEqual({
      a: { '@_id': '1', '#text': 'hi' }
    })
  })

  it('element with children', () => {
    expect(parseXmlSafe('<a><b>1</b><c>2</c></a>')).toEqual({
      a: { b: '1', c: '2' }
    })
  })

  it('empty self-closing element', () => {
    expect(parseXmlSafe('<a/>')).toEqual({ a: '' })
  })

  it('empty open/close element', () => {
    expect(parseXmlSafe('<a></a>')).toEqual({ a: '' })
  })
})

describe('parseXmlSafe — arrays', () => {
  it('repeated element (N >= 2) becomes an array', () => {
    const r = parseXmlSafe('<root><x>a</x><x>b</x><x>c</x></root>') as {
      root: { x: string[] }
    }
    expect(r.root.x).toEqual(['a', 'b', 'c'])
  })

  it('single occurrence is NOT an array by default', () => {
    const r = parseXmlSafe('<root><x>a</x></root>') as { root: { x: unknown } }
    expect(r.root.x).toBe('a')
  })
})

describe('parseXmlSafe — alwaysArray', () => {
  it('loose tag name forces an array for a single occurrence', () => {
    const r = parseXmlSafe('<root><x>a</x></root>', { alwaysArray: ['x'] }) as {
      root: { x: string[] }
    }
    expect(r.root.x).toEqual(['a'])
  })

  it('full jpath forces an array only on that path', () => {
    const xml = '<root><aa><x>one</x></aa><bb><x>two</x></bb></root>'
    const r = parseXmlSafe(xml, { alwaysArray: ['root.aa.x'] }) as {
      root: { aa: { x: string[] }; bb: { x: unknown } }
    }
    expect(r.root.aa.x).toEqual(['one'])
    expect(r.root.bb.x).toBe('two')
  })

  it('jpath respects stripNamespaces (no prefixes in the path)', () => {
    const xml =
      '<soap:Envelope xmlns:soap="x"><soap:Body><roles><role>admin</role></roles></soap:Body></soap:Envelope>'
    const r = parseXmlSafe(xml, {
      stripNamespaces: true,
      alwaysArray: ['Envelope.Body.roles.role']
    }) as {
      Envelope: { Body: { roles: { role: string[] } } }
    }
    expect(r.Envelope.Body.roles.role).toEqual(['admin'])
  })
})

describe('parseXmlSafe — namespaces', () => {
  const xml =
    '<soap:Envelope xmlns:soap="http://x"><soap:Body><LoginResponse><token>abc</token></LoginResponse></soap:Body></soap:Envelope>'

  it('keeps namespace prefixes literal by default', () => {
    const r = parseXmlSafe(xml) as Record<string, unknown>
    expect(r).toHaveProperty('soap:Envelope')
    const env = r['soap:Envelope'] as Record<string, unknown>
    expect(env).toHaveProperty('soap:Body')
  })

  it('strips namespace prefixes when stripNamespaces is true', () => {
    const r = parseXmlSafe(xml, { stripNamespaces: true }) as Record<string, unknown>
    expect(r).toHaveProperty('Envelope')
    expect(r).not.toHaveProperty('soap:Envelope')
    const env = r.Envelope as Record<string, unknown>
    expect(env).toHaveProperty('Body')
  })
})

describe('parseXmlSafe — scalar types', () => {
  it('numeric-looking values stay as strings', () => {
    const r = parseXmlSafe('<a>42</a>') as { a: string }
    expect(r.a).toBe('42')
    expect(typeof r.a).toBe('string')
  })

  it('preserves precision for large integers (no float coercion)', () => {
    const big = '12345678901234567890'
    const r = parseXmlSafe(`<id>${big}</id>`) as { id: string }
    expect(r.id).toBe(big)
  })
})

describe('parseXmlSafe — CDATA, entities, declaration, comments', () => {
  it('CDATA is merged as plain text', () => {
    const r = parseXmlSafe('<x><![CDATA[<raw>&]]></x>') as { x: string }
    expect(r.x).toBe('<raw>&')
  })

  it('entities are decoded', () => {
    const r = parseXmlSafe('<x>a &amp; b</x>') as { x: string }
    expect(r.x).toBe('a & b')
  })

  it('decimal and hex character references are decoded in text (XML 1.0 §4.1)', () => {
    expect(parseXmlSafe('<x>Jos&#233;</x>')).toEqual({ x: 'José' })
    expect(parseXmlSafe('<x>caf&#xE9;</x>')).toEqual({ x: 'café' })
    expect(parseXmlSafe('<x>caf&#xe9;</x>')).toEqual({ x: 'café' })
    expect(parseXmlSafe('<x>a&#xD;b</x>')).toEqual({ x: 'a\rb' })
  })

  it('character references are decoded in attribute values', () => {
    expect(parseXmlSafe('<x a="&amp;&#233;" b="&#x41;"/>')).toEqual({
      x: { '@_a': '&é', '@_b': 'A' }
    })
  })

  it('an escaped reference is decoded once, and HTML named entities stay literal', () => {
    expect(parseXmlSafe('<x>&amp;&lt;&gt;&quot;&apos;</x>')).toEqual({ x: '&<>"\'' })
    expect(parseXmlSafe('<x>&amp;#233;</x>')).toEqual({ x: '&#233;' })
    expect(parseXmlSafe('<x>a&nbsp;b</x>')).toEqual({ x: 'a&nbsp;b' })
  })

  it('XML declaration is ignored (no stray key)', () => {
    const r = parseXmlSafe('<?xml version="1.0"?><a>hi</a>')
    expect(r).toEqual({ a: 'hi' })
  })

  it('comments are ignored', () => {
    const r = parseXmlSafe('<a><!-- c -->hi</a>')
    expect(r).toEqual({ a: 'hi' })
  })
})

describe('parseXmlSafe — errors', () => {
  it('throws TypeError when body is not a string', () => {
    expect(() => parseXmlSafe(123 as unknown as string)).toThrow(TypeError)
    expect(() => parseXmlSafe(null as unknown as string)).toThrow(TypeError)
    expect(() => parseXmlSafe(undefined as unknown as string)).toThrow(TypeError)
  })

  it('throws with size info when body exceeds MAX_XML_BYTES', () => {
    const oversize = 'a'.repeat(MAX_XML_BYTES + 1)
    expect(() => parseXmlSafe(oversize)).toThrow(/too large/)
    try {
      parseXmlSafe(oversize)
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toMatch(/max 10\.0 MB/)
      expect(msg).toMatch(/would block the main process/)
    }
  })

  it('throws on malformed XML with a "failed to parse" prefix', () => {
    expect(() => parseXmlSafe('<a><b></a>')).toThrow(/xml2Json: failed to parse/)
    expect(() => parseXmlSafe('not xml at all')).toThrow(/xml2Json: failed to parse/)
    expect(() => parseXmlSafe('')).toThrow(/xml2Json: failed to parse/)
  })
})

describe('parseXmlSafe — security', () => {
  it('expands an entity declared in the internal DTD (documented behavior)', () => {
    expect(parseXmlSafe('<!DOCTYPE a [<!ENTITY e "hello">]><a>&e;</a>')).toEqual({ a: 'hello' })
  })

  it('does not expand external entities (XXE)', () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>'
    let threw = false
    let result: unknown
    try {
      result = parseXmlSafe(xml)
    } catch {
      threw = true
    }
    if (!threw) {
      // If the parser tolerated the DOCTYPE it MUST NOT have pulled filesystem
      // content into the resulting object.
      const serialized = JSON.stringify(result)
      expect(serialized).not.toMatch(/root:/)
      expect(serialized).not.toMatch(/\/bin\//)
    }
  })

  it('does not expand billion-laughs entities to unbounded strings', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE lolz [',
      '<!ENTITY lol "lol">',
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">',
      '<!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">',
      '<!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">',
      ']>',
      '<lolz>&lol5;</lolz>'
    ].join('')
    let size: number
    try {
      const r = parseXmlSafe(xml)
      size = JSON.stringify(r).length
    } catch {
      // Throwing is also an acceptable outcome — the parser refused to
      // expand. Either way, the output did not balloon to GBs.
      size = 0
    }
    // 10^5 chars would be 10^10 = 10 GB if fully expanded. We require the
    // output to stay far below any catastrophic growth.
    expect(size).toBeLessThan(10_000)
  })
})
