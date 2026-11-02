/**
 * Execution context that every core operation receives. The adapter (desktop
 * IPC handler or the future CLI command) builds it and passes it in. Core never
 * reads ambient/singleton state — everything contextual arrives here.
 */
export interface ExecutionContext {
  /** Absolute path of the workspace the operation runs against. */
  workspacePath: string
  /**
   * Active environment id. Optional: operations that don't need an environment
   * work without it; operations that do must validate it and throw a typed
   * {@link CoreError} (`ENVIRONMENT_NOT_FOUND`) when missing.
   */
  environmentId?: string
  /**
   * Cancellation signal. The desktop wires the one from its executionId map;
   * the CLI wires the one from SIGINT.
   */
  signal?: AbortSignal
}

/**
 * Typed error classification shared between desktop and CLI. The CLI maps
 * `code` to exit codes; the desktop serializes to `Error.message` for the
 * renderer (custom properties do not survive IPC, so adapters re-throw a plain
 * `Error` with a readable message).
 */
export type CoreErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_INVALID'
  | 'ENVIRONMENT_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'PARSE_ERROR'
  | 'SCRIPT_FAILED'
  | 'REQUEST_CANCELLED'
  | 'INTERNAL_ERROR'
  /** REQ-0066: a multipart file part exceeds `binaryFileLimits.blockBytes` at stage time. */
  | 'MULTIPART_FILE_TOO_LARGE'
  /** REQ-0066: a multipart file part references a staged file that no longer exists in `requests/.files/`. */
  | 'MULTIPART_FILE_MISSING'
  /** REQ-0066: a `# @multipart-part` marker failed validation, or a script tried to push a part with invalid shape. */
  | 'MULTIPART_INVALID_PART'
  /** REQ-0066: the encoder failed to find a non-colliding boundary after two attempts. Defensive — not expected in practice. */
  | 'MULTIPART_BOUNDARY_COLLISION'
  /** REQ-0070: a referenced secret variable needs decryption but no workspace key is available (CLI: env var absent; desktop: locked). */
  | 'SECRETS_KEY_MISSING'
  /** REQ-0070: the provided workspace key fails the format CRC or the workspace challenge. */
  | 'SECRETS_KEY_INVALID'
  /** REQ-0070: the key validates but a specific secret value fails parsing/authentication (tamper or wrong-key-for-value). */
  | 'SECRETS_VALUE_CORRUPT'
  /** REQ-0070: a referenced secret variable is `null` (needs-value); detectable and reported even without a key. */
  | 'SECRETS_VALUE_UNSET'
  /** REQ-0087: an environment variable name begins with the reserved `$` system-namespace prefix. */
  | 'RESERVED_VARIABLE_NAME'
  /** REQ-0089: save of an app-global client certificate whose passphrase contains a `{{...}}` reference (app-global is literal-only). */
  | 'CLIENT_CERT_PASSPHRASE_VARIABLE_NOT_ALLOWED'

export class CoreError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'CoreError'
    // Restore the prototype chain so `instanceof CoreError` holds even when the
    // bundle is transpiled to a target that breaks native `extends`.
    Object.setPrototypeOf(this, CoreError.prototype)
  }
}
