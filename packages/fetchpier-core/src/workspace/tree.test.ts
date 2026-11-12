import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRequestIds, readTree } from './tree'
import type { WorkspaceTree } from '@shared/types'

async function write(
  dir: string,
  rel: string,
  content = 'GET https://example.com\n'
): Promise<void> {
  const full = join(dir, rel)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}

function byName(nodes: WorkspaceTree[], name: string): WorkspaceTree | undefined {
  return nodes.find((n) => n.name === name)
}

describe('readTree — request instances grouping', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'core-tree-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('tags regular requests with kind "request" and folders with kind "folder"', async () => {
    await write(root, 'login.http')
    await fs.mkdir(join(root, 'auth'), { recursive: true })
    const tree = await readTree(root)
    expect(byName(tree, 'auth')?.kind).toBe('folder')
    expect(byName(tree, 'login.http')?.kind).toBe('request')
  })

  it('groups an instance file as a child of its parent request', async () => {
    await write(root, 'login.http')
    await write(root, 'login.happy-path.instance.http')
    await write(root, 'login.error-401.instance.http')
    const tree = await readTree(root)

    // Only the parent is a top-level node; instances are not top-level.
    expect(tree.map((n) => n.name)).toEqual(['login.http'])
    const parent = byName(tree, 'login.http')!
    expect(parent.kind).toBe('request')
    expect(parent.children?.map((c) => c.name)).toEqual([
      'login.error-401.instance.http',
      'login.happy-path.instance.http'
    ])
    for (const child of parent.children ?? []) {
      expect(child.kind).toBe('instance')
    }
  })

  it('sorts instance children alphabetically by filename', async () => {
    await write(root, 'login.http')
    await write(root, 'login.zeta.instance.http')
    await write(root, 'login.alpha.instance.http')
    const tree = await readTree(root)
    const parent = byName(tree, 'login.http')!
    expect(parent.children?.map((c) => c.name)).toEqual([
      'login.alpha.instance.http',
      'login.zeta.instance.http'
    ])
  })

  it('renders an orphan instance (no parent in the directory) as a top-level instance node', async () => {
    await write(root, 'login.happy-path.instance.http')
    const tree = await readTree(root)
    const orphan = byName(tree, 'login.happy-path.instance.http')
    expect(orphan).toBeDefined()
    expect(orphan?.kind).toBe('instance')
    expect(orphan?.children).toBeUndefined()
  })

  it('binds to the longest matching parent stem', async () => {
    await write(root, 'login.http')
    await write(root, 'login.v2.http')
    await write(root, 'login.v2.happy-path.instance.http')
    const tree = await readTree(root)
    // Should bind to login.v2.http, not login.http
    expect(byName(tree, 'login.v2.http')?.children?.map((c) => c.name)).toEqual([
      'login.v2.happy-path.instance.http'
    ])
    expect(byName(tree, 'login.http')?.children).toBeUndefined()
  })

  it('groups instances inside nested folders', async () => {
    await write(root, 'auth/login.http')
    await write(root, 'auth/login.ok.instance.http')
    const tree = await readTree(root)
    const folder = byName(tree, 'auth')!
    expect(folder.children?.map((c) => c.name)).toEqual(['login.http'])
    expect(byName(folder.children!, 'login.http')?.children?.map((c) => c.name)).toEqual([
      'login.ok.instance.http'
    ])
  })

  it('keeps folders first, then files (regular + orphan instances) alphabetically', async () => {
    await fs.mkdir(join(root, 'zebra'), { recursive: true })
    await write(root, 'apple.http')
    await write(root, 'orphan.x.instance.http')
    const tree = await readTree(root)
    expect(tree.map((n) => n.name)).toEqual(['zebra', 'apple.http', 'orphan.x.instance.http'])
  })
})

describe('collectRequestIds — reads the @id the parser recognizes', () => {
  const ID_A = '550e8400-e29b-41d4-a716-446655440000'
  const ID_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'core-tree-ids-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('collects an @id that follows comments and blank lines in the leading block', async () => {
    await write(root, 'requests/a.http', `# Users API\n\n# @id ${ID_A}\nGET https://example.com\n`)
    await write(root, 'requests/b.http', `\r\n# @id ${ID_B}\r\nGET https://example.com\r\n`)
    expect([...(await collectRequestIds(root))].sort()).toEqual([ID_A, ID_B].sort())
  })

  it('ignores an @id line after the request line', async () => {
    await write(root, 'requests/a.http', `GET https://example.com\n# @id ${ID_A}\n`)
    await write(
      root,
      'requests/b.http',
      `# Users API\n\nGET https://example.com\n\n# @id ${ID_B}\n`
    )
    expect(await collectRequestIds(root)).toEqual(new Set())
  })
})
