// Glyph sets for the CLI reporter. Unicode by default; ASCII fallback for old
// terminals (via `--ascii`). The mapping is contractual — the reporter snapshot
// tests assert both renderings.

export interface GlyphSet {
  /** Request marker (line start). */
  bullet: string
  /** Outgoing arrow (resolved request). */
  arrowOut: string
  /** Incoming arrow (response). */
  arrowIn: string
  /** Passing test / success. */
  pass: string
  /** Failing test / failure. */
  fail: string
  /** Inline separator between metrics. */
  sep: string
}

export const UNICODE_GLYPHS: GlyphSet = Object.freeze({
  bullet: '▶',
  arrowOut: '→',
  arrowIn: '←',
  pass: '✓',
  fail: '✗',
  sep: '·'
})

export const ASCII_GLYPHS: GlyphSet = Object.freeze({
  bullet: '>',
  arrowOut: '->',
  arrowIn: '<-',
  pass: '[OK]',
  fail: '[FAIL]',
  sep: '-'
})

/** Pick the glyph set. ASCII when `--ascii` is set; Unicode otherwise. */
export function selectGlyphs(ascii: boolean): GlyphSet {
  return ascii ? ASCII_GLYPHS : UNICODE_GLYPHS
}
