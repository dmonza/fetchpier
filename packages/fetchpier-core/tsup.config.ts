import { defineConfig } from 'tsup'

export default defineConfig((options) => ({
  // Two entries (REQ-0063). `src/index.ts` is the cold-path surface
  // (`workspace`, `requests`, `scripting`, `tls`, `shared`); `src/schema-import.ts`
  // is a lazy secondary entry that the Electron main process loads only on the
  // first `schema:detectFormat`/`schema:import` IPC call. Splitting at the
  // build artifact level is the only way to keep `@readme/openapi-parser`,
  // `graphql`, `js-yaml`, `ajv` & co out of the cold-path bundle — a dynamic
  // import that resolves into the same monolith would gain nothing.
  entry: [
    'src/index.ts',
    'src/schema-import.ts',
    'src/activity-log/index.ts',
    // Durable-write helpers on their own, for the desktop's startup path — see
    // the header of `src/atomic-write.ts`.
    'src/atomic-write.ts'
  ],
  format: ['cjs'],
  dts: true,
  sourcemap: true,
  // CJS does not code-split by default, but make it explicit so the two
  // outputs (`dist/index.js`, `dist/schema-import.js`) cannot share a chunk
  // that would re-introduce the schema-import deps into the cold-path entry.
  splitting: false,
  // Limpiamos dist en builds one-shot, pero NO durante `--watch`. El `clean` de
  // tsup vacía dist/ antes de cada rebuild; durante `npm run dev` ese vaciado
  // compite con Electron cargando el paquete externalizado @fetchpier/core (que
  // se resuelve en runtime vía el symlink del workspace → dist/index.js), lo que
  // provoca "Cannot find module". Con dos entries fijos (`index.ts` y
  // `schema-import.ts`) siempre sobreescribimos los mismos archivos, así que
  // rebuildear in-place en watch sigue siendo seguro y no deja huérfanos.
  clean: !options.watch,
  target: 'node20',
  // The secrets module resolves libsodium-wrappers via `createRequire`, using a
  // `typeof __filename !== 'undefined' ? __filename : import.meta.url` anchor.
  // In the CJS output `__filename` is always defined, so the `import.meta.url`
  // branch is dead — silence esbuild's (correct but irrelevant) empty-import-meta
  // warning for this known case rather than littering the build log.
  esbuildOptions(options) {
    options.logOverride = { ...options.logOverride, 'empty-import-meta': 'silent' }
  },
  // `@shared/*` no es un package npm: esbuild lo resuelve vía los `paths` de
  // tsconfig.json y lo inlinea en el bundle. Las deps npm declaradas en
  // package.json (undici, fast-xml-parser, @readme/openapi-parser, graphql,
  // js-yaml) se externalizan automáticamente. Electron NUNCA se importa desde
  // core, así que no aparece acá ni en deps.
  tsconfig: './tsconfig.json'
}))
