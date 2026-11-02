/**
 * Request-separator detection for `.http` files (`.http` round-trip fidelity).
 *
 * A `###` line is a request separator **only** when the next content line is a
 * request line. This makes the body opaque to a bare `###` (a Markdown heading,
 * a diff hunk) that is not actually starting a new request. The bias is to
 * **not** split: when in doubt the `###` line stays in the body.
 */

/** A leading method token: a word, optionally hyphenated (covers custom verbs). */
const METHOD_TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/

/** A `###` line (optional leading whitespace, optional trailing label). */
const SEPARATOR_LINE = /^[ \t]*###/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('#') || t.startsWith('//')
}

/**
 * Is the second token of a request line shaped like a URL? Accepts a
 * scheme-prefixed URL, a leading-slash path, a `{{token}}`, `localhost[:port]`,
 * or a host containing a dot. Conservative by design.
 */
function isUrlShaped(token: string): boolean {
  if (token === '') return false
  if (/^https?:\/\//i.test(token)) return true
  if (token.startsWith('/')) return true
  if (token.startsWith('{{')) return true
  if (/^localhost(:\d+)?([/?]|$)/i.test(token)) return true
  // host.tld[:port][/...|?...] — at least one dot between label characters.
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?([/?]|$)/.test(token)) return true
  return false
}

/**
 * True when `line` looks like an HTTP request line: a method token followed by a
 * URL-shaped token. Used both to anchor separators and to find the request line
 * within a block.
 */
export function isRequestLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false
  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) return false
  if (!METHOD_TOKEN.test(parts[0])) return false
  return isUrlShaped(parts[1])
}

/**
 * Indices of the `###` lines that are confirmed request separators: a `###`
 * line whose next content line — after its same-line label and any following
 * blank / comment lines — is a request line. Lines are LF-split file lines.
 */
export function findRequestSeparators(lines: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!SEPARATOR_LINE.test(lines[i])) continue
    // Look ahead past blank and comment lines for the next content line.
    let j = i + 1
    while (j < lines.length && (lines[j].trim() === '' || isComment(lines[j]))) j += 1
    if (j < lines.length && isRequestLine(lines[j])) out.push(i)
  }
  return out
}
