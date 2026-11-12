import { create } from 'zustand'
import type { Environment } from '../../shared/types'
import { useCookieStore } from './cookies'

interface EnvironmentState {
  environments: Environment[]
  activeEnvironmentId: string | null
  isLoading: boolean
  /** Current workspace path — used to persist active env selection */
  workspacePath: string | null
  /**
   * Per-environment snapshot of the variables as last synced with disk (load or
   * successful save). Sent as the merge baseline on save so a concurrent editor's
   * change to a *different* variable is preserved (REQ write-safety). Not for UI.
   */
  baselines: Record<string, Record<string, string | null>>

  /** Load all environments for the given workspace from disk. */
  loadEnvironments: (workspacePath: string) => Promise<void>
  /** Set the active environment by id (null = no environment). */
  setActive: (id: string | null) => void
  /** Create a new environment with the given name. */
  createEnvironment: (name: string) => Promise<Environment>
  /**
   * Rename an environment. The folder moves and the display name changes; the
   * identifier does not, so the selected and active environments are untouched
   * and the personal workspace state is never written.
   */
  renameEnvironment: (envId: string, newName: string) => Promise<Environment>
  /** Duplicate an environment under `newName`. The copy gets a fresh identifier. */
  duplicateEnvironment: (sourceEnvId: string, newName: string) => Promise<Environment>
  /** Save changes to an existing environment. */
  saveEnvironment: (env: Environment) => Promise<void>
  /**
   * Replace an environment in the store without an IPC write (REQ-0070). Used
   * after a secret operation, whose handler already persisted the updated
   * environment and returns the new shape.
   */
  replaceEnvironment: (env: Environment) => void
  /** Delete an environment by id. */
  deleteEnvironment: (envId: string) => Promise<void>
  /** Returns the variables of the currently active environment, or {} if none. */
  getActiveVariables: () => Record<string, string>
}

export const useEnvironmentStore = create<EnvironmentState>()((set, get) => ({
  environments: [],
  activeEnvironmentId: null,
  isLoading: false,
  workspacePath: null,
  baselines: {},

  loadEnvironments: async (workspacePath: string) => {
    set({ isLoading: true, workspacePath })
    try {
      const [envs, workspaceState] = await Promise.all([
        window.api.environment.list(),
        window.api.workspaceState.read()
      ])
      const savedId = workspaceState.activeEnvironmentId ?? null
      const savedExists = savedId !== null && envs.some((e) => e.id === savedId)
      let finalActiveId: string | null = null
      set((state) => {
        const stillExists =
          state.activeEnvironmentId !== null &&
          state.workspacePath === workspacePath &&
          envs.some((e) => e.id === state.activeEnvironmentId)
        const activeEnvironmentId = savedExists
          ? savedId
          : stillExists
            ? state.activeEnvironmentId
            : (envs[0]?.id ?? null)
        finalActiveId = activeEnvironmentId
        const baselines = Object.fromEntries(envs.map((e) => [e.id, { ...e.variables }]))
        return { environments: envs, activeEnvironmentId, baselines }
      })
      useCookieStore.getState().loadForEnvironment(finalActiveId).catch(console.error)
    } finally {
      set({ isLoading: false })
    }
  },

  setActive: (id) => {
    set({ activeEnvironmentId: id })
    const { workspacePath } = get()
    if (workspacePath) {
      window.api.workspaceState.setActiveEnvironment(id).catch(console.error)
    }
    useCookieStore.getState().loadForEnvironment(id).catch(console.error)
  },

  createEnvironment: async (name) => {
    const env = await window.api.environment.create(name)
    set((state) => ({
      environments: [...state.environments, env],
      baselines: { ...state.baselines, [env.id]: { ...env.variables } }
    }))
    return env
  },

  renameEnvironment: async (envId, newName) => {
    const renamed = await window.api.environment.rename(envId, newName)
    // The identifier is stable across a rename, so the row keeps its place, the
    // selection survives, and `activeEnvironmentId` needs no write — that is the
    // whole point of decoupling identity from the folder.
    set((state) => ({
      environments: state.environments.map((e) => (e.id === renamed.id ? renamed : e)),
      baselines: { ...state.baselines, [renamed.id]: { ...renamed.variables } }
    }))
    return renamed
  },

  duplicateEnvironment: async (sourceEnvId, newName) => {
    const copy = await window.api.environment.duplicate(sourceEnvId, newName)
    set((state) => ({
      environments: [...state.environments, copy],
      baselines: { ...state.baselines, [copy.id]: { ...copy.variables } }
    }))
    return copy
  },

  saveEnvironment: async (env) => {
    // Send the pre-edit baseline so the main-process merge only overwrites the
    // variables this editor actually changed (REQ write-safety).
    const baseline = get().baselines[env.id]
    await window.api.environment.save(env, baseline)
    set((state) => ({
      environments: state.environments.map((e) => (e.id === env.id ? env : e)),
      baselines: { ...state.baselines, [env.id]: { ...env.variables } }
    }))
  },

  replaceEnvironment: (env) => {
    set((state) => ({
      environments: state.environments.map((e) => (e.id === env.id ? env : e)),
      baselines: { ...state.baselines, [env.id]: { ...env.variables } }
    }))
  },

  deleteEnvironment: async (envId) => {
    await window.api.environment.delete(envId)
    const wasActive = get().activeEnvironmentId === envId
    set((state) => {
      const remaining = state.environments.filter((e) => e.id !== envId)
      const { [envId]: _removed, ...baselines } = state.baselines
      return { environments: remaining, baselines }
    })
    if (wasActive) {
      // Through `setActive`: besides the persisted selection it re-points the
      // cookie store and main's send environment, which would otherwise keep
      // resolving secrets, local values and cookies against the deleted id.
      get().setActive(get().environments[0]?.id ?? null)
      return
    }
    const { workspacePath: wp } = get()
    if (wp) {
      const { activeEnvironmentId } = get()
      window.api.workspaceState.setActiveEnvironment(activeEnvironmentId).catch(console.error)
    }
  },

  getActiveVariables: () => {
    const { environments, activeEnvironmentId } = get()
    if (!activeEnvironmentId) return {}
    const variables = environments.find((e) => e.id === activeEnvironmentId)?.variables ?? {}
    // REQ-0076: the unified map mixes plain + secret (`enc:`/`null`) values; expose
    // only the plain ones for renderer-side interpolation/preview (secrets resolve
    // in the main process).
    const plain: Record<string, string> = {}
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === 'string' && !value.startsWith('enc:')) plain[name] = value
    }
    return plain
  }
}))
