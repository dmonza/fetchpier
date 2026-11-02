// Pretty-printers and a tiny content sniffer used by the response viewer.
//
// All functions are total: on malformed/unexpected input they return the
// original string (or `null` for the sniffer) instead of throwing — the viewer
// should always be able to show *something*.

import type { CodeMirrorLanguage } from '../hooks/useCodeMirror'

const INDENT = '  '

/** Re-indent JSON with 2-space indentation. Returns `raw` if it isn't valid JSON. */
export function prettyPrintJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * Split an XML string into a flat list of nodes: tags (`<…>`, including
 * comments / CDATA / PIs / doctype) and the trimmed text between them.
 * Whitespace-only text is dropped. Returns `null` if an open construct
 * (`<!-- …`, `<![CDATA[ …`, `< …`) is never closed.
 */
function tokenizeXml(src: string): string[] | null {
  const tokens: string[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    if (src[i] === '<') {
      let end: number
      if (src.startsWith('<!--', i)) {
        end = src.indexOf('-->', i + 4)
        if (end === -1) return null
        end += 3
      } else if (src.startsWith('<![CDATA[', i)) {
        end = src.indexOf(']]>', i + 9)
        if (end === -1) return null
        end += 3
      } else {
        end = src.indexOf('>', i + 1)
        if (end === -1) return null
        end += 1
      }
      tokens.push(src.slice(i, end))
      i = end
    } else {
      const lt = src.indexOf('<', i)
      const end = lt === -1 ? n : lt
      const text = src.slice(i, end).trim()
      if (text) tokens.push(text)
      i = end
    }
  }
  return tokens
}

const openTagName = (s: string): string => /^<\s*([^\s/>]+)/.exec(s)?.[1] ?? ''
const closeTagName = (s: string): string => /^<\/\s*([^\s>]+)/.exec(s)?.[1] ?? ''

/**
 * Re-indent an XML document for readability — pure string processing, no DOM
 * and no parser. Deliberately forgiving: any anomaly (unbalanced tags, depth
 * underflow, unterminated construct) makes it return `raw` untouched. Idempotent
 * on input that is already pretty-printed.
 *
 * Caveat: significant whitespace in mixed content is collapsed (standard
 * pretty-print tradeoff), and a `<!DOCTYPE …>` with an internal subset that
 * contains `>` is not handled.
 */
export function prettyPrintXml(raw: string): string {
  const src = raw.trim()
  if (!src.startsWith('<')) return raw
  try {
    const tokens = tokenizeXml(src)
    if (!tokens || tokens.length === 0) return raw

    const out: string[] = []
    let depth = 0
    const pad = (): string => INDENT.repeat(depth)

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]

      if (!tok.startsWith('<')) {
        // Bare text node (mixed content).
        out.push(pad() + tok)
        continue
      }

      const isComment = tok.startsWith('<!--')
      const isCData = tok.startsWith('<![CDATA[')
      const isDecl = tok.startsWith('<?') || tok.startsWith('<!') // <?xml?>, <!DOCTYPE>, …
      const isClosing = tok.startsWith('</')
      const isSelfClosing = tok.endsWith('/>') || isComment || isCData || isDecl

      if (isClosing) {
        depth--
        if (depth < 0) return raw
        out.push(pad() + tok)
        continue
      }

      if (!isSelfClosing) {
        const name = openTagName(tok)
        // Keep short element content on a single line:
        //   <a></a>   or   <a>text</a>
        const next: string | undefined = tokens[i + 1]
        if (next !== undefined && next.startsWith('</') && closeTagName(next) === name) {
          out.push(pad() + tok + next)
          i += 1
          continue
        }
        const afterNext: string | undefined = tokens[i + 2]
        if (
          next !== undefined &&
          !next.startsWith('<') &&
          afterNext !== undefined &&
          afterNext.startsWith('</') &&
          closeTagName(afterNext) === name
        ) {
          out.push(pad() + tok + next + afterNext)
          i += 2
          continue
        }
      }

      out.push(pad() + tok)
      if (!isSelfClosing) depth++
    }

    if (depth !== 0) return raw
    return out.join('\n')
  } catch {
    return raw
  }
}

/**
 * Best-effort language guess from the body alone — used when the response has a
 * generic or missing `Content-Type`. Returns `null` when nothing matches.
 */
export function sniffLanguage(body: string): CodeMirrorLanguage | null {
  const t = body.trimStart()
  if (!t) return null
  if (t.startsWith('<')) {
    const head = t.slice(0, 256).toLowerCase()
    if (head.startsWith('<!doctype html') || /^<html[\s/>]/.test(head)) return 'html'
    return 'xml'
  }
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  return null
}
