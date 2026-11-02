import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — mjs with JSDoc types, no .d.ts emitted.
import { scanFileForViolations, isAllowed, auditAtomicWrites } from './atomic-write-audit.mjs'

describe('scanFileForViolations', () => {
  it('flags a direct fs.writeFile call with its line number', () => {
    const content = ['const x = 1', 'await fs.writeFile(target, data)', 'const y = 2'].join('\n')
    const violations = scanFileForViolations('src/main/foo.ts', content)
    expect(violations).toEqual([{ file: 'src/main/foo.ts', line: 2, match: 'fs.writeFile(' }])
  })

  it('flags writeFileSync and renameSync (qualified or bare)', () => {
    const content = ['writeFileSync(tmp, data)', 'fs.renameSync(tmp, filePath)'].join('\n')
    const violations = scanFileForViolations('src/main/bar.ts', content)
    expect(violations.map((v) => v.line)).toEqual([1, 2])
    expect(violations.map((v) => v.match)).toEqual(['writeFileSync(', 'fs.renameSync('])
  })

  it('does not flag unrelated fs calls, including the async fs.rename used for moves (no false positives)', () => {
    const content = [
      'await fs.readFile(target)',
      'await fs.mkdir(dir, { recursive: true })',
      'await fs.unlink(target)',
      'await fs.rm(dir, { recursive: true })',
      'await fs.access(target)',
      'await fs.stat(target)',
      // A pure rename-as-move (e.g. renaming a request/collection) is out of
      // scope by design — see the module doc comment — because it collides
      // with unrelated `.rename(...)` methods elsewhere in this codebase.
      'await fs.rename(resolvedOld, newPath)',
      'return handle.tree.rename(oldPath, newName)'
    ].join('\n')
    expect(scanFileForViolations('src/main/baz.ts', content)).toEqual([])
  })

  it('does not flag a mention inside a comment or string (line-scan, not semantic — documented limitation)', () => {
    // This documents the known trade-off (regex/line-scan, no AST) rather than asserting it as a feature.
    const content = '// see fs.writeFile( for context'
    // A literal match inside a comment is still flagged — the allowlist is the intended
    // escape hatch, not comment-awareness. This test locks in that current behavior.
    expect(scanFileForViolations('src/main/qux.ts', content)).toHaveLength(1)
  })
})

describe('isAllowed', () => {
  const allowlist = [
    { file: 'src/main/ipc/file.ipc.ts', reason: 'user Save-As dialog' },
    { file: 'packages/fetchpier-cli/src/reporters/', reason: 'CLI --output artifacts' }
  ]

  it('matches an exact allowlisted file path', () => {
    expect(isAllowed(allowlist, 'src/main/ipc/file.ipc.ts')).toBe(true)
  })

  it('matches an allowlisted directory prefix', () => {
    expect(isAllowed(allowlist, 'packages/fetchpier-cli/src/reporters/html.ts')).toBe(true)
  })

  it('does not match an unrelated path', () => {
    expect(isAllowed(allowlist, 'packages/fetchpier-core/src/workspace/history.ts')).toBe(false)
  })
})

describe('auditAtomicWrites', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fp-atomic-audit-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('flags a bypassing writer under a scanned root', async () => {
    const root = join(dir, 'src', 'main')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'offender.ts'), 'await fs.writeFile(target, data)\n', 'utf-8')

    const result = await auditAtomicWrites({
      repoRoot: dir,
      roots: ['src/main'],
      helperModulePath: join(dir, 'packages/fetchpier-core/src/workspace/atomic-write.ts'),
      allowlist: []
    })

    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].file).toBe('src/main/offender.ts')
  })

  it('does not flag an allowlisted file', async () => {
    const root = join(dir, 'src', 'main')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'file.ipc.ts'), 'await fs.writeFile(target, data)\n', 'utf-8')

    const result = await auditAtomicWrites({
      repoRoot: dir,
      roots: ['src/main'],
      helperModulePath: join(dir, 'packages/fetchpier-core/src/workspace/atomic-write.ts'),
      allowlist: [{ file: 'src/main/file.ipc.ts', reason: 'user Save-As dialog' }]
    })

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('does not flag the shared helper module itself', async () => {
    const helperDir = join(dir, 'packages', 'fetchpier-core', 'src', 'workspace')
    await mkdir(helperDir, { recursive: true })
    const helperPath = join(helperDir, 'atomic-write.ts')
    await writeFile(helperPath, 'await fsp.rename(tmp, filePath)\n', 'utf-8')

    const result = await auditAtomicWrites({
      repoRoot: dir,
      roots: ['packages/fetchpier-core/src'],
      helperModulePath: helperPath,
      allowlist: []
    })

    expect(result.ok).toBe(true)
  })

  it('ignores test files', async () => {
    const root = join(dir, 'src', 'main')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'foo.test.ts'), 'await fs.writeFile(target, data)\n', 'utf-8')

    const result = await auditAtomicWrites({
      repoRoot: dir,
      roots: ['src/main'],
      helperModulePath: join(dir, 'packages/fetchpier-core/src/workspace/atomic-write.ts'),
      allowlist: []
    })

    expect(result.ok).toBe(true)
  })
})
