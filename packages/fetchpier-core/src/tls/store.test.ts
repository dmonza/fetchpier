/**
 * Unit tests for `updateClient` host/port/passphrase editing (PLAN-0117).
 *
 * `createTlsStore` is dependency-injected, so we exercise it against an
 * in-memory workspace-scope settings object — no Electron, no filesystem. These
 * cases cover the patch surface widened for in-place editing; file imports and
 * matching are covered by `import.test.ts` / `matcher.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientCertEntry, TlsScopeSettings } from '@shared/types'
import { createTlsStore, writeCertFileNoOverwrite, type TlsStore } from './store'
import { TlsImportError } from './import'

const WS = '/ws'

function clientEntry(partial: Partial<ClientCertEntry> & { id: string }): ClientCertEntry {
  return {
    host: 'example.com',
    port: null,
    type: 'pfx',
    pfxFile: 'client-1234.pfx',
    passphrase: null,
    disabled: false,
    ...partial
  }
}

function makeStore(initial: ClientCertEntry[]): {
  store: TlsStore
  current: () => TlsScopeSettings
} {
  let workspaceTls: TlsScopeSettings = {
    caCertificates: [],
    clientCertificates: initial
  }
  const store = createTlsStore({
    appCertsDir: () => '/app/certs',
    getWorkspacePath: () => WS,
    readAppTls: () => undefined,
    writeAppTls: (next) => next,
    readWorkspaceTls: async () => workspaceTls,
    writeWorkspaceTls: async (_ws, next) => {
      workspaceTls = next
      return next
    }
  })
  return { store, current: () => workspaceTls }
}

describe('updateClient — in-place metadata editing', () => {
  let store: TlsStore
  let current: () => TlsScopeSettings

  beforeEach(() => {
    const made = makeStore([
      clientEntry({ id: 'cc-1', host: 'badssl.com', port: null, passphrase: 'old' })
    ])
    store = made.store
    current = made.current
  })

  it('edits host and port and persists them', async () => {
    const updated = await store.updateClient({
      scope: 'workspace',
      id: 'cc-1',
      patch: { host: 'client.badssl.com', port: 8443 }
    })
    expect(updated.host).toBe('client.badssl.com')
    expect(updated.port).toBe(8443)
    const persisted = current().clientCertificates[0]
    expect(persisted.host).toBe('client.badssl.com')
    expect(persisted.port).toBe(8443)
  })

  it('trims the host before storing it', async () => {
    const updated = await store.updateClient({
      scope: 'workspace',
      id: 'cc-1',
      patch: { host: '  client.badssl.com  ' }
    })
    expect(updated.host).toBe('client.badssl.com')
  })

  it('rejects an empty or whitespace-only host', async () => {
    await expect(
      store.updateClient({ scope: 'workspace', id: 'cc-1', patch: { host: '   ' } })
    ).rejects.toBeInstanceOf(TlsImportError)
    // The original host is untouched on failure.
    expect(current().clientCertificates[0].host).toBe('badssl.com')
  })

  it('sets port to null (any port) when patched with null', async () => {
    await store.updateClient({ scope: 'workspace', id: 'cc-1', patch: { port: 443 } })
    const updated = await store.updateClient({
      scope: 'workspace',
      id: 'cc-1',
      patch: { port: null }
    })
    expect(updated.port).toBeNull()
  })

  it('still patches passphrase and disabled alongside host', async () => {
    const updated = await store.updateClient({
      scope: 'workspace',
      id: 'cc-1',
      patch: { host: 'api.example.com', passphrase: 'new-pass', disabled: true }
    })
    expect(updated.host).toBe('api.example.com')
    expect(updated.passphrase).toBe('new-pass')
    expect(updated.disabled).toBe(true)
  })

  it('leaves unspecified fields untouched', async () => {
    const updated = await store.updateClient({
      scope: 'workspace',
      id: 'cc-1',
      patch: { port: 9000 }
    })
    // host and passphrase from the original entry survive.
    expect(updated.host).toBe('badssl.com')
    expect(updated.passphrase).toBe('old')
  })

  it('throws when the id does not exist', async () => {
    await expect(
      store.updateClient({ scope: 'workspace', id: 'missing', patch: { host: 'x.com' } })
    ).rejects.toThrow(/not found/i)
  })
})

describe('app-global passphrase is literal-only (REQ-0089)', () => {
  it('rejects addClient on app scope with a {{variable}} passphrase before any write', async () => {
    const { store } = makeStore([])
    await expect(
      store.addClient({
        scope: 'app',
        host: 'api.example.com',
        type: 'pfx',
        sourcePaths: { pfxPath: '/does/not/exist.pfx' },
        passphrase: '{{cert_pass}}'
      })
    ).rejects.toMatchObject({ code: 'CLIENT_CERT_PASSPHRASE_VARIABLE_NOT_ALLOWED' })
  })

  it('rejects updateClient on app scope with a {{variable}} passphrase', async () => {
    const { store } = makeStore([])
    await expect(
      store.updateClient({ scope: 'app', id: 'whatever', patch: { passphrase: '{{cert_pass}}' } })
    ).rejects.toMatchObject({ code: 'CLIENT_CERT_PASSPHRASE_VARIABLE_NOT_ALLOWED' })
  })

  it('accepts a {{variable}} passphrase on workspace scope', async () => {
    const { store, current } = makeStore([
      clientEntry({ id: 'cc-1', host: 'badssl.com', passphrase: 'old' })
    ])
    const updated = await store.updateClient({
      scope: 'workspace',
      id: 'cc-1',
      patch: { passphrase: '{{cert_pass}}' }
    })
    expect(updated.passphrase).toBe('{{cert_pass}}')
    expect(current().clientCertificates[0].passphrase).toBe('{{cert_pass}}')
  })

  it('accepts a literal passphrase on app scope (no variable reference)', async () => {
    // Workspace-only deps in makeStore, but app addClient validation runs before
    // any disk access — a literal value passes validation (file read then fails,
    // which is the expected "no such file" path, not the contractual rejection).
    const { store } = makeStore([])
    await expect(
      store.addClient({
        scope: 'app',
        host: 'api.example.com',
        type: 'pfx',
        sourcePaths: { pfxPath: '/does/not/exist.pfx' },
        passphrase: 'literal-pass'
      })
    ).rejects.not.toMatchObject({ code: 'CLIENT_CERT_PASSPHRASE_VARIABLE_NOT_ALLOWED' })
  })
})

// REQ write-safety / CA-09 — certificate import never overwrites a different
// certificate's bytes, and reuses the file for identical re-imports.
describe('writeCertFileNoOverwrite', () => {
  let dir: string
  const read = (name: string): Promise<Buffer> => fs.readFile(join(dir, name))

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fp-cert-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  // Atomic writes — closing the write-safety coverage gap: this writer used
  // to do a direct fs.writeFile with no temp file at all.
  it('retries the rename through a transient error and still writes the cert (CA-06)', async () => {
    const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
      code: 'EBUSY'
    })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

    const used = await writeCertFileNoOverwrite(dir, 'ca-acme-ab12.pem', Buffer.from('FIRST'))

    expect(renameSpy).toHaveBeenCalled()
    renameSpy.mockRestore()
    expect(used).toBe('ca-acme-ab12.pem')
    expect((await read(used)).toString()).toBe('FIRST')
  })

  it('writes to a free slot and returns the filename', async () => {
    const used = await writeCertFileNoOverwrite(dir, 'ca-acme-ab12.pem', Buffer.from('FIRST'))
    expect(used).toBe('ca-acme-ab12.pem')
    expect((await read(used)).toString()).toBe('FIRST')
  })

  it('reuses the existing file for identical material (no duplication)', async () => {
    const bytes = Buffer.from('SAME-MATERIAL')
    const a = await writeCertFileNoOverwrite(dir, 'ca-acme-ab12.pem', bytes)
    const b = await writeCertFileNoOverwrite(dir, 'ca-acme-ab12.pem', bytes)
    expect(b).toBe(a)
    expect(await readdir(dir)).toEqual(['ca-acme-ab12.pem'])
  })

  it('preserves the first cert and disambiguates when a different material collides', async () => {
    const first = await writeCertFileNoOverwrite(dir, 'ca-acme-ab12.pem', Buffer.from('FIRST'))
    const second = await writeCertFileNoOverwrite(dir, 'ca-acme-ab12.pem', Buffer.from('SECOND'))

    expect(second).not.toBe(first)
    expect(second).toBe('ca-acme-ab12-2.pem')
    expect((await read(first)).toString()).toBe('FIRST')
    expect((await read(second)).toString()).toBe('SECOND')
  })

  it('keeps disambiguating across multiple distinct collisions', async () => {
    await writeCertFileNoOverwrite(dir, 'c-1.pem', Buffer.from('A'))
    const b = await writeCertFileNoOverwrite(dir, 'c-1.pem', Buffer.from('B'))
    const c = await writeCertFileNoOverwrite(dir, 'c-1.pem', Buffer.from('C'))
    expect([b, c]).toEqual(['c-1-2.pem', 'c-1-3.pem'])
  })
})
