// Source of truth for the Fetchpier script API types.
//
// This file is hand-maintained. It is:
//   1. imported by `fp-sandbox.ts` to type the runtime `fp` object (so
//      TypeScript emits a compile error if the runtime drifts from these types)
//   2. consumed by `scripts/generate-fp-dts.mjs` which strips `import`/`export`
//      statements and appends `declare const fp: FpApi;` to produce
//      `src/renderer/hooks/fp.d.ts.generated` — the `.d.ts` mounted in the
//      editor's TypeScript virtual filesystem.
//
// Contract:
//   - Only top-level `export interface` / `export type` declarations.
//   - No value-level `export` (const, function, class) — the generator cannot
//     strip those safely.
//   - No `import` from files other than another `.d.ts` source (imports are
//     erased by the generator).
//   - All public members should carry JSDoc — that JSDoc ends up as hover
//     tooltips in the editor.

// ── Request ────────────────────────────────────────────────────────────────

/**
 * Mutable view of the outgoing HTTP request.
 *
 * In **pre-request** scripts every field is writable — changes are persisted
 * to the request that is actually sent.
 *
 * In **post-response** scripts the fetch already occurred; assigning to any
 * field throws at runtime. A future refinement (REQ-42) will type this as
 * `Readonly<FpRequest>` in post-response.
 */
export interface FpRequest {
  /** HTTP method (e.g. "GET", "POST"). Case-preserved. */
  method: string

  /** Fully-resolved URL with interpolated `{{variables}}`. */
  url: string

  /** Case-insensitive header accessor. */
  headers: FpHeaders

  /**
   * Request body. The shape depends on `bodyType`:
   *
   *   - `'none'`: `undefined`.
   *   - `'raw'` / `'x-www-form-urlencoded'`: a string (mutable in pre-request).
   *   - `'binary'`: NOT exposed — reads as `undefined`, writes throw. Use
   *     `binaryFileRef` for the staged-file identifier; the bytes themselves
   *     stay in the host realm.
   *   - `'multipart-form'`: an {@link FpMultipartBody} object with a `parts`
   *     array. Mutate via `body.parts.push(...)`, indexed access, or splice.
   *     File parts may only be added by referencing an already-staged
   *     `fileRef` — raw bytes are never accepted from scripts.
   *
   * Assigning `null`/`undefined` clears string bodies. Assigning to a
   * multipart body throws — mutate the parts array instead.
   */
  body: string | undefined | FpMultipartBody

  /**
   * Body mode the user picked in the editor. Read-only — switching modes is
   * a user action, not a script action.
   */
  readonly bodyType: 'none' | 'raw' | 'x-www-form-urlencoded' | 'binary' | 'multipart-form'

  /**
   * Reference to the staged binary file when `bodyType === 'binary'`,
   * `undefined` otherwise. The reference is opaque (`<sha256>__<name>`) and
   * read-only — scripts cannot mutate the binary attachment from a script.
   */
  readonly binaryFileRef: string | undefined
}

// ── Multipart body (REQ-0066) ──────────────────────────────────────────────

/**
 * Structured request body exposed when `bodyType === 'multipart-form'`.
 * The single property is `parts`, an array-like list of text and file parts.
 *
 * In pre-request scripts, `parts` is mutable: indexed assignment, `push`,
 * `splice`, `pop`, `shift`, `unshift`, `reverse`, and `sort` are supported.
 * Each push validates the part shape and throws `TypeError` synchronously
 * on invalid input. File parts may only be added by referencing an
 * already-staged `fileRef` — `bytes`, `path`, or any other source throws.
 *
 * In post-response scripts, all mutations throw.
 */
export interface FpMultipartBody {
  parts: FpMultipartPart[]
}

/** One part of a multipart body — either text or file. */
export type FpMultipartPart = FpMultipartTextPart | FpMultipartFilePart

/**
 * A text part. Receivers without a per-part `contentType` default to
 * `text/plain;charset=US-ASCII` per RFC 7578 §4.4.
 */
export interface FpMultipartTextPart {
  readonly kind: 'text'
  /** Form field name, sent in `Content-Disposition: form-data; name="..."`. */
  name: string
  /** Text value sent verbatim as the part body. */
  value: string
  /** Optional per-part Content-Type. */
  contentType?: string
  /** Disabled parts are skipped on send. */
  disabled?: boolean
}

/**
 * A file part. Bytes are read from the workspace-staged file referenced by
 * `fileRef` at send time — scripts cannot supply or read the bytes.
 */
export interface FpMultipartFilePart {
  readonly kind: 'file'
  /** Form field name, sent in `Content-Disposition: form-data; name="..."`. */
  name: string
  /**
   * Opaque reference to a workspace-staged file (`<sha256>__<sanitized-name>`).
   * Read-only — assignment throws. To swap the file, push a new part and
   * remove the old one.
   */
  readonly fileRef: string
  /**
   * Optional wire-`filename` override. When unset, the encoder uses the
   * sanitized original name embedded in `fileRef`.
   */
  filename?: string
  /**
   * Optional per-part Content-Type. When unset, the encoder uses the staged
   * file's MIME type (extension-based) and falls back to `application/octet-stream`.
   */
  contentType?: string
  /** Disabled parts are skipped on send. */
  disabled?: boolean
}

/**
 * Case-insensitive header accessor.
 *
 * Header names are matched case-insensitively for reads/writes but the
 * original casing is preserved when the request is serialised.
 */
export interface FpHeaders {
  /** Returns the first value for `name` (case-insensitive), or `undefined`. */
  get(name: string): string | undefined

  /**
   * Returns every value for `name` (case-insensitive), in order. A header name
   * may legitimately repeat (e.g. multiple `Accept` or `Set-Cookie`); this is
   * how you read all of them without the first-match collapse of `get()`.
   */
  getAll(name: string): string[]

  /**
   * Sets a header value, replacing every existing entry with that name. Only
   * effective in pre-request scripts — throws in post-response.
   */
  set(name: string, value: string): void

  /**
   * Appends a header value, keeping any existing same-name entries — use this to
   * author duplicate headers. Only effective in pre-request scripts.
   */
  add(name: string, value: string): void

  /** Removes every entry with `name`. Only effective in pre-request scripts. */
  remove(name: string): void

  /** Total number of header entries (duplicates counted). */
  count(): number

  /**
   * Snapshot of all headers as a plain object. Lossy for duplicates (the last
   * value wins) — use {@link FpHeaders.getAll} to read repeated names.
   */
  toObject(): Record<string, string>
}

// ── Response ───────────────────────────────────────────────────────────────

/**
 * The HTTP response.
 *
 * Only available in **post-response** scripts. In pre-request scripts
 * `fp.response` is `undefined`. REQ-42 will tighten the type so the editor
 * reports an error when accessing it from a pre-request script.
 */
export interface FpResponse {
  /** HTTP status code (e.g. 200, 404, 500). */
  readonly status: number

  /** Reason phrase sent by the server. May be empty for HTTP/2. */
  readonly statusText: string

  /** Read-only case-insensitive response headers. */
  readonly headers: FpResponseHeaders

  /** Raw response body as a string. */
  readonly body: string

  /** Total time from request-start to response-end, in milliseconds. */
  readonly timingMs: number

  /** Size of the response body in bytes. */
  readonly sizeBytes: number

  /**
   * Parses the response body as JSON.
   *
   * The result is typed as freely usable: reading any property, indexing, and
   * passing it into another `fp.*` method type-check without a diagnostic. The
   * response shape is unknown at author time, so no member set is asserted —
   * completion offers no suggestions on the result (REQ-0082).
   *
   * @throws if the body exceeds the 10 MB parse cap or is not valid JSON.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): any

  /**
   * Parses the response body as XML into a JSON-like object tree.
   *
   * Uses `fast-xml-parser` under the hood with safe defaults (no entity
   * expansion, attribute names prefixed with `@_`). Repeated calls with no
   * options share a cached result within the same script execution.
   *
   * The result is typed as freely usable, identically to {@link FpResponse.json}:
   * property access, nested access, and pass-through into another `fp.*` method
   * produce no diagnostic, and completion offers no member suggestions on it
   * (REQ-0082).
   *
   * @throws if the body exceeds the 10 MB parse cap or is not valid XML.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  xml2Json(opts?: FpXml2JsonOptions): any
}

/** Read-only subset of {@link FpHeaders} exposed on `fp.response.headers`. */
export interface FpResponseHeaders {
  /** Returns the first value for `name` (case-insensitive), or `undefined`. */
  get(name: string): string | undefined
  /** Returns every value for `name` (case-insensitive), in order — e.g. `Set-Cookie`. */
  getAll(name: string): string[]
  /** Total number of response header entries (duplicates counted). */
  count(): number
  /** Snapshot of all response headers as a plain object (lossy for duplicates). */
  toObject(): Record<string, string>
}

/** Options for `fp.response.xml2Json(opts)`. */
export interface FpXml2JsonOptions {
  /**
   * If true, strip namespace prefixes from element and attribute names:
   * `"soap:Body"` → `"Body"`. When two namespaces declare tags with the same
   * local name, the last one wins. Default: `false`.
   */
  stripNamespaces?: boolean

  /**
   * Tag names (or full jpaths like `"Envelope.Body.LoginResponse.roles.role"`)
   * that must always be materialised as arrays, even when they appear exactly
   * once in the document. Default: `[]`.
   */
  alwaysArray?: string[]
}

// ── Environment ────────────────────────────────────────────────────────────

/**
 * Persistent environment variables for the active environment.
 *
 * Changes are written back to the environment file (`*.env.json`) after the
 * request completes. Both phases can read and write.
 */
export interface FpEnvironment {
  /** Returns the variable value, or `undefined` if not set. */
  get(name: string): string | undefined

  /**
   * Sets a variable. Values are coerced to strings. Takes effect after the
   * request completes.
   */
  set(name: string, value: string): void

  /** Removes a variable. */
  remove(name: string): void

  /** Snapshot of all environment variables. */
  toObject(): Record<string, string>
}

// ── Variables (ephemeral, per-request) ─────────────────────────────────────

/**
 * Ephemeral per-request variables shared between the pre-request and
 * post-response scripts of the **same** send. Cleared after post-response
 * finishes.
 */
export interface FpVariables {
  /** Returns the variable value, or `undefined` if not set. */
  get(name: string): unknown
  /** Sets a variable. Any JSON-serialisable value is accepted. */
  set(name: string, value: unknown): void
}

// ── Chai-like assertion DSL ────────────────────────────────────────────────

/**
 * `include` / `contain` — dual-role terminal: callable to check containment,
 * or chained as `.include.keys(...)` for subset checks.
 */
export interface ChaiIncludeTerminal {
  /** Assert that `target` contains `value` (string substring, array member, or object subset). */
  (value: unknown): void
  /** Assert that `target` is an object containing at least the given keys. */
  keys(...names: Array<string | string[]>): void
}

/**
 * Fluent, chai-compatible assertion builder returned by `fp.expect(value)`.
 *
 * All terminal calls throw `AssertionError` on failure — typical usage is
 * inside `fp.test(name, () => { fp.expect(…).to.equal(…) })`.
 */
export interface ChaiExpect {
  // ── Chainable connectors (no-op, return self) ──
  /** Connective chain word. */
  readonly to: ChaiExpect
  /** Connective chain word. */
  readonly be: ChaiExpect
  /** Connective chain word. */
  readonly been: ChaiExpect
  /** Connective chain word. */
  readonly is: ChaiExpect
  /** Connective chain word. */
  readonly that: ChaiExpect
  /** Connective chain word. */
  readonly which: ChaiExpect
  /** Connective chain word. */
  readonly and: ChaiExpect
  /** Connective chain word. */
  readonly has: ChaiExpect
  /** Connective chain word. */
  readonly have: ChaiExpect
  /** Connective chain word. */
  readonly with: ChaiExpect
  /** Connective chain word. */
  readonly at: ChaiExpect
  /** Connective chain word. */
  readonly of: ChaiExpect
  /** Connective chain word. */
  readonly same: ChaiExpect

  /** Switch subsequent `equal` into deep-structural equality. */
  readonly deep: ChaiExpect

  /** Switch subsequent `property()` to dotted-path resolution. */
  readonly nested: ChaiExpect

  /** Negate the next assertion. */
  readonly not: ChaiExpect

  // ── Terminal properties (assertion on access) ──
  /** Assert target is neither `null` nor `undefined`. */
  readonly exist: void
  /** Assert target is truthy. */
  readonly ok: void
  /** Assert target is strictly `true`. */
  readonly true: void
  /** Assert target is strictly `false`. */
  readonly false: void
  /** Assert target is strictly `null`. */
  readonly null: void
  /** Assert target is strictly `undefined`. */
  readonly undefined: void
  /** Assert target is an empty string, array or object. */
  readonly empty: void

  // ── Equality ──
  /** Strict equality (`Object.is`). Use `.deep.equal(…)` for deep comparisons. */
  equal(expected: unknown): void
  /** Alias of {@link ChaiExpect.equal}. */
  equals(expected: unknown): void
  /** Alias of {@link ChaiExpect.equal}. */
  eq(expected: unknown): void
  /** Deep structural equality. */
  eql(expected: unknown): void
  /** Deep structural equality. */
  deepEqual(expected: unknown): void

  // ── Type checks ──
  /**
   * Assert `typeof target` matches the given name
   * (`"string"`, `"number"`, `"object"`, `"array"`, `"null"`, …).
   */
  a(type: string): void
  /** Alias of {@link ChaiExpect.a}. */
  an(type: string): void
  /** Assert `target instanceof ctor`. */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  instanceOf(ctor: Function): void

  // ── Properties / containment ──
  /**
   * Assert `target` has own/inherited property `name`. If a second argument is
   * given, also assert the property's value equals it (deep equality).
   *
   * Chain `.nested` first to resolve dotted paths (e.g. `"a.b.0.c"`).
   */
  property(name: string, value?: unknown): void

  /** Containment check (string substring, array member, or object subset). */
  include: ChaiIncludeTerminal
  /** Alias of {@link ChaiExpect.include}. */
  contain: ChaiIncludeTerminal

  /** Assert `target` matches the given regex. */
  match(regex: RegExp): void

  // ── Numeric comparisons ──
  /** Assert `target > n`. */
  above(n: number): void
  /** Alias of {@link ChaiExpect.above}. */
  greaterThan(n: number): void
  /** Assert `target < n`. */
  below(n: number): void
  /** Alias of {@link ChaiExpect.below}. */
  lessThan(n: number): void
  /** Assert `target >= n`. */
  least(n: number): void
  /** Assert `target <= n`. */
  most(n: number): void

  /** Assert `target.length === n`. */
  lengthOf(n: number): void

  // ── Custom predicates ──
  /** Pass when `predicate(target)` returns truthy. */
  satisfy(predicate: (value: unknown) => boolean): void

  /** Assert `target` deep-equals one of the candidates. */
  oneOf(list: unknown[]): void

  /** Assert `Math.abs(target - expected) <= delta`. */
  closeTo(expected: number, delta: number): void

  /** Assert `target` is an object whose keys exactly match the given set. */
  keys(...names: Array<string | string[]>): void

  /**
   * Assert `target` is a function that throws.
   * Optionally narrow to a message substring, RegExp match, or error class.
   */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  throw(matcher?: string | RegExp | Function): void

  /** String-only: assert `target.startsWith(prefix)`. */
  startWith(prefix: string): void
  /** String-only: assert `target.endsWith(suffix)`. */
  endWith(suffix: string): void
}

// ── Root API ───────────────────────────────────────────────────────────────

/**
 * The Fetchpier scripting API — the only global exposed to pre-request and
 * post-response scripts besides `console` and a whitelisted subset of
 * ECMAScript built-ins.
 *
 * Available in two phases:
 *   - **pre-request** (runs before the HTTP fetch): `fp.request` is mutable,
 *     `fp.response` is `undefined`.
 *   - **post-response** (runs after the fetch): `fp.response` is available,
 *     mutations to `fp.request` throw.
 */
export interface FpApi {
  /** The outgoing HTTP request. Mutable in pre-request, read-only in post-response. */
  readonly request: FpRequest

  /** The HTTP response. Only defined in post-response scripts. */
  readonly response?: FpResponse

  /** Persistent environment variables for the active environment. */
  readonly environment: FpEnvironment

  /** Ephemeral per-request variables shared between pre and post phases. */
  readonly variables: FpVariables

  /**
   * Defines a named test. The callback must be synchronous; any error thrown
   * (including `fp.expect` failures) marks the test as failed.
   *
   * The result is surfaced in the Tests tab of the request pane.
   *
   * @param name Human-readable test name shown in the UI.
   * @param fn Synchronous assertion block.
   *
   * @example
   * fp.test('status is 200', () => {
   *   fp.expect(fp.response.status).to.equal(200)
   * })
   */
  test(name: string, fn: () => void): void

  /**
   * Starts a fluent chai-like assertion on `value`.
   *
   * @example
   * fp.expect(user).to.have.property('email').that.is.a('string')
   */
  expect(value: unknown): ChaiExpect

  /** Logs to the Scripts console at the `log` level. */
  log(...args: unknown[]): void

  /** Logs to the Scripts console at the `warn` level. */
  warn(...args: unknown[]): void

  /** Logs to the Scripts console at the `error` level. */
  error(...args: unknown[]): void
}
