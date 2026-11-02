import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { MultipartPart } from '@shared/types'
import {
  encodeContentDisposition as encodeContentDispositionShared,
  resolvePartContentType,
  resolveWireFilename
} from '@shared/lib/multipart-format'
import { CoreError } from '../shared/context'
import { resolveBinaryRef } from './binary-store'

/**
 * Multipart/form-data encoder (REQ-0066). Pure module — given a parts list and
 * a workspace path, produces the Content-Type header (including the generated
 * boundary) and the encoded body buffer ready to hand to undici. Lives in core
 * so the desktop IPC handler and the CLI both produce byte-identical wire
 * output for the same request.
 *
 * Wire format follows RFC 7578 / RFC 2046. File parts use RFC 6266 §4.3 for
 * `Content-Disposition.filename` and RFC 5987 for the `filename*` parameter
 * when the wire-filename is not pure US-ASCII.
 *
 * The boundary is generated per call from 256 bits of randomness (CSPRNG) and
 * is verified not to appear in any text part value or file part bytes; on
 * collision (statistically negligible) the encoder rerolls once before raising
 * `MULTIPART_BOUNDARY_COLLISION`. The boundary is never user-configurable —
 * exposing it accumulates bugs (cf. Postman issues #6140, #6737, #11471).
 */

const BOUNDARY_PREFIX = 'fetchpier-'
const CRLF = '\r\n'
const CRLF_BUF = Buffer.from(CRLF, 'ascii')

/**
 * Generate a single boundary candidate. Uses base64url over 32 random bytes
 * (256 bits of entropy, ASCII-safe per RFC 2046 `bcharsnospace`). If the
 * candidate happens to contain the substring `--` (which would prematurely
 * terminate the body), regenerate until clean. With base64url's alphabet
 * (`A-Za-z0-9-_`) `--` occurs with probability ~1/2048 per position; a tight
 * retry loop converges immediately.
 */
export function generateBoundary(): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomBytes(32).toString('base64url')
    // Check the *full* candidate including its junction with the prefix's
    // trailing `-`: a candidate starting with `-` would create `--` after
    // concatenation, which would prematurely terminate the body.
    const boundary = `${BOUNDARY_PREFIX}${candidate}`
    if (!boundary.includes('--')) return boundary
  }
  // Astronomically unlikely (probability ~(1/64)^8) but covered defensively.
  throw new CoreError(
    'MULTIPART_BOUNDARY_COLLISION',
    'Could not generate a multipart boundary without a "--" substring after 8 attempts.'
  )
}

/**
 * Encoder-side wrapper around the shared content-disposition formatter. The
 * shared helper throws plain `Error` on CR/LF; we promote those to typed
 * `CoreError(MULTIPART_INVALID_PART)` so the CLI can exit-code-classify them.
 */
export function encodeContentDisposition(part: MultipartPart, wireFilename?: string): string {
  try {
    return encodeContentDispositionShared(part, wireFilename)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new CoreError('MULTIPART_INVALID_PART', msg)
  }
}

interface PreparedPart {
  part: MultipartPart
  /** Resolved wire-filename for file parts. */
  wireFilename?: string
  /** Buffer of raw bytes to emit as the part body. */
  bytes: Buffer
}

/**
 * Read file bytes for each enabled file part. Done before boundary generation
 * so collision detection can scan the same buffers without re-reading.
 */
async function prepareParts(
  enabled: MultipartPart[],
  workspacePath: string
): Promise<PreparedPart[]> {
  return Promise.all(
    enabled.map(async (part) => {
      if (part.kind === 'text') {
        return { part, bytes: Buffer.from(part.value ?? '', 'utf8') }
      }
      const absPath = resolveBinaryRef(workspacePath, part.file.ref)
      let bytes: Buffer
      try {
        bytes = await fs.readFile(absPath)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          throw new CoreError(
            'MULTIPART_FILE_MISSING',
            `Multipart file part "${part.name}" references missing file: ${part.file.ref}`,
            { ref: part.file.ref, partName: part.name }
          )
        }
        throw err
      }
      return { part, wireFilename: resolveWireFilename(part), bytes }
    })
  )
}

/**
 * Scan all part bodies for the boundary marker `--<boundary>` which would
 * prematurely terminate the body. With 256 bits of entropy the probability of
 * collision is astronomically low; if it does happen, the caller rerolls once.
 */
function boundaryCollides(boundary: string, prepared: PreparedPart[]): boolean {
  const needle = Buffer.from(`--${boundary}`, 'ascii')
  for (const p of prepared) {
    if (p.bytes.indexOf(needle) !== -1) return true
  }
  return false
}

/** Serialise one prepared part into its wire-shaped buffer. */
function emitPart(prepared: PreparedPart, boundary: string): Buffer {
  const headers: string[] = []
  headers.push(`--${boundary}`)
  headers.push(
    `Content-Disposition: ${encodeContentDisposition(prepared.part, prepared.wireFilename)}`
  )
  const ct = resolvePartContentType(prepared.part)
  if (ct) headers.push(`Content-Type: ${ct}`)
  const headerBlock = Buffer.from(headers.join(CRLF) + CRLF + CRLF, 'utf8')
  return Buffer.concat([headerBlock, prepared.bytes, CRLF_BUF])
}

export interface MultipartEncodeOptions {
  workspacePath: string
  /**
   * Override boundary (tests only). When omitted, a fresh boundary is
   * generated. Production code MUST NOT pass this — the value is exposed for
   * the CLI/desktop parity assertion.
   */
  boundary?: string
}

export interface MultipartEncodeResult {
  /** Full `Content-Type` header value, including `; boundary=...`. */
  contentType: string
  /** The encoded wire body. */
  body: Buffer
  /** The boundary that was used (generated or overridden). */
  boundary: string
}

/**
 * Encode a list of multipart parts into a single buffer suitable for an
 * `undici` request body. Disabled parts are skipped (the boundary, byte
 * length, and part count reflect the wire, not the editor state). An empty
 * enabled-parts list produces a minimal valid multipart body containing only
 * the closing boundary delimiter — receivers may reject this with 400, but
 * that is the receiver's contract, not Fetchpier's.
 */
export async function encodeMultipart(
  parts: MultipartPart[],
  options: MultipartEncodeOptions
): Promise<MultipartEncodeResult> {
  const enabled = parts.filter((p) => !p.disabled)
  const prepared = await prepareParts(enabled, options.workspacePath)

  let boundary: string
  if (options.boundary !== undefined) {
    boundary = options.boundary
    if (boundaryCollides(boundary, prepared)) {
      throw new CoreError(
        'MULTIPART_BOUNDARY_COLLISION',
        `The supplied boundary "${boundary}" appears as "--${boundary}" inside a part body.`
      )
    }
  } else {
    boundary = generateBoundary()
    if (boundaryCollides(boundary, prepared)) {
      // One reroll — collisions with 256 bits of entropy are effectively
      // impossible against random data; a single retry is enough for any
      // realistic adversarial payload short of one that contains all 2^256
      // possible boundary candidates.
      boundary = generateBoundary()
      if (boundaryCollides(boundary, prepared)) {
        throw new CoreError(
          'MULTIPART_BOUNDARY_COLLISION',
          'Generated multipart boundary collided with part bytes twice in a row.'
        )
      }
    }
  }

  const chunks: Buffer[] = []
  for (const p of prepared) chunks.push(emitPart(p, boundary))
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'))

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
    boundary
  }
}
