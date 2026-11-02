import { create } from 'zustand'
import type {
  Environment,
  SecretsAddKeyResult,
  SecretsEnterKeyResult,
  SecretsSetupResult,
  SecretsStatus,
  WorkspaceKeyMetadata,
  WorkspaceKeyReferences
} from '../../shared/types'

interface SecretsState {
  status: SecretsStatus | null
  /** Re-read the workspace secret-encryption status. */
  refreshStatus: () => Promise<SecretsStatus>
  /** Generate the workspace key (first secret). Returns the one-time backup key. */
  setup: () => Promise<SecretsSetupResult>
  /** Submit a pasted key to unlock the workspace. */
  enterKey: (key: string) => Promise<SecretsEnterKeyResult>
  /** Reveal one secret's plaintext (runs the re-auth gate in main). */
  reveal: (envId: string, name: string) => Promise<string>
  /** Mark a variable secret / set a secret's value. */
  setSecret: (envId: string, name: string, plaintext: string) => Promise<Environment>
  /** Turn a secret back into a plaintext variable. */
  unsetSecret: (envId: string, name: string) => Promise<Environment>
  /** Author a needs-value entry / clear a corrupt one. */
  clearSecret: (envId: string, name: string) => Promise<Environment>
  /** REQ-0077: delete a secret variable directly (both layers, no decryption). */
  deleteSecret: (envId: string, name: string) => Promise<Environment>
  /** Rotate the workspace key. Returns the new one-time backup key. */
  rotate: () => Promise<SecretsSetupResult>

  // ── REQ-0073: Workspace keys management slice (metadata only) ──────────────
  /** Listed keystore entries (metadata, never key material). */
  keys: WorkspaceKeyMetadata[]
  /** Reference marks computed fresh on the last `listKeys` call. */
  references: WorkspaceKeyReferences | null
  /** True while the tab is (re)loading the listing. */
  keysLoading: boolean
  /** Refresh the keystore listing + reference marks. Never prompts (no unwrap). */
  listKeys: () => Promise<void>
  /** Forget a key on this machine, then refresh the listing. */
  deleteKey: (keyId: string) => Promise<void>
  /**
   * Add a pasted key. The `key` argument is forwarded straight to IPC and never
   * retained in store state. Refreshes the listing on a mutating result.
   */
  addKey: (key: string, hint?: string, replace?: boolean) => Promise<SecretsAddKeyResult>
}

export const useSecretsStore = create<SecretsState>()((set) => ({
  status: null,

  refreshStatus: async () => {
    const status = await window.api.secrets.status()
    set({ status })
    return status
  },

  setup: async () => {
    const result = await window.api.secrets.setup()
    const status = await window.api.secrets.status()
    set({ status })
    return result
  },

  enterKey: async (key) => {
    const result = await window.api.secrets.enterKey(key)
    if (result.ok) {
      const status = await window.api.secrets.status()
      set({ status })
    }
    return result
  },

  reveal: (envId, name) => window.api.secrets.reveal(envId, name),

  setSecret: (envId, name, plaintext) => window.api.secrets.setSecret(envId, name, plaintext),

  unsetSecret: (envId, name) => window.api.secrets.unsetSecret(envId, name),

  clearSecret: (envId, name) => window.api.secrets.clearSecret(envId, name),

  deleteSecret: (envId, name) => window.api.secrets.deleteSecret(envId, name),

  rotate: async () => {
    const result = await window.api.secrets.rotate()
    const status = await window.api.secrets.status()
    set({ status })
    return result
  },

  keys: [],
  references: null,
  keysLoading: false,

  listKeys: async () => {
    set({ keysLoading: true })
    try {
      const { entries, references } = await window.api.secrets.listKeys()
      set({ keys: entries, references })
    } finally {
      set({ keysLoading: false })
    }
  },

  deleteKey: async (keyId) => {
    await window.api.secrets.deleteKey(keyId)
    const { entries, references } = await window.api.secrets.listKeys()
    set({ keys: entries, references })
  },

  addKey: async (key, hint, replace) => {
    const result = await window.api.secrets.addKey(key, hint, replace)
    if (result.status !== 'conflict' && result.status !== 'invalid-format') {
      const { entries, references } = await window.api.secrets.listKeys()
      set({ keys: entries, references })
    }
    return result
  }
}))
