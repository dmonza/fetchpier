import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import prettier from 'prettier'

// Coverage for the formatter's configuration contract (CI-003). Everything here resolves through the formatter's own APIs
// against the real `.prettierrc` / `.prettierignore`, so the tests assert
// behavior rather than the text of two config files.
//
// What is deliberately NOT tested here: that the whole repository is currently
// formatted. That is exactly what `npm run format:check` does, and it runs in
// two gates — re-proving it in Vitest would cost seconds on every run.

const REPO_ROOT = resolve(__dirname, '..')
const IGNORE_PATH = resolve(REPO_ROOT, '.prettierignore')
const p = (...segments: string[]): string => resolve(REPO_ROOT, ...segments)

describe('formatter configuration', () => {
  it('resolves the committed configuration instead of falling back to factory defaults', async () => {
    const found = await prettier.resolveConfigFile(p('src', 'main', 'index.ts'))
    expect(found).toBe(p('.prettierrc'))
  })

  // The four settings are the whole contract: each one is the opposite of the
  // formatter's default, which is why their absence produced a ~680-file drift.
  it('states the four settings that match the codebase', async () => {
    const config = await prettier.resolveConfig(p('src', 'main', 'index.ts'))
    expect(config).toMatchObject({
      singleQuote: true,
      semi: false,
      trailingComma: 'none',
      printWidth: 100
    })
  })
})

describe('formatter ignore rules', () => {
  const isIgnored = async (relativePath: string): Promise<boolean> => {
    const info = await prettier.getFileInfo(p(relativePath), { ignorePath: IGNORE_PATH })
    return info.ignored
  }

  // The formatter does not read .gitignore. `playwright-report/index.html` is a
  // generated single-file report with embedded minified script: left governed,
  // it alone expands by ~21.7k lines and swamps every other diff. This is the
  // highest-value assertion in the file.
  it.each([
    ['out/main/index.js', 'build output'],
    ['dist/index.js', 'build output'],
    ['coverage/coverage-summary.json', 'coverage output'],
    ['playwright-report/index.html', 'generated report with embedded minified script'],
    ['test-results/report.json', 'generated test output']
  ])('excludes %s (%s)', async (path) => {
    expect(await isIgnored(path)).toBe(true)
  })

  // The maintainer's local documentation folder is not part of the published
  // tree and is never formatted.
  it.each([
    ['docs/SYSTEM.md'],
    ['docs/requirements/REQ-0001-example.md'],
    ['docs/plans/PLAN-0001-example.md'],
    ['docs/manual/manual.md']
  ])('excludes %s', async (path) => {
    expect(await isIgnored(path)).toBe(true)
  })

  // Fixtures are compared byte-for-byte by the importer and e2e suites;
  // reformatting one would silently change what those suites assert.
  it.each([
    ['test/fixtures/binary/payload.json'],
    ['test/workspaces/postman-import/collection-with-scripts.json'],
    ['packages/fetchpier-core/src/schema-import/importers/__fixtures__/postman/basic.json']
  ])('excludes the fixture %s', async (path) => {
    expect(await isIgnored(path)).toBe(true)
  })

  // Scripts regenerate these through a serializer whose output the formatter
  // does not reproduce exactly; governing them would turn the gate red after
  // every legitimate baseline update.
  it.each([['test/perf-baseline.json'], ['test/coverage-baseline.json']])(
    'excludes the baseline %s',
    async (path) => {
      expect(await isIgnored(path)).toBe(true)
    }
  )

  // The negative half: the ignore file must not be so broad that it stops
  // governing the code it exists for.
  it.each([
    ['src/main/index.ts'],
    ['src/renderer/App.tsx'],
    ['packages/fetchpier-core/src/requests/client.ts'],
    ['packages/fetchpier-cli/src/index.ts'],
    ['scripts/post-req.mjs'],
    ['test/e2e/smoke.spec.ts'],
    ['package.json']
  ])('still governs %s', async (path) => {
    expect(await isIgnored(path)).toBe(false)
  })
})

describe('format gate wiring', () => {
  // The drift check is worthless if nothing invokes it. Both entry points are
  // asserted because they cover different ground: post-req is the local and
  // Linux-gate path, the CI static job is the fast cross-platform path.
  it('runs as a step of the completion gate', () => {
    const postReq = readFileSync(p('scripts', 'post-req.mjs'), 'utf8')
    expect(postReq).toContain('format:check')
  })

  it('runs in the CI static job alongside lint', () => {
    const ci = readFileSync(p('.github', 'workflows', 'ci.yml'), 'utf8')
    expect(ci).toContain('npm run format:check')
  })

  it('is exposed as a package script that checks without writing', () => {
    const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['format:check']).toBeDefined()
    expect(pkg.scripts['format:check']).not.toContain('--write')
  })
})
