import { resolve } from 'node:path'
import { defineConfig } from 'tsup'
import { bundledLicensesPlugin } from './tooling/bundled-licenses'

export default defineConfig((options) => ({
  // Dual entry: the `fp` binary (gets the shebang from src/fp.ts) and the
  // programmatic API (`@fetchpier/cli`). With `"type": "commonjs"` tsup emits
  // cjs → `.js` and esm → `.mjs`, so the bin resolves to `dist/fp.js`.
  entry: {
    fp: 'src/fp.ts',
    index: 'src/index.ts'
  },
  format: ['cjs', 'esm'],
  // Types only for the public API entry; the bin needs no `.d.ts`.
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  // Same rationale as @fetchpier/core: clean only on one-shot builds, never
  // under --watch (the dist wipe races consumers resolving the package).
  clean: !options.watch,
  target: 'node20',
  // `@fetchpier/core` is bundled IN (`noExternal`) so the published tarball is
  // self-contained: core is `"private": true` and cannot be resolved from the
  // public registry, so a `require('@fetchpier/core')` against a global install
  // would crash (REQ-0071). Inlining core's *own source* dodges that without
  // making core a public package. The CLI's own dependency, commander, is
  // bundled too, so the bin carries no CLI-only runtime dependency. `@shared/*`
  // is not a package: esbuild inlines it via the tsconfig `paths` (type-only,
  // erased — no Electron pulled in).
  //
  // What stays `external` is core's third-party runtime deps reached by the code
  // paths the CLI uses (undici, fast-xml-parser, mime). They are re-declared in
  // the CLI's own `dependencies` so `npm install -g` pulls them from the registry
  // like any normal dep — bundling them would only bloat the dist with no gain.
  // The main core barrel does not re-export `schema-import`, so its heavy deps
  // (graphql, js-yaml) are unreachable and not declared.
  //
  // `libsodium-wrappers` is a fourth entry in that `dependencies` list without
  // appearing here, and the asymmetry is the point: core reaches it through
  // `createRequire`, which esbuild cannot follow, so it is already external
  // whether or not this array says so. Listing it would suggest the choice was
  // ours. `@fetchpier/core`'s `runtime-dynamic-deps.ts` is the canonical list of
  // those, and two tests pin it to the manifest — it was missing from
  // `dependencies` in a shipped tarball, where it surfaced as "invalid
  // workspace key" rather than as a missing module.
  external: ['undici', 'fast-xml-parser', 'mime'],
  noExternal: ['commander', '@fetchpier/core'],
  // Inlining third-party code obliges us to ship its license notices. Written
  // to dist/ on every build from the exact bundled inputs, so the tarball
  // (`files: ["dist", …]`) always carries them — see tooling/bundled-licenses.ts.
  esbuildPlugins: [
    bundledLicensesPlugin({
      outFile: resolve('dist', 'THIRD_PARTY_LICENSES.txt'),
      packageName: '@fetchpier/cli'
    })
  ],
  tsconfig: './tsconfig.json',
  banner: {
    js: '/*! Fetchpier — Copyright (c) 2026 Daniel Monza — MIT — https://fetchpier.com */'
  }
}))
