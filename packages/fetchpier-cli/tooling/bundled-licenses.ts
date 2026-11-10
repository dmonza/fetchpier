/**
 * License notices for the third-party code bundled into `dist/`.
 *
 * `@fetchpier/cli` inlines some packages into its bundle (`noExternal`:
 * commander, and whatever `@fetchpier/core` pulls in, such as
 * tough-cookie and tldts). Their licenses require the copyright notice to
 * travel with every copy, and only a few of them carry a `/*!` legal comment
 * esbuild would preserve. This writes `dist/THIRD_PARTY_LICENSES.txt` on every
 * build, from the exact inputs esbuild bundled, so the published tarball
 * (`files: ["dist", …]`) always carries the notices of what it contains.
 *
 * Build-time only: imported by `tsup.config.ts`, never by `src/`, so it never
 * reaches the bundle. Packages installed separately by npm (the CLI's
 * `dependencies`) ship their own license files and are not repeated here.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Plugin } from 'esbuild'

export interface BundledPackage {
  name: string
  version: string
  license: string
  licenseText: string
}

const NODE_MODULES = `${sep}node_modules${sep}`
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i

/**
 * The package roots (absolute directories) that bundled input files belong to.
 * A file is attributed to the innermost `node_modules/<pkg>` (or
 * `node_modules/@scope/<pkg>`) above it; inputs outside `node_modules` — the
 * CLI's own source, core inlined from source, virtual modules — are skipped.
 */
export function packageRootsFromInputs(inputs: readonly string[], cwd: string): string[] {
  const roots = new Set<string>()
  for (const input of inputs) {
    const abs = resolve(cwd, input.split('\\').join('/'))
    const at = abs.lastIndexOf(NODE_MODULES)
    if (at < 0) continue
    const base = abs.slice(0, at + NODE_MODULES.length)
    const segments = abs.slice(base.length).split(sep)
    const name = segments[0].startsWith('@') ? join(segments[0], segments[1] ?? '') : segments[0]
    if (name) roots.add(join(base, name))
  }
  return [...roots].sort()
}

/** Name, version, declared license and license text of a package root. */
export function readBundledPackage(dir: string): BundledPackage {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
    name?: string
    version?: string
    license?: string
  }
  const name = manifest.name ?? dir
  const version = manifest.version ?? '0.0.0'
  const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f))
  if (!file) {
    // Failing the build is deliberate: shipping bundled code without its
    // notice is the defect this module exists to prevent.
    throw new Error(
      `[bundled-licenses] ${name}@${version} is bundled into dist/ but ships no license file (${dir})`
    )
  }
  return {
    name,
    version,
    license: manifest.license ?? 'SEE LICENSE TEXT',
    licenseText: readFileSync(join(dir, file), 'utf-8').replace(/\r\n/g, '\n').trim()
  }
}

/** Render the notices file: deterministic, one block per `name@version`. */
export function renderLicenseNotices(
  packageName: string,
  packages: readonly BundledPackage[]
): string {
  const unique = new Map<string, BundledPackage>()
  for (const p of packages) unique.set(`${p.name}@${p.version}`, p)
  const sorted = [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  )
  const rule = '-'.repeat(72)
  const header = [
    `Third-party software bundled into ${packageName}`,
    '',
    'This package includes code from the packages below; their license notices',
    'follow. Packages installed alongside it by npm (its "dependencies") ship',
    'their own license files and are not repeated here.',
    ''
  ]
  const blocks = sorted.flatMap((p) => [
    rule,
    `${p.name}@${p.version} (${p.license})`,
    rule,
    '',
    p.licenseText,
    ''
  ])
  return `${[...header, ...blocks].join('\n').trimEnd()}\n`
}

/**
 * esbuild plugin: enable the metafile, and after each build write the notices
 * for the union of packages bundled so far. tsup runs the cjs and esm builds
 * in one process, so the last (synchronous) write covers both formats.
 */
export function bundledLicensesPlugin(options: { outFile: string; packageName: string }): Plugin {
  const roots = new Set<string>()
  return {
    name: 'bundled-licenses',
    setup(build) {
      build.initialOptions.metafile = true
      const cwd = build.initialOptions.absWorkingDir ?? process.cwd()
      build.onEnd((result) => {
        if (result.errors.length > 0 || !result.metafile) return
        for (const r of packageRootsFromInputs(Object.keys(result.metafile.inputs), cwd)) {
          roots.add(r)
        }
        const text = renderLicenseNotices(options.packageName, [...roots].map(readBundledPackage))
        mkdirSync(dirname(options.outFile), { recursive: true })
        writeFileSync(options.outFile, text)
      })
    }
  }
}
