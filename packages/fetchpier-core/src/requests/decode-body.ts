/**
 * Response body decoding against `Content-Encoding` (CLI readiness for CI).
 *
 * The transport hands over the bytes exactly as they arrived; this decodes the
 * supported codings with the runtime's built-in compression and reports what
 * happened, so every consumer (viewer, scripts, reports) sees the same status.
 * A body that cannot be decoded is never dropped: it is kept as received, the
 * status says why, and an advisory carries the coding and the reason.
 */

import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import type {
  DecodingStatus,
  ResponseDecodingFailedWarning,
  UnsupportedContentEncodingWarning
} from '@shared/types'
import { describeError } from '../shared/describe-error'

/** Upper bound on a decoded body — a guard against compression bombs. */
export const MAX_DECODED_BYTES = 100 * 1024 * 1024

export interface DecodedBody {
  status: DecodingStatus
  /** Decoded bytes, or the bytes as received when nothing (or nothing valid) was decoded. */
  body: Buffer
  compressedBytes: number
  decompressedBytes: number
  warning?: ResponseDecodingFailedWarning | UnsupportedContentEncodingWarning
}

type Decoder = (input: Buffer, maxOutputLength: number) => Buffer

const DECODERS: Record<string, Decoder> = {
  gzip: (b, max) => gunzipSync(b, { maxOutputLength: max }),
  'x-gzip': (b, max) => gunzipSync(b, { maxOutputLength: max }),
  // `deflate` is specified as zlib-wrapped, but servers routinely send raw
  // deflate; accept both rather than fail a body every other client reads.
  // Only a zlib header/data error means "not zlib-wrapped": anything else (the
  // output cap above all) is the real failure and must not be masked by the
  // raw retry's own error.
  deflate: (b, max) => {
    try {
      return inflateSync(b, { maxOutputLength: max })
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'Z_DATA_ERROR') throw err
      return inflateRawSync(b, { maxOutputLength: max })
    }
  },
  br: (b, max) => brotliDecompressSync(b, { maxOutputLength: max })
}

/**
 * Decode `wire` according to the `Content-Encoding` header value. Codings are
 * listed in the order they were applied, so they are undone in reverse.
 */
export function decodeBody(
  wire: Buffer,
  contentEncoding: string | undefined,
  options: { maxDecodedBytes?: number } = {}
): DecodedBody {
  const max = options.maxDecodedBytes ?? MAX_DECODED_BYTES
  const unchanged = (status: DecodingStatus, warning?: DecodedBody['warning']): DecodedBody => ({
    status,
    body: wire,
    compressedBytes: wire.length,
    decompressedBytes: wire.length,
    ...(warning ? { warning } : {})
  })

  const codings = (contentEncoding ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity')
  if (codings.length === 0 || wire.length === 0) return unchanged('not-required')

  const declared = (contentEncoding ?? '').trim()
  const unsupported = codings.find((c) => !(c in DECODERS))
  if (unsupported) {
    return unchanged('unsupported', { code: 'UNSUPPORTED_CONTENT_ENCODING', encoding: declared })
  }

  try {
    let out = wire
    for (const coding of [...codings].reverse()) out = DECODERS[coding](out, max)
    return {
      status: 'decoded',
      body: out,
      compressedBytes: wire.length,
      decompressedBytes: out.length
    }
  } catch (err) {
    return unchanged('failed', {
      code: 'RESPONSE_DECODING_FAILED',
      encoding: declared,
      reason: describeError(err)
    })
  }
}
