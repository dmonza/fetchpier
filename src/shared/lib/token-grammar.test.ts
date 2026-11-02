import { describe, it, expect } from 'vitest'
import { createTokenRegex, mapTokenLiterals, mapTokenLiteralsSafe } from './token-grammar'

/** Collects the verbatim token substrings the regex recognizes in `input`. */
function tokensFrom(input: string): string[] {
  const regex = createTokenRegex()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(input)) !== null) out.push(m[0])
  return out
}

/**
 * Collects the substrings `mapTokenLiterals` leaves untouched, by replacing
 * every literal segment with a sentinel (a control char that cannot appear
 * inside a `{{...}}` token) and splitting it back out.
 */
function preservedBy(input: string): string[] {
  const SENT = String.fromCharCode(0)
  const marked = mapTokenLiterals(input, () => SENT)
  return marked.split(SENT).filter((s) => s !== '')
}

describe('createTokenRegex', () => {
  it('returns a fresh instance each call (no shared lastIndex)', () => {
    const a = createTokenRegex()
    const b = createTokenRegex()
    expect(a).not.toBe(b)
    a.exec('{{x}}')
    expect(b.lastIndex).toBe(0)
  })

  it('captures the inner variable name', () => {
    const m = createTokenRegex().exec('{{ name }}')
    expect(m?.[1]).toBe(' name ')
  })
})

describe('mapTokenLiterals', () => {
  it('transforms only literal segments, leaves tokens verbatim', () => {
    expect(mapTokenLiterals('a&b {{x}}', encodeURIComponent)).toBe('a%26b%20{{x}}')
  })

  it('preserves a token that fills the whole string', () => {
    expect(mapTokenLiterals('{{clientId}}', encodeURIComponent)).toBe('{{clientId}}')
  })

  it('encodes empty {{}} fully — not a token', () => {
    expect(mapTokenLiterals('{{}}', encodeURIComponent)).toBe('%7B%7B%7D%7D')
  })

  it('preserves only the inner match in nested braces', () => {
    expect(mapTokenLiterals('{{a{{b}}}}', encodeURIComponent)).toBe('%7B%7Ba{{b}}%7D%7D')
  })

  it('never decodes a literal % inside a token (valid-looking escape)', () => {
    expect(mapTokenLiterals('{{a%41b}}', decodeURIComponent)).toBe('{{a%41b}}')
  })

  it('does not throw on an invalid % escape inside a token', () => {
    expect(() => mapTokenLiterals('{{a%b}}', decodeURIComponent)).not.toThrow()
    expect(mapTokenLiterals('{{a%b}}', decodeURIComponent)).toBe('{{a%b}}')
  })

  it('decodes literal segments around a token', () => {
    expect(mapTokenLiterals('a%20b{{x}}c%26d', decodeURIComponent)).toBe('a b{{x}}c&d')
  })

  it('encode then decode round-trips strings mixing literals and tokens', () => {
    for (const s of ['{{clientId}}', 'user-{{userId}}', 'a&b {{x}}', '{{a%41b}}', 'plain']) {
      const encoded = mapTokenLiterals(s, encodeURIComponent)
      expect(mapTokenLiterals(encoded, decodeURIComponent)).toBe(s)
    }
  })
})

describe('mapTokenLiteralsSafe — containment belongs to the contract (REQ-0113 §6.6)', () => {
  it('never propagates a throwing transform, whatever the transform is', () => {
    const boom = (): string => {
      throw new Error('boom')
    }
    // Deliberately not the percent-decoder: containment must be a property of
    // the grammar, not a special case for the one transform that throws today.
    expect(() => mapTokenLiteralsSafe('abc{{x}}def', boom)).not.toThrow()
    const r = mapTokenLiteralsSafe('abc{{x}}def', boom)
    expect(r.failed).toBe(true)
    expect(r.text).toBe('abc{{x}}def')
  })

  it('reports failure and keeps the offending literal byte-for-byte', () => {
    const r = mapTokenLiteralsSafe('%E0', decodeURIComponent)
    expect(r.failed).toBe(true)
    expect(r.text).toBe('%E0')
  })

  it('reports no failure when every literal transforms', () => {
    const r = mapTokenLiteralsSafe('a%20b{{x}}c%26d', decodeURIComponent)
    expect(r.failed).toBe(false)
    expect(r.text).toBe('a b{{x}}c&d')
  })

  it('contains per literal segment — a healthy segment still transforms', () => {
    // The load-bearing case for callers: `text` is PARTIALLY transformed, so a
    // caller that must preserve authored bytes has to fall back to its own raw
    // input rather than to `text` (see query-string.ts).
    const r = mapTokenLiteralsSafe('%20{{x}}%E0', decodeURIComponent)
    expect(r.failed).toBe(true)
    expect(r.text).toBe(' {{x}}%E0')
  })
})

describe('mapTokenLiterals — the wrapper inherits the containment', () => {
  it('no longer throws on a malformed escape in a literal segment', () => {
    expect(() => mapTokenLiterals('%E0', decodeURIComponent)).not.toThrow()
    expect(mapTokenLiterals('%E0', decodeURIComponent)).toBe('%E0')
  })
})

describe('grammar symmetry (REQ-0080 §9.2)', () => {
  // The set of substrings the serializer/loader leave untouched must equal
  // exactly the set the resolver recognizes as tokens — for every input.
  const samples = [
    '{{clientId}}',
    '{{ name }}',
    'user-{{userId}}',
    'a&b {{x}}',
    '{{}}', // empty inner — not a token
    '{{a{{b}}}}', // only inner {{b}} is a token
    '{{a%41b}}',
    '{{a%b}}',
    'no-tokens-here',
    '{{a}}{{b}}',
    '}}stray{{'
  ]

  it.each(samples)('preserved substrings == resolver tokens for %j', (input) => {
    // Compare the concatenation: adjacent tokens (`{{a}}{{b}}`) have no literal
    // between them, so the split helper cannot separate them — but the verbatim
    // character set the serializer/loader preserve must still equal the
    // resolver's token set exactly.
    expect(preservedBy(input).join('')).toEqual(tokensFrom(input).join(''))
  })
})
