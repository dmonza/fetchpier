import { CoreError, type CoreErrorCode } from '@fetchpier/core'
import { EXIT, type ExitCode } from './exit-codes'

/**
 * An error raised by the CLI itself (not by core) that carries the exit code to
 * use. Use for argument/usage problems and reporter target errors — anything
 * that aborts before or around a core call.
 */
export class CliError extends Error {
  constructor(
    public readonly exitCode: ExitCode,
    message: string,
    /** Extra lines printed under the main message (hints, "Available: …"). */
    public readonly hints?: string[]
  ) {
    super(message)
    this.name = 'CliError'
    Object.setPrototypeOf(this, CliError.prototype)
  }
}

const CORE_CODE_TO_EXIT: Record<CoreErrorCode, ExitCode> = {
  WORKSPACE_NOT_FOUND: EXIT.WORKSPACE,
  WORKSPACE_INVALID: EXIT.WORKSPACE,
  ENVIRONMENT_NOT_FOUND: EXIT.ENVIRONMENT,
  FILE_NOT_FOUND: EXIT.PATH_NOT_FOUND,
  PARSE_ERROR: EXIT.PARSE,
  // A script error is functional: it does not abort the run, it counts as a
  // request failure. If one ever propagates here, treat it as a test failure.
  SCRIPT_FAILED: EXIT.TEST_FAILURE,
  REQUEST_CANCELLED: EXIT.SIGINT,
  INTERNAL_ERROR: EXIT.INTERNAL,
  MULTIPART_FILE_TOO_LARGE: EXIT.MULTIPART_FILE_TOO_LARGE,
  MULTIPART_FILE_MISSING: EXIT.MULTIPART_FILE_MISSING,
  MULTIPART_INVALID_PART: EXIT.MULTIPART_INVALID_PART,
  MULTIPART_BOUNDARY_COLLISION: EXIT.MULTIPART_BOUNDARY_COLLISION,
  SECRETS_KEY_MISSING: EXIT.SECRETS_KEY_MISSING,
  SECRETS_KEY_INVALID: EXIT.SECRETS_KEY_INVALID,
  SECRETS_VALUE_CORRUPT: EXIT.SECRETS_VALUE_CORRUPT,
  SECRETS_VALUE_UNSET: EXIT.SECRETS_VALUE_UNSET,
  // REQ-0087: a `$`-prefixed variable name reaching a workspace-edit op is a
  // usage error (no dedicated exit code — reuse the existing USAGE code).
  RESERVED_VARIABLE_NAME: EXIT.USAGE,
  // REQ-0089: a save-time validation error (app-global passphrase with a
  // variable). Never thrown during a CLI run, but the map must stay total;
  // classify as a usage error.
  CLIENT_CERT_PASSPHRASE_VARIABLE_NOT_ALLOWED: EXIT.USAGE,
  // An unusable proxy URL (flag or variable) or `--proxy` with `--no-proxy`:
  // fatal before anything is sent, as a usage error naming its source.
  PROXY_INVALID: EXIT.USAGE
}

export interface ResolvedError {
  exitCode: ExitCode
  /** First line printed to stderr (without the leading "Error: "). */
  message: string
  /** Additional indented lines (hints / available options). */
  hints: string[]
  /** Only set for internal errors — printed for debuggability. */
  stack?: string
}

/**
 * Classify any thrown value into an exit code + printable message. This is the
 * single place that owns the error → exit-code contract; `fp.ts` calls it from
 * the top-level catch.
 */
export function resolveError(err: unknown): ResolvedError {
  if (err instanceof CliError) {
    return { exitCode: err.exitCode, message: err.message, hints: err.hints ?? [] }
  }
  if (err instanceof CoreError) {
    const exitCode = CORE_CODE_TO_EXIT[err.code] ?? EXIT.INTERNAL
    return { exitCode, message: err.message, hints: [] }
  }
  // Anything else is an unexpected bug.
  const message = err instanceof Error ? err.message : String(err)
  return {
    exitCode: EXIT.INTERNAL,
    message: `Internal error: ${message}`,
    hints: ['', 'This is a bug. Please file it at https://github.com/dmonza/fetchpier/issues'],
    stack: err instanceof Error ? err.stack : undefined
  }
}
