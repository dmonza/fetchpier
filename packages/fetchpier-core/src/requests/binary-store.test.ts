import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSafeRef,
  buildRef,
  hashBuffer,
  listBinaries,
  lookupMimeType,
  removeBinary,
  resolveBinaryRef,
  sanitizeOriginalName,
  stageBinary,
  statBinary
} from './binary-store'

describe('binary-store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'core-bin-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('hashBuffer', () => {
    it('produces a deterministic lowercase hex sha256', () => {
      const hex = hashBuffer(Buffer.from('hello'))
      expect(hex).toMatch(/^[a-f0-9]{64}$/)
      expect(hashBuffer(Buffer.from('hello'))).toBe(hex)
    })

    it('differs for different content', () => {
      expect(hashBuffer(Buffer.from('a'))).not.toBe(hashBuffer(Buffer.from('b')))
    })
  })

  describe('sanitizeOriginalName', () => {
    it('keeps safe characters', () => {
      expect(sanitizeOriginalName('report-2026.pdf')).toBe('report-2026.pdf')
      expect(sanitizeOriginalName('My File.png')).toBe('My File.png')
    })

    it('strips path separators', () => {
      expect(sanitizeOriginalName('../../../etc/passwd')).toBe('passwd')
      expect(sanitizeOriginalName('C:\\Users\\me\\file.txt')).toBe('file.txt')
    })

    // Both separators are stripped on every platform, so these assertions hold
    // identically on Windows, macOS and Linux. Guards the portability promise:
    // with `path.basename` the Windows path above yielded `file.txt` on Windows
    // and `C__Users_me_file.txt` on POSIX — one attachment, two refs.
    it('strips path separators the same way on every platform', () => {
      expect(sanitizeOriginalName('a/b\\c/d.txt')).toBe('d.txt')
      expect(sanitizeOriginalName('\\\\server\\share\\doc.pdf')).toBe('doc.pdf')
    })

    it('replaces Windows-reserved characters with underscore', () => {
      // `:` mid-string is now deterministic. It used to be excluded here: with
      // `path.basename`, Windows read `a:` as a drive-letter prefix and dropped
      // it before the sanitizer saw the input, so `a:b.txt` gave `b.txt` there
      // and `a_b.txt` on POSIX. Splitting on separators only leaves `:` to the
      // character class, which is the same everywhere.
      expect(sanitizeOriginalName('q<r>s|t.bin')).toBe('q_r_s_t.bin')
      expect(sanitizeOriginalName('a?b*c.txt')).toBe('a_b_c.txt')
      expect(sanitizeOriginalName('a:b.txt')).toBe('a_b.txt')
    })

    it('replaces control characters', () => {
      expect(sanitizeOriginalName('file\u0000name.bin')).toBe('file_name.bin')
    })

    it('trims leading/trailing dots', () => {
      expect(sanitizeOriginalName('.hidden')).toBe('hidden')
      expect(sanitizeOriginalName('weird.')).toBe('weird')
    })

    it('falls back to "file" when the input degenerates to empty', () => {
      expect(sanitizeOriginalName('....')).toBe('file')
      expect(sanitizeOriginalName('')).toBe('file')
    })
  })

  describe('assertSafeRef', () => {
    const validHash = 'a'.repeat(64)

    it('accepts well-formed refs', () => {
      expect(assertSafeRef(`${validHash}__hello.txt`)).toBe(`${validHash}__hello.txt`)
    })

    it.each([
      'short',
      `${validHash}_hello.txt`, // single underscore
      `${'g'.repeat(64)}__hello.txt`, // non-hex
      `${validHash}__`, // empty suffix
      `${validHash}__../escape`,
      `${validHash}__sub/path`,
      `${validHash}__sub\\path`,
      `${validHash}__null\u0000byte`
    ])('rejects %s', (ref) => {
      expect(() => assertSafeRef(ref as string)).toThrow(/Unsafe binary file ref/)
    })

    it('rejects non-string input', () => {
      // @ts-expect-error testing runtime guard
      expect(() => assertSafeRef(42)).toThrow()
    })
  })

  describe('lookupMimeType', () => {
    it('derives common extensions', () => {
      expect(lookupMimeType('a.json')).toBe('application/json')
      expect(lookupMimeType('a.png')).toBe('image/png')
      expect(lookupMimeType('a.pdf')).toBe('application/pdf')
    })

    it('falls back to application/octet-stream for unknown or missing extensions', () => {
      expect(lookupMimeType('a.zzzzz')).toBe('application/octet-stream')
      expect(lookupMimeType('noext')).toBe('application/octet-stream')
    })
  })

  describe('stageBinary', () => {
    it('writes the file under requests/.files/ with a content-addressed name', async () => {
      const src = join(dir, 'hello.txt')
      await fs.writeFile(src, 'hello world')
      const result = await stageBinary(dir, src)
      expect(result.ref).toMatch(/^[a-f0-9]{64}__hello\.txt$/)
      expect(result.originalName).toBe('hello.txt')
      expect(result.sizeBytes).toBe(Buffer.byteLength('hello world'))
      expect(result.mimeType).toBe('text/plain')
      const onDisk = await fs.readFile(result.absolutePath, 'utf-8')
      expect(onDisk).toBe('hello world')
    })

    it('dedupes when the same content is staged twice', async () => {
      const src1 = join(dir, 'a.txt')
      const src2 = join(dir, 'b.txt')
      await fs.writeFile(src1, 'same content')
      await fs.writeFile(src2, 'same content')
      const r1 = await stageBinary(dir, src1)
      const r2 = await stageBinary(dir, src2)
      // Same hash but different sanitized name → distinct refs.
      expect(r1.ref).not.toBe(r2.ref)
      expect(r1.ref.split('__')[0]).toBe(r2.ref.split('__')[0])
    })

    it('idempotent re-stage of the same path does not re-write the target', async () => {
      const src = join(dir, 'idem.bin')
      await fs.writeFile(src, Buffer.from([0xde, 0xad, 0xbe, 0xef]))
      const first = await stageBinary(dir, src)
      const stat1 = await fs.stat(first.absolutePath)
      await new Promise((r) => setTimeout(r, 5))
      const second = await stageBinary(dir, src)
      const stat2 = await fs.stat(second.absolutePath)
      expect(second.ref).toBe(first.ref)
      expect(stat2.mtimeMs).toBe(stat1.mtimeMs)
    })

    it('sanitizes the source filename when staging', async () => {
      const src = join(dir, 'odd name.txt')
      await fs.writeFile(src, 'x')
      const result = await stageBinary(dir, src)
      expect(result.originalName).toBe('odd name.txt')
      expect(result.ref).toMatch(/^[a-f0-9]{64}__odd name\.txt$/)
    })

    // Atomic writes — closing the write-safety coverage gap: this writer used
    // to do a direct fs.writeFile with no temp file at all.
    it('retries the rename through a transient error and still stages the file (CA-06)', async () => {
      const src = join(dir, 'retry.txt')
      await fs.writeFile(src, 'hello world')
      const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
        code: 'EBUSY'
      })
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

      const result = await stageBinary(dir, src)

      expect(renameSpy).toHaveBeenCalled()
      renameSpy.mockRestore()
      const onDisk = await fs.readFile(result.absolutePath, 'utf-8')
      expect(onDisk).toBe('hello world')
    })
  })

  describe('resolveBinaryRef', () => {
    it('returns the absolute path inside the workspace', async () => {
      const ref = buildRef('a'.repeat(64), 'hello.txt')
      const p = resolveBinaryRef(dir, ref)
      expect(p.endsWith(join('requests', '.files', ref))).toBe(true)
    })

    it('throws for malformed refs', () => {
      expect(() => resolveBinaryRef(dir, 'short')).toThrow()
      expect(() => resolveBinaryRef(dir, 'a'.repeat(64) + '__../etc/passwd')).toThrow()
    })
  })

  describe('removeBinary', () => {
    it('deletes a staged file and returns true', async () => {
      const src = join(dir, 'tmp.txt')
      await fs.writeFile(src, 'gone')
      const staged = await stageBinary(dir, src)
      const removed = await removeBinary(dir, staged.ref)
      expect(removed).toBe(true)
      await expect(fs.access(staged.absolutePath)).rejects.toThrow()
    })

    it('returns false when the ref does not exist on disk', async () => {
      const ref = buildRef('b'.repeat(64), 'nope.txt')
      expect(await removeBinary(dir, ref)).toBe(false)
    })

    it('throws on malformed refs (cannot remove what we cannot safely resolve)', async () => {
      await expect(removeBinary(dir, 'short')).rejects.toThrow()
    })
  })

  describe('statBinary', () => {
    it('returns size and mime for an existing staged file', async () => {
      const src = join(dir, 'doc.json')
      await fs.writeFile(src, '{"ok":true}')
      const staged = await stageBinary(dir, src)
      const stat = await statBinary(dir, staged.ref)
      expect(stat.exists).toBe(true)
      expect(stat.sizeBytes).toBe(11)
      expect(stat.mimeType).toBe('application/json')
    })

    it('reports exists: false for a missing ref', async () => {
      const ref = buildRef('c'.repeat(64), 'missing.png')
      const stat = await statBinary(dir, ref)
      expect(stat.exists).toBe(false)
    })

    it('reports exists: false for a malformed ref (cannot resolve safely)', async () => {
      const stat = await statBinary(dir, 'not-a-ref')
      expect(stat.exists).toBe(false)
    })
  })

  describe('listBinaries', () => {
    it('returns [] when the workspace has no .files/ directory yet', async () => {
      expect(await listBinaries(dir)).toEqual([])
    })

    it('returns staged files with original name, size, mime and mtime', async () => {
      const src = join(dir, 'doc.json')
      await fs.writeFile(src, '{"ok":true}')
      const staged = await stageBinary(dir, src)
      const list = await listBinaries(dir)
      expect(list).toHaveLength(1)
      expect(list[0].ref).toBe(staged.ref)
      expect(list[0].originalName).toBe('doc.json')
      expect(list[0].sizeBytes).toBe(11)
      expect(list[0].mimeType).toBe('application/json')
      expect(typeof list[0].mtimeMs).toBe('number')
    })

    it('sorts by mtime descending (most recent first)', async () => {
      const a = join(dir, 'a.txt')
      const b = join(dir, 'b.txt')
      await fs.writeFile(a, 'first')
      await stageBinary(dir, a)
      await new Promise((r) => setTimeout(r, 10))
      await fs.writeFile(b, 'second')
      await stageBinary(dir, b)
      const list = await listBinaries(dir)
      expect(list.map((e) => e.originalName)).toEqual(['b.txt', 'a.txt'])
    })

    it('ignores entries that do not match the ref pattern', async () => {
      const src = join(dir, 'real.txt')
      await fs.writeFile(src, 'real')
      await stageBinary(dir, src)
      // Drop a stray file in the same dir.
      const filesDir = join(dir, 'requests', '.files')
      await fs.writeFile(join(filesDir, 'README.md'), 'not a staged file')
      await fs.writeFile(join(filesDir, 'shorthash__name.bin'), 'malformed ref')
      const list = await listBinaries(dir)
      expect(list).toHaveLength(1)
      expect(list[0].originalName).toBe('real.txt')
    })
  })
})
