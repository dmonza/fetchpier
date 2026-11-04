/**
 * REQ-0089 — Path-keyed workspace TLS resolution.
 *
 * `resolveRequestTls` reads workspace TLS content (settings + cert files) from
 * the workspace path; app-global material is injected. These tests build a real
 * temp workspace on disk (cert bytes are dummies — matching is metadata-only and
 * resolution just loads the bytes) and exercise the §6.1 passphrase cases, the
 * app-global verbatim rule, the lazy contractual secret failure, the CA bundle,
 * and desktop↔CLI byte-equivalence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tlsMod from 'node:tls'
import type { TlsScopeSettings } from '@shared/types'
import { CoreError } from '../shared/context'
import { resolveRequestTls, previewRequestCert, type AppGlobalTlsMaterial } from './resolve'

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

/** Create a temp workspace with a `tls` block and the given cert files written under certs/. */
async function makeWorkspace(
  tls: TlsScopeSettings,
  files: Record<string, string> = {}
): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), 'fp-tls-'))
  tempDirs.push(ws)
  await fs.mkdir(join(ws, '.fetchpier', 'certs'), { recursive: true })
  await fs.writeFile(
    join(ws, '.fetchpier', 'settings.json'),
    JSON.stringify({ version: 1, http: { tls } }, null, 2)
  )
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(ws, '.fetchpier', 'certs', name), content)
  }
  return ws
}

/** Create an app-global cert dir + settings (desktop-injected material). */
async function makeAppGlobal(
  settings: TlsScopeSettings,
  files: Record<string, string> = {}
): Promise<AppGlobalTlsMaterial> {
  const certsDir = mkdtempSync(join(tmpdir(), 'fp-app-certs-'))
  tempDirs.push(certsDir)
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(certsDir, name), content)
  }
  return { certsDir, settings }
}

function pfxCert(passphrase: string | null, host = 'api.example.com') {
  return {
    id: 'cc-1',
    host,
    port: null,
    type: 'pfx' as const,
    pfxFile: 'client-1234.pfx',
    passphrase,
    disabled: false
  }
}

const URL_MATCH = 'https://api.example.com/resource'

describe('resolveRequestTls — workspace passphrase resolution (§6.1)', () => {
  it('uses a literal passphrase verbatim', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('literal-pw')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    const material = await resolveRequestTls(URL_MATCH, {}, { workspacePath: ws })
    expect(material.pfx?.toString()).toBe('PFXBYTES')
    expect(material.passphrase).toBe('literal-pw')
  })

  it('resolves a plain variable reference from the environment', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('{{cert_pass}}')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    const material = await resolveRequestTls(
      URL_MATCH,
      { cert_pass: 'plain-value' },
      { workspacePath: ws }
    )
    expect(material.passphrase).toBe('plain-value')
  })

  it('decrypts a secret reference via resolvePassphraseSecrets when unlocked', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('{{cert_pass}}')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    const resolvePassphraseSecrets = vi.fn().mockResolvedValue({ cert_pass: 'secret-plaintext' })
    const material = await resolveRequestTls(
      URL_MATCH,
      {},
      { workspacePath: ws, resolvePassphraseSecrets }
    )
    expect(material.passphrase).toBe('secret-plaintext')
    expect(resolvePassphraseSecrets).toHaveBeenCalledWith(['cert_pass'])
  })

  it('propagates the contractual SECRETS_KEY_MISSING when the workspace is locked', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('{{cert_pass}}')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    const resolvePassphraseSecrets = vi
      .fn()
      .mockRejectedValue(new CoreError('SECRETS_KEY_MISSING', 'locked'))
    await expect(
      resolveRequestTls(URL_MATCH, {}, { workspacePath: ws, resolvePassphraseSecrets })
    ).rejects.toMatchObject({ code: 'SECRETS_KEY_MISSING' })
  })

  it('leaves an unresolved reference literal and proceeds (warn-and-proceed)', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('{{nope}}')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    const resolvePassphraseSecrets = vi.fn().mockResolvedValue({})
    const onWarning = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const material = await resolveRequestTls(
      URL_MATCH,
      {},
      { workspacePath: ws, resolvePassphraseSecrets, onWarning }
    )
    expect(material.passphrase).toBe('{{nope}}')
    // Reported through the context, never the process console (CLI readiness).
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('"nope"'))
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('lets a local plain override (in the environment) win — secrets are not consulted for it', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('{{cert_pass}}')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    // The adapter put the plain (local-override) value into the environment and
    // returns nothing from the secret resolver (the name is not a secret here).
    const resolvePassphraseSecrets = vi.fn().mockResolvedValue({})
    const material = await resolveRequestTls(
      URL_MATCH,
      { cert_pass: 'local-override' },
      { workspacePath: ws, resolvePassphraseSecrets }
    )
    expect(material.passphrase).toBe('local-override')
  })

  it('needs no secret resolver for a literal passphrase (laziness)', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('plain-literal')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    const resolvePassphraseSecrets = vi.fn()
    const material = await resolveRequestTls(
      URL_MATCH,
      {},
      { workspacePath: ws, resolvePassphraseSecrets }
    )
    expect(material.passphrase).toBe('plain-literal')
    expect(resolvePassphraseSecrets).not.toHaveBeenCalled()
  })
})

describe('resolveRequestTls — app-global passphrase is verbatim (CA-05)', () => {
  it('uses an app-global passphrase verbatim, never interpolated', async () => {
    // Empty workspace; the match comes from app-global. Even a `{{...}}`-shaped
    // value (which save-time validation forbids) must pass through untouched.
    const ws = await makeWorkspace({ caCertificates: [], clientCertificates: [] })
    const appGlobal = await makeAppGlobal(
      { caCertificates: [], clientCertificates: [pfxCert('{{cert_pass}}')] },
      { 'client-1234.pfx': 'APPPFX' }
    )
    const resolvePassphraseSecrets = vi.fn().mockResolvedValue({ cert_pass: 'should-not-be-used' })
    const material = await resolveRequestTls(
      URL_MATCH,
      { cert_pass: 'should-not-be-used' },
      { workspacePath: ws, appGlobal, resolvePassphraseSecrets }
    )
    expect(material.pfx?.toString()).toBe('APPPFX')
    expect(material.passphrase).toBe('{{cert_pass}}')
    expect(resolvePassphraseSecrets).not.toHaveBeenCalled()
  })
})

describe('resolveRequestTls — CA bundle and matching', () => {
  it('returns {} for a non-https URL', async () => {
    const ws = await makeWorkspace({ caCertificates: [], clientCertificates: [pfxCert('x')] })
    expect(await resolveRequestTls('http://api.example.com/x', {}, { workspacePath: ws })).toEqual(
      {}
    )
  })

  it('applies the workspace CA bundle on top of Node roots', async () => {
    const ws = await makeWorkspace(
      {
        caCertificates: [{ id: 'ca-1', file: 'ca-1234.pem' }],
        clientCertificates: []
      },
      { 'ca-1234.pem': 'WORKSPACE-CA' }
    )
    const material = await resolveRequestTls(URL_MATCH, {}, { workspacePath: ws })
    expect(material.ca?.length).toBe(tlsMod.rootCertificates.length + 1)
    expect(material.ca?.some((b) => b.toString() === 'WORKSPACE-CA')).toBe(true)
  })

  it('returns only the CA bundle (no cert material) when nothing matches', async () => {
    const ws = await makeWorkspace({
      caCertificates: [],
      clientCertificates: [pfxCert('x', 'other.host')]
    })
    const material = await resolveRequestTls(URL_MATCH, {}, { workspacePath: ws })
    expect(material.cert).toBeUndefined()
    expect(material.pfx).toBeUndefined()
    expect(material.ca?.length).toBe(tlsMod.rootCertificates.length)
  })
})

describe('resolveRequestTls — desktop ↔ CLI byte-equivalence (CA-09)', () => {
  it('selects and resolves the same workspace material with and without app-global', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('{{cert_pass}}')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    const resolvePassphraseSecrets = vi.fn().mockResolvedValue({ cert_pass: 'plaintext' })
    // CLI: no app-global injected.
    const cli = await resolveRequestTls(
      URL_MATCH,
      {},
      { workspacePath: ws, resolvePassphraseSecrets }
    )
    // Desktop: app-global present, but the workspace cert is the higher-priority match.
    const appGlobal = await makeAppGlobal({ caCertificates: [], clientCertificates: [] })
    const desktop = await resolveRequestTls(
      URL_MATCH,
      {},
      {
        workspacePath: ws,
        appGlobal,
        resolvePassphraseSecrets
      }
    )
    expect(desktop.pfx?.toString()).toBe(cli.pfx?.toString())
    expect(desktop.passphrase).toBe(cli.passphrase)
    expect(cli.passphrase).toBe('plaintext')
  })
})

describe('previewRequestCert — metadata only, works locked', () => {
  it('reports the selected workspace cert and scope without resolving the passphrase', async () => {
    const ws = await makeWorkspace(
      { caCertificates: [], clientCertificates: [pfxCert('{{cert_pass}}')] },
      { 'client-1234.pfx': 'PFXBYTES' }
    )
    // No resolvePassphraseSecrets supplied (locked) — preview must not need it.
    const preview = await previewRequestCert(URL_MATCH, { workspacePath: ws })
    expect(preview.scope).toBe('workspace')
    expect(preview.selected?.id).toBe('cc-1')
  })

  it('returns null selection when nothing matches', async () => {
    const ws = await makeWorkspace({ caCertificates: [], clientCertificates: [] })
    const preview = await previewRequestCert(URL_MATCH, { workspacePath: ws })
    expect(preview.selected).toBeNull()
    expect(preview.scope).toBeNull()
  })
})
