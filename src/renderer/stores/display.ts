import { create } from 'zustand'

const ZOOM_STEP = 0.1
const ZOOM_MIN = 0.5
const ZOOM_MAX = 2.0

interface DisplayState {
  zoomFactor: number
  scaleFactor: number
  setZoomFactor: (factor: number) => void
  setScaleFactor: (factor: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  setZoom: (factor: number) => void
}

export const useDisplayStore = create<DisplayState>()((set, get) => ({
  zoomFactor: 1.0,
  scaleFactor: 1.0,

  setZoomFactor: (factor) => set({ zoomFactor: factor }),
  setScaleFactor: (factor) => set({ scaleFactor: factor }),

  zoomIn: () => {
    const next = Math.min(ZOOM_MAX, Math.round((get().zoomFactor + ZOOM_STEP) * 10) / 10)
    get().setZoom(next)
  },

  zoomOut: () => {
    const next = Math.max(ZOOM_MIN, Math.round((get().zoomFactor - ZOOM_STEP) * 10) / 10)
    get().setZoom(next)
  },

  resetZoom: () => get().setZoom(1.0),

  setZoom: (factor: number) => {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor))
    const stepped = Math.round(clamped * 10) / 10
    window.api.display.setZoom(stepped).then((applied) => {
      set({ zoomFactor: applied })
    })
  }
}))
