import { describe, expect, it } from 'vitest'
import { PALETTE_ARG } from '../app-shell'
import { decodePaletteArg, encodePaletteArg } from './launch-arg'
import { ORIGINAL_PALETTES } from './original'

const NONE = { light: null, dark: null }

describe('palette launch argument', () => {
  it('round-trips both modes', () => {
    const palettes = { light: { ...ORIGINAL_PALETTES.light }, dark: null }
    const arg = encodePaletteArg(palettes)
    expect(arg.startsWith(PALETTE_ARG)).toBe(true)
    // No characters a command line could mangle.
    expect(arg.slice(PALETTE_ARG.length)).toMatch(/^[A-Za-z0-9_-]*$/)
    expect(decodePaletteArg(['electron', '--foo', arg])).toEqual(palettes)
  })

  it('reads as Original when the argument is absent', () => {
    expect(decodePaletteArg(['electron', '--fetchpier-resolved-theme=dark'])).toEqual(NONE)
  })

  const forge = (value: unknown): string =>
    PALETTE_ARG +
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  it.each([
    ['not base64 JSON', `${PALETTE_ARG}%%%`],
    ['not an object', forge(['x'])],
    ['an unknown token', forge({ light: { 'surface-1': '#ffffff', evil: '#000000' }, dark: null })],
    [
      'a value that is not a colour',
      forge({ light: { canvas: 'red;}body{background:url(x)' }, dark: null })
    ],
    ['an injected declaration', forge({ light: { canvas: '#ffffff; color: red' }, dark: null })],
    ['a mode that is neither null nor an object', forge({ light: 'ocean', dark: null })],
    ['an oversize payload', `${PALETTE_ARG}${'A'.repeat(20000)}`]
  ])('drops the whole argument when it holds %s', (_label, arg) => {
    expect(decodePaletteArg([arg])).toEqual(NONE)
  })
})
