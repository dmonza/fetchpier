import { create } from 'zustand'
import { DEFAULT_BINARY_FILE_LIMITS } from '../../shared/types'
import type { WorkspaceHttpSettings } from '../../shared/types'

const DEFAULT: WorkspaceHttpSettings = {
  httpVersion: 'auto',
  verifySsl: true,
  followRedirects: true,
  maxRedirects: 10,
  followAuthorizationOnRedirect: false,
  encodeUrl: true,
  disableCookieJar: false,
  binaryFileLimits: DEFAULT_BINARY_FILE_LIMITS
}

interface WorkspaceSettingsState {
  httpSettings: WorkspaceHttpSettings
  isLoading: boolean
  /** Set to the workspace path that was last loaded. */
  loadedFor: string | null

  load: (workspacePath: string) => Promise<void>
  update: (partial: Partial<WorkspaceHttpSettings>) => Promise<void>
  resetToDefaults: () => Promise<void>
  /** Apply a broadcast from main without making another IPC call. */
  applyExternal: (next: WorkspaceHttpSettings) => void
}

export const useWorkspaceSettingsStore = create<WorkspaceSettingsState>()((set) => ({
  httpSettings: DEFAULT,
  isLoading: false,
  loadedFor: null,

  load: async (workspacePath) => {
    set({ isLoading: true })
    try {
      const settings = await window.api.workspace.getHttpSettings()
      set({ httpSettings: settings, loadedFor: workspacePath })
    } finally {
      set({ isLoading: false })
    }
  },

  update: async (partial) => {
    const next = await window.api.workspace.updateHttpSettings(partial)
    set({ httpSettings: next })
  },

  resetToDefaults: async () => {
    const next = await window.api.workspace.updateHttpSettings(DEFAULT)
    set({ httpSettings: next })
  },

  applyExternal: (next) => set({ httpSettings: next })
}))
