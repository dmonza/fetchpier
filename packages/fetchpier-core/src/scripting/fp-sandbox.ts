// Fetchpier sandbox — synchronous-only execution contract.
//
// Threat model: `node:vm` is NOT a security boundary, and this sandbox does
// not pretend to be one. Scripts are authored by the user who owns the
// workspace — same trust model as Postman / Bruno / VS Code REST Client. The
// goal of the code in this file is (1) surface reduction so the API a script
// can see is small enough to audit, and (2) catching the obvious accidental
// reaches into the host realm (e.g. `fp.log.constructor.constructor("...")`)
// that a careless or curious script would trip over. A determined attacker
// with script-author privileges should be assumed able to escape via V8
// internals, timing side channels, or prototype-chain corners that no
// userland scrub can close. Full statement: `SECURITY.md`, "Scope".
//
// Within that model, the sandbox is **synchronous**. No `Promise`, no
// `setTimeout/setInterval/setImmediate`, no `queueMicrotask`, no
// `SharedArrayBuffer`/`Atomics`, no `WebAssembly`. These are absent not for
// adversarial reasons but because allowing them would silently break the
// synchronous contract the rest of the request pipeline depends on.
//
// `vm.runInContext` honors `timeout` only for synchronous CPU-bound code; if
// you add an async global here, you must ALSO (a) drive its event loop yourself
// and (b) abort pending microtasks on timeout. Until that plumbing exists,
// async globals stay on FORBIDDEN_GLOBALS and are enforced by the whitelist
// + isolation tests.
//
// Rule: if you need a new global inside scripts, add it to ALLOWED_GLOBALS and
// add a test in `fp-sandbox.isolation.test.ts` that asserts it is present AND
// synchronous AND doesn't widen the documented surface.
import vm from 'node:vm'
import type {
  HeaderEntry,
  HttpRequest,
  HttpResponse,
  ScriptExecutionResult,
  ScriptLog,
  ScriptTestResult,
  EnvironmentChanges
} from '@shared/types'
import { safeClone } from '../shared/safe-clone'
import { recordToHeaders } from '@shared/lib/headers'
import { isReservedVariableName } from '@shared/lib/dynamic-variables'

// Whitelist of built-in globals that the sandbox is allowed to expose beyond
// the injected `fp` and `console` objects. Anything outside this list is
// deleted from the context before the user script runs.
// Globals that Node exposes to a vm context as non-configurable — we cannot
// `delete` them. Instead we wrap the user script in an IIFE that binds each of
// these names to `undefined` in the function's scope, so `typeof Promise` etc.
// resolve to `'undefined'` inside the user code.
const FORBIDDEN_GLOBALS: ReadonlyArray<string> = [
  'Promise',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'SharedArrayBuffer',
  'Atomics',
  'WebAssembly',
  'process',
  'global',
  'globalThis',
  'Buffer',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename'
]

// ── Host-surface freeze ─────────────────────────────────────────────────────
//
// Surface-reduction hardening, NOT an adversarial security boundary (see the
// threat model at the top of this file).
//
// `vm.runInContext({ codeGeneration: { strings: false } })` is a per-realm
// flag. It blocks `eval`/`new Function(...)` *inside the vm context*, but does
// NOT apply to functions that live in the host realm and happen to be
// reachable from inside the sandbox via property access — e.g. the methods we
// expose on `fp` and `console`. A careless script could otherwise navigate
// `fp.log.constructor` → host `Function` and accidentally compile host code,
// reaching `process`, `process.binding('fs')`, etc.
//
// `freezeHostSurface` walks every host object/function we bridge into the
// sandbox and nulls its prototype, so `.constructor` is `undefined`. That
// closes the obvious accidental path. Dynamic data returns (parsed JSON/XML,
// header dumps) are handled separately, via the JSON round-trip through the
// sandbox's own `JSON.parse` — see `intoSandbox` below.
//
// Side effect: `fp.log.bind/.call/.apply` and similar `Function.prototype`
// methods become `undefined` on every host function exposed in the sandbox.
// User code creating its own functions inside the sandbox is unaffected.
//
// What this does NOT do: stop a deliberately malicious script. A motivated
// attacker with author privileges has many other angles (V8 internals, GC
// timing, native add-on shenanigans, host primordials reached via subtle
// paths). The fp surface is not the only attack vector against the host
// realm — it's just the easiest one to close.
//
// Test coverage: `fp-sandbox.isolation.test.ts`.
const scrubbedHostValues = new WeakSet<object>()

export function freezeHostSurface<T>(value: T): T {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t !== 'object' && t !== 'function') return value
  const obj = value as unknown as object
  if (scrubbedHostValues.has(obj)) return value
  scrubbedHostValues.add(obj)

  for (const key of Reflect.ownKeys(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc) continue

    if ('value' in desc) {
      const v = desc.value
      if (typeof v === 'function') {
        // Scrub the function: null its prototype. That alone drops
        // `.constructor` (and `.bind`/`.call`/`.apply`) reach for any caller,
        // which is the property we care about. We do NOT wrap to also scrub
        // *return values*, because methods like `fp.response.xml2Json()`
        // legitimately return arrays whose `.join` / `.map` etc. user code
        // depends on. Return values that need sanitising are handled at the
        // method-implementation level (e.g. `json()` / `xml2Json()` /
        // `toObject()` route through the sandbox's own `JSON.parse`, and
        // mini-chai chains use `Object.create(null)`).
        freezeHostSurface(v)
      } else if (typeof v === 'object' && v !== null) {
        freezeHostSurface(v)
      }
    } else {
      // Accessor descriptor — scrub the getter/setter functions themselves so
      // `desc.get.constructor` is gone. Same rationale for not wrapping the
      // returns.
      if (desc.get) freezeHostSurface(desc.get)
      if (desc.set) freezeHostSurface(desc.set)
    }
  }

  try {
    Object.setPrototypeOf(obj, null)
  } catch {
    // Sealed or non-extensible host object — the per-property scrub above is
    // still in effect; this just means `obj.constructor` resolves via whatever
    // (also-scrubbed-if-reachable) prototype it kept.
  }
  return value
}

const ALLOWED_GLOBALS: ReadonlySet<string> = new Set([
  'fp',
  'console',
  'JSON',
  'Math',
  'Date',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'Symbol',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'undefined',
  'NaN',
  'Infinity',
  'isNaN',
  'isFinite',
  'parseInt',
  'parseFloat',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI'
])

import { AssertionError, createExpect } from './mini-chai'
import { parseXmlSafe, MAX_XML_BYTES, type Xml2JsonOptions } from './xml-parser'
import type { FpApi, FpMultipartBody, FpMultipartPart, FpRequest, FpResponse } from './fp-api'
import type { MultipartPart } from '@shared/types'
import { lookupMimeType } from '../requests/binary-store'

/** Maximum JSON body size `fp.response.json()` will try to parse. */
const MAX_JSON_BYTES = MAX_XML_BYTES

function formatBytesAsMb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1)
}

export type ScriptPhase = 'pre-request' | 'post-response'

export interface FpSandboxInput {
  phase: ScriptPhase
  script: string
  request: HttpRequest
  response?: HttpResponse
  environment: Record<string, string>
  /** Temporary per-request variables shared between pre and post. */
  variables: Record<string, unknown>
  /** Sandbox CPU timeout in ms — defaults to 5000. */
  timeoutMs?: number
}

export interface FpSandboxOutcome {
  result: ScriptExecutionResult
  /** New variables object (may be mutated by the script). */
  variables: Record<string, unknown>
  /** Final request after mutations (pre-request only; equal to input for post-response). */
  request: HttpRequest
  /** Final environment after mutations. */
  environment: Record<string, string>
}

// ── Case-insensitive header store ───────────────────────────────────────────

function normalizeHeaderName(name: string): string {
  return name.toLowerCase()
}

interface HeaderStore {
  /** First value for `name` (case-insensitive). */
  get(name: string): string | undefined
  /** All values for `name` (case-insensitive), in order — duplicate-aware. */
  getAll(name: string): string[]
  /** Replace every same-name entry with a single value (first position kept). */
  set(name: string, value: string): void
  /** Append a value, preserving any existing same-name entries (duplicate-aware). */
  add(name: string, value: string): void
  remove(name: string): void
  /** Total number of header entries (duplicates counted). */
  count(): number
  /** Lossy name→value view (last value wins). */
  toObject(): Record<string, string>
  /** Ordered, duplicate-capable view. */
  toList(): HeaderEntry[]
  /** Read-only snapshot excluding mutators (used for post-response). */
  toReadonly(): Pick<HeaderStore, 'get' | 'getAll' | 'toObject' | 'count'>
  /** Return the underlying object keyed by original casing. */
  snapshot(): Record<string, string>
}

function createHeaderStore(initial: HeaderEntry[]): HeaderStore {
  // Ordered, duplicate-capable list — duplicates are never lost merely because a
  // name-keyed accessor exists. Names compare case-insensitively.
  let list: HeaderEntry[] = initial.map((e) => ({ name: e.name, value: e.value }))
  const lc = (s: string): string => normalizeHeaderName(s)

  const get = (name: string): string | undefined => list.find((e) => lc(e.name) === lc(name))?.value
  const getAll = (name: string): string[] =>
    list.filter((e) => lc(e.name) === lc(name)).map((e) => e.value)
  const set = (name: string, value: string): void => {
    const target = lc(name)
    const firstIdx = list.findIndex((e) => lc(e.name) === target)
    if (firstIdx === -1) {
      list.push({ name, value: String(value) })
      return
    }
    const keptName = list[firstIdx].name // preserve original casing
    // Drop every same-name entry except the first, then update its value.
    list = list.filter((e, i) => i === firstIdx || lc(e.name) !== target)
    const idx = list.findIndex((e) => lc(e.name) === target)
    list[idx] = { name: keptName, value: String(value) }
  }
  const add = (name: string, value: string): void => {
    list.push({ name, value: String(value) })
  }
  const remove = (name: string): void => {
    const target = lc(name)
    list = list.filter((e) => lc(e.name) !== target)
  }
  const count = (): number => list.length
  const toObject = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const { name, value } of list) out[name] = value
    return out
  }
  const toList = (): HeaderEntry[] => list.map((e) => ({ name: e.name, value: e.value }))

  return {
    get,
    getAll,
    set,
    add,
    remove,
    count,
    toObject,
    toList,
    toReadonly: () => ({ get, getAll, toObject, count }),
    snapshot: toObject
  }
}

// ── Multipart body proxy (REQ-0066) ─────────────────────────────────────────

const MULTIPART_REF_PATTERN = /^[a-f0-9]{64}__.+$/
const ALLOWED_TEXT_PART_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'name',
  'value',
  'contentType',
  'disabled'
])
const ALLOWED_FILE_PART_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'name',
  'fileRef',
  'filename',
  'contentType',
  'disabled'
])

/**
 * Validate and normalise a part spec pushed by a script into a canonical
 * {@link MultipartPart}. Throws `TypeError` synchronously on any shape
 * violation: missing required field, unknown field, wrong kind for the
 * supplied fields, or `bytes`/`path`/etc. on a file part (scripts may only
 * reference an already-staged `fileRef`).
 */
function validateAndNormalisePartSpec(spec: unknown, idCounter: { value: number }): MultipartPart {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('Multipart part must be an object literal')
  }
  const s = spec as Record<string, unknown>
  const kind = s.kind
  if (kind === 'text') {
    for (const k of Object.keys(s)) {
      if (!ALLOWED_TEXT_PART_FIELDS.has(k)) {
        throw new TypeError(`Multipart text part has unknown field "${k}"`)
      }
    }
    if (typeof s.name !== 'string') {
      throw new TypeError('Multipart text part requires string "name"')
    }
    if (typeof s.value !== 'string') {
      throw new TypeError('Multipart text part requires string "value"')
    }
    return {
      kind: 'text',
      id: `mp-script-${idCounter.value++}`,
      name: s.name,
      value: s.value,
      contentType: s.contentType === undefined ? undefined : String(s.contentType),
      disabled: s.disabled === true ? true : undefined
    }
  }
  if (kind === 'file') {
    for (const k of Object.keys(s)) {
      if (!ALLOWED_FILE_PART_FIELDS.has(k)) {
        throw new TypeError(
          `Multipart file part has unknown field "${k}" — file parts may only reference an already-staged fileRef; bytes/path/etc. are not accepted`
        )
      }
    }
    if (typeof s.name !== 'string') {
      throw new TypeError('Multipart file part requires string "name"')
    }
    if (typeof s.fileRef !== 'string' || !MULTIPART_REF_PATTERN.test(s.fileRef)) {
      throw new TypeError(
        'Multipart file part requires "fileRef" matching <64-hex>__<sanitized-name> (only already-staged files may be referenced from a script)'
      )
    }
    const originalName = s.fileRef.slice(66)
    return {
      kind: 'file',
      id: `mp-script-${idCounter.value++}`,
      name: s.name,
      file: {
        ref: s.fileRef,
        originalName,
        sizeBytes: 0,
        mimeType: lookupMimeType(originalName)
      },
      filename: s.filename === undefined ? undefined : String(s.filename),
      contentType: s.contentType === undefined ? undefined : String(s.contentType),
      disabled: s.disabled === true ? true : undefined
    }
  }
  throw new TypeError(`Multipart part requires kind "text" or "file" (got ${JSON.stringify(kind)})`)
}

/**
 * Wrap a single stored {@link MultipartPart} as a script-facing part object.
 * Mutable fields (`name`, `value`, `contentType`, `filename`, `disabled`) are
 * proxied through getters/setters that gate on `isPre`. The `kind` and
 * (file-only) `fileRef` are read-only on existing parts — assignment throws.
 */
function wrapPart(part: MultipartPart, isPre: boolean): FpMultipartPart {
  const guardWrite = (label: string): void => {
    if (!isPre) {
      throw new TypeError(`fp.request.body.parts[].${label} is read-only in post-response scripts`)
    }
  }
  const wrapper = Object.create(null) as Record<string, unknown>
  Object.defineProperty(wrapper, 'kind', {
    get: () => part.kind,
    set: () => {
      throw new TypeError('fp.request.body.parts[].kind is read-only')
    },
    enumerable: true,
    configurable: true
  })
  Object.defineProperty(wrapper, 'name', {
    get: () => part.name,
    set: (v: unknown) => {
      guardWrite('name')
      part.name = String(v)
    },
    enumerable: true,
    configurable: true
  })
  Object.defineProperty(wrapper, 'contentType', {
    get: () => part.contentType,
    set: (v: unknown) => {
      guardWrite('contentType')
      part.contentType = v === undefined || v === null ? undefined : String(v)
    },
    enumerable: true,
    configurable: true
  })
  Object.defineProperty(wrapper, 'disabled', {
    get: () => part.disabled,
    set: (v: unknown) => {
      guardWrite('disabled')
      part.disabled = v === true ? true : undefined
    },
    enumerable: true,
    configurable: true
  })
  if (part.kind === 'text') {
    Object.defineProperty(wrapper, 'value', {
      get: () => part.value,
      set: (v: unknown) => {
        guardWrite('value')
        part.value = String(v)
      },
      enumerable: true,
      configurable: true
    })
  } else {
    Object.defineProperty(wrapper, 'fileRef', {
      get: () => part.file.ref,
      set: () => {
        throw new TypeError('fp.request.body.parts[].fileRef is read-only')
      },
      enumerable: true,
      configurable: true
    })
    Object.defineProperty(wrapper, 'filename', {
      get: () => part.filename,
      set: (v: unknown) => {
        guardWrite('filename')
        part.filename = v === undefined || v === null ? undefined : String(v)
      },
      enumerable: true,
      configurable: true
    })
  }
  return wrapper as unknown as FpMultipartPart
}

/**
 * Build the `fp.request.body` proxy when `bodyType === 'multipart-form'`.
 * The proxy carries a single `parts` array whose mutating methods are
 * intercepted so that pushed specs are validated and normalised in place.
 *
 * Surface reduction: only the documented members (length, indexed access,
 * push, pop, shift, unshift, splice, reverse, sort) are reachable through
 * the proxy. Everything else — including the array's `constructor` — is
 * blocked at the `get` trap to keep the recursive `.constructor` walk in
 * the isolation suite from reaching host realm `Function`. Each mutating
 * method is `freezeHostSurface`-d so its own `.constructor` chain is also
 * scrubbed.
 *
 * The underlying storage is the same `MultipartPart[]` the host keeps, so
 * the snapshot diff at script-end sees mutations immediately.
 */
function createMultipartBody(
  storage: MultipartPart[],
  isPre: boolean,
  idCounter: { value: number }
): FpMultipartBody {
  const guardWrite = (op: string): void => {
    if (!isPre) {
      throw new TypeError(`fp.request.body.parts.${op}() is read-only in post-response scripts`)
    }
  }

  // Pre-create and surface-scrub every method we expose so that
  // `parts.push.constructor` returns undefined (its prototype is nulled).
  const pushFn = freezeHostSurface((...specs: unknown[]) => {
    guardWrite('push')
    for (const spec of specs) {
      storage.push(validateAndNormalisePartSpec(spec, idCounter))
    }
    return storage.length
  })
  const unshiftFn = freezeHostSurface((...specs: unknown[]) => {
    guardWrite('unshift')
    const normalised = specs.map((s) => validateAndNormalisePartSpec(s, idCounter))
    storage.unshift(...normalised)
    return storage.length
  })
  const popFn = freezeHostSurface(() => {
    guardWrite('pop')
    return storage.pop()
  })
  const shiftFn = freezeHostSurface(() => {
    guardWrite('shift')
    return storage.shift()
  })
  const spliceFn = freezeHostSurface((start: number, deleteCount?: number, ...specs: unknown[]) => {
    guardWrite('splice')
    const normalised = specs.map((s) => validateAndNormalisePartSpec(s, idCounter))
    return storage.splice(start, deleteCount ?? 0, ...normalised)
  })
  const reverseFn = freezeHostSurface(() => {
    guardWrite('reverse')
    storage.reverse()
    return partsProxy
  })
  const sortFn = freezeHostSurface((cmp?: (a: MultipartPart, b: MultipartPart) => number) => {
    guardWrite('sort')
    storage.sort(cmp)
    return partsProxy
  })

  const methodNames = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort'])

  const partsHandler: ProxyHandler<MultipartPart[]> = {
    get(target, prop) {
      // Block escape vectors: `parts.constructor.constructor` is the canonical
      // multi-hop reach into host realm `Function`. Returning undefined makes
      // the recursive isolation walk bail out at the first hop.
      if (
        prop === 'constructor' ||
        prop === '__proto__' ||
        prop === 'prototype' ||
        prop === Symbol.iterator ||
        prop === Symbol.toPrimitive
      ) {
        return undefined
      }
      if (prop === 'length') return target.length
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const idx = Number(prop)
        if (idx >= target.length) return undefined
        return wrapPart(target[idx], isPre)
      }
      if (typeof prop === 'string' && methodNames.has(prop)) {
        switch (prop) {
          case 'push':
            return pushFn
          case 'unshift':
            return unshiftFn
          case 'pop':
            return popFn
          case 'shift':
            return shiftFn
          case 'splice':
            return spliceFn
          case 'reverse':
            return reverseFn
          case 'sort':
            return sortFn
        }
      }
      // Everything else (forEach/map/slice/...) returns undefined so the
      // sandbox doesn't expose the host Array prototype. Scripts can iterate
      // with `for (let i = 0; i < parts.length; i++)`.
      return undefined
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        if (!isPre) {
          throw new TypeError('fp.request.body.parts[] is read-only in post-response scripts')
        }
        target[Number(prop)] = validateAndNormalisePartSpec(value, idCounter)
        return true
      }
      if (prop === 'length') {
        if (!isPre) {
          throw new TypeError('fp.request.body.parts.length is read-only in post-response scripts')
        }
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0) return true
        target.length = n
        return true
      }
      // Reject all other writes (constructor, __proto__, arbitrary keys).
      return false
    },
    getPrototypeOf() {
      return null
    },
    has(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        return Number(prop) < target.length
      }
      return prop === 'length' || (typeof prop === 'string' && methodNames.has(prop))
    },
    ownKeys(target) {
      const keys: (string | symbol)[] = []
      for (let i = 0; i < target.length; i += 1) keys.push(String(i))
      keys.push('length')
      return keys
    }
  }

  const partsProxy = new Proxy(storage, partsHandler) as unknown as FpMultipartPart[]

  const body: FpMultipartBody = Object.create(null)
  Object.defineProperty(body, 'parts', {
    get: () => partsProxy,
    set: () => {
      throw new TypeError(
        'fp.request.body.parts is the parts collection; reassign via splice/push/index instead of replacing the array reference'
      )
    },
    enumerable: true,
    configurable: true
  })
  return body
}

// ── Sandbox runner ──────────────────────────────────────────────────────────

export function runFpScript(input: FpSandboxInput): FpSandboxOutcome {
  const { phase, script, request, response, environment, variables, timeoutMs = 5000 } = input

  const logs: ScriptLog[] = []
  const testResults: ScriptTestResult[] = []

  // ── Sandbox-realm helpers ──────────────────────────────────────────────
  // `intoSandbox()` re-creates a value inside the vm realm (via the context's
  // own `JSON.parse`) so its prototype chain hits the sandbox-realm
  // `Object`/`Array`, whose `constructor.constructor` is the in-context
  // `Function` — which is gated by `codeGeneration.strings: false`. Without
  // this step, data-shaped returns from host methods (headers dumps, parsed
  // JSON/XML) would let a careless script reach the host realm's `Function`
  // via `result.constructor.constructor("...")`. Same scope as
  // `freezeHostSurface`: accidental-footgun reduction, not an adversarial
  // barrier (see threat model at top of file).
  //
  // Late-bound: methods reference this closure but the parser is filled in
  // after `vm.createContext` runs (the only time we can extract a vm-realm
  // function). Methods aren't called until the user script runs, which is
  // strictly after.
  let sandboxJsonParse: ((s: string) => unknown) | null = null
  function intoSandbox<T>(value: T): T {
    if (value === null || value === undefined) return value
    if (typeof value !== 'object') return value
    if (!sandboxJsonParse) return value // unreachable in practice
    try {
      return sandboxJsonParse(JSON.stringify(value)) as T
    } catch {
      return value
    }
  }

  // ── Request proxy ──────────────────────────────────────────────────────
  // Prefer the ordered, duplicate-capable list; fall back to the lossy record.
  const headerStore = createHeaderStore(
    request.headerList ?? recordToHeaders(request.headers ?? {})
  )
  const initialHeaderSnapshot = JSON.stringify(headerStore.toList())

  const isPre = phase === 'pre-request'
  const isBinary = request.bodyType === 'binary'
  const isMultipart = request.bodyType === 'multipart-form'
  const binaryFileRef = request.binaryFile?.ref

  const requestState = {
    method: request.method,
    url: request.url,
    body: isBinary || isMultipart ? undefined : request.body
  }

  // Multipart body surface (REQ-0066). Mirrors the `binaryFileRef` pattern
  // but exposes a structured object instead of a single ref: pre-request
  // scripts can mutate the parts array (push, splice, indexed assignment,
  // pop, shift, unshift, reverse, sort). File parts may only be added by
  // referencing an already-staged fileRef. The wrapper and each part proxy
  // are themselves `freezeHostSurface`-d below to close `.constructor`
  // escape paths through the new surface.
  const multipartStorage: MultipartPart[] = isMultipart
    ? (request.multipartParts ?? []).map((p) => structuredClone(p))
    : []
  const multipartInitialSnapshot = JSON.stringify(multipartStorage)
  const scriptIdCounter = { value: 0 }
  const multipartBody: FpMultipartBody | undefined = isMultipart
    ? createMultipartBody(multipartStorage, isPre, scriptIdCounter)
    : undefined

  const headersProxy: Pick<
    HeaderStore,
    'get' | 'getAll' | 'set' | 'add' | 'remove' | 'count' | 'toObject'
  > = isPre
    ? {
        get: (n: string) => headerStore.get(n),
        getAll: (n: string) => intoSandbox(headerStore.getAll(n)),
        set: (n: string, v: string) => headerStore.set(n, v),
        add: (n: string, v: string) => headerStore.add(n, v),
        remove: (n: string) => headerStore.remove(n),
        count: () => headerStore.count(),
        toObject: () => intoSandbox(headerStore.toObject())
      }
    : {
        get: (n: string) => headerStore.get(n),
        getAll: (n: string) => intoSandbox(headerStore.getAll(n)),
        set: () => {
          throw new Error('fp.request.headers.set() is only available in pre-request scripts')
        },
        add: () => {
          throw new Error('fp.request.headers.add() is only available in pre-request scripts')
        },
        remove: () => {
          throw new Error('fp.request.headers.remove() is only available in pre-request scripts')
        },
        count: () => headerStore.count(),
        toObject: () => intoSandbox(headerStore.toObject())
      }

  // Descriptors are declared configurable so that `freezeHostSurface` can
  // replace the accessor functions with return-value-scrubbing wrappers. The
  // user-visible API stays the same (getters still gate writes per phase).
  const requestObj: FpRequest = Object.create(
    {},
    {
      method: {
        get: () => requestState.method,
        set: (v: string) => {
          if (!isPre) throw new Error('fp.request.method is read-only in post-response scripts')
          requestState.method = String(v)
        },
        enumerable: true,
        configurable: true
      },
      url: {
        get: () => requestState.url,
        set: (v: string) => {
          if (!isPre) throw new Error('fp.request.url is read-only in post-response scripts')
          requestState.url = String(v)
        },
        enumerable: true,
        configurable: true
      },
      body: {
        get: () => (isMultipart ? multipartBody : requestState.body),
        set: (v: string | undefined) => {
          if (!isPre) throw new Error('fp.request.body is read-only in post-response scripts')
          if (isBinary) {
            throw new Error(
              "fp.request.body is read-only when bodyType === 'binary' — binary payload is not exposed to scripts"
            )
          }
          if (isMultipart) {
            throw new Error(
              "fp.request.body is structured when bodyType === 'multipart-form' — mutate via fp.request.body.parts (push/splice/pop/shift/unshift/index assignment)"
            )
          }
          requestState.body = v === undefined || v === null ? undefined : String(v)
        },
        enumerable: true,
        configurable: true
      },
      bodyType: {
        get: () => request.bodyType ?? 'none',
        set: () => {
          throw new Error('fp.request.bodyType is read-only')
        },
        enumerable: true,
        configurable: true
      },
      binaryFileRef: {
        get: () => binaryFileRef,
        set: () => {
          throw new Error('fp.request.binaryFileRef is read-only')
        },
        enumerable: true,
        configurable: true
      },
      headers: { value: headersProxy, enumerable: true, configurable: true, writable: false }
    }
  )

  // ── Response proxy ─────────────────────────────────────────────────────
  let responseObj: FpResponse | undefined
  if (response) {
    const respHeaders = createHeaderStore(recordToHeaders(response.headers ?? {}))
    // Memoization: the default-options XML parse is cached so repeated
    // `fp.response.xml2Json()` calls in the same post-response script don't
    // re-parse. Calls with explicit options always re-parse (simple contract:
    // keep the result in a `const` if you want to reuse it).
    let xmlDefaultCache: { parsed: unknown } | undefined
    const rawBody = response.body
    // Responses rebuilt from history carry no status: nothing was decoded there.
    const decodingStatus = response.decodingStatus ?? 'not-required'
    // A body that could not be decoded is still the bytes as received; parsing it
    // would fail with a confusing syntax error over compressed data. Fail with
    // the real cause instead, so a test depending on the body says why.
    const assertDecoded = (method: string): void => {
      if (decodingStatus !== 'failed' && decodingStatus !== 'unsupported') return
      const encoding =
        Object.entries(response.headers ?? {}).find(
          ([k]) => k.toLowerCase() === 'content-encoding'
        )?.[1] ?? 'unknown'
      throw new Error(
        decodingStatus === 'unsupported'
          ? `fp.response.${method}(): response body could not be decoded (${encoding}: unsupported content encoding)`
          : `fp.response.${method}(): response body could not be decoded (${encoding}: decoding failed)`
      )
    }
    responseObj = {
      status: response.status,
      statusText: response.statusText,
      headers: {
        get: (n: string) => respHeaders.get(n),
        getAll: (n: string) => intoSandbox(respHeaders.getAll(n)),
        count: () => respHeaders.count(),
        toObject: () => intoSandbox(respHeaders.toObject())
      },
      body: rawBody,
      decodingStatus,
      json(): unknown {
        assertDecoded('json')
        if (typeof rawBody !== 'string') {
          throw new Error('fp.response.json(): response body is not a string')
        }
        if (rawBody.length > MAX_JSON_BYTES) {
          throw new Error(
            `fp.response.json(): response body too large (${formatBytesAsMb(
              rawBody.length
            )} MB, max ${formatBytesAsMb(
              MAX_JSON_BYTES
            )} MB). Parsing would block the main process.`
          )
        }
        // Route through the sandbox-realm `JSON.parse` so the resulting tree
        // has sandbox prototypes (constructor-chain blocked by codeGeneration).
        try {
          if (!sandboxJsonParse) return JSON.parse(rawBody)
          return sandboxJsonParse(rawBody)
        } catch (e) {
          throw new Error(`fp.response.json(): body is not valid JSON (${(e as Error).message})`, {
            cause: e
          })
        }
      },
      xml2Json(opts?: Xml2JsonOptions): unknown {
        assertDecoded('xml2Json')
        const hasOpts = !!opts && Object.keys(opts).length > 0
        if (!hasOpts) {
          if (!xmlDefaultCache) xmlDefaultCache = { parsed: intoSandbox(parseXmlSafe(rawBody)) }
          return xmlDefaultCache.parsed
        }
        return intoSandbox(parseXmlSafe(rawBody, opts))
      },
      timingMs: response.timingMs,
      sizeBytes: response.sizeBytes
    }
  }

  // ── Environment proxy ──────────────────────────────────────────────────
  const envStore: Record<string, string> = { ...environment }
  const envChanges: EnvironmentChanges = { set: {}, removed: [] }
  const envProxy = {
    get(name: string): string | undefined {
      return envStore[name]
    },
    set(name: string, value: string): void {
      // REQ-0087: the whole `$` prefix is the system dynamic-variable namespace.
      // A script may not create or rename a variable into it; the thrown error
      // surfaces in the script console (RESERVED_VARIABLE_NAME-class).
      if (isReservedVariableName(name)) {
        throw new Error(
          `fp.environment.set("${name}", …): names starting with "$" are reserved for system dynamic variables.`
        )
      }
      const str = String(value)
      // REQ-0076: `enc:` is the reserved ciphertext prefix. A script writes
      // plaintext (the system encrypts secret-named values); a literal `enc:`
      // string is always a mistake and would corrupt the read path.
      if (str.startsWith('enc:')) {
        throw new Error(
          `fp.environment.set("${name}", …): values starting with "enc:" are reserved for encrypted secrets.`
        )
      }
      envStore[name] = str
      envChanges.set[name] = str
      const idx = envChanges.removed.indexOf(name)
      if (idx >= 0) envChanges.removed.splice(idx, 1)
    },
    remove(name: string): void {
      delete envStore[name]
      delete envChanges.set[name]
      if (!envChanges.removed.includes(name)) envChanges.removed.push(name)
    },
    toObject(): Record<string, string> {
      return intoSandbox({ ...envStore })
    }
  }

  // ── Variables proxy (ephemeral per-request store) ─────────────────────
  const varsStore: Record<string, unknown> = { ...variables }
  const variablesProxy = {
    get(name: string): unknown {
      return varsStore[name]
    },
    set(name: string, value: unknown): void {
      varsStore[name] = value
    }
  }

  // ── Tests + expect ─────────────────────────────────────────────────────
  const expectFn = createExpect()
  const testFn = (name: string, fn: () => void): void => {
    try {
      fn()
      testResults.push({ name: String(name), passed: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      testResults.push({ name: String(name), passed: false, error: msg })
    }
  }

  // ── Logging ────────────────────────────────────────────────────────────
  const pushLog = (level: ScriptLog['level'], args: unknown[]): void => {
    logs.push({ level, args: args.map((a) => safeClone(a)), timestamp: new Date().toISOString() })
  }

  const fp: FpApi = {
    request: requestObj,
    response: responseObj,
    environment: envProxy,
    variables: variablesProxy,
    test: testFn,
    expect: expectFn,
    log: (...args: unknown[]): void => pushLog('log', args),
    warn: (...args: unknown[]): void => pushLog('warn', args),
    error: (...args: unknown[]): void => pushLog('error', args)
  }

  // ── Context ─────────────────────────────────────────────────────────────
  // Deliberately minimal — no process, no require, no globalThis.
  // `console` is aliased to fp logging so scripts can use familiar console.log().
  const consoleAlias = {
    log: (...args: unknown[]): void => pushLog('log', args),
    warn: (...args: unknown[]): void => pushLog('warn', args),
    error: (...args: unknown[]): void => pushLog('error', args),
    info: (...args: unknown[]): void => pushLog('log', args)
  }
  // Create the context BEFORE attaching `fp`/`console`. We need a sandbox-realm
  // `JSON.parse` reference to round-trip data returns through, and that only
  // exists after `vm.createContext`.
  const context: Record<string, unknown> = {}
  vm.createContext(context, {
    name: `fp-sandbox:${phase}`,
    codeGeneration: { strings: false, wasm: false }
  })

  // Remove any configurable global that isn't on the whitelist. Many V8-defined
  // globals (Promise, SharedArrayBuffer, Atomics, WebAssembly, …) are
  // non-configurable in a vm context and can't be `delete`d — we handle those
  // via shadowing in the IIFE wrapper below.
  const allowedList = JSON.stringify(Array.from(ALLOWED_GLOBALS))
  vm.runInContext(
    `(() => {
      const allowed = new Set(${allowedList});
      const names = Object.getOwnPropertyNames(globalThis);
      for (const name of names) {
        if (!allowed.has(name)) {
          try { delete globalThis[name]; } catch { /* non-configurable — ignore */ }
        }
      }
    })();`,
    context,
    { filename: 'fp-sandbox-isolate.js' }
  )

  // Capture the sandbox-realm `JSON.parse` so `intoSandbox()` can re-root host
  // data returns into the vm realm.
  sandboxJsonParse = vm.runInContext('JSON.parse', context) as (s: string) => unknown

  // Scrub host objects reachable from `fp` / `console` so an accidental
  // `fp.log.constructor` walk no longer reaches host `Function`. This is
  // surface reduction, not adversarial containment — see `freezeHostSurface`
  // above and the threat model at the top of this file.
  freezeHostSurface(fp)
  freezeHostSurface(consoleAlias)

  // Now expose them to the sandbox.
  context.fp = fp
  context.console = consoleAlias

  const result: ScriptExecutionResult = {
    success: true,
    logs,
    testResults
  }

  // Wrap the user script in an IIFE whose parameters shadow every forbidden
  // global with `undefined`. This works even for non-configurable globals like
  // `Promise` and `SharedArrayBuffer` that `delete` can't remove.
  const shadowParams = FORBIDDEN_GLOBALS.join(', ')
  const wrappedScript = `(function(${shadowParams}) { "use strict";\n${script}\n}).call(void 0);`

  try {
    vm.runInContext(wrappedScript, context, {
      timeout: timeoutMs,
      displayErrors: true,
      filename: `fp-${phase}-script.js`
    })
  } catch (err) {
    // Timeouts surface as a vm-generated Error; syntax errors too.
    result.success = false
    const e = err as Error
    result.error = {
      message: e?.message ?? String(err),
      stack: e?.stack
    }
  }

  // Build modifiedRequest (only meaningful in pre-request)
  if (isPre) {
    const modified: Partial<HttpRequest> = {}
    if (requestState.method !== request.method) modified.method = requestState.method
    if (requestState.url !== request.url) modified.url = requestState.url
    if (!isMultipart && requestState.body !== request.body) modified.body = requestState.body
    // Compare the ordered list (duplicate-aware) so a change that touches only a
    // duplicate is detected; emit both the list and the lossy record view.
    if (JSON.stringify(headerStore.toList()) !== initialHeaderSnapshot) {
      modified.headers = headerStore.toObject()
      modified.headerList = headerStore.toList()
    }
    if (isMultipart) {
      // Positional snapshot diff (REQ-0066). Cheap and exact for our shape
      // (no Symbols, no circular refs). When changed, the whole parts list
      // replaces the in-flight `multipartParts` — the merge in execute.ts is
      // "replace, don't deep-merge."
      const finalSnapshot = JSON.stringify(multipartStorage)
      if (finalSnapshot !== multipartInitialSnapshot) {
        modified.multipartParts = multipartStorage.map((p) => structuredClone(p))
      }
    }
    if (Object.keys(modified).length > 0) result.modifiedRequest = modified
  }

  if (Object.keys(envChanges.set).length > 0 || envChanges.removed.length > 0) {
    result.environmentChanges = envChanges
  }

  // Assertion error in the top-level of the script (not inside `fp.test`) is
  // treated as a failure above (stored in `result.error`). No extra handling.
  void AssertionError

  const finalRequest: HttpRequest = isPre
    ? {
        ...request,
        method: requestState.method,
        url: requestState.url,
        headers: headerStore.toObject(),
        headerList: headerStore.toList(),
        body: isMultipart ? undefined : requestState.body,
        multipartParts: isMultipart
          ? multipartStorage.map((p) => structuredClone(p))
          : request.multipartParts
      }
    : request

  return {
    result,
    variables: varsStore,
    request: finalRequest,
    environment: envStore
  }
}
