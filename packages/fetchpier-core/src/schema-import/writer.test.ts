import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeSchemaToDisk } from './writer'
import type { IntermediateSchema } from '@shared/types'
import { DEFAULT_REQUEST_STATE } from '@shared/types'

function fakeSchema(): IntermediateSchema {
  return {
    title: 'Pets',
    format: 'openapi',
    baseUrl: 'https://petstore.example.com',
    operations: [
      {
        id: 'op-1',
        name: 'listPets',
        displayName: 'List Pets',
        folderPath: ['pets'],
        comment: 'List all pets',
        request: {
          method: 'GET',
          url: 'https://petstore.example.com/pets',
          headers: {}
        },
        editorState: {
          ...DEFAULT_REQUEST_STATE,
          method: 'GET',
          url: 'https://petstore.example.com/pets'
        }
      },
      {
        id: 'op-2',
        name: 'createPet',
        displayName: 'Create Pet',
        folderPath: ['pets'],
        request: {
          method: 'POST',
          url: 'https://petstore.example.com/pets',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name":"a"}'
        },
        editorState: {
          ...DEFAULT_REQUEST_STATE,
          method: 'POST',
          url: 'https://petstore.example.com/pets',
          bodyType: 'raw',
          rawSubtype: 'json',
          body: '{"name":"a"}'
        }
      }
    ]
  }
}

describe('writeSchemaToDisk', () => {
  let workspace: string
  beforeEach(async () => {
    workspace = await fs.mkdtemp(join(tmpdir(), 'orc-schema-writer-'))
  })
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('creates the expected folder structure and files', async () => {
    const result = await writeSchemaToDisk(fakeSchema(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'abort',
      workspacePath: workspace
    })
    expect(result.operationsCreated).toBe(2)
    expect(result.warnings).toHaveLength(0)
    const listFile = join(result.collectionPath, 'pets', 'listPets.http')
    expect((await fs.readFile(listFile, 'utf8')).length).toBeGreaterThan(0)
  })

  it('aborts when target exists and strategy is abort', async () => {
    await fs.mkdir(join(workspace, 'Pets'), { recursive: true })
    await expect(
      writeSchemaToDisk(fakeSchema(), {
        targetFolder: workspace,
        collectionName: 'Pets',
        conflictStrategy: 'abort',
        workspacePath: workspace
      })
    ).rejects.toThrow(/already exists/)
  })

  // CA-04: there is no destructive "replace" — merge never wipes the folder, so
  // unrelated hand-authored requests survive an import into an existing collection.
  it('merge preserves unrelated hand-authored requests in the target collection', async () => {
    await fs.mkdir(join(workspace, 'Pets', 'old'), { recursive: true })
    await fs.writeFile(join(workspace, 'Pets', 'old', 'keep.http'), 'hand-authored', 'utf8')
    const result = await writeSchemaToDisk(fakeSchema(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'merge',
      workspacePath: workspace
    })
    expect(result.operationsCreated).toBe(2)
    const kept = await fs.readFile(join(result.collectionPath, 'old', 'keep.http'), 'utf8')
    expect(kept).toBe('hand-authored')
  })

  it('merge keeps existing files and warns', async () => {
    await fs.mkdir(join(workspace, 'Pets', 'pets'), { recursive: true })
    await fs.writeFile(join(workspace, 'Pets', 'pets', 'listPets.http'), 'existing', 'utf8')
    const result = await writeSchemaToDisk(fakeSchema(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'merge',
      workspacePath: workspace
    })
    expect(result.operationsCreated).toBe(1)
    expect(result.warnings.some((w) => w.kind === 'name-collision')).toBe(true)
    const kept = await fs.readFile(join(workspace, 'Pets', 'pets', 'listPets.http'), 'utf8')
    expect(kept).toBe('existing')
  })

  // Atomic writes — closing the write-safety coverage gap: this writer used
  // to do a direct fs.writeFile with no temp file at all.
  it('retries the rename through a transient error and eventually writes the request (CA-06)', async () => {
    const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
      code: 'EBUSY'
    })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

    const result = await writeSchemaToDisk(fakeSchema(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'abort',
      workspacePath: workspace
    })

    expect(renameSpy).toHaveBeenCalled()
    renameSpy.mockRestore()
    expect(result.operationsCreated).toBe(2)
    const listFile = join(result.collectionPath, 'pets', 'listPets.http')
    expect((await fs.readFile(listFile, 'utf8')).length).toBeGreaterThan(0)
  })
})

describe('writeSchemaToDisk — environment handling', () => {
  let workspace: string
  beforeEach(async () => {
    workspace = await fs.mkdtemp(join(tmpdir(), 'orc-schema-writer-env-'))
    // Mark this as a Fetchpier workspace (for symmetry with real workspaces).
    await fs.mkdir(join(workspace, '.fetchpier'), { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
  })

  function schemaWithVars(): IntermediateSchema {
    return {
      ...fakeSchema(),
      envVariables: { base_url: 'https://api.example.com', id: '1' }
    }
  }

  it('does not touch environments when strategy is none', async () => {
    const result = await writeSchemaToDisk(schemaWithVars(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'abort',
      postman: { environmentStrategy: 'none' },
      workspacePath: workspace
    })
    expect(result.environmentCreated).toBeUndefined()
    expect(result.environmentMerged).toBeUndefined()
    const envDir = join(workspace, 'environments')
    await expect(fs.access(envDir)).rejects.toThrow()
  })

  it('creates a new environment folder when strategy is new', async () => {
    const result = await writeSchemaToDisk(schemaWithVars(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'abort',
      postman: { environmentStrategy: 'new', environmentName: 'RESTful Blueprint' },
      workspacePath: workspace
    })
    expect(result.environmentCreated).toBe('restful-blueprint')
    const raw = await fs.readFile(
      join(workspace, 'environments', 'restful-blueprint', 'config.json'),
      'utf8'
    )
    const env = JSON.parse(raw)
    expect(env.name).toBe('RESTful Blueprint')
    expect(env.variables).toEqual({ base_url: 'https://api.example.com', id: '1' })
  })

  it('throws ENVIRONMENT_NAME_CONFLICT when the derived env folder is taken', async () => {
    const envDir = join(workspace, 'environments')
    await fs.mkdir(join(envDir, 'pets'), { recursive: true })
    await fs.writeFile(
      join(envDir, 'pets', 'config.json'),
      JSON.stringify({ id: 'pets', name: 'Pets', variables: {} }),
      'utf8'
    )
    await expect(
      writeSchemaToDisk(schemaWithVars(), {
        targetFolder: workspace,
        collectionName: 'Pets',
        conflictStrategy: 'abort',
        postman: { environmentStrategy: 'new', environmentName: 'Pets' },
        workspacePath: workspace
      })
    ).rejects.toThrow(/ENVIRONMENT_NAME_CONFLICT/)
  })

  it('merges into an existing environment without overwriting existing vars', async () => {
    const envDir = join(workspace, 'environments')
    await fs.mkdir(join(envDir, 'dev'), { recursive: true })
    await fs.writeFile(
      join(envDir, 'dev', 'config.json'),
      JSON.stringify({
        id: 'dev',
        name: 'Dev',
        variables: { base_url: 'http://localhost:3000', existing_only: 'keep' }
      }),
      'utf8'
    )
    const result = await writeSchemaToDisk(schemaWithVars(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'abort',
      postman: { environmentStrategy: 'merge', mergeEnvironmentId: 'dev' },
      workspacePath: workspace
    })
    expect(result.environmentMerged).toBe('dev')
    const raw = await fs.readFile(join(envDir, 'dev', 'config.json'), 'utf8')
    const env = JSON.parse(raw)
    // existing value wins; new `id` var was added
    expect(env.variables).toEqual({
      base_url: 'http://localhost:3000',
      existing_only: 'keep',
      id: '1'
    })
  })

  // Atomic writes — closing the write-safety coverage gap: the merge branch
  // used to hand-roll its own JSON.stringify + fs.writeFile with no temp file.
  it('leaves the previous environment config intact when the merge write is interrupted (CA-05)', async () => {
    const envDir = join(workspace, 'environments')
    await fs.mkdir(join(envDir, 'dev'), { recursive: true })
    const before = JSON.stringify({
      id: 'dev',
      name: 'Dev',
      variables: { base_url: 'http://localhost:3000', existing_only: 'keep' }
    })
    await fs.writeFile(join(envDir, 'dev', 'config.json'), before, 'utf8')

    // Target only the env-config rename (the operations loop runs first and
    // renames its own `.http` temp files — a blanket `mockRejectedValueOnce`
    // would fail one of those instead).
    const realRename = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes(join('dev', 'config.json'))) {
        throw new Error('ENOSPC: simulated disk full')
      }
      return realRename(from, to)
    })

    const result = await writeSchemaToDisk(schemaWithVars(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'abort',
      postman: { environmentStrategy: 'merge', mergeEnvironmentId: 'dev' },
      workspacePath: workspace
    })
    renameSpy.mockRestore()

    // The merge failure is reported as a warning (existing contract), not thrown.
    expect(result.environmentMerged).toBeUndefined()
    expect(result.warnings.some((w) => w.kind === 'other')).toBe(true)
    const raw = await fs.readFile(join(envDir, 'dev', 'config.json'), 'utf8')
    expect(raw).toBe(before)
  })

  it('emits a warning when merge target is missing', async () => {
    const result = await writeSchemaToDisk(schemaWithVars(), {
      targetFolder: workspace,
      collectionName: 'Pets',
      conflictStrategy: 'abort',
      postman: { environmentStrategy: 'merge', mergeEnvironmentId: 'ghost' },
      workspacePath: workspace
    })
    expect(result.environmentMerged).toBeUndefined()
    expect(result.warnings.some((w) => w.message.includes('ghost'))).toBe(true)
  })
})
