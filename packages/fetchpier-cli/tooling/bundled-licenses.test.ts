import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundledLicensesPlugin,
  packageRootsFromInputs,
  readBundledPackage,
  renderLicenseNotices,
  type BundledPackage
} from './bundled-licenses'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fp-licenses-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fakePackage(
  dir: string,
  manifest: Record<string, unknown>,
  licenseFile?: [string, string]
): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  if (licenseFile) writeFileSync(join(dir, licenseFile[0]), licenseFile[1])
  return dir
}

describe('packageRootsFromInputs', () => {
  it('maps bundled input files to their package roots, deduplicated and sorted', () => {
    const cwd = join(root, 'packages', 'cli')
    const roots = packageRootsFromInputs(
      [
        'node_modules/commander/lib/command.js',
        'node_modules/commander/index.js',
        '../../node_modules/tldts/dist/index.js',
        'src/fp.ts',
        '../fetchpier-core/src/index.ts'
      ],
      cwd
    )
    expect(roots).toEqual(
      [join(cwd, 'node_modules', 'commander'), join(root, 'node_modules', 'tldts')].sort()
    )
  })

  it('keeps the scope of a scoped package', () => {
    const roots = packageRootsFromInputs(['node_modules/@scope/pkg/dist/a.js'], root)
    expect(roots).toEqual([join(root, 'node_modules', '@scope', 'pkg')])
  })

  it('attributes a file in a nested node_modules to the innermost package', () => {
    const roots = packageRootsFromInputs(['node_modules/outer/node_modules/inner/index.js'], root)
    expect(roots).toEqual([join(root, 'node_modules', 'outer', 'node_modules', 'inner')])
  })

  it('accepts backslash-separated inputs', () => {
    const roots = packageRootsFromInputs(['node_modules\\chalk\\source\\index.js'], root)
    expect(roots).toEqual([join(root, 'node_modules', 'chalk')])
  })

  it('returns nothing when no input comes from node_modules', () => {
    expect(packageRootsFromInputs(['src/index.ts', '<runtime>'], root)).toEqual([])
  })
})

describe('readBundledPackage', () => {
  it.each(['LICENSE', 'license', 'LICENSE.md', 'LICENCE.txt'])(
    'reads name, version, license and the %s text',
    (file) => {
      const dir = fakePackage(join(root, 'p'), { name: 'p', version: '1.2.3', license: 'MIT' }, [
        file,
        'Copyright (c) Someone\n'
      ])
      expect(readBundledPackage(dir)).toEqual({
        name: 'p',
        version: '1.2.3',
        license: 'MIT',
        licenseText: 'Copyright (c) Someone'
      })
    }
  )

  it('fails naming the package when it ships no license file', () => {
    const dir = fakePackage(join(root, 'bare'), { name: 'bare', version: '0.0.1', license: 'MIT' })
    expect(() => readBundledPackage(dir)).toThrow(/bare@0\.0\.1/)
  })
})

describe('bundledLicensesPlugin', () => {
  type OnEnd = (result: {
    errors: unknown[]
    metafile?: { inputs: Record<string, unknown> }
  }) => void

  /** A minimal stand-in for esbuild's `build` object: options + captured onEnd. */
  function fakeBuild(): { build: unknown; options: { metafile?: boolean }; end: OnEnd } {
    const options: { metafile?: boolean; absWorkingDir: string } = { absWorkingDir: root }
    let end: OnEnd = () => {}
    const build = { initialOptions: options, onEnd: (cb: OnEnd) => (end = cb) }
    return {
      build,
      options,
      get end() {
        return end
      }
    }
  }

  it('enables the metafile and writes the union of every build it saw', () => {
    fakePackage(join(root, 'node_modules', 'a'), { name: 'a', version: '1.0.0', license: 'MIT' }, [
      'LICENSE',
      'A license'
    ])
    fakePackage(join(root, 'node_modules', 'b'), { name: 'b', version: '2.0.0', license: 'ISC' }, [
      'LICENSE',
      'B license'
    ])
    const outFile = join(root, 'dist', 'THIRD_PARTY_LICENSES.txt')
    const plugin = bundledLicensesPlugin({ outFile, packageName: 'pkg' })

    const cjs = fakeBuild()
    const esm = fakeBuild()
    plugin.setup(cjs.build as never)
    plugin.setup(esm.build as never)
    expect(cjs.options.metafile).toBe(true)

    cjs.end({ errors: [], metafile: { inputs: { 'node_modules/a/index.js': {} } } })
    esm.end({ errors: [], metafile: { inputs: { 'node_modules/b/index.js': {} } } })

    const text = readFileSync(outFile, 'utf-8')
    expect(text).toContain('a@1.0.0 (MIT)')
    expect(text).toContain('b@2.0.0 (ISC)')
  })

  it('writes nothing for a failed build', () => {
    const outFile = join(root, 'dist', 'THIRD_PARTY_LICENSES.txt')
    const b = fakeBuild()
    bundledLicensesPlugin({ outFile, packageName: 'pkg' }).setup(b.build as never)
    b.end({ errors: [{}], metafile: { inputs: {} } })
    expect(existsSync(outFile)).toBe(false)
  })
})

describe('renderLicenseNotices', () => {
  const pkg = (name: string, version = '1.0.0'): BundledPackage => ({
    name,
    version,
    license: 'MIT',
    licenseText: `Copyright (c) ${name} authors`
  })

  it('lists every package once, sorted by name, each with its license text', () => {
    const text = renderLicenseNotices('@fetchpier/cli', [pkg('zeta'), pkg('alpha'), pkg('zeta')])
    expect(text).toContain('@fetchpier/cli')
    expect(text.match(/zeta@1\.0\.0 \(MIT\)/g)).toHaveLength(1)
    expect(text.indexOf('alpha@1.0.0')).toBeLessThan(text.indexOf('zeta@1.0.0'))
    expect(text).toContain('Copyright (c) alpha authors')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('is deterministic for the same input in any order', () => {
    expect(renderLicenseNotices('x', [pkg('b'), pkg('a')])).toBe(
      renderLicenseNotices('x', [pkg('a'), pkg('b')])
    )
  })
})
