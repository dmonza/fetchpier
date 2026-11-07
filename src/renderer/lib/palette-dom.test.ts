import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPaletteOverrides, createFrameApplier, inlinePaletteOverrides } from './palette-dom'
import { ORIGINAL_PALETTES } from '../../shared/palette/original'

const root = document.documentElement

beforeEach(() => {
  root.removeAttribute('style')
})

// Requirement *Dynamic color themes* §6.4.3 / §8.5 of the source specification:
// one central place applies a palette, and nothing of a previous palette survives.
describe('applyPaletteOverrides', () => {
  it('sets every token of a palette as an inline custom property', () => {
    applyPaletteOverrides({ canvas: '#101010', primary: '#123456' })
    expect(root.style.getPropertyValue('--canvas')).toBe('#101010')
    expect(root.style.getPropertyValue('--primary')).toBe('#123456')
  })

  it('removes every override for Original, so the stylesheet shows (CA-08)', () => {
    applyPaletteOverrides({ ...ORIGINAL_PALETTES.dark, canvas: '#000001' })
    applyPaletteOverrides(null)
    expect(inlinePaletteOverrides()).toEqual({})
  })

  it('leaves nothing of the previous palette behind (CA-09)', () => {
    applyPaletteOverrides({ canvas: '#101010', primary: '#123456', ring: '#abcdef' })
    applyPaletteOverrides({ canvas: '#202020' })
    expect(inlinePaletteOverrides()).toEqual({ canvas: '#202020' })
  })

  it('never touches inline properties that are not palette tokens', () => {
    root.style.setProperty('--titlebar-height', '40px')
    root.style.setProperty('zoom', '1.1')
    applyPaletteOverrides({ canvas: '#101010' })
    applyPaletteOverrides(null)
    expect(root.style.getPropertyValue('--titlebar-height')).toBe('40px')
    expect(root.style.getPropertyValue('zoom')).toBe('1.1')
  })

  it('removes overrides a preload applied before the interface existed', () => {
    root.style.setProperty('--canvas', '#030303')
    applyPaletteOverrides(null)
    expect(root.style.getPropertyValue('--canvas')).toBe('')
  })
})

describe('createFrameApplier', () => {
  it('applies at most once per frame, with the latest palette', () => {
    const frames: Array<() => void> = []
    const apply = vi.fn()
    const schedule = createFrameApplier(apply, (cb) => {
      frames.push(cb)
      return frames.length
    })

    schedule({ canvas: '#000001' })
    schedule({ canvas: '#000002' })
    schedule({ canvas: '#000003' })
    expect(apply).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)

    frames[0]()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ canvas: '#000003' })
  })

  it('applies immediately and drops a pending frame when asked to', () => {
    const frames: Array<() => void> = []
    const apply = vi.fn()
    const schedule = createFrameApplier(apply, (cb) => {
      frames.push(cb)
      return frames.length
    })

    schedule({ canvas: '#000001' })
    schedule.now(null)
    expect(apply).toHaveBeenCalledWith(null)
    frames[0]()
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
