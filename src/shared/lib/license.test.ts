import { describe, expect, it } from 'vitest'
import { splitLicenseText } from './license'

const MIT = [
  'MIT License',
  '',
  'Copyright (c) 2026 Daniel Monza — Fetchpier (https://fetchpier.com)',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software.'
].join('\n')

describe('splitLicenseText', () => {
  it('extracts the first line starting with "Copyright", verbatim', () => {
    const { copyright } = splitLicenseText(MIT)
    expect(copyright).toBe('Copyright (c) 2026 Daniel Monza — Fetchpier (https://fetchpier.com)')
  })

  it('keeps the body as the whole file, copyright line included', () => {
    const { body } = splitLicenseText(MIT)
    expect(body).toBe(MIT)
  })

  it('takes the first Copyright line when several exist', () => {
    const text = 'A\nCopyright first\nB\nCopyright second'
    const { copyright, body } = splitLicenseText(text)
    expect(copyright).toBe('Copyright first')
    expect(body).toBe(text)
  })

  it('returns a null copyright and the whole text when no line starts with "Copyright"', () => {
    const text = 'Public domain.\nNo notice here.'
    const { copyright, body } = splitLicenseText(text)
    expect(copyright).toBeNull()
    expect(body).toBe(text)
  })

  it('does not match a line that merely mentions Copyright after other text', () => {
    const text = '  Copyright indented\nThe Copyright notice above.'
    const { copyright } = splitLicenseText(text)
    expect(copyright).toBeNull()
  })

  it('normalizes CRLF, in the copyright line and in the body alike', () => {
    const { copyright, body } = splitLicenseText('MIT\r\nCopyright (c) X\r\nBody\r\n')
    expect(copyright).toBe('Copyright (c) X')
    expect(body).toBe('MIT\nCopyright (c) X\nBody')
  })

  it('trims the blank lines surrounding the file, not its inner spacing', () => {
    const { body } = splitLicenseText('\n\nMIT\n\nCopyright (c) X\n\nBody\n\n')
    expect(body).toBe('MIT\n\nCopyright (c) X\n\nBody')
  })

  it('handles an empty file', () => {
    expect(splitLicenseText('')).toEqual({ copyright: null, body: '' })
  })
})
