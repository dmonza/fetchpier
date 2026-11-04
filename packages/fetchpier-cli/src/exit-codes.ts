// Exit-code table — discriminated from day one. Codes 1–9 are generic across
// domains; 10+ are allocated per feature area in the order the areas landed
// (10–13 multipart, 14–17 secrets, 18 host runtime, 19 empty run target); 130 is the Unix SIGINT
// convention; 255 signals an internal bug. An earlier version of this comment
// reserved 10–19 for a `mock`/`flow` domain that never took the range — those
// domains will allocate from the next free code like everyone else.
//
// This learns from Newman's history of ambiguous exit codes (#883, #527, #96,
// #1059): a caller in CI can branch on the exact failure class.

export const EXIT = Object.freeze({
  /** Everything passed. */
  SUCCESS: 0,
  /** A run completed but tests failed (or a script error counted as a failure). */
  TEST_FAILURE: 1,
  /** Reporter output target invalid (e.g. directory does not exist). */
  REPORTER_OUTPUT: 2,
  /** Reserved for generic usage/argument errors surfaced by commander. */
  USAGE: 3,
  /** Workspace not found or invalid (`--workspace`, env var, or discovery). */
  WORKSPACE: 4,
  /** An input path (`.http` file or folder) does not exist. */
  PATH_NOT_FOUND: 5,
  /** The selected environment does not exist. */
  ENVIRONMENT: 6,
  /** Malformed `--env-var` (expected `KEY=VALUE`). */
  ENV_VAR: 7,
  /** Parse error in a `.http` file. */
  PARSE: 8,
  /** Unknown reporter requested. */
  UNKNOWN_REPORTER: 9,
  /** REQ-0066: a multipart file part exceeds `binaryFileLimits.blockBytes` at stage time. */
  MULTIPART_FILE_TOO_LARGE: 10,
  /** REQ-0066: a multipart file part references a staged file that no longer exists in `requests/.files/`. */
  MULTIPART_FILE_MISSING: 11,
  /** REQ-0066: a `# @multipart-part` marker failed validation, or a script pushed a part with invalid shape. */
  MULTIPART_INVALID_PART: 12,
  /** REQ-0066: encoder failed to find a non-colliding boundary after two attempts. Defensive — not expected. */
  MULTIPART_BOUNDARY_COLLISION: 13,
  /** REQ-0070: a referenced secret needs decryption but `FETCHPIER_WORKSPACE_KEY` is absent. */
  SECRETS_KEY_MISSING: 14,
  /** REQ-0070: the provided workspace key fails the format CRC or the workspace challenge. */
  SECRETS_KEY_INVALID: 15,
  /** REQ-0070: the key validates but a referenced secret value fails parsing/authentication. */
  SECRETS_VALUE_CORRUPT: 16,
  /** REQ-0070: a referenced secret variable is `null` (needs-value). */
  SECRETS_VALUE_UNSET: 17,
  /**
   * The host Node.js runtime is below the floor declared in `engines.node`.
   * Raised by `node-floor.ts` before any work — `engines` alone is a warning
   * npm prints and ignores, so a global install on an old runtime would
   * otherwise fail deep inside a dependency.
   */
  UNSUPPORTED_NODE: 18,
  /**
   * A run target holds no request to run: an existing folder (explicit, or the
   * workspace's `requests/`) with no `.http` file. A run that sends nothing is
   * not a success — CI would read it as green.
   */
  NO_REQUESTS: 19,
  /** Run aborted by SIGINT/SIGTERM. */
  SIGINT: 130,
  /** Unexpected internal error (a bug). */
  INTERNAL: 255
} as const)

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
