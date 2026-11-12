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
import { generateKeyPairSync } from 'node:crypto'
import type { CACertEntry, ClientCertEntry, TlsScopeSettings } from '@shared/types'
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

// A valid self-signed CERTIFICATE block (same static fixture as import.test.ts),
// so `readPemCertFile` accepts it without issuing a certificate per test.
const VALID_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUVKi9KIDClUiBgEMtq7msIVnZIPwwDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCVVMxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNDA5MTAxMjAwMDBaFw0zNDA5
MDgxMjAwMDBaMEUxCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDQOnZf3rZQqGAxBNTWnvMKjpKbsEzdAcr/iLQGfbpV
0lF3oVk46GLNwYltKjL2J19jD+y9pyfL+3SLBu5VxPfsftFt7olwfpL/ZTrAcCxe
EJqd6gJnZ+B+rqJsXJp89dBPRX/MmnFCmJJSGwZGFsP4ZIA+ZNlWoyAGGwOq8L3y
GZNTV3hsfdLqvKLfQ3iIxJypzG8aD0/5zULRH1JCXFXrhPRPDdwIIJqyEgrV+SCo
GFCv9j6BcyqyrUw2OvojfRyIWPRyEemX+1/JC6S0bGRoSUOgZQClUH6RKAcGypXl
QnpD1MIQ4DEsfSb1qLO5b/F6cTatNYrR/8wOdJI9d4OXAgMBAAGjUzBRMB0GA1Ud
DgQWBBSxRENuU8VeAEEnSEjcyfwTo3hPDDAfBgNVHSMEGDAWgBSxRENuU8VeAEEn
SEjcyfwTo3hPDDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCV
8w65EVbE3DM3sQDxIBz+9bvW9Q8aafIuylgGsvkLhX2nL15rEH4O8L48n3CnSqUg
3StupGn8RcVk3eW4yX67ny6Tm0FsNAFTKqIIHTtHrJjQ1HZ5zo7ZJjlh1IJtxe4r
ZN6gXmJxnxROZqkqLB8m4u3wYwUykG+8h2sB8a/8MzcZW1ImOOH7AbWccGYBbqjK
1IhrSb5RNz0kVxlYqaApjMz1pbtPRPbZOrtb1OkX8s1Q3LpQNlVKlsx7gT/UWdYj
W3vjsfdwiW+rJ5KKWXk1n5q9KOyo0e6gKwMOl3xPMrxlbsR6T0BAg9bDP9CXspGd
H3SVPtKvUjQfytV5gz29
-----END CERTIFICATE-----
`

/** An app-scope store over a real certs directory and in-memory metadata. */
function makeAppStore(certsDir: string): { store: TlsStore; current: () => TlsScopeSettings } {
  let appTls: TlsScopeSettings | undefined
  const store = createTlsStore({
    appCertsDir: () => certsDir,
    getWorkspacePath: () => null,
    readAppTls: () => appTls,
    writeAppTls: (next) => {
      appTls = next
      return next
    },
    readWorkspaceTls: async () => undefined,
    writeWorkspaceTls: async (_ws, next) => next
  })
  return {
    store,
    current: () => appTls ?? { caCertificates: [], clientCertificates: [] }
  }
}

const exists = (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  )

// TLS-02 — identical imports share one canonical file; removing one entry must
// not delete material another entry of the same scope still points at.
describe('remove — files shared by several entries', () => {
  let root: string
  let certsDir: string
  let caSource: string
  let certSource: string
  let keySource: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fp-cert-shared-'))
    certsDir = join(root, 'certs')
    caSource = join(root, 'ca.pem')
    certSource = join(root, 'client.crt')
    keySource = join(root, 'client.key')
    await fs.writeFile(caSource, VALID_PEM_CERT)
    await fs.writeFile(certSource, VALID_PEM_CERT)
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    await fs.writeFile(keySource, privateKey)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps a CA file another entry still uses, and deletes it with the last entry', async () => {
    const { store, current } = makeAppStore(certsDir)
    const first = await store.addCA({ scope: 'app', sourcePath: caSource })
    const second = await store.addCA({ scope: 'app', sourcePath: caSource })
    expect(second.file).toBe(first.file)

    await store.remove({ scope: 'app', id: second.id, kind: 'ca' })
    expect(current().caCertificates.map((c) => c.id)).toEqual([first.id])
    expect(await exists(join(certsDir, first.file))).toBe(true)

    await store.remove({ scope: 'app', id: first.id, kind: 'ca' })
    expect(current().caCertificates).toEqual([])
    expect(await exists(join(certsDir, first.file))).toBe(false)
  })

  it('keeps the cert and key files of a client entry for the same material on another port', async () => {
    const { store, current } = makeAppStore(certsDir)
    const add = (port: number): Promise<ClientCertEntry> =>
      store.addClient({
        scope: 'app',
        host: 'api.example.com',
        port,
        type: 'pem',
        sourcePaths: { certPath: certSource, keyPath: keySource }
      })
    const on443 = await add(443)
    const on8443 = await add(8443)
    expect(on8443.certFile).toBe(on443.certFile)
    expect(on8443.keyFile).toBe(on443.keyFile)

    await store.remove({ scope: 'app', id: on8443.id, kind: 'client' })
    expect(current().clientCertificates.map((c) => c.id)).toEqual([on443.id])
    expect(await exists(join(certsDir, on443.certFile!))).toBe(true)
    expect(await exists(join(certsDir, on443.keyFile!))).toBe(true)
  })
})

// TLS-06 — entries written by hand (or moved from a CLI run file) may carry no
// id. Each gets a stable generated id on load, persisted on the next write, and
// a missing or empty id never matches an entry.
describe('id-less entries', () => {
  let ws: string
  let workspaceTls: TlsScopeSettings
  let store: TlsStore
  const certs = (): string => join(ws, '.fetchpier', 'certs')
  const idless = (host: string, stem: string): ClientCertEntry =>
    ({
      host,
      port: null,
      type: 'pem',
      certFile: `${stem}.crt`,
      keyFile: `${stem}.key`,
      passphrase: null,
      disabled: false
    }) as unknown as ClientCertEntry

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'fp-cert-idless-'))
    await fs.mkdir(certs(), { recursive: true })
    for (const name of ['ci-a.crt', 'ci-a.key', 'ci-b.crt', 'ci-b.key', 'ca-x.pem']) {
      await fs.writeFile(join(certs(), name), name)
    }
    workspaceTls = {
      caCertificates: [{ file: 'ca-x.pem', id: '' } as unknown as CACertEntry],
      clientCertificates: [idless('a.example.com', 'ci-a'), idless('b.example.com', 'ci-b')]
    }
    store = createTlsStore({
      appCertsDir: () => join(ws, 'app-certs'),
      getWorkspacePath: () => ws,
      readAppTls: () => undefined,
      writeAppTls: (next) => next,
      readWorkspaceTls: async () => structuredClone(workspaceTls),
      writeWorkspaceTls: async (_ws, next) => {
        workspaceTls = structuredClone(next)
        return next
      }
    })
  })
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it('gives every id-less or empty-id entry a distinct id that is the same on every load', async () => {
    const first = await store.loadScopeSettings('workspace')
    const second = await store.loadScopeSettings('workspace')
    const ids = [...first.caCertificates, ...first.clientCertificates].map((e) => e.id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(3)
    expect(second).toEqual(first)
  })

  it('toggles only the row it was asked for and persists the generated ids', async () => {
    const rowB = (await store.loadScopeSettings('workspace')).clientCertificates[1]
    await store.updateClient({ scope: 'workspace', id: rowB.id, patch: { disabled: true } })

    const [a, b] = workspaceTls.clientCertificates
    expect(a.disabled).toBe(false)
    expect(b.disabled).toBe(true)
    expect(b.id).toBe(rowB.id)
    expect(a.id).toBeTruthy()
    expect(workspaceTls.caCertificates[0].id).toBeTruthy()
  })

  it('removes only the row it was asked for, with its own files', async () => {
    const rowB = (await store.loadScopeSettings('workspace')).clientCertificates[1]
    await store.remove({ scope: 'workspace', id: rowB.id, kind: 'client' })

    expect(workspaceTls.clientCertificates.map((c) => c.host)).toEqual(['a.example.com'])
    expect(await exists(join(certs(), 'ci-a.crt'))).toBe(true)
    expect(await exists(join(certs(), 'ci-a.key'))).toBe(true)
    expect(await exists(join(certs(), 'ci-b.crt'))).toBe(false)
  })

  it.each([
    ['missing', undefined],
    ['empty', '']
  ])('rejects update and remove with a %s id and changes nothing', async (_label, id) => {
    const before = structuredClone(workspaceTls)
    const badId = id as unknown as string
    await expect(
      store.updateClient({ scope: 'workspace', id: badId, patch: { disabled: true } })
    ).rejects.toThrow(/id/i)
    await expect(
      store.updateCA({ scope: 'workspace', id: badId, patch: { label: 'x' } })
    ).rejects.toThrow(/id/i)
    await expect(store.remove({ scope: 'workspace', id: badId, kind: 'client' })).rejects.toThrow(
      /id/i
    )
    await expect(store.remove({ scope: 'workspace', id: badId, kind: 'ca' })).rejects.toThrow(/id/i)
    expect(workspaceTls).toEqual(before)
    expect(await exists(join(certs(), 'ci-a.crt'))).toBe(true)
    expect(await exists(join(certs(), 'ca-x.pem'))).toBe(true)
  })
})
