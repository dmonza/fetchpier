/*! Fetchpier — Copyright (c) 2026 Daniel Monza — MIT — https://fetchpier.com */

// @fetchpier/core — barrel del package.
//
// La lógica de negocio de Fetchpier (workspace, requests, scripting, tls)
// vive acá, sin ninguna dependencia de Electron. El desktop la consume desde
// los IPC handlers y el futuro CLI la consumirá igual.
//
// `schemaImport` se sirve por una segunda entrada (`@fetchpier/core/schema-import`,
// resuelta vía el campo `exports` del package.json). El barrel principal NO la
// re-exporta: cargarla acá traería `@readme/openapi-parser`, `graphql`,
// `js-yaml` y `ajv` al cold path del main process (REQ-0063). El handler
// `src/main/ipc/schema.ipc.ts` hace `await import('@fetchpier/core/schema-import')`
// en la primera llamada y cachea el módulo.
export { CoreError } from './shared/context'
export type { ExecutionContext, CoreErrorCode } from './shared/context'
// Cross-domain, como `CoreError`: lo consumen el pipeline de requests y los dos
// adaptadores. Garantiza que ningún motivo de fallo llegue vacío al usuario.
export { describeError, NO_REPORTED_REASON } from './shared/describe-error'

export * as workspace from './workspace'
export * as scripting from './scripting'
export * as requests from './requests'
export * as tls from './tls'
export * as activityLog from './activity-log'
export * as secrets from './secrets'
