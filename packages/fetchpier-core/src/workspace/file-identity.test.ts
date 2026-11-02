// REQ case-insensitive tree name uniqueness — `isSameFile` is the single
// file-identity comparison in the codebase: it answers "are these two paths the
// same physical file?" via the filesystem's own identity (dev+ino), which is
// what makes the case-only rename self-exclusion correct on every platform.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { promises as fs, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSameFile } from './file-identity'

// Runtime probe: does this filesystem treat `a` and `A` as the same entry?
// Decides which branch of the platform-dependent cases below is meaningful.
const probeDir = mkdtempSync(join(tmpdir(), 'case-probe-'))
writeFileSync(join(probeDir, 'a'), '')
const FS_CASE_INSENSITIVE = existsSync(join(probeDir, 'A'))
rmSync(probeDir, { recursive: true, force: true })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'core-file-id-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('reports the same path as the same file', async () => {
  const p = join(dir, 'a.http')
  await fs.writeFile(p, '')
  expect(await isSameFile(p, p)).toBe(true)
})

it('reports two distinct files as different', async () => {
  await fs.writeFile(join(dir, 'a.http'), '')
  await fs.writeFile(join(dir, 'b.http'), '')
  expect(await isSameFile(join(dir, 'a.http'), join(dir, 'b.http'))).toBe(false)
})

it('reports false when either path does not exist', async () => {
  await fs.writeFile(join(dir, 'a.http'), '')
  expect(await isSameFile(join(dir, 'a.http'), join(dir, 'missing.http'))).toBe(false)
  expect(await isSameFile(join(dir, 'missing.http'), join(dir, 'a.http'))).toBe(false)
})

it.runIf(FS_CASE_INSENSITIVE)(
  'reports two casings of one file as the same file (case-insensitive filesystem)',
  async () => {
    await fs.writeFile(join(dir, 'get-users.http'), '')
    expect(await isSameFile(join(dir, 'get-users.http'), join(dir, 'Get-Users.http'))).toBe(true)
  }
)

it.runIf(!FS_CASE_INSENSITIVE)(
  'reports two casing-only siblings as different files (case-sensitive filesystem)',
  async () => {
    await fs.writeFile(join(dir, 'alpha.http'), 'lower')
    await fs.writeFile(join(dir, 'Alpha.http'), 'upper')
    expect(await isSameFile(join(dir, 'alpha.http'), join(dir, 'Alpha.http'))).toBe(false)
  }
)

it('compares directories by identity too', async () => {
  await fs.mkdir(join(dir, 'payments'))
  await fs.mkdir(join(dir, 'archive'))
  expect(await isSameFile(join(dir, 'payments'), join(dir, 'payments'))).toBe(true)
  expect(await isSameFile(join(dir, 'payments'), join(dir, 'archive'))).toBe(false)
})
