// @fetchpier/core/schema-import — secondary entry point.
//
// Re-exports the public surface of the schema-import domain so it can be
// loaded on demand instead of at boot. Pulling this subpath drags in
// `@readme/openapi-parser`, `graphql`, `js-yaml`, `ajv` and its kin — a
// ~200–300 ms one-shot cost the desktop now pays only when the user opens
// the Import Schema wizard (REQ-0063). The main entry (`@fetchpier/core`)
// deliberately does **not** re-export this namespace; the IPC handler in
// `src/main/ipc/schema.ipc.ts` uses `await import('@fetchpier/core/schema-import')`
// behind a module-level cache so the deps stay off the cold path.

export {
  detectFormat,
  importSchema,
  importOpenApi,
  importGraphQL,
  importWsdl,
  importPostman,
  writeSchemaToDisk,
  sanitizeName,
  sanitizeSegments,
  uniqueName,
  generateExampleFromJsonSchema,
  prettyJson
} from './schema-import/index'

export type { SchemaImportProgressCallback } from './schema-import/index'
