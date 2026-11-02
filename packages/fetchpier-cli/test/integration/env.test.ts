import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCommand } from '../../src/commands/env/list'
import { currentCommand, currentEnvironment } from '../../src/commands/env/current'

function writeEnv(ws: string, folder: string, id: string = folder): void {
  const dir = join(ws, 'environments', folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ id, name: folder, variables: {} }))
}

describe('fp env', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'fp-envcmd-'))
    mkdirSync(join(ws, '.fetchpier'), { recursive: true })
    writeFileSync(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it('list prints each environment folder name on its own line (CA-17)', async () => {
    writeEnv(ws, 'default')
    writeEnv(ws, 'staging')
    let out = ''
    await listCommand({ workspace: ws }, { env: {}, cwd: '/', write: (s) => (out += s) })
    const lines = out.trim().split('\n').sort()
    expect(lines).toEqual(['default', 'staging'])
  })

  it('list prints the folder, never the opaque identifier (CA-17)', async () => {
    writeEnv(ws, 'default')
    writeEnv(ws, 'staging', '9f1c-4a2e-opaque')
    let out = ''
    await listCommand({ workspace: ws }, { env: {}, cwd: '/', write: (s) => (out += s) })
    const lines = out.trim().split('\n').sort()
    // These are exactly the strings `--env` accepts.
    expect(lines).toEqual(['default', 'staging'])
  })

  it('current prints "default" when nothing is set', () => {
    writeEnv(ws, 'default')
    let out = ''
    currentCommand({ workspace: ws }, { env: {}, cwd: '/', write: (s) => (out += s) })
    expect(out.trim()).toBe('default')
  })

  it('current reflects FETCHPIER_ENV and --env, never WorkspacePrefs', () => {
    expect(currentEnvironment({}, { env: { FETCHPIER_ENV: 'staging' } })).toBe('staging')
    expect(currentEnvironment({ env: 'dev' }, { env: { FETCHPIER_ENV: 'staging' } })).toBe('dev')
    expect(currentEnvironment({}, { env: {} })).toBe('default')
  })
})
