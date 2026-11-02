import { create } from 'zustand'
import type { Cookie } from '../../shared/types'

interface CookieStore {
  cookies: Cookie[]
  isLoading: boolean
  environmentId: string | null

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

  loadForEnvironment: async (envId) => {
    set({ isLoading: true, environmentId: envId })
    await window.api.cookies.setActiveEnvironment(envId)
    if (!envId) {
      set({ cookies: [], isLoading: false })
      return
    }
    try {
      const cookies = await window.api.cookies.list(envId)
      set({ cookies, isLoading: false })
    } catch (err) {
      console.error('[cookies] load failed:', err)
      set({ cookies: [], isLoading: false })
    }
  },

  create: async (cookie) => {
    const env = get().environmentId
    if (!env) return
    await window.api.cookies.create(env, { ...cookie, source: 'manual' })
    const cookies = await window.api.cookies.list(env)
    set({ cookies })
  },

  update: async (id, changes) => {
    const env = get().environmentId
    if (!env) return
    await window.api.cookies.update(env, id, changes)
    const cookies = await window.api.cookies.list(env)
    set({ cookies })
  },

  remove: async (id) => {
    const env = get().environmentId
    if (!env) return
    await window.api.cookies.delete(env, id)
    const cookies = await window.api.cookies.list(env)
    set({ cookies })
  },

  clearAll: async () => {
    const env = get().environmentId
    if (!env) return
    await window.api.cookies.clear(env)
    set({ cookies: [] })
  }
}))

// Subscribe to main-process broadcast; refresh store if the active env changed.
if (typeof window !== 'undefined' && window.api?.cookies?.onChanged) {
  window.api.cookies.onChanged((envId) => {
    const current = useCookieStore.getState().environmentId
    if (current && envId === current) {
      window.api.cookies
        .list(envId)
        .then((cookies) => useCookieStore.setState({ cookies }))
        .catch((err) => console.error('[cookies] refresh failed:', err))
    }
  })
}
