import { create } from 'zustand'
import type { CACertEntry, ClientCertEntry, TlsScope, TlsScopeSettings } from '../../shared/types'

const EMPTY: TlsScopeSettings = { caCertificates: [], clientCertificates: [] }

interface CertificateStore {
  app: TlsScopeSettings
  workspace: TlsScopeSettings
  isLoading: boolean
  loadAll: () => Promise<void>
  reloadScope: (scope: TlsScope) => Promise<void>
  addCA: (args: { scope: TlsScope; sourcePath: string; label?: string }) => Promise<CACertEntry>
  addClient: (args: {
    scope: TlsScope
    host: string
    port?: number | null
    type: 'pem' | 'pfx'
    sourcePaths: { certPath?: string; keyPath?: string; pfxPath?: string }
    passphrase?: string | null
  }) => Promise<ClientCertEntry>
  updateCA: (args: {
    scope: TlsScope
    id: string
    patch: { label?: string | null }
  }) => Promise<CACertEntry>
  updateClient: (args: {
    scope: TlsScope
    id: string
    patch: {
      host?: string
      port?: number | null
      passphrase?: string | null
      disabled?: boolean
    }
  }) => Promise<ClientCertEntry>
  remove: (args: { scope: TlsScope; id: string; kind: 'ca' | 'client' }) => Promise<void>
}

export const useCertificateStore = create<CertificateStore>()((set, _get) => ({
  app: EMPTY,
  workspace: EMPTY,
  isLoading: false,

  loadAll: async () => {
    set({ isLoading: true })
    try {
      const [app, workspace] = await Promise.all([
        window.api.certificates.list('app'),
        window.api.certificates.list('workspace')
      ])
      set({ app, workspace, isLoading: false })
    } catch (err) {
      console.error('[certificates] loadAll failed:', err)
      set({ isLoading: false })
    }
  },

  reloadScope: async (scope) => {
    try {
      const next = await window.api.certificates.list(scope)
      set(scope === 'app' ? { app: next } : { workspace: next })
    } catch (err) {
      console.error(`[certificates] reload ${scope} failed:`, err)
    }
  },

  addCA: async (args) => {
    const entry = await window.api.certificates.addCA(args)
    // The main process broadcasts certificates:changed which triggers a reload;
    // still, await refresh here so the awaiting caller sees the new entry.
    await useCertificateStore.getState().reloadScope(args.scope)
    return entry
  },

  addClient: async (args) => {
    const entry = await window.api.certificates.addClient(args)
    await useCertificateStore.getState().reloadScope(args.scope)
    return entry
  },

  updateCA: async (args) => {
    const entry = await window.api.certificates.updateCA(args)
    await useCertificateStore.getState().reloadScope(args.scope)
    return entry
  },

  updateClient: async (args) => {
    const entry = await window.api.certificates.updateClient(args)
    await useCertificateStore.getState().reloadScope(args.scope)
    return entry
  },

  remove: async (args) => {
    await window.api.certificates.remove(args)
    await useCertificateStore.getState().reloadScope(args.scope)
  }
}))

if (typeof window !== 'undefined' && window.api?.certificates?.onChanged) {
  window.api.certificates.onChanged((scope) => {
    useCertificateStore
      .getState()
      .reloadScope(scope)
      .catch((err) => console.error('[certificates] broadcast refresh failed:', err))
  })
}
