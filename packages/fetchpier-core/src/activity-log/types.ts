// Activity-log neutral types.
//
// This module describes the on-disk `.http` format used to record one HTTP
// exchange that already happened (a "run"). It is **agnostic of who originated
// the exchange** — requests (client-side) and mocks (server-side, REQ-0070)
// both serialize into the same shape and add their own directives as
// extensions. Nothing here references either domain.
//
// All types are pure data. The module imports no Node APIs so it can be used
// from main, CLI and renderer alike.

/** One entry in the file header (everything above the request-line). */
export type HeaderItem =
  /** `# @<key>: <value>` line. */
  | { kind: 'directive'; key: string; value: string }
  /** A free-form `# <text>` comment that is not a `# @<directive>`. */
  | { kind: 'comment'; text: string }
  /** A blank line. Preserved for round-trip lossless re-emit. */
  | { kind: 'blank' }
  /**
   * `# @<name>` ... `# @end-<name>` block in the header. Lines are stored
   * **without** the leading `# ` prefix (or the markers themselves) so callers
   * can read structured content; the serializer re-emits the markers.
   */
  | { kind: 'block'; name: string; lines: string[] }

/**
 * Tail extension block: `# @<name>` ... `# @end-<name>` placed **after** the
 * response (script results, future mock-domain blocks, etc.). Same line
 * convention as the header `block` item.
 */
export interface ExtensionBlock {
  name: string
  lines: string[]
}

/**
 * Parsed in-memory representation of an activity-log `.http` file.
 *
 * Round-trip invariant: `serialize(parse(text)) === text` for any well-formed
 * input. Unknown directives, unknown blocks, free-form comments and blank
 * lines all survive untouched — this is what makes the extension-by-domain
 * model work (the requests parser tolerates mock directives like
 * `# @route-id`, and vice versa).
 */
export interface ActivityLogFile {
  /** Ordered list of items from the top of the file up to the first non-`#` line. */
  header: HeaderItem[]
  /**
   * Raw request bytes as they appear in the file: request-line, headers, a
   * blank line, and the body (or the binary placeholder line). Includes the
   * trailing newline produced by the serializer.
   */
  requestRaw: string
  /**
   * Raw response bytes: status-line, headers, blank line, body (or binary
   * placeholder). Same shape as `requestRaw`.
   */
  responseRaw: string
  /** Extension blocks that follow the response, in original order. */
  tailBlocks: ExtensionBlock[]
}

/** Input to `buildActivityLogFilename`. */
export interface FilenameSpec {
  /** Start time of the exchange. */
  timestamp: Date | string
  /**
   * Unique id for this run. Used to derive a 4-hex disambiguator when
   * `counter` is 0.
   */
  runId: string
  /**
   * Session counter (mock domain uses this; requests always passes 0). When
   * `> 0`, the disambiguator becomes the 5-digit zero-padded counter; when
   * `0`, it becomes `hash4(runId)`.
   */
  counter: number
  /** HTTP method (case-insensitive in, uppercased out). */
  method: string
  /**
   * Original request path **including** the query string. Used for the slug
   * and, when the filename exceeds the cap, the truncation hash.
   */
  pathRaw: string
}

/** Result of binary body detection. */
export interface BinaryDecision {
  isBinary: boolean
  /** Reason populated when `isBinary` is true; useful for tests. */
  reason?: 'content-type' | 'content-encoding' | 'utf8-probe'
}
