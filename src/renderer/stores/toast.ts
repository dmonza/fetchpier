import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'error'

export interface ToastMessage {
  id: string
  message: string
  type: ToastType
  durationMs: number
}

export interface ToastStore {
  messages: ToastMessage[]
  /**
   * Push a toast. Schedules automatic dismissal after `durationMs` (default
   * 3500 ms). Returns the toast id so callers can dismiss it earlier.
   */
  push: (message: string, opts?: { type?: ToastType; durationMs?: number }) => string
  dismiss: (id: string) => void
}

let counter = 0
const nextId = (): string => `t-${++counter}-${Date.now()}`

export const useToastStore = create<ToastStore>((set, get) => ({
  messages: [],
  push: (message, opts) => {
    const id = nextId()
    const toast: ToastMessage = {
      id,
      message,
      type: opts?.type ?? 'info',
      durationMs: opts?.durationMs ?? 3500
    }
    set((s) => ({ messages: [...s.messages, toast] }))
    setTimeout(() => {
      // Re-check existence: caller may have already dismissed.
      if (get().messages.some((m) => m.id === id)) {
        get().dismiss(id)
      }
    }, toast.durationMs)
    return id
  },
  dismiss: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) }))
}))
