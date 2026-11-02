/**
 * Drift guard for the product URLs the interface links to. The releases page is
 * derived from the repository declared in `package.json`, so a repository move
 * that forgets this constant fails here instead of shipping a dead download link.
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { PRODUCT_RELEASES_URL } from './types'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8')
) as { repository: { url: string } }

describe('PRODUCT_RELEASES_URL', () => {
  it('is the Releases page of the repository declared in package.json', () => {
    const repo = pkg.repository.url.replace(/\.git$/, '')
    expect(PRODUCT_RELEASES_URL).toBe(`${repo}/releases`)
  })
})
