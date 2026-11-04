import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseDotenv,
  readDotenv,
  resolveEnvReferences,
  resolveEnvReferencesDetailed,
  MAX_DOTENV_BYTES
} from './env-source'

describe('parseDotenv', () => {
  it('parses bare KEY=VALUE pairs', () => {
    const { values, warnings } = parseDotenv('FOO=bar\nBAZ=qux')
    expect(values).toEqual({ FOO: 'bar', BAZ: 'qux' })
    expect(warnings).toEqual([])
  })

  it('ignores blank lines and full-line comments', () => {
    const src = ['# header', '', '  # indented comment', 'FOO=bar', ''].join('\n')
    const { values, warnings } = parseDotenv(src)
    expect(values).toEqual({ FOO: 'bar' })
    expect(warnings).toEqual([])
  })

  it('treats a value that starts with # (after trim) as an empty value (REQ §5.2 example)', () => {
    const { values } = parseDotenv(
      'EMPTY=                              # definida con valor "" — sombrea SO'
    )
    expect(values).toEqual({ EMPTY: '' })
  })

  it('handles inline " #" comments only for unquoted values', () => {
    const { values } = parseDotenv(
      [
        'INLINE_COMMENT=plain # this part is a comment',
        'QUOTED_HASH="value # not a comment"',
        "SINGLE_HASH='value # also not a comment'"
      ].join('\n')
    )
    expect(values).toEqual({
      INLINE_COMMENT: 'plain',
      QUOTED_HASH: 'value # not a comment',
      SINGLE_HASH: 'value # also not a comment'
    })
  })

  it('preserves spaces inside double-quoted values (REQ-0067 CA-15)', () => {
    const { values } = parseDotenv('T="ghp_abc def"')
    expect(values).toEqual({ T: 'ghp_abc def' })
  })

  it('supports double-quote escape sequences \\n \\r \\t \\\\ \\"', () => {
    const { values } = parseDotenv(String.raw`MULTI="line1\nline2\ttab\\back\"end"`)
    expect(values).toEqual({ MULTI: 'line1\nline2\ttab\\back"end' })
  })

  it('keeps unknown \\x escapes literal in double-quoted values', () => {
    const { values } = parseDotenv(String.raw`KEEP="\q\z"`)
    expect(values).toEqual({ KEEP: '\\q\\z' })
  })

  it('single-quoted values are literal (no escapes)', () => {
    const { values } = parseDotenv(String.raw`SLACK='https://hooks.slack.com/services/...'`)
    expect(values).toEqual({ SLACK: 'https://hooks.slack.com/services/...' })
  })

  it('KEY=  produces an empty string value', () => {
    const { values } = parseDotenv('A=\nB=""\nC=\'\'')
    expect(values).toEqual({ A: '', B: '', C: '' })
  })

  it('emits a warning for malformed lines and keeps valid ones (CA-14)', () => {
    const src = ['VALID=ok', '=novalid', 'no_equals_sign', 'ANOTHER=fine'].join('\n')
    const { values, warnings } = parseDotenv(src)
    expect(values).toEqual({ VALID: 'ok', ANOTHER: 'fine' })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatchObject({ line: 2 })
    expect(warnings[1]).toMatchObject({ line: 3 })
  })

  it('rejects KEY names that do not match [A-Za-z_][A-Za-z0-9_]*', () => {
    const { values, warnings } = parseDotenv('1FOO=bad\nFOO-BAR=bad\nVALID=ok')
    expect(values).toEqual({ VALID: 'ok' })
    expect(warnings).toHaveLength(2)
  })

  it('duplicate keys: last one wins', () => {
    const { values } = parseDotenv('K=a\nK=b\nK=c')
    expect(values).toEqual({ K: 'c' })
  })

  it('warns on unterminated double-quoted value but keeps what was parsed', () => {
    const { values, warnings } = parseDotenv('UNCLOSED="abc')
    expect(values).toEqual({ UNCLOSED: 'abc' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('unterminated')
  })

  it('warns on unterminated single-quoted value', () => {
    const { warnings } = parseDotenv("UNCLOSED='abc")
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('unterminated')
  })

  it('strips trailing whitespace from unquoted values', () => {
    const { values } = parseDotenv('A=value   ')
    expect(values).toEqual({ A: 'value' })
  })
})

describe('readDotenv', () => {
  let dir: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'core-dotenv-'))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    warnSpy.mockRestore()
  })

  it('returns null silently when .env is absent (CA-13)', async () => {
    const result = await readDotenv(dir)
    expect(result).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns parsed values when .env exists', async () => {
    await fs.writeFile(join(dir, '.env'), 'A=alfa\nB=beta\n', 'utf-8')
    const result = await readDotenv(dir)
    expect(result).toEqual({ A: 'alfa', B: 'beta' })
  })

  it('emits warnings via console.warn for malformed lines', async () => {
    await fs.writeFile(join(dir, '.env'), 'VALID=ok\n=novalid\n', 'utf-8')
    const result = await readDotenv(dir)
    expect(result).toEqual({ VALID: 'ok' })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('refuses files larger than MAX_DOTENV_BYTES and returns null + warn', async () => {
    const big = 'X='.padEnd(MAX_DOTENV_BYTES + 100, 'a')
    await fs.writeFile(join(dir, '.env'), big, 'utf-8')
    const result = await readDotenv(dir)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ENV_FILE_TOO_LARGE'))
  })

  it('rejects UTF-16 BOM as invalid encoding', async () => {
    // UTF-16 LE BOM 0xff 0xfe
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A=alfa', 'utf16le')])
    await fs.writeFile(join(dir, '.env'), utf16)
    const result = await readDotenv(dir)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ENV_FILE_INVALID_ENCODING'))
  })
})

describe('resolveEnvReferences', () => {
  let dir: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'core-envref-'))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    warnSpy.mockRestore()
  })

  it('resolves from process.env when .env is absent (CA-01)', async () => {
    const result = await resolveEnvReferences(
      { apiKey: '{{$env.OPENAI_KEY}}' },
      { workspacePath: dir, processEnv: { OPENAI_KEY: 'sk-real' } }
    )
    expect(result).toEqual({ apiKey: 'sk-real' })
  })

  it('.env wins over process.env (CA-02)', async () => {
    await fs.writeFile(join(dir, '.env'), 'OPENAI_KEY=sk-from-env-file', 'utf-8')
    const result = await resolveEnvReferences(
      { apiKey: '{{$env.OPENAI_KEY}}' },
      { workspacePath: dir, processEnv: { OPENAI_KEY: 'sk-from-shell' } }
    )
    expect(result).toEqual({ apiKey: 'sk-from-env-file' })
  })

  it('empty value in .env shadows process.env (CA-03)', async () => {
    await fs.writeFile(join(dir, '.env'), 'KEY=', 'utf-8')
    const result = await resolveEnvReferences(
      { x: 'Bearer {{$env.KEY}}' },
      { workspacePath: dir, processEnv: { KEY: 'del-shell' } }
    )
    expect(result).toEqual({ x: 'Bearer ' })
  })

  it('missing key in all sources resolves to "" (CA-04)', async () => {
    const result = await resolveEnvReferences(
      { x: 'Bearer {{$env.MISSING}}' },
      { workspacePath: dir, processEnv: {} }
    )
    expect(result).toEqual({ x: 'Bearer ' })
  })

  it('process.env="" resolves to "" (CA-05)', async () => {
    const result = await resolveEnvReferences(
      { x: 'Bearer {{$env.KEY}}' },
      { workspacePath: dir, processEnv: { KEY: '' } }
    )
    expect(result).toEqual({ x: 'Bearer ' })
  })

  it('mixes literals and references (CA-07)', async () => {
    await fs.writeFile(join(dir, '.env'), 'A=alfa\nB=beta\n', 'utf-8')
    const result = await resolveEnvReferences(
      { x: 'prefix-{{$env.A}}-mid-{{$env.B}}-suffix' },
      { workspacePath: dir, processEnv: {} }
    )
    expect(result).toEqual({ x: 'prefix-alfa-mid-beta-suffix' })
  })

  it('single-pass: does not recursively resolve $env in resolved values (CA-08)', async () => {
    await fs.writeFile(join(dir, '.env'), 'A={{$env.B}}\nB=beta\n', 'utf-8')
    const result = await resolveEnvReferences(
      { x: '{{$env.A}}' },
      { workspacePath: dir, processEnv: {} }
    )
    expect(result).toEqual({ x: '{{$env.B}}' })
  })

  it('tolerates whitespace inside the braces ({{ $env.NAME }})', async () => {
    await fs.writeFile(join(dir, '.env'), 'NAME=ok', 'utf-8')
    const result = await resolveEnvReferences(
      { x: '{{ $env.NAME }}' },
      { workspacePath: dir, processEnv: {} }
    )
    expect(result).toEqual({ x: 'ok' })
  })

  it('leaves invalid $env names as literals (no match)', async () => {
    const result = await resolveEnvReferences(
      { x: '{{$env.123-bad}}' },
      { workspacePath: dir, processEnv: {} }
    )
    expect(result).toEqual({ x: '{{$env.123-bad}}' })
  })

  it('does not touch {{varName}} placeholders (no $env. prefix)', async () => {
    const result = await resolveEnvReferences(
      { x: 'Bearer {{token}}' },
      { workspacePath: dir, processEnv: { token: 'should-not-be-used' } }
    )
    expect(result).toEqual({ x: 'Bearer {{token}}' })
  })

  it('does not mutate process.env', async () => {
    const snapshot = { K: 'before' }
    await resolveEnvReferences({ x: '{{$env.K}}' }, { workspacePath: dir, processEnv: snapshot })
    expect(snapshot).toEqual({ K: 'before' })
  })

  it('skips the disk read entirely when no value contains a $env reference', async () => {
    const result = await resolveEnvReferences(
      { x: 'literal', y: 'Bearer {{token}}' },
      { workspacePath: dir, processEnv: {} }
    )
    expect(result).toEqual({ x: 'literal', y: 'Bearer {{token}}' })
  })

  it('returns a copy (does not mutate input)', async () => {
    const input = { x: '{{$env.K}}' }
    await resolveEnvReferences(input, { workspacePath: dir, processEnv: { K: 'v' } })
    expect(input).toEqual({ x: '{{$env.K}}' })
  })
})

describe('resolveEnvReferencesDetailed (CLI hardening)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'core-envref-detail-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports references no source defines, per variable, once each', async () => {
    const { values, undefinedByVariable } = await resolveEnvReferencesDetailed(
      { token: 'Bearer {{$env.MISSING}}{{$env.MISSING}}', ok: '{{$env.SET}}', plain: 'x' },
      { workspacePath: dir, processEnv: { SET: 'v' } }
    )
    expect(values).toEqual({ token: 'Bearer ', ok: 'v', plain: 'x' })
    expect(undefinedByVariable).toEqual({ token: ['MISSING'] })
  })

  it('a name defined empty — in .env or the process — is not undefined', async () => {
    await fs.writeFile(join(dir, '.env'), 'FROM_FILE=\n', 'utf-8')
    const { undefinedByVariable } = await resolveEnvReferencesDetailed(
      { a: '{{$env.FROM_FILE}}', b: '{{$env.FROM_PROCESS}}' },
      { workspacePath: dir, processEnv: { FROM_PROCESS: '' } }
    )
    expect(undefinedByVariable).toEqual({})
  })
})
