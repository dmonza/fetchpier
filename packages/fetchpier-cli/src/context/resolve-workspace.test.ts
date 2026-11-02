import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorkspace, isValidWorkspace } from './resolve-workspace'
import { CliError } from '../errors'
import { EXIT } from '../exit-codes'

function makeWorkspace(root: string): string {
  mkdirSync(join(root, '.fetchpier'), { recursive: true })
  writeFileSync(join(root, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  return root
}

describe('resolveWorkspace', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fp-ws-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('isValidWorkspace requires .fetchpier/settings.json', () => {
    expect(isValidWorkspace(tmp)).toBe(false)
    makeWorkspace(tmp)
    expect(isValidWorkspace(tmp)).toBe(true)
  })

  it('honors --workspace when valid', () => {
    makeWorkspace(tmp)
    expect(resolveWorkspace({ flag: tmp, env: {}, cwd: '/' })).toBe(tmp)
  })

  it('rejects an invalid --workspace with exit 4', () => {
    try {
      resolveWorkspace({ flag: tmp, env: {}, cwd: '/' })
      expect.unreachable()
    } catch (err) {
      expect((err as CliError).exitCode).toBe(EXIT.WORKSPACE)
    }
  })

  it('flag wins over the env var', () => {
    const a = makeWorkspace(mkdtempSync(join(tmpdir(), 'fp-a-')))
    const b = makeWorkspace(mkdtempSync(join(tmpdir(), 'fp-b-')))
    expect(resolveWorkspace({ flag: a, env: { FETCHPIER_WORKSPACE: b }, cwd: '/' })).toBe(a)
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  it('uses FETCHPIER_WORKSPACE when no flag', () => {
    makeWorkspace(tmp)
    expect(resolveWorkspace({ env: { FETCHPIER_WORKSPACE: tmp }, cwd: '/' })).toBe(tmp)
  })

  it('reports the source in the env-var error', () => {
    try {
      resolveWorkspace({ env: { FETCHPIER_WORKSPACE: tmp }, cwd: '/' })
      expect.unreachable()
    } catch (err) {
      expect((err as CliError).message).toContain('from FETCHPIER_WORKSPACE')
    }
  })

  it('discovers the workspace by walking up from cwd', () => {
    makeWorkspace(tmp)
    const deep = join(tmp, 'requests', 'a', 'b')
    mkdirSync(deep, { recursive: true })
    expect(resolveWorkspace({ env: {}, cwd: deep })).toBe(tmp)
  })

  it('throws exit 4 when nothing resolves', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'fp-orphan-'))
    try {
      resolveWorkspace({ env: {}, cwd: orphan })
      expect.unreachable()
    } catch (err) {
      expect((err as CliError).exitCode).toBe(EXIT.WORKSPACE)
    } finally {
      rmSync(orphan, { recursive: true, force: true })
    }
  })
})
