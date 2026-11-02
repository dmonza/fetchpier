// PLAN-0132 (REQ: Core-owned workspace handle) — Phase F0 scaffolding.
// Verifies that the workspace handle (`openWorkspace`) is a faithful façade over
// the existing pure functions (delegation equivalence), is stateless (CA-02), and
// does no eager I/O at construction (CA-03).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Environment, HistoryEntry } from '@shared/types'
import { openWorkspace } from './handle'
import { loadHttpSettings } from './settings-store'
import { readEnvFile, envConfigPath, envDirPath, envFolderPath } from './environments'
import { readTree, requestsRootPath } from './tree'
import * as history from './history'
import { readManifest } from './secrets-store'
import { readLocalValues, localValuesPath, type LocalValuesFile } from '../secrets/local-values'
import { readDotenv, resolveEnvReferences } from './env-source'
import { listBinaries, resolveBinaryRef } from '../requests/binary-store'
import { createWorkspace } from './create'

function buildHistoryEntry(): HistoryEntry {
  return {
    id: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    timestamp: '2026-06-23T10:00:00.000Z',
    sourceFile: 'requests/a.http',
    request: { method: 'GET', url: 'https://example.com', headers: {}, body: '' },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: 'ok',
      timingMs: 10,
      sizeBytes: 2
    }
  }
}

describe('workspace.openWorkspace (handle façade)', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'core-handle-'))
  })
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  // ── CA-03: construction does no eager I/O ───────────────────────────────────
  it('CA-03: openWorkspace does no eager I/O and exposes the resolved path', () => {
    const missing = join(ws, 'does-not-exist-yet')
    const handle = openWorkspace(missing) // must not throw
    expect(handle.path).toBe(resolve(missing))
  })

  it('CA-03: the first real operation is what touches disk (read of a missing env rejects)', async () => {
    const handle = openWorkspace(join(ws, 'nope'))
    await expect(handle.environments.read('default')).rejects.toBeTruthy()
  })

  // ── Delegation equivalence: handle method == pure function ───────────────────
  describe('delegation equivalence', () => {
    it('settings.load/update match the pure functions', async () => {
      await createWorkspace(ws)
      const handle = openWorkspace(ws)
      await handle.settings.update({ verifySsl: false })
      expect(await handle.settings.load()).toEqual(await loadHttpSettings(ws))
    })

    it('environments read/write/create/paths match the pure functions', async () => {
      const handle = openWorkspace(ws)
      const env: Environment = { id: 'dev', folder: 'dev', name: 'Dev', variables: { a: '1' } }
      await handle.environments.write(env)
      expect(await handle.environments.read('dev')).toEqual(
        await readEnvFile(envConfigPath(ws, 'dev'))
      )
      expect(handle.environments.dirPath()).toBe(envDirPath(ws))
      expect(handle.environments.folderPath('dev')).toBe(envFolderPath(ws, 'dev'))
      expect(handle.environments.configPath('dev')).toBe(envConfigPath(ws, 'dev'))

      const created = await handle.environments.create('Staging')
      // Addressed by its folder — the identifier is opaque and is never a path segment.
      expect(created.folder).toBe('staging')
      expect(await readEnvFile(envConfigPath(ws, created.folder))).toEqual(created)
      expect(await handle.environments.resolveFolder(created.id)).toBe('staging')
    })

    it('tree read/requestsRoot match the pure functions', async () => {
      const handle = openWorkspace(ws)
      const root = requestsRootPath(ws)
      await fs.mkdir(join(root, 'col'), { recursive: true })
      await fs.writeFile(join(root, 'a.http'), 'GET https://example.com\n', 'utf-8')
      expect(handle.tree.requestsRoot()).toBe(root)
      expect(await handle.tree.read()).toEqual(await readTree(root))
    })

    it('history save/list/get match the namespace functions', async () => {
      const handle = openWorkspace(ws)
      const entry = buildHistoryEntry()
      await handle.history.save(entry)
      expect(await handle.history.list()).toEqual(await history.list(ws))
      expect(await handle.history.get(entry.id)).toBe(await history.get(ws, entry.id))
    })

    it('secrets manifest + local values match the pure functions', async () => {
      const handle = openWorkspace(ws)
      // The local layer lives inside the environment's folder, resolved from the
      // identifier — so the environment has to exist first.
      await handle.environments.write({ id: 'dev', folder: 'dev', name: 'Dev', variables: {} })
      expect(await handle.secrets.readManifest()).toEqual(await readManifest(ws))
      expect(handle.secrets.localValuesPath('dev')).toBe(localValuesPath(ws, 'dev'))
      const file: LocalValuesFile = { version: 1, variables: { x: 'y' } }
      await handle.secrets.writeLocalValues('dev', file)
      expect(await handle.secrets.readLocalValues('dev')).toEqual(await readLocalValues(ws, 'dev'))
    })

    it('dotenv read + resolveReferences match the pure functions', async () => {
      await fs.writeFile(join(ws, '.env'), 'TOKEN=abc\n', 'utf-8')
      const handle = openWorkspace(ws)
      expect(await handle.dotenv.read()).toEqual(await readDotenv(ws))
      const vars = { auth: '{{$env.TOKEN}}' }
      expect(await handle.dotenv.resolveReferences(vars, {})).toEqual(
        await resolveEnvReferences(vars, { workspacePath: ws, processEnv: {} })
      )
    })

    it('binary list/resolveRef match the pure functions', async () => {
      const handle = openWorkspace(ws)
      expect(await handle.binary.list()).toEqual(await listBinaries(ws))
      const ref = `${'a'.repeat(64)}__file.bin`
      expect(handle.binary.resolveRef(ref)).toBe(resolveBinaryRef(ws, ref))
    })

    it('resolveInside matches resolveInsideWorkspace; atomicWrite is confined', async () => {
      const handle = openWorkspace(ws)
      expect(handle.resolveInside('requests', 'a.http')).toBe(
        join(resolve(ws), 'requests', 'a.http')
      )
      await handle.atomicWrite('requests/x.http', 'GET https://e.com\n')
      expect(await fs.readFile(join(resolve(ws), 'requests', 'x.http'), 'utf-8')).toBe(
        'GET https://e.com\n'
      )
    })

    it('create delegates to createWorkspace over its own path', async () => {
      const handle = openWorkspace(ws)
      const res = await handle.create()
      expect(res).toHaveProperty('gitignoreCreated')
      expect((await fs.stat(join(resolve(ws), '.fetchpier'))).isDirectory()).toBe(true)
    })
  })

  // ── F4–F7 domains added to the handle (delegation smoke) ────────────────────
  describe('F4–F7 domains', () => {
    it('environments list/save/delete via the handle', async () => {
      const handle = openWorkspace(ws)
      await handle.environments.write({ id: 'dev', folder: 'dev', name: 'Dev', variables: {} })
      await handle.environments.save({
        id: 'dev',
        folder: 'dev',
        name: 'Dev',
        variables: { a: '1' }
      })
      expect((await handle.environments.list()).map((e) => e.id)).toEqual(['dev'])
      expect(await handle.environments.listFolders()).toEqual(['dev'])
      await handle.environments.delete('dev')
      expect(await handle.environments.list()).toEqual([])
    })

    it('cookies upsert/list/remove/clear via the handle', async () => {
      const handle = openWorkspace(ws)
      await handle.environments.write({ id: 'dev', folder: 'dev', name: 'Dev', variables: {} })
      const c = await handle.cookies.upsert('dev', {
        name: 'sid',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        expires: null,
        maxAge: null,
        secure: false,
        httpOnly: false,
        sameSite: null,
        hostOnly: true,
        source: 'manual'
      })
      expect((await handle.cookies.list('dev')).map((x) => x.name)).toEqual(['sid'])
      await handle.cookies.remove('dev', c.id)
      expect(await handle.cookies.list('dev')).toEqual([])
    })

    it('tree create/duplicate/findAvailable + fileExists via the handle', async () => {
      const handle = openWorkspace(ws)
      await handle.tree.createCollection('requests', 'auth')
      const reqPath = await handle.tree.createRequest('requests/auth', 'login')
      expect(reqPath.endsWith('login.http')).toBe(true)
      expect(await handle.fileExists('requests/auth/login.http')).toBe(true)
      expect(await handle.fileExists('requests/auth/missing.http')).toBe(false)
      const dup = await handle.tree.duplicate('requests/auth/login.http')
      expect(dup.endsWith('login-copy.http')).toBe(true)
      expect((await handle.tree.findAvailableUntitled(1)).name).toBe('untitled-1')
    })

    it('binary stage/read + readTextFile via the handle', async () => {
      const handle = openWorkspace(ws)
      const src = join(ws, 'source.bin')
      await fs.writeFile(src, Buffer.from([1, 2, 3, 4]))
      const staged = await handle.binary.stage(src)
      expect(Array.from(await handle.binary.read(staged.ref))).toEqual([1, 2, 3, 4])

      await handle.atomicWrite('requests/x.http', 'GET https://e.com\n')
      expect(await handle.readTextFile('requests/x.http')).toBe('GET https://e.com\n')
    })
  })

  // ── CA-02: stateless (no caching) ───────────────────────────────────────────
  it('CA-02: reads are not cached — a second read reflects an external change', async () => {
    await createWorkspace(ws)
    const handle = openWorkspace(ws)
    await handle.settings.update({ verifySsl: true })
    expect((await handle.settings.load()).verifySsl).toBe(true)

    const settingsPath = join(ws, '.fetchpier', 'settings.json')
    const raw = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as {
      http: { verifySsl: boolean }
    }
    raw.http.verifySsl = false
    await fs.writeFile(settingsPath, JSON.stringify(raw), 'utf-8')

    expect((await handle.settings.load()).verifySsl).toBe(false)
  })
})
