/**
 * `.env` reading + resolution of `{{$env.NAME}}` references inside the values
 * of environment variables (REQ-0067).
 *
 * Source chain per resolution: dotenv file in the workspace root (if any) >
 * `process.env[NAME]` > empty string. The resolution is single-pass: the result
 * of substituting `$env.*` is not re-scanned for further references.
 *
 * Pure except for `readDotenv` (single file read with defensive degradation).
 * No side effects on `process.env`.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** Maximum allowed size for `.env` in bytes (1 MiB). */
export const MAX_DOTENV_BYTES = 1024 * 1024

/** Dotenv KEY pattern. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `{{$env.NAME}}` reference pattern. Whitespace inside the braces is tolerated
 * around the whole token but not inside the `$env.NAME` itself.
 */
const ENV_REF_PATTERN = /\{\{\s*\$env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
/** Same as {@link ENV_REF_PATTERN} without `/g`, for use with `.test()`. */
const ENV_REF_PROBE = /\{\{\s*\$env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/

export interface DotenvParseWarning {
  /** 1-based line number where the warning originated. */
  line: number
  message: string
}

export interface DotenvParseResult {
  values: Record<string, string>
  warnings: DotenvParseWarning[]
}

/**
 * Parses the dotenv subset documented in REQ-0067 §5.2.
 *
 * Recognized: `KEY=VALUE`, double-quoted values with `\n \r \t \\ \"` escapes,
 * single-quoted literal values, full-line `#` comments, inline ` #` comments
 * for unquoted values, blank lines. Duplicate keys: last one wins.
 *
 * Malformed lines are recorded as warnings; the remaining valid lines apply.
 * No variable expansion (`$OTHER`, `${OTHER}` are literal).
 */
export function parseDotenv(content: string): DotenvParseResult {
  const values: Record<string, string> = {}
  const warnings: DotenvParseWarning[] = []

  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const lineNo = i + 1

    const leading = rawLine.replace(/^[ \t]+/, '')
    if (leading.length === 0) continue
    if (leading.startsWith('#')) continue

    const eqIdx = rawLine.indexOf('=')
    if (eqIdx === -1) {
      warnings.push({ line: lineNo, message: 'missing "=" separator' })
      continue
    }

    const rawKey = rawLine.substring(0, eqIdx).trim()
    if (!KEY_PATTERN.test(rawKey)) {
      warnings.push({ line: lineNo, message: `invalid key: "${rawKey}"` })
      continue
    }

    const rawVal = rawLine.substring(eqIdx + 1)
    const parsed = parseValue(rawVal, lineNo)
    if (parsed.warning) warnings.push(parsed.warning)
    values[rawKey] = parsed.value
  }

  return { values, warnings }
}

function parseValue(raw: string, lineNo: number): { value: string; warning?: DotenvParseWarning } {
  const stripped = raw.replace(/^[ \t]+/, '')
  if (stripped.length === 0) return { value: '' }

  const first = stripped[0]

  if (first === '"') {
    return parseDoubleQuoted(stripped, lineNo)
  }
  if (first === "'") {
    return parseSingleQuoted(stripped, lineNo)
  }
  if (first === '#') {
    return { value: '' }
  }

  const cmtIdx = stripped.indexOf(' #')
  const cut = cmtIdx === -1 ? stripped : stripped.substring(0, cmtIdx)
  return { value: cut.replace(/[ \t]+$/, '') }
}

function parseDoubleQuoted(
  s: string,
  lineNo: number
): { value: string; warning?: DotenvParseWarning } {
  let out = ''
  let i = 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1]
      if (next === 'n') out += '\n'
      else if (next === 'r') out += '\r'
      else if (next === 't') out += '\t'
      else if (next === '\\') out += '\\'
      else if (next === '"') out += '"'
      else out += '\\' + next
      i += 2
      continue
    }
    if (ch === '"') {
      return { value: out }
    }
    out += ch
    i++
  }
  return {
    value: out,
    warning: { line: lineNo, message: 'unterminated double-quoted value' }
  }
}

function parseSingleQuoted(
  s: string,
  lineNo: number
): { value: string; warning?: DotenvParseWarning } {
  const closing = s.indexOf("'", 1)
  if (closing === -1) {
    return {
      value: s.substring(1),
      warning: { line: lineNo, message: 'unterminated single-quoted value' }
    }
  }
  return { value: s.substring(1, closing) }
}

/**
 * Reads `<workspacePath>/.env` and returns its parsed values, or `null` if the
 * file is absent / unreadable / too large / not UTF-8.
 *
 * Errors degrade gracefully: any non-`ENOENT` failure emits a `console.warn`
 * and returns `null`. Absent file is silent — a missing `.env` is a normal,
 * supported state.
 */
export async function readDotenv(workspacePath: string): Promise<Record<string, string> | null> {
  const filePath = join(workspacePath, '.env')

  let stat
  try {
    stat = await fs.stat(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.warn(`[env-source] cannot stat .env: ${(err as Error).message}`)
    return null
  }

  if (!stat.isFile()) {
    console.warn('[env-source] .env exists but is not a regular file; ignoring')
    return null
  }

  if (stat.size > MAX_DOTENV_BYTES) {
    console.warn(
      `[env-source] ENV_FILE_TOO_LARGE: .env exceeds ${MAX_DOTENV_BYTES} bytes (${stat.size}); ignoring`
    )
    return null
  }

  let content: string
  try {
    const buf = await fs.readFile(filePath)
    // node's utf-8 decoder is permissive; reject if it produced replacement
    // characters when the source clearly was not UTF-8 (e.g. UTF-16 BOM).
    if (
      buf.length >= 2 &&
      ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
    ) {
      console.warn('[env-source] ENV_FILE_INVALID_ENCODING: .env appears to be UTF-16; ignoring')
      return null
    }
    content = buf.toString('utf-8')
  } catch (err) {
    console.warn(`[env-source] failed to read .env: ${(err as Error).message}`)
    return null
  }

  const { values, warnings } = parseDotenv(content)
  for (const w of warnings) {
    console.warn(`[env-source] .env line ${w.line}: ${w.message}`)
  }
  return values
}

export interface ResolveEnvReferencesOptions {
  workspacePath: string
  /** Defaults to `process.env`. Tests inject a snapshot. */
  processEnv?: NodeJS.ProcessEnv
}

/**
 * Substitutes every `{{$env.NAME}}` occurrence in each value of `variables`
 * with a string from the source chain: dotenv > processEnv > "".
 *
 * Single-pass: if the substituted result contains another `{{$env.X}}`, that
 * inner reference is **not** re-resolved. References that never appear in any
 * source resolve to `""` (the request goes out with a hole; the user debugs
 * via server response). References whose name does not match `[A-Za-z_]\w*`
 * are left as literals.
 *
 * Reads `.env` at most once per invocation.
 */
export async function resolveEnvReferences(
  variables: Record<string, string>,
  options: ResolveEnvReferencesOptions
): Promise<Record<string, string>> {
  // Short-circuit when there is nothing to do — avoid the disk read.
  let needsReadDotenv = false
  for (const value of Object.values(variables)) {
    if (typeof value === 'string' && ENV_REF_PROBE.test(value)) {
      needsReadDotenv = true
      break
    }
  }
  if (!needsReadDotenv) return { ...variables }

  const dotenv = await readDotenv(options.workspacePath)
  const processEnv = options.processEnv ?? process.env

  const lookup = (name: string): string => {
    if (dotenv && Object.prototype.hasOwnProperty.call(dotenv, name)) {
      return dotenv[name]
    }
    const v = processEnv[name]
    return v ?? ''
  }

  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(variables)) {
    if (typeof v !== 'string') {
      out[k] = v
      continue
    }
    out[k] = v.replace(ENV_REF_PATTERN, (_match, name: string) => lookup(name))
  }
  return out
}
