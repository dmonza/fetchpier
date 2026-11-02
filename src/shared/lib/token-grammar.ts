/**
 * Single source of truth for the `{{variable}}` token grammar.
 *
 * One grammar definition is consumed by three sites that must stay symmetric
 * (REQ-0080 §8): the query serializer (save path), the query loader/splitter
 * (load path), and variable resolution. Because the dependency direction is
 * core → shared and renderer → shared, the grammar lives here in the shared
 * layer and all three consumers import it — drift is impossible by construction.
 *
 * Grammar: `{{` + one-or-more non-brace characters + `}}`. Inner whitespace is
 * preserved verbatim (resolution trims it later). A maximal substring matching
 * this shape is a token; everything else — including empty `{{}}` and stray or
 * unbalanced braces — is an ordinary literal.
 */

/**
 * Returns a fresh global token regex on every call.
 *
 * A new instance avoids `lastIndex` statefulness when the regex is driven with
 * `.exec()` in a loop. The capture group `([^{}]+)` exposes the inner variable
 * name to resolution.
 */
export function createTokenRegex(): RegExp {
  return /\{\{([^{}]+)\}\}/g
}

/** Outcome of {@link mapTokenLiteralsSafe}. */
export interface TokenMapResult {
  /** The mapped string. Literal segments whose transform threw are verbatim. */
  text: string
  /** True when at least one literal segment's transform threw. */
  failed: boolean
}

/**
 * Partitions `input` into literal and token segments using the token grammar,
 * applies `transform` to each literal segment, emits each token segment
 * verbatim, and concatenates the results in order.
 *
 * Drives both the save path (`transform = encodeURIComponent`) and the load
 * path (`transform = decodeURIComponent`): tokens are never encoded nor decoded,
 * so the set of substrings left untouched equals exactly the set resolution
 * recognizes as tokens.
 *
 * **Never throws, for any transform** (REQ-0113 §6.6). A literal segment whose
 * transform throws keeps its *original bytes* and the failure is reported via
 * `failed` — it is neither repaired, normalized, nor substituted. Containment
 * lives here, in the contract, rather than at each call site: the percent-decoder
 * is the only transform that throws today, but a guard at one call seam leaves
 * the class open (that is exactly how a malformed escape in a query parameter
 * name came to abort a whole parse, while a sibling seam handled it fine).
 *
 * Containment is **per literal segment**: healthy segments still transform, so
 * `text` can be partially transformed. A caller that must preserve the author's
 * bytes for the value as a whole falls back to its own raw input when `failed`
 * is set, not to `text` — see `splitUrlAndParams` in `query-string.ts`.
 */
export function mapTokenLiteralsSafe(
  input: string,
  transform: (literal: string) => string
): TokenMapResult {
  const regex = createTokenRegex()
  let result = ''
  let lastIndex = 0
  let failed = false
  let match: RegExpExecArray | null

  /** Transform one literal, or keep it verbatim and record the failure. */
  const mapLiteral = (literal: string): string => {
    try {
      return transform(literal)
    } catch {
      failed = true
      return literal
    }
  }

  while ((match = regex.exec(input)) !== null) {
    // Literal text before this token.
    if (match.index > lastIndex) {
      result += mapLiteral(input.slice(lastIndex, match.index))
    }
    // Token itself, verbatim.
    result += match[0]
    lastIndex = match.index + match[0].length
  }

  // Trailing literal after the last token (or the whole string if no token).
  if (lastIndex < input.length) {
    result += mapLiteral(input.slice(lastIndex))
  }

  return { text: result, failed }
}

/**
 * {@link mapTokenLiteralsSafe} for callers with no use for the failure signal —
 * the encode direction (`encodeURIComponent` never throws) and the surfaces that
 * only need containment. Never throws.
 */
export function mapTokenLiterals(input: string, transform: (literal: string) => string): string {
  return mapTokenLiteralsSafe(input, transform).text
}
