import { create } from 'zustand'
import type { Cookie } from '../../shared/types'

interface CookieStore {
  cookies: Cookie[]
  isLoading: boolean
  environmentId: string | null
  /** The message of the last failed load, `null` once a load succeeds. */
  loadError: string | null

  loadForEnvironment: (envId: string | null) => Promise<void>
  create: (cookie: Omit<Cookie, 'id' | 'createdAt' | 'updatedAt' | 'source'>) => Promise<void>
  update: (id: string, changes: Partial<Cookie>) => Promise<void>
  remove: (id: string) => Promise<void>
  clearAll: () => Promise<void>
}

export const useCookieStore = create<CookieStore>()((set, get) => ({
  cookies: [],
  isLoading: false,
  environmentId: null,
  loadError: null,

  loadForEnvironment: async (envId) => {
    set({ isLoading: true, environmentId: envId })
    // Overlapping loads can resolve out of order: after every await, a reply
    // for an environment that is no longer the active one is dropped, so the
    // last switch wins rather than the last reply.
    const stale = (): boolean => get().environmentId !== envId
    await window.api.cookies.setActiveEnvironment(envId)
    if (stale()) return
    if (!envId) {
      set({ cookies: [], isLoading: false, loadError: null })
      return
    }
    try {
      const cookies = await window.api.cookies.list(envId)
      if (stale()) return
      set({ cookies, isLoading: false, loadError: null })
    } catch (err) {
      console.error('[cookies] load failed:', err)
      if (stale()) return
      set({
        cookies: [],
        isLoading: false,
        loadError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  create: async (cookie) => {
    const env = get().environmentId
    if (!env) return
    await window.api.cookies.create(env, { ...cookie, source: 'manual' })
    const cookies = await window.api.cookies.list(env)
    if (get().environmentId === env) set({ cookies })
  },

  update: async (id, changes) => {
    const env = get().environmentId
    if (!env) return
    await window.api.cookies.update(env, id, changes)
    const cookies = await window.api.cookies.list(env)
    if (get().environmentId === env) set({ cookies })
  },

  remove: async (id) => {
    const env = get().environmentId
    if (!env) return
    await window.api.cookies.delete(env, id)
    const cookies = await window.api.cookies.list(env)
    if (get().environmentId === env) set({ cookies })
  },

  clearAll: async () => {
    const env = get().environmentId
    if (!env) return
    await window.api.cookies.clear(env)
    // The unreadable-jar banner recommends Clear all: once it succeeded, the
    // file it was about is gone.
    set({ cookies: [], loadError: null })
  }
}))

// Subscribe to main-process broadcast; refresh store if the active env changed.
if (typeof window !== 'undefined' && window.api?.cookies?.onChanged) {
  window.api.cookies.onChanged((envId) => {
    const current = useCookieStore.getState().environmentId
    if (current && envId === current) {
      window.api.cookies
        .list(envId)
        // A successful read means the jar is readable again (fixed by hand, or
        // replaced): the load failure no longer applies.
        .then((cookies) => {
          // The active environment may have changed while the list was read.
          if (useCookieStore.getState().environmentId !== envId) return
          useCookieStore.setState({ cookies, loadError: null })
        })
        .catch((err) => console.error('[cookies] refresh failed:', err))
    }
  })
}
