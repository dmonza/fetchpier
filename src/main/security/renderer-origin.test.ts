import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { createRendererUrlPolicy } from './renderer-origin'

const RENDERER_DIR = join(tmpdir(), 'Fetchpier App', 'resources', 'app.asar', 'out', 'renderer')
const fileUrl = (...segments: string[]): string => pathToFileURL(join(...segments)).href

describe('createRendererUrlPolicy — packaged documents', () => {
  const isAllowed = createRendererUrlPolicy({ rendererDir: RENDERER_DIR })

  it('accepts the main window document', () => {
    expect(isAllowed(fileUrl(RENDERER_DIR, 'index.html'))).toBe(true)
  })

  it('accepts the activity-panel popout document', () => {
    expect(isAllowed(fileUrl(RENDERER_DIR, 'activity-panel-popout.html'))).toBe(true)
  })

  it('ignores the query string and the fragment', () => {
    expect(isAllowed(`${fileUrl(RENDERER_DIR, 'index.html')}?a=1#/route`)).toBe(true)
  })

  it('rejects another file in the renderer directory', () => {
    expect(isAllowed(fileUrl(RENDERER_DIR, 'assets', 'index.html'))).toBe(false)
    expect(isAllowed(fileUrl(RENDERER_DIR, 'other.html'))).toBe(false)
  })

  it('rejects a look-alike document outside the app (path ending in /renderer/index.html)', () => {
    expect(isAllowed(fileUrl(tmpdir(), 'Downloads', 'renderer', 'index.html'))).toBe(false)
  })

  it('rejects non-file origins and malformed input', () => {
    expect(isAllowed('https://example.com/renderer/index.html')).toBe(false)
    expect(isAllowed('about:blank')).toBe(false)
    expect(isAllowed('not a url')).toBe(false)
    expect(isAllowed('')).toBe(false)
  })
})

describe('createRendererUrlPolicy — dev server', () => {
  const isAllowed = createRendererUrlPolicy({
    devUrl: 'http://localhost:5173',
    rendererDir: RENDERER_DIR
  })

  it('accepts any document served by the dev server origin', () => {
    expect(isAllowed('http://localhost:5173/')).toBe(true)
    expect(isAllowed('http://localhost:5173/activity-panel-popout.html')).toBe(true)
  })

  it('rejects an origin that only shares a string prefix with the dev server', () => {
    expect(isAllowed('http://localhost:51730/')).toBe(false)
    expect(isAllowed('http://localhost:5173.evil.test/')).toBe(false)
  })

  it('rejects the packaged documents while a dev server is configured', () => {
    expect(isAllowed(fileUrl(RENDERER_DIR, 'index.html'))).toBe(false)
  })
})
