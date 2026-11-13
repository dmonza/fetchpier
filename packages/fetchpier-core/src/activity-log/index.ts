// Activity-log: neutral `.http` format for HTTP-exchange logs (REQ-0068).
//
// Used by the requests adapter (`workspace/history.ts`) and — once
// implemented — by the mock-server adapter (REQ-0070). The module is pure:
// no Node imports, no `electron`, no domain coupling.

export type {
  ActivityLogFile,
  HeaderItem,
  ExtensionBlock,
  FilenameSpec,
  BinaryDecision
} from './types'
export { serializeActivityLog, RESPONSE_SEPARATOR } from './serializer'
export { parseActivityLog } from './parser'
export { buildActivityLogFilename, hash4 } from './filename'
export { detectBinaryBody, binaryPlaceholder, bodyByteLength, isProbablyUtf8 } from './binary'
export { fillReasonPhrase } from './reason-phrase'
export { readMetadataPreview, type ActivityLogMetadataPreview } from './header-read'
export { METHOD_TOKEN } from './method-token'
