import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { matchClientCertificate, type CandidateScope, type ClientCertCandidate } from './matcher'
import type { ClientCertEntry } from '@shared/types'

function entry(partial: Partial<ClientCertEntry> & { host: string; id?: string }): ClientCertEntry {
  return {
    id: partial.id ?? 'id-' + partial.host,
    host: partial.host,
    port: partial.port ?? null,
    type: partial.type ?? 'pem',
    certFile: partial.certFile ?? 'cert.crt',
    keyFile: partial.keyFile ?? 'cert.key',
    pfxFile: partial.pfxFile,
    passphrase: partial.passphrase ?? null,
    disabled: partial.disabled ?? false
  }
}

function candidate(e: ClientCertEntry, scope: CandidateScope, index = 0): ClientCertCandidate {
  return { entry: e, scope, index }
}

describe('matchClientCertificate', () => {
  it('returns null when no candidates match', () => {
    const url = new URL('https://api.example.com/v1')
    const result = matchClientCertificate(url, [
      candidate(entry({ host: 'other.com' }), 'workspace')
    ])
    expect(result).toBeNull()
  })

  it('matches literal host exactly', () => {
    const url = new URL('https://api.example.com/v1')
    const e = entry({ host: 'api.example.com' })
    const result = matchClientCertificate(url, [candidate(e, 'workspace')])
    expect(result?.selected).toBe(e)
    expect(result?.scope).toBe('workspace')
  })

  it('matches single-label wildcard host', () => {
    const url = new URL('https://foo.example.com/v1')
    const e = entry({ host: '*.example.com' })
    const result = matchClientCertificate(url, [candidate(e, 'app')])
    expect(result?.selected).toBe(e)
  })

  it('wildcard does NOT match the bare apex (example.com vs *.example.com)', () => {
    const url = new URL('https://example.com/v1')
    const e = entry({ host: '*.example.com' })
    const result = matchClientCertificate(url, [candidate(e, 'app')])
    expect(result).toBeNull()
  })

  it('wildcard does NOT match deeper subdomains (Postman single-label semantics)', () => {
    const url = new URL('https://deep.nested.example.com/v1')
    const e = entry({ host: '*.example.com' })
    const result = matchClientCertificate(url, [candidate(e, 'app')])
    expect(result).toBeNull()
  })

  it('skips disabled candidates', () => {
    const url = new URL('https://api.example.com/v1')
    const e = entry({ host: 'api.example.com', disabled: true })
    const result = matchClientCertificate(url, [candidate(e, 'workspace')])
    expect(result).toBeNull()
  })

  describe('port matching', () => {
    it('candidate with explicit port matches matching request port', () => {
      const url = new URL('https://api.example.com:8443/v1')
      const e = entry({ host: 'api.example.com', port: 8443 })
      const result = matchClientCertificate(url, [candidate(e, 'workspace')])
      expect(result?.selected).toBe(e)
    })

    it('candidate with explicit port does NOT match different request port', () => {
      const url = new URL('https://api.example.com:9000/v1')
      const e = entry({ host: 'api.example.com', port: 8443 })
      const result = matchClientCertificate(url, [candidate(e, 'workspace')])
      expect(result).toBeNull()
    })

    it('candidate without port matches any request port', () => {
      const url = new URL('https://api.example.com:8443/v1')
      const e = entry({ host: 'api.example.com' })
      const result = matchClientCertificate(url, [candidate(e, 'workspace')])
      expect(result?.selected).toBe(e)
    })

    it('https default port (443) matches candidate.port=443 when URL has no explicit port', () => {
      const url = new URL('https://api.example.com/v1')
      const e = entry({ host: 'api.example.com', port: 443 })
      const result = matchClientCertificate(url, [candidate(e, 'workspace')])
      expect(result?.selected).toBe(e)
    })
  })

  describe('ranking by specificity (REQ §5.2)', () => {
    it('literal+port beats literal-no-port', () => {
      const url = new URL('https://api.example.com:8443/v1')
      const a = entry({ id: 'a', host: 'api.example.com', port: 8443 })
      const b = entry({ id: 'b', host: 'api.example.com' })
      const result = matchClientCertificate(url, [
        candidate(b, 'workspace', 0),
        candidate(a, 'workspace', 1)
      ])
      expect(result?.selected.id).toBe('a')
    })

    it('literal-no-port beats wildcard+port', () => {
      const url = new URL('https://api.example.com:8443/v1')
      const lit = entry({ id: 'lit', host: 'api.example.com' })
      const wild = entry({ id: 'wild', host: '*.example.com', port: 8443 })
      const result = matchClientCertificate(url, [
        candidate(wild, 'workspace', 0),
        candidate(lit, 'workspace', 1)
      ])
      expect(result?.selected.id).toBe('lit')
    })

    it('wildcard+port beats wildcard-no-port', () => {
      const url = new URL('https://api.example.com:8443/v1')
      const wPort = entry({ id: 'wport', host: '*.example.com', port: 8443 })
      const wNoPort = entry({ id: 'wnoport', host: '*.example.com' })
      const result = matchClientCertificate(url, [
        candidate(wNoPort, 'workspace', 0),
        candidate(wPort, 'workspace', 1)
      ])
      expect(result?.selected.id).toBe('wport')
    })

    it('more-specific literal beats less-specific wildcard regardless of scope (REQ §11)', () => {
      const url = new URL('https://api.example.com/v1')
      const wildWorkspace = entry({ id: 'wild', host: '*.example.com' })
      const literalApp = entry({ id: 'lit', host: 'api.example.com' })
      const result = matchClientCertificate(url, [
        candidate(wildWorkspace, 'workspace', 0),
        candidate(literalApp, 'app', 0)
      ])
      expect(result?.selected.id).toBe('lit')
      expect(result?.scope).toBe('app')
    })
  })

  describe('scope tie-break', () => {
    it('workspace beats app-global at the same specificity tier', () => {
      const url = new URL('https://api.example.com/v1')
      const ws = entry({ id: 'ws', host: 'api.example.com' })
      const app = entry({ id: 'app', host: 'api.example.com' })
      const result = matchClientCertificate(url, [
        candidate(app, 'app', 0),
        candidate(ws, 'workspace', 0)
      ])
      expect(result?.selected.id).toBe('ws')
      expect(result?.scope).toBe('workspace')
    })

    // Owner decision (security finding P1-1): a certificate given for this run
    // (`--tls-config`) was named explicitly, so it wins a tie with the workspace.
    it('a run certificate beats workspace and app-global at the same tier', () => {
      const url = new URL('https://api.example.com/v1')
      const ws = entry({ id: 'ws', host: 'api.example.com' })
      const app = entry({ id: 'app', host: 'api.example.com' })
      const run = entry({ id: 'run', host: 'api.example.com' })
      const result = matchClientCertificate(url, [
        candidate(ws, 'workspace', 0),
        candidate(app, 'app', 0),
        candidate(run, 'run', 0)
      ])
      expect(result?.selected.id).toBe('run')
      expect(result?.scope).toBe('run')
    })

    it('specificity still decides first: a literal workspace host beats a run wildcard', () => {
      const url = new URL('https://api.example.com/v1')
      const ws = entry({ id: 'ws', host: 'api.example.com' })
      const run = entry({ id: 'run', host: '*.example.com' })
      const result = matchClientCertificate(url, [
        candidate(run, 'run', 0),
        candidate(ws, 'workspace', 0)
      ])
      expect(result?.selected.id).toBe('ws')
    })

    it('document order breaks ties within the same scope and tier', () => {
      const url = new URL('https://api.example.com/v1')
      const first = entry({ id: 'first', host: 'api.example.com' })
      const second = entry({ id: 'second', host: 'api.example.com' })
      const result = matchClientCertificate(url, [
        candidate(first, 'workspace', 0),
        candidate(second, 'workspace', 1)
      ])
      expect(result?.selected.id).toBe('first')
    })

    it('reports same-tier, same-scope ambiguity through onWarning, not the console', () => {
      const url = new URL('https://api.example.com/v1')
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onWarning = vi.fn()
      try {
        const a = entry({ id: 'a', host: 'api.example.com' })
        const b = entry({ id: 'b', host: 'api.example.com' })
        matchClientCertificate(
          url,
          [candidate(a, 'workspace', 0), candidate(b, 'workspace', 1)],
          onWarning
        )
        expect(onWarning).toHaveBeenCalledOnce()
        expect(onWarning.mock.calls[0][0]).toContain('several client certificates match')
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })

    it('does NOT warn for cross-scope ties (workspace silently wins)', () => {
      const url = new URL('https://api.example.com/v1')
      const onWarning = vi.fn()
      const ws = entry({ id: 'ws', host: 'api.example.com' })
      const app = entry({ id: 'app', host: 'api.example.com' })
      matchClientCertificate(
        url,
        [candidate(ws, 'workspace', 0), candidate(app, 'app', 0)],
        onWarning
      )
      expect(onWarning).not.toHaveBeenCalled()
    })
  })

  describe('case insensitivity', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('matches host case-insensitively', () => {
      const url = new URL('https://API.Example.COM/v1')
      const e = entry({ host: 'api.example.com' })
      const result = matchClientCertificate(url, [candidate(e, 'workspace')])
      expect(result?.selected).toBe(e)
    })

    it('matches wildcard pattern case-insensitively', () => {
      const url = new URL('https://Foo.EXAMPLE.com/v1')
      const e = entry({ host: '*.Example.com' })
      const result = matchClientCertificate(url, [candidate(e, 'workspace')])
      expect(result?.selected).toBe(e)
    })
  })
})
