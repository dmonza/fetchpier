import { describe, it, expect } from 'vitest'
// @ts-expect-error — the module under test is plain .mjs typed through JSDoc, which
// this spec imports from TypeScript; `scripts/` is outside every tsconfig, so
// there is no declaration file to resolve.
import { compareLicenseText, checkLicenseFile } from './check-license-file.mjs'

// Unit/integration coverage for the third-party license drift gate (CI-001).
// The generator is injected, so no
// test here shells out to the real license tool.

describe('compareLicenseText', () => {
  it('reports no drift for identical content', () => {
    const text = 'Copyright (c) Someone\n\nMIT terms here.\n'
    expect(compareLicenseText(text, text).ok).toBe(true)
  })

  it('ignores a line-ending difference so the gate survives crossing platforms', () => {
    const lf = 'Copyright (c) Someone\nMIT terms here.\n'
    const crlf = 'Copyright (c) Someone\r\nMIT terms here.\r\n'
    expect(compareLicenseText(lf, crlf).ok).toBe(true)
  })

  it('ignores trailing blank lines at end of file', () => {
    const a = 'Copyright (c) Someone\n'
    const b = 'Copyright (c) Someone\n\n\n'
    expect(compareLicenseText(a, b).ok).toBe(true)
  })

  it('detects a changed line and reports where it first diverges', () => {
    const committed = 'line one\nline two\nline three\n'
    const generated = 'line one\nline TWO\nline three\n'
    const result = compareLicenseText(committed, generated)

    expect(result.ok).toBe(false)
    expect(result.firstDiffLine).toBe(2)
  })

  it('detects an added dependency block at the end', () => {
    const committed = 'pkg-a\n'
    const generated = 'pkg-a\npkg-b\n'
    const result = compareLicenseText(committed, generated)

    expect(result.ok).toBe(false)
    expect(result.firstDiffLine).toBe(2)
  })

  it('detects a removed dependency block', () => {
    const committed = 'pkg-a\npkg-b\n'
    const generated = 'pkg-a\n'
    const result = compareLicenseText(committed, generated)

    expect(result.ok).toBe(false)
    expect(result.firstDiffLine).toBe(2)
  })
})

describe('checkLicenseFile', () => {
  it('passes when the committed file matches what the dependencies generate', async () => {
    const result = await checkLicenseFile({
      readCommitted: async () => 'same\n',
      generate: async () => 'same\n'
    })

    expect(result.ok).toBe(true)
  })

  it('fails when the committed file is stale', async () => {
    const result = await checkLicenseFile({
      readCommitted: async () => 'old\n',
      generate: async () => 'new\n'
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('drift')
  })

  it('fails with a distinct reason when the committed file is absent', async () => {
    const result = await checkLicenseFile({
      readCommitted: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      generate: async () => 'anything\n'
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing')
  })

  it('fails with a distinct reason when generation itself breaks', async () => {
    const result = await checkLicenseFile({
      readCommitted: async () => 'whatever\n',
      generate: async () => {
        throw new Error('license tool exploded')
      }
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('generator-failed')
    expect(result.detail).toContain('license tool exploded')
  })
})
