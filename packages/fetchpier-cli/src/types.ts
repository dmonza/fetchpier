// CLI-owned types. These describe the runner's options and its structured
// run summary (the JSON reporter's schema). They live here, not in
// `@fetchpier/core`, because they are specific to the CLI runner — the desktop
// does not reuse them. If the desktop ever wants to render runs in this shape,
// promote them to `@fetchpier/core` in a dedicated change.

/** Verbosity: 0 = warn+ (default), 1 = info (-v), 2 = debug (-vv), 3 = trace (-vvv). */
export type Verbosity = 0 | 1 | 2 | 3

export interface ReporterConfig {
  type: 'cli' | 'json' | 'junit' | 'html'
  /**
   * Output path, or `'-'` for stdout (only valid for `json`). `undefined` means
   * stdout for `cli`, and is an error for `json`/`junit`/`html`.
   */
  output?: string
  options?: {
    /** json reporter — omit response bodies for lighter reports. */
    noBody?: boolean
    /** html reporter — start with the "only failures" filter on. */
    onlyFailures?: boolean
  }
}

export interface RunOptions {
  paths: string[]
  /** Resolved absolute workspace path. When omitted, resolved from cwd/env. */
  workspace?: string
  /** Environment name. When omitted, resolved from env var / `default`. */
  environment?: string
  /** Overrides from repeated `--env-var "K=V"`. Script writes win over them once made. */
  envVars?: Record<string, string>
  /**
   * Persist script environment changes into the local value layer, exactly as
   * the desktop does (`--persist-env`). Default: changes live for the run only.
   */
  persistEnv?: boolean
  /** Proxy for every request (`--proxy`); wins over `HTTPS_PROXY` / `HTTP_PROXY`. */
  proxy?: string
  /** Ignore `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (`--no-proxy`). */
  noProxy?: boolean
  bail?: boolean
  /** Milliseconds to wait between requests. */
  delay?: number
  /** `verifySsl=false` override for this run. */
  insecure?: boolean
  reporters?: ReporterConfig[]
  silent?: boolean
  noColor?: boolean
  ascii?: boolean
  verbosity?: Verbosity
  /**
   * Per-request timeout in milliseconds. `0` disables it. Programmatic callers
   * that omit it get the binary's default (30 s).
   */
  timeoutMs?: number
  saveHistory?: boolean
  /** Always exit 0 even when tests fail (still nonzero for fatal errors). */
  suppressExitCode?: boolean
  /** Do not redact credentials (Authorization, API-key auth) and cookie values in output. */
  showSecrets?: boolean
  /** Cancellation signal (wired from SIGINT/SIGTERM by the binary). */
  signal?: AbortSignal
}

export interface ScriptLog {
  level: 'log' | 'warn' | 'error'
  message: string
  argsRedacted?: boolean
}

export interface ScriptError {
  message: string
  line?: number
  stack?: string
}

export interface ScriptMutationSummary {
  headersModified: number
  variablesSet: number
  environmentChanged: number
}

export interface RequestUnit {
  type: 'request'
  /** Path relative to the workspace. */
  path: string
  /** Typically "METHOD URL". */
  name: string
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body?: string
  }
  response?: {
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
    timingMs: number
    /** Byte length of the body as read (after decoding). Unchanged meaning. */
    sizeBytes: number
    /** Body bytes as received on the wire. Additive (schema stays `1.0`). */
    compressedBytes?: number
    /** Body bytes after decoding; equals `compressedBytes` when nothing was decoded. */
    decompressedBytes?: number
    /** `decoded` · `not-required` · `unsupported` · `failed`. */
    decodingStatus?: 'decoded' | 'not-required' | 'unsupported' | 'failed'
  }
  scripts: {
    preRequest?: { logs: ScriptLog[]; errors: ScriptError[]; mutations?: ScriptMutationSummary }
    postResponse?: { logs: ScriptLog[]; errors: ScriptError[]; mutations?: ScriptMutationSummary }
  }
  tests: { name: string; passed: boolean; error?: string }[]
  /**
   * Why the request produced no response — an unreachable host, a timeout, a TLS
   * failure, an interrupt, or a pre-send abort. Present only on a unit with no
   * `response`; absent otherwise. Optional and additive, so `schemaVersion` does
   * not move: a consumer that wants the reason checks for the key, which is the
   * only reliable test since the field is absent on successful units at any
   * version.
   */
  error?: string
  /**
   * Present (`true`) when no send was attempted — a file with no request, a
   * failed pre-request script, a multipart part or binary file that could not
   * be read. Absent when a send was attempted, even one that failed in
   * transport. Optional and additive (`schemaVersion` does not move).
   */
  notRun?: true
  /**
   * Whether the request went through the configured proxy or directly (an
   * exclusion matched). Present only when the run has a proxy configured.
   */
  via?: 'proxy' | 'direct'
  durationMs: number
}

// Open union — future domains add `FlowStepUnit | MockRuleUnit`. Consumers that
// filter on `type === 'request'` keep working when those appear.
export type RunUnit = RequestUnit

export interface RunSummary {
  schemaVersion: '1.0'
  fetchpier: { cliVersion: string }
  workspace: string
  /** The environment's opaque identifier (unchanged). */
  environment: string
  /**
   * The environment's folder name — what `--env` accepts and `fp env list`
   * prints. Optional and additive: `schemaVersion` does not move.
   */
  environmentName?: string
  /** ISO timestamp. */
  startedAt: string
  /** ISO timestamp. */
  endedAt: string
  durationMs: number
  summary: {
    requests: { total: number; passed: number; failed: number }
    tests: { total: number; passed: number; failed: number }
    scriptErrors: number
  }
  units: RunUnit[]
}
