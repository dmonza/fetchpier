// F6 — request-tree mutations relocated to core. Exercises conflict refusal,
// the `*.instance.http` cascade, and create/rename/move/delete/duplicate over a
// real tmpdir. (On-disk cascade is also covered at the adapter integration level
// in src/main/ipc/filesystem.ipc.integration.test.ts via the handle.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkNameAvailable,
  createCollection,
  createInstance,
  createRequest,
  deleteEntry,
  duplicateEntry,
  duplicateInstance,
  findAvailableUntitledPath,
  moveEntry,
  renameEntry
} from './tree-mutations'

// Runtime probe: does this filesystem treat `a` and `A` as the same entry?
// Gates the cases that need two distinct casing-only siblings on disk (only
// possible on a case-sensitive filesystem — the Linux CI leg runs them).
const probeDir = mkdtempSync(join(tmpdir(), 'case-probe-'))
writeFileSync(join(probeDir, 'a'), '')
const FS_CASE_INSENSITIVE = existsSync(join(probeDir, 'A'))
rmSync(probeDir, { recursive: true, force: true })

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'core-tree-mut-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ws, { recursive: true, force: true })
})

async function seed(rel: string, content = 'GET https://example.com\n'): Promise<void> {
  const full = join(ws, rel)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}
/** The `# @id` written into `rel` (the duplicate's freshly generated one). */
async function idOf(rel: string): Promise<string | undefined> {
  const content = await fs.readFile(join(ws, rel), 'utf-8')
  return content.match(/# @id (\S+)/)?.[1]
}
function exists(rel: string): Promise<boolean> {
  return fs
    .access(join(ws, rel))
    .then(() => true)
    .catch(() => false)
}

describe('createCollection / createRequest', () => {
  it('creates a collection folder and a request file', async () => {
    await createCollection(ws, 'requests', 'auth')
    expect(await exists('requests/auth')).toBe(true)
    const created = await createRequest(ws, 'requests/auth', 'login')
    expect(created.endsWith(join('requests', 'auth', 'login.http'))).toBe(true)
    expect(await exists('requests/auth/login.http')).toBe(true)
  })

  it('refuses a request name already taken (REQUEST_NAME_CONFLICT)', async () => {
    await seed('requests/a.http')
    await expect(createRequest(ws, 'requests', 'a')).rejects.toThrow(/REQUEST_NAME_CONFLICT/)
  })

  it('refuses a collection name colliding with a request stem (COLLECTION_NAME_CONFLICT)', async () => {
    await seed('requests/a.http')
    await expect(createCollection(ws, 'requests', 'a')).rejects.toThrow(/COLLECTION_NAME_CONFLICT/)
  })
})

// WSP-03: a name that is not valid on every OS (and in git) is refused before
// anything touches the disk — no hidden temp leftover, no entry git cannot add.
describe('portable names on create / rename / check (INVALID_ENTRY_NAME)', () => {
  const INVALID = ['Step 1: login', 'what?', 'a*b', 'v2.', 'v3 ', 'CON', 'nul.backup', 'a/b']

  async function requestsListing(): Promise<string[]> {
    return (await fs.readdir(join(ws, 'requests'))).sort()
  }

  it.each(INVALID)('createRequest refuses %j and leaves nothing on disk', async (name) => {
    await fs.mkdir(join(ws, 'requests'), { recursive: true })
    await expect(createRequest(ws, 'requests', name)).rejects.toThrow(/^INVALID_ENTRY_NAME:/)
    expect(await requestsListing()).toEqual([])
  })

  it.each(INVALID)('createCollection refuses %j and leaves nothing on disk', async (name) => {
    await fs.mkdir(join(ws, 'requests'), { recursive: true })
    await expect(createCollection(ws, 'requests', name)).rejects.toThrow(/^INVALID_ENTRY_NAME:/)
    expect(await requestsListing()).toEqual([])
  })

  it('renameEntry refuses an invalid request name and keeps the file', async () => {
    await seed('requests/login.http')
    await expect(renameEntry(ws, 'requests/login.http', 'Step 1: login.http')).rejects.toThrow(
      /^INVALID_ENTRY_NAME:/
    )
    expect(await requestsListing()).toEqual(['login.http'])
  })

  it('renameEntry refuses an invalid collection name and keeps the folder', async () => {
    await fs.mkdir(join(ws, 'requests', 'auth'), { recursive: true })
    await expect(renameEntry(ws, 'requests/auth', 'AUX')).rejects.toThrow(/^INVALID_ENTRY_NAME:/)
    expect(await requestsListing()).toEqual(['auth'])
  })

  it('checkNameAvailable refuses an invalid name', async () => {
    await fs.mkdir(join(ws, 'requests'), { recursive: true })
    await expect(
      checkNameAvailable(ws, { kind: 'entry', parentPath: 'requests', name: 'Step 1: login' })
    ).rejects.toThrow(/^INVALID_ENTRY_NAME:/)
  })

  it('still accepts names that only look unusual', async () => {
    await fs.mkdir(join(ws, 'requests'), { recursive: true })
    await createRequest(ws, 'requests', 'users.v2')
    await createCollection(ws, 'requests', 'CONSOLE')
    expect(await requestsListing()).toEqual(['CONSOLE', 'users.v2.http'])
  })
})

describe('createInstance', () => {
  it('clones the parent with a fresh @id', async () => {
    await seed('requests/login.http', '# @id parent-uuid\nGET https://example.com\n')
    const dest = await createInstance(ws, 'requests/login.http', 'happy')
    expect(dest.endsWith('login.happy.instance.http')).toBe(true)
    const written = await fs.readFile(join(ws, 'requests', 'login.happy.instance.http'), 'utf-8')
    expect(written.match(/# @id (\S+)/)?.[1]).not.toBe('parent-uuid')
  })

  it('rejects an instance of an instance', async () => {
    await seed('requests/login.http')
    await seed('requests/login.ok.instance.http')
    await expect(createInstance(ws, 'requests/login.ok.instance.http', 'x')).rejects.toThrow(
      /INSTANCE_OF_INSTANCE/
    )
  })

  it('rejects an invalid instance name', async () => {
    await seed('requests/login.http')
    await expect(createInstance(ws, 'requests/login.http', 'a/b')).rejects.toThrow(
      /INVALID_INSTANCE_NAME/
    )
  })

  it('rejects a duplicate instance name', async () => {
    await seed('requests/login.http')
    await createInstance(ws, 'requests/login.http', 'ok')
    await expect(createInstance(ws, 'requests/login.http', 'ok')).rejects.toThrow(
      /INSTANCE_NAME_CONFLICT/
    )
  })

  // Atomic writes — closing the write-safety coverage gap: this writer used
  // to do a direct fs.writeFile with no temp file at all (its sibling
  // createRequest already went through the shared helper).
  it('retries the rename through a transient error and eventually writes the clone (CA-06)', async () => {
    await seed('requests/login.http', '# @id parent-uuid\nGET https://example.com\n')
    const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
      code: 'EBUSY'
    })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

    const dest = await createInstance(ws, 'requests/login.http', 'happy')

    expect(renameSpy).toHaveBeenCalled()
    renameSpy.mockRestore()
    const written = await fs.readFile(dest, 'utf-8')
    expect(written.match(/# @id (\S+)/)?.[1]).not.toBe('parent-uuid')
  })
})

describe('renameEntry', () => {
  it('renames a request and cascades its instance siblings', async () => {
    await seed('requests/login.http')
    await seed('requests/login.ok.instance.http')
    const result = await renameEntry(ws, 'requests/login.http', 'signin.http')
    expect(await exists('requests/signin.http')).toBe(true)
    expect(await exists('requests/signin.ok.instance.http')).toBe(true)
    expect(await exists('requests/login.http')).toBe(false)
    expect(result.instances).toHaveLength(1)
  })

  // The cascade's skip branch: a foreign file already holding the name an
  // instance wants is never overwritten, and the parent rename still completes
  // Green before and after the self-exclusion fix — it guards
  // the opposite failure, dropping the occupancy check altogether.
  it('skips an instance whose target name is taken by another file, parent rename still completes', async () => {
    await seed('requests/login.http')
    await seed('requests/login.ok.instance.http', 'SOURCE')
    await seed('requests/signin.ok.instance.http', 'OCCUPANT')
    const result = await renameEntry(ws, 'requests/login.http', 'signin.http')
    expect(await exists('requests/signin.http')).toBe(true)
    expect(result.instances).toHaveLength(0)
    expect(await fs.readFile(join(ws, 'requests', 'signin.ok.instance.http'), 'utf-8')).toBe(
      'OCCUPANT'
    )
    expect(await fs.readFile(join(ws, 'requests', 'login.ok.instance.http'), 'utf-8')).toBe(
      'SOURCE'
    )
  })

  it('refuses renaming over an existing sibling', async () => {
    await seed('requests/a.http')
    await seed('requests/b.http')
    await expect(renameEntry(ws, 'requests/a.http', 'b.http')).rejects.toThrow(
      /REQUEST_NAME_CONFLICT/
    )
  })
})

describe('moveEntry', () => {
  it('moves a request and cascades instances into the target folder', async () => {
    await seed('requests/auth/login.http')
    await seed('requests/auth/login.ok.instance.http')
    await fs.mkdir(join(ws, 'requests', 'users'), { recursive: true })
    await moveEntry(ws, 'requests/auth/login.http', 'requests/users')
    expect(await exists('requests/users/login.http')).toBe(true)
    expect(await exists('requests/users/login.ok.instance.http')).toBe(true)
    expect(await exists('requests/auth/login.http')).toBe(false)
  })

  it('rejects moving a folder into itself', async () => {
    await fs.mkdir(join(ws, 'requests', 'col'), { recursive: true })
    await expect(moveEntry(ws, 'requests/col', 'requests/col')).rejects.toThrow(/MOVE_INTO_SELF/)
  })

  it('rejects a move that would overwrite an existing target', async () => {
    await seed('requests/a.http')
    await fs.mkdir(join(ws, 'requests', 'sub'), { recursive: true })
    await seed('requests/sub/a.http')
    await expect(moveEntry(ws, 'requests/a.http', 'requests/sub')).rejects.toThrow(/MOVE_CONFLICT/)
  })
})

describe('deleteEntry', () => {
  it('deletes a request and cascades its instances', async () => {
    await seed('requests/login.http')
    await seed('requests/login.ok.instance.http')
    const result = await deleteEntry(ws, 'requests/login.http')
    expect(await exists('requests/login.http')).toBe(false)
    expect(await exists('requests/login.ok.instance.http')).toBe(false)
    expect(result.deletedInstances).toHaveLength(1)
  })
})

describe('duplicateInstance', () => {
  const SOURCE = '# @id source-uuid\nGET https://example.com\nX-Trace: on\n\n{"a":1}\n'

  it('writes a sibling instance of the same parent carrying the source contents', async () => {
    await seed('requests/login.http')
    await seed('requests/login.happy-path.instance.http', SOURCE)

    const dest = await duplicateInstance(ws, 'requests/login.happy-path.instance.http', 'error-500')

    // Bound to `login`, not nested under the source instance.
    expect(dest.endsWith(join('requests', 'login.error-500.instance.http'))).toBe(true)
    expect(await exists('requests/login.error-500.instance.http')).toBe(true)
    const written = await fs.readFile(
      join(ws, 'requests', 'login.error-500.instance.http'),
      'utf-8'
    )
    expect(written).toContain('X-Trace: on')
    expect(written).toContain('{"a":1}')
    // The source is untouched.
    expect(await fs.readFile(join(ws, 'requests', 'login.happy-path.instance.http'), 'utf-8')).toBe(
      SOURCE
    )
  })

  it('gives the copy a fresh @id and carries every other line verbatim', async () => {
    await seed('requests/login.http')
    await seed('requests/login.happy-path.instance.http', SOURCE)

    const dest = await duplicateInstance(ws, 'requests/login.happy-path.instance.http', 'copy-1')

    const written = await fs.readFile(dest, 'utf-8')
    expect(written.match(/# @id (\S+)/)?.[1]).not.toBe('source-uuid')
    expect(written.replace(/# @id \S+/, '# @id source-uuid')).toBe(SOURCE)
  })

  it('rejects a name already taken and never overwrites or auto-increments', async () => {
    await seed('requests/login.http')
    await seed('requests/login.happy-path.instance.http', SOURCE)
    await seed('requests/login.error-500.instance.http', 'EXISTING')

    await expect(
      duplicateInstance(ws, 'requests/login.happy-path.instance.http', 'error-500')
    ).rejects.toThrow(/INSTANCE_NAME_CONFLICT/)

    expect(await fs.readFile(join(ws, 'requests', 'login.error-500.instance.http'), 'utf-8')).toBe(
      'EXISTING'
    )
    // Unlike duplicating a request, no `-copy-2`-style ladder is walked.
    expect(await exists('requests/login.error-500-2.instance.http')).toBe(false)
  })

  it.each([['a/b'], ['a.b'], ['a b'], ['']])(
    'rejects the invalid instance name "%s"',
    async (name) => {
      await seed('requests/login.http')
      await seed('requests/login.happy-path.instance.http', SOURCE)
      await expect(
        duplicateInstance(ws, 'requests/login.happy-path.instance.http', name)
      ).rejects.toThrow(/INVALID_INSTANCE_NAME/)
    }
  )

  it('duplicates an orphan into another orphan, inventing no parent', async () => {
    await seed('requests/lonely.instance.http', SOURCE)

    const dest = await duplicateInstance(ws, 'requests/lonely.instance.http', 'lonely-copy')

    expect(dest.endsWith(join('requests', 'lonely-copy.instance.http'))).toBe(true)
    expect(await exists('requests/lonely-copy.http')).toBe(false)
    expect((await fs.readFile(dest, 'utf-8')).match(/# @id (\S+)/)?.[1]).not.toBe('source-uuid')
  })

  it('rejects a source that is not an instance file', async () => {
    await seed('requests/login.http', SOURCE)
    await expect(duplicateInstance(ws, 'requests/login.http', 'x')).rejects.toThrow(
      /NOT_AN_INSTANCE/
    )
  })

  it('refuses to write outside the workspace', async () => {
    await expect(duplicateInstance(ws, '../escape.instance.http', 'x')).rejects.toThrow()
  })
})

describe('duplicateEntry', () => {
  it('copies to -copy then -copy-2', async () => {
    await seed('requests/a.http', 'BODY')
    const first = await duplicateEntry(ws, 'requests/a.http')
    expect(first.endsWith('a-copy.http')).toBe(true)
    const second = await duplicateEntry(ws, 'requests/a.http')
    expect(second.endsWith('a-copy-2.http')).toBe(true)
    // A source with no identity directive still yields an identifiable copy.
    expect(await fs.readFile(join(ws, 'requests', 'a-copy.http'), 'utf-8')).toBe(
      `# @id ${await idOf('requests/a-copy.http')}\nBODY`
    )
  })

  it('gives the copy a fresh @id, leaving the rest of the file identical', async () => {
    const source = '# @id source-uuid\nGET https://example.com\nAccept: */*\n'
    await seed('requests/a.http', source)

    const dest = await duplicateEntry(ws, 'requests/a.http')

    const written = await fs.readFile(dest, 'utf-8')
    expect(written.match(/# @id (\S+)/)?.[1]).not.toBe('source-uuid')
    expect(written.replace(/# @id \S+/, '# @id source-uuid')).toBe(source)
  })

  it('leaves the source request instances behind, bound to the original', async () => {
    await seed('requests/login.http', '# @id source-uuid\nGET https://example.com\n')
    await seed('requests/login.ok.instance.http', 'INSTANCE-A')
    await seed('requests/login.ko.instance.http', 'INSTANCE-B')

    await duplicateEntry(ws, 'requests/login.http')

    expect(await exists('requests/login-copy.http')).toBe(true)
    expect(await exists('requests/login-copy.ok.instance.http')).toBe(false)
    expect(await exists('requests/login-copy.ko.instance.http')).toBe(false)
    expect(await fs.readFile(join(ws, 'requests', 'login.ok.instance.http'), 'utf-8')).toBe(
      'INSTANCE-A'
    )
    expect(await fs.readFile(join(ws, 'requests', 'login.ko.instance.http'), 'utf-8')).toBe(
      'INSTANCE-B'
    )
  })

  it('refuses an instance path (its name would silently stop binding to the parent)', async () => {
    await seed('requests/login.http')
    await seed('requests/login.ok.instance.http')
    await expect(duplicateEntry(ws, 'requests/login.ok.instance.http')).rejects.toThrow(
      /DUPLICATE_OF_INSTANCE/
    )
    expect(await exists('requests/login.ok.instance-copy.http')).toBe(false)
  })
})

describe('findAvailableUntitledPath', () => {
  it('returns the first free untitled-N and creates requests/', async () => {
    const a = await findAvailableUntitledPath(ws, 1)
    expect(a.name).toBe('untitled-1')
    await seed('requests/untitled-1.http')
    const b = await findAvailableUntitledPath(ws, 1)
    expect(b.name).toBe('untitled-2')
  })
})

// ── REQ case-insensitive tree name uniqueness ───────────────────────────────

describe('case-only rename of the same element', () => {
  it('renames a request changing only its casing (CA-01)', async () => {
    await seed('requests/get-users.http')
    const result = await renameEntry(ws, 'requests/get-users.http', 'Get-Users.http')
    // Assert the *stored* casing via readdir — exists() would match either
    // casing on a case-insensitive filesystem and prove nothing.
    expect(await fs.readdir(join(ws, 'requests'))).toContain('Get-Users.http')
    expect(await fs.readdir(join(ws, 'requests'))).not.toContain('get-users.http')
    expect(result.newPath.endsWith('Get-Users.http')).toBe(true)
  })

  it('renames a collection changing only its casing (CA-02)', async () => {
    await fs.mkdir(join(ws, 'requests', 'payments'), { recursive: true })
    await renameEntry(ws, 'requests/payments', 'Payments')
    expect(await fs.readdir(join(ws, 'requests'))).toContain('Payments')
    expect(await fs.readdir(join(ws, 'requests'))).not.toContain('payments')
  })

  it('cascades instance siblings on a case-only rename', async () => {
    await seed('requests/login.http')
    await seed('requests/login.ok.instance.http')
    const result = await renameEntry(ws, 'requests/login.http', 'Login.http')
    expect(await fs.readdir(join(ws, 'requests'))).toContain('Login.ok.instance.http')
    expect(result.instances).toHaveLength(1)
  })

  // Self-exclusion is by physical identity, never by folded name: the source
  // instance does not block its own cascade, but a *distinct* casing-only
  // sibling does. Both entries fold to the same name, so only the inode tells
  // them apart. Needs two casing variants on disk — case-sensitive FS only.
  it.runIf(!FS_CASE_INSENSITIVE)(
    'never merges a legacy casing-only instance sibling during a cascade',
    async () => {
      await seed('requests/login.http')
      await seed('requests/login.ok.instance.http', 'lower')
      await seed('requests/Login.ok.instance.http', 'upper')
      const result = await renameEntry(ws, 'requests/login.http', 'Login.http')
      expect(result.instances).toHaveLength(0)
      expect(await fs.readFile(join(ws, 'requests', 'login.ok.instance.http'), 'utf-8')).toBe(
        'lower'
      )
      expect(await fs.readFile(join(ws, 'requests', 'Login.ok.instance.http'), 'utf-8')).toBe(
        'upper'
      )
    }
  )
})

describe('case-insensitive uniqueness within a folder', () => {
  it('refuses renaming onto a casing variant of a distinct sibling (CA-03)', async () => {
    await seed('requests/alpha.http', 'A')
    await seed('requests/beta.http', 'B')
    await expect(renameEntry(ws, 'requests/beta.http', 'Alpha.http')).rejects.toThrow(
      /REQUEST_NAME_CONFLICT/
    )
    expect(await fs.readFile(join(ws, 'requests', 'alpha.http'), 'utf-8')).toBe('A')
    expect(await fs.readFile(join(ws, 'requests', 'beta.http'), 'utf-8')).toBe('B')
  })

  it('refuses creating a request whose name is a casing variant of a sibling (CA-04)', async () => {
    await seed('requests/orders.http')
    await expect(createRequest(ws, 'requests', 'Orders')).rejects.toThrow(/REQUEST_NAME_CONFLICT/)
  })

  it('refuses creating a collection whose name is a casing variant of a request (CA-04)', async () => {
    await seed('requests/orders.http')
    await expect(createCollection(ws, 'requests', 'Orders')).rejects.toThrow(
      /COLLECTION_NAME_CONFLICT/
    )
  })

  it('applies the rule across kinds: renaming a request onto a casing variant of a folder', async () => {
    await seed('requests/reports.http')
    await fs.mkdir(join(ws, 'requests', 'Archive'), { recursive: true })
    await expect(renameEntry(ws, 'requests/reports.http', 'archive.http')).rejects.toThrow(
      /REQUEST_NAME_CONFLICT/
    )
  })

  it('folds non-ASCII letters when comparing', async () => {
    await seed('requests/café.http')
    await expect(createRequest(ws, 'requests', 'Café')).rejects.toThrow(/REQUEST_NAME_CONFLICT/)
  })

  it.runIf(!FS_CASE_INSENSITIVE)(
    'never merges legacy casing-only duplicates via rename (CA-08)',
    async () => {
      await seed('requests/alpha.http', 'lower')
      await seed('requests/Alpha.http', 'upper')
      await expect(renameEntry(ws, 'requests/alpha.http', 'Alpha.http')).rejects.toThrow(
        /REQUEST_NAME_CONFLICT/
      )
      expect(await fs.readFile(join(ws, 'requests', 'alpha.http'), 'utf-8')).toBe('lower')
      expect(await fs.readFile(join(ws, 'requests', 'Alpha.http'), 'utf-8')).toBe('upper')
    }
  )
})

describe('moveEntry case rules', () => {
  it('refuses a move into a folder holding a casing variant (CA-05)', async () => {
    await seed('requests/a/reports.http', 'SOURCE')
    await seed('requests/b/Reports.http', 'TARGET')
    await expect(moveEntry(ws, 'requests/a/reports.http', 'requests/b')).rejects.toThrow(
      /MOVE_CONFLICT/
    )
    expect(await exists('requests/a/reports.http')).toBe(true)
    expect(await fs.readFile(join(ws, 'requests', 'b', 'Reports.http'), 'utf-8')).toBe('TARGET')
  })

  it('applies the uniform kinds rule on move: request vs folder name', async () => {
    await seed('requests/a/reports.http')
    await fs.mkdir(join(ws, 'requests', 'b', 'Reports'), { recursive: true })
    await expect(moveEntry(ws, 'requests/a/reports.http', 'requests/b')).rejects.toThrow(
      /MOVE_CONFLICT/
    )
  })

  it('is a silent no-op when the destination is the element’s own folder (CA-06)', async () => {
    await seed('requests/sub/alpha.http', 'BODY')
    const result = await moveEntry(ws, 'requests/sub/alpha.http', 'requests/sub')
    expect(result.instances).toHaveLength(0)
    expect(result.newPath.endsWith(join('requests', 'sub', 'alpha.http'))).toBe(true)
    expect(await fs.readFile(join(ws, 'requests', 'sub', 'alpha.http'), 'utf-8')).toBe('BODY')
  })

  it.runIf(FS_CASE_INSENSITIVE)(
    'treats a differently-cased path of the own folder as the same folder (CA-06)',
    async () => {
      await seed('requests/sub/alpha.http', 'BODY')
      const result = await moveEntry(ws, 'requests/sub/alpha.http', 'requests/Sub')
      expect(result.instances).toHaveLength(0)
      expect(await fs.readFile(join(ws, 'requests', 'sub', 'alpha.http'), 'utf-8')).toBe('BODY')
    }
  )
})

describe('instance name case rules (CA-07)', () => {
  it('refuses creating an instance whose name is a casing variant of a sibling', async () => {
    await seed('requests/login.http')
    await createInstance(ws, 'requests/login.http', 'ok')
    await expect(createInstance(ws, 'requests/login.http', 'OK')).rejects.toThrow(
      /INSTANCE_NAME_CONFLICT/
    )
  })

  it('refuses duplicating an instance into a casing variant of a sibling', async () => {
    await seed('requests/login.http')
    await seed('requests/login.happy.instance.http')
    await seed('requests/login.ok.instance.http', 'EXISTING')
    await expect(duplicateInstance(ws, 'requests/login.happy.instance.http', 'OK')).rejects.toThrow(
      /INSTANCE_NAME_CONFLICT/
    )
    expect(await fs.readFile(join(ws, 'requests', 'login.ok.instance.http'), 'utf-8')).toBe(
      'EXISTING'
    )
  })
})

describe('checkNameAvailable (CA-09)', () => {
  it('reports a free name as available', async () => {
    await fs.mkdir(join(ws, 'requests'), { recursive: true })
    expect(
      await checkNameAvailable(ws, { kind: 'entry', parentPath: 'requests', name: 'fresh' })
    ).toEqual({ available: true })
  })

  it('reports a name taken by a request, in any casing', async () => {
    await seed('requests/orders.http')
    expect(
      await checkNameAvailable(ws, { kind: 'entry', parentPath: 'requests', name: 'Orders' })
    ).toEqual({ available: false, conflict: 'request' })
  })

  it('reports a name taken by a collection, in any casing', async () => {
    await fs.mkdir(join(ws, 'requests', 'archive'), { recursive: true })
    expect(
      await checkNameAvailable(ws, { kind: 'entry', parentPath: 'requests', name: 'Archive' })
    ).toEqual({ available: false, conflict: 'collection' })
  })

  it('excludes the element being renamed, in any casing (self)', async () => {
    await seed('requests/get-users.http')
    expect(
      await checkNameAvailable(ws, {
        kind: 'entry',
        parentPath: 'requests',
        name: 'Get-Users',
        selfPath: 'requests/get-users.http'
      })
    ).toEqual({ available: true })
  })

  it.runIf(!FS_CASE_INSENSITIVE)(
    'does not mistake a distinct casing-only sibling for self',
    async () => {
      await seed('requests/alpha.http')
      await seed('requests/Alpha.http')
      expect(
        await checkNameAvailable(ws, {
          kind: 'entry',
          parentPath: 'requests',
          name: 'Alpha',
          selfPath: 'requests/alpha.http'
        })
      ).toEqual({ available: false, conflict: 'request' })
    }
  )

  it('reports available for a folder that does not exist yet (a name verdict, not a path check)', async () => {
    expect(
      await checkNameAvailable(ws, { kind: 'entry', parentPath: 'requests/nowhere', name: 'x' })
    ).toEqual({ available: true })
  })

  it('answers instance-name checks against the parent request', async () => {
    await seed('requests/login.http')
    await seed('requests/login.ok.instance.http')
    expect(
      await checkNameAvailable(ws, {
        kind: 'instance',
        parentPath: 'requests/login.http',
        instanceName: 'OK'
      })
    ).toEqual({ available: false, conflict: 'instance' })
    expect(
      await checkNameAvailable(ws, {
        kind: 'instance',
        parentPath: 'requests/login.http',
        instanceName: 'fresh'
      })
    ).toEqual({ available: true })
  })

  it('answers instance-name checks against a source instance (duplicate flow)', async () => {
    await seed('requests/login.http')
    await seed('requests/login.happy.instance.http')
    await seed('requests/login.ok.instance.http')
    expect(
      await checkNameAvailable(ws, {
        kind: 'instance',
        parentPath: 'requests/login.happy.instance.http',
        instanceName: 'ok'
      })
    ).toEqual({ available: false, conflict: 'instance' })
  })
})
