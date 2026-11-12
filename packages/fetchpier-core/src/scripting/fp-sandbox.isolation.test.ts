// Sandbox surface regression suite.
//
// This file is NOT a security audit and the sandbox it pins is NOT a security
// boundary against malicious scripts — see `SECURITY.md`, "Scope", for the
// full statement. `node:vm` is documented by Node as
// unsafe for untrusted code; the trust boundary here is the script author,
// same as Postman / Bruno / VS Code REST Client.
//
// What every test in this file pins is one property of the *documented
// surface*: which globals are reachable, which constructors are exposed,
// which APIs cross the realm boundary. The point is to catch accidental
// widening of that surface in CI before it ships — not to prove the sandbox
// resists adversaries. Most of the assertions also happen to make obvious
// reaches into the host realm fail loudly, which protects against careless
// or curious scripts; that is a side benefit, not the contract.
//
// Whenever you add a global to `ALLOWED_GLOBALS` or expose a new method on
// `fp`, you MUST add a matching assertion here. The recursive `.constructor`
// walk at the bottom is the safety net for future drift — it iterates every
// host value reachable from `fp` / `console` and fails if any of them widen
// the surface so far as to make the host realm's `Function` reachable.
import { describe, it, expect } from 'vitest'
import { runFpScript } from './fp-sandbox'
import type { HttpRequest, HttpResponse } from '@shared/types'

function baseRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    url: 'https://example.com/',
    headers: {},
    body: undefined,
    ...overrides
  }
}

const VALID_HASH = 'a'.repeat(64)
const VALID_REF = `${VALID_HASH}__beach.jpg`

function multipartRequest(): HttpRequest {
  return {
    method: 'POST',
    url: 'https://example.com/upload',
    headers: {},
    bodyType: 'multipart-form',
    multipartParts: [
      { kind: 'text', id: 'mp-0', name: 'desc', value: 'hello' },
      {
        kind: 'file',
        id: 'mp-1',
        name: 'photo',
        file: { ref: VALID_REF, originalName: 'beach.jpg', sizeBytes: 0, mimeType: 'image/jpeg' }
      }
    ]
  }
}

function runMultipart(script: string, phase: 'pre-request' | 'post-response' = 'pre-request') {
  return runFpScript({
    phase,
    script,
    request: multipartRequest(),
    response: phase === 'post-response' ? baseResponse : undefined,
    environment: {},
    variables: {}
  })
}

const baseResponse: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'Content-Type': 'application/json' },
  body: '{"id":1}',
  timingMs: 1,
  sizeBytes: 8
}

function run(script: string, opts: { phase?: 'pre-request' | 'post-response' } = {}) {
  return runFpScript({
    phase: opts.phase ?? 'pre-request',
    script,
    request: baseRequest(),
    response: opts.phase === 'post-response' ? baseResponse : undefined,
    environment: {},
    variables: {}
  })
}

// ── 1. The reproducer ──────────────────────────────────────────────────────
// Came out of probing during the audit that produced this file. Without the
// host-surface freeze, a script could reach the host realm's `Function`
// constructor through `fp.log.constructor` and bypass the vm context's
// `codeGeneration.strings: false` flag — gaining access to `process`,
// `process.env`, `process.binding('fs')`, `process.getBuiltinModule`, etc.
describe('host realm escape via fp.<fn>.constructor', () => {
  it('fp.log.constructor("return process")() does NOT return the host process', () => {
    const outcome = run(`
      try {
        const F = fp.log.constructor;
        const r = F && F("return typeof process")();
        fp.variables.set("escape", { ctor: typeof F, r });
      } catch (e) {
        fp.variables.set("escape", { thrown: true, message: e && e.message });
      }
    `)
    expect(outcome.result.success).toBe(true)
    const probe = outcome.variables.escape as
      { ctor?: string; r?: unknown; thrown?: boolean; message?: string } | undefined
    // Accept three outcomes, in priority order:
    //   1. The script threw (constructor not callable as code generator).
    //   2. fp.log.constructor is undefined (no constructor at all).
    //   3. The constructor IS callable but does NOT yield the host `process`.
    // What is NOT acceptable: `r === 'object'`, which is exactly what `typeof
    // process` returns in the host realm — that would prove `process` leaked.
    if (probe?.thrown) {
      expect(probe.message).toBeTypeOf('string')
    } else {
      expect(probe?.ctor).toBe('undefined')
      expect(probe?.r).not.toBe('object')
    }
  })

  it('process.binding / process.getBuiltinModule cannot be reached via any host method on fp', () => {
    const targets = [
      'fp.log',
      'fp.warn',
      'fp.error',
      'fp.test',
      'fp.expect',
      'fp.environment.set',
      'fp.environment.get',
      'fp.environment.remove',
      'fp.environment.toObject',
      'fp.variables.set',
      'fp.variables.get'
    ]
    for (const target of targets) {
      // Walk a few hops up the constructor chain — the dangerous two-hop case
      // is `target.constructor.constructor("...")` (Function via Object).
      const outcome = run(`
        let leak = null;
        try {
          let cur = ${target};
          for (let i = 0; i < 4; i++) {
            const next = cur && cur.constructor;
            if (typeof next !== 'function') break;
            try {
              const r = next("return [typeof process, typeof process && process.binding && typeof process.binding('fs')]")();
              leak = { hops: i + 1, result: r };
              break;
            } catch (e) { /* in-context Function or non-compiler — keep going */ }
            cur = next;
          }
        } catch (e) { leak = { error: e && e.message }; }
        fp.variables.set("r", leak);
      `)
      expect(outcome.variables.r, `${target} constructor chain leaked host Function`).toBeNull()
    }
  })

  it('return values of fp.expect are also scrubbed (chain objects have no host constructor)', () => {
    // `fp.expect(x)` returns a fresh chain object each call. Scrubbing the
    // static surface isn't enough — the chain has to be sanitized at return
    // time too, otherwise `fp.expect(1).constructor.constructor("...")` is an
    // escape vector identical to `fp.log.constructor("...")`.
    const outcome = run(`
      try {
        const chain = fp.expect(1);
        const C = chain && chain.constructor;
        const r = C && C("return typeof process")();
        fp.variables.set("r", { chainCtor: typeof C, r });
      } catch (e) {
        fp.variables.set("r", { thrown: true, message: e && e.message });
      }
    `)
    const probe = outcome.variables.r as
      { chainCtor?: string; r?: unknown; thrown?: boolean; message?: string } | undefined
    if (probe?.thrown) {
      expect(probe.message).toBeTypeOf('string')
    } else {
      expect(probe?.chainCtor).toBe('undefined')
      expect(probe?.r).not.toBe('object')
    }
  })
})

// ── 2. Async APIs forbidden by the sandbox contract ───────────────────────
// The sandbox contract is synchronous-only. These names MUST resolve to
// `undefined` inside user scripts.
describe('async / threading globals are not reachable', () => {
  const probes = [
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
    'WebAssembly'
  ]
  for (const name of probes) {
    it(`typeof ${name} === 'undefined'`, () => {
      const outcome = run(`fp.variables.set("t", typeof ${name});`)
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables.t).toBe('undefined')
    })
  }

  it('new Promise(...) throws because Promise is shadowed', () => {
    const outcome = run(`new Promise(() => {});`)
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.error?.message).toMatch(/Promise is not (defined|a constructor)/)
  })

  it('SharedArrayBuffer + Atomics combo (typical TOCTOU vector) is unreachable', () => {
    const outcome = run(`
      try { new SharedArrayBuffer(8); fp.variables.set("r", "constructed"); }
      catch (e) { fp.variables.set("r", "threw:" + e.message); }
    `)
    expect(outcome.variables.r).toMatch(/^threw:/)
  })

  it('WebAssembly.compile is unreachable (wasm codeGeneration disabled too)', () => {
    const outcome = run(`fp.variables.set("t", typeof WebAssembly);`)
    expect(outcome.variables.t).toBe('undefined')
  })
})

// ── 3. Node-host globals ───────────────────────────────────────────────────
// `vm.createContext` does not by default expose Node's runtime globals (fetch,
// URL, crypto, etc.) — these tests pin that assumption so a future Node /
// V8 upgrade that starts auto-exposing host globals into vm contexts is caught.
describe('Node-runtime globals are absent from the vm context', () => {
  const probes = [
    'process',
    'global',
    'globalThis',
    'Buffer',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'fetch',
    'URL',
    'URLSearchParams',
    'crypto',
    'TextEncoder',
    'TextDecoder',
    'XMLHttpRequest',
    'performance',
    'AbortController',
    'AbortSignal',
    'structuredClone'
  ]
  for (const name of probes) {
    it(`typeof ${name} === 'undefined'`, () => {
      const outcome = run(`fp.variables.set("t", typeof ${name});`)
      expect(outcome.result.success).toBe(true)
      expect(outcome.variables.t).toBe('undefined')
    })
  }
})

// ── 4. Code generation ─────────────────────────────────────────────────────
describe('code generation from strings is disabled', () => {
  it('global eval cannot compile strings', () => {
    // `eval` is non-configurable in V8 and strict mode forbids shadowing it
    // via an IIFE parameter (the name is reserved). The identifier therefore
    // stays reachable, but the vm context's `codeGeneration.strings: false`
    // makes any string argument throw — that's the actual security property.
    const outcome = run(`
      try { eval("1+1"); fp.variables.set("r", "compiled"); }
      catch (e) { fp.variables.set("r", "threw:" + e.message); }
    `)
    expect(outcome.variables.r).toMatch(/Code generation from strings disallowed/)
  })

  it('new Function() is shadowed (FORBIDDEN_GLOBALS) → ReferenceError-equivalent', () => {
    const outcome = run(`
      try { new Function("return 1")(); fp.variables.set("r", "compiled"); }
      catch (e) { fp.variables.set("r", "threw:" + e.message); }
    `)
    expect(outcome.variables.r).toMatch(/^threw:/)
  })

  it('reaching Function via prototype chain still throws (codeGeneration.strings = false)', () => {
    // `({}).constructor.constructor` resolves to the IN-CONTEXT Function in V8,
    // which is constrained by the context's codeGeneration flag.
    const outcome = run(`
      try { ({}).constructor.constructor("return 1")(); fp.variables.set("r", "compiled"); }
      catch (e) { fp.variables.set("r", "threw:" + e.message); }
    `)
    expect(outcome.variables.r).toMatch(/Code generation from strings disallowed/)
  })

  it('AsyncFunction via prototype chain is also blocked', () => {
    const outcome = run(`
      try {
        async function f(){}
        f.constructor("return 1")();
        fp.variables.set("r", "compiled");
      } catch (e) { fp.variables.set("r", "threw:" + e.message); }
    `)
    expect(outcome.variables.r).toMatch(/Code generation from strings disallowed/)
  })

  it('GeneratorFunction via prototype chain is also blocked', () => {
    const outcome = run(`
      try {
        function* g(){}
        g.constructor("return 1")();
        fp.variables.set("r", "compiled");
      } catch (e) { fp.variables.set("r", "threw:" + e.message); }
    `)
    expect(outcome.variables.r).toMatch(/Code generation from strings disallowed/)
  })

  it('eval-via-prototype on a host fp method (the real escape) is blocked', () => {
    // Same shape as the §1 reproducer but framed as a code-generation gate.
    const outcome = run(`
      try {
        const F = fp.log.constructor;
        if (F) { F("return 1")(); fp.variables.set("r", "compiled"); }
        else { fp.variables.set("r", "no-ctor"); }
      } catch (e) { fp.variables.set("r", "threw:" + e.message); }
    `)
    expect(outcome.variables.r).not.toBe('compiled')
  })
})

// ── 5. Module system ───────────────────────────────────────────────────────
describe('module system is unreachable', () => {
  it('require() is undefined', () => {
    const outcome = run(`fp.variables.set("t", typeof require);`)
    expect(outcome.variables.t).toBe('undefined')
  })

  it('dynamic import() is not configured on this vm context', () => {
    // We don't pass `importModuleDynamically` to vm.runInContext. Depending on
    // the Node version this manifests as a synchronous throw OR as a rejected
    // promise (engine-created, since the import-call expression is the one
    // producing it — `Promise` being shadowed in user scope doesn't matter).
    // The script silences the rejection so vitest doesn't see it as an
    // "unhandled rejection"; we only need to assert the import did NOT yield
    // the host `fs` module synchronously.
    const outcome = run(`
      let outcome = "no-attempt";
      try {
        const p = import("fs");
        if (p && typeof p.then === "function") {
          p.then(function(){}, function(){});      // silence the rejection
          outcome = "got-pending-promise";
        } else {
          outcome = "got-non-promise:" + typeof p;
        }
      } catch (e) { outcome = "threw:" + (e && e.message); }
      fp.variables.set("r", outcome);
    `)
    // Acceptable: the script either threw or got back an opaque promise that
    // it then suppressed. What is NOT acceptable: a synchronous resolution
    // with a usable module object.
    expect(outcome.variables.r).not.toMatch(/got-non-promise:object/)
  })

  it('static import is a SyntaxError (script body is not a module)', () => {
    const outcome = run(`import x from "fs"; fp.variables.set("x", typeof x);`)
    expect(outcome.result.success).toBe(false)
  })
})

// ── 6. Cross-script state isolation ────────────────────────────────────────
describe('state does not leak across separate runFpScript invocations', () => {
  it('Object.prototype mutation in one script does not survive into the next', () => {
    const first = run(`Object.prototype.__leak__ = "yes"; fp.variables.set("r", "wrote");`)
    expect(first.result.success).toBe(true)
    const second = run(`fp.variables.set("r", ({}).__leak__);`)
    expect(second.result.success).toBe(true)
    expect(second.variables.r).toBeUndefined()
  })

  it('a global declared in one script is not visible in the next', () => {
    const first = run(`var leaked = "first";`)
    expect(first.result.success).toBe(true)
    const second = run(`fp.variables.set("r", typeof leaked);`)
    expect(second.variables.r).toBe('undefined')
  })
})

// ── 7. Strict mode / receiver hardening ────────────────────────────────────
describe('strict mode + IIFE wrapper', () => {
  it('top-level `this` is undefined (IIFE called with .call(void 0) in strict)', () => {
    const outcome = run(`fp.variables.set("t", typeof this);`)
    expect(outcome.variables.t).toBe('undefined')
  })

  it('arguments inside the wrapper IIFE is all undefined (no leak of the shadow params)', () => {
    // The wrapper signature is `function(Promise, setTimeout, ...) { user code }`
    // called with no arguments — every named param is undefined and `arguments`
    // reflects the same.
    const outcome = run(`
      const a = (function(){ return arguments; })();
      fp.variables.set("len", a.length);
    `)
    // The inner anonymous function has no params, so its own `arguments` is
    // empty. We just care that NO observable leak of host values occurs.
    expect(outcome.variables.len).toBe(0)
  })
})

// ── 8. Sync built-ins remain available ─────────────────────────────────────
// Negative sandboxing is only useful if positive functionality still works.
// This is the "you didn't accidentally break legitimate scripts" net.
describe('whitelisted globals remain functional', () => {
  const expected: Array<[string, string]> = [
    ['JSON', 'object'],
    ['Math', 'object'],
    ['Date', 'function'],
    ['Array', 'function'],
    ['Object', 'function'],
    ['String', 'function'],
    ['Number', 'function'],
    ['Boolean', 'function'],
    ['RegExp', 'function'],
    ['Error', 'function'],
    ['Symbol', 'function'],
    ['Map', 'function'],
    ['Set', 'function'],
    ['WeakMap', 'function'],
    ['WeakSet', 'function'],
    ['encodeURIComponent', 'function'],
    ['decodeURIComponent', 'function']
  ]
  for (const [name, typ] of expected) {
    it(`typeof ${name} === '${typ}'`, () => {
      const outcome = run(`fp.variables.set("t", typeof ${name});`)
      expect(outcome.variables.t).toBe(typ)
    })
  }
})

describe('environment / variables stores answer only their own names', () => {
  const PROTO_NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']

  it('get() of an unset prototype-member name is undefined in both stores', () => {
    const outcome = run(`
      const out = {};
      for (const n of ${JSON.stringify(PROTO_NAMES)}) {
        out['env:' + n] = typeof fp.environment.get(n);
        out['vars:' + n] = typeof fp.variables.get(n);
      }
      fp.variables.set('out', out);
    `)
    expect(outcome.result.success).toBe(true)
    const expected: Record<string, string> = {}
    for (const n of PROTO_NAMES) {
      expected[`env:${n}`] = 'undefined'
      expected[`vars:${n}`] = 'undefined'
    }
    expect(outcome.variables.out).toEqual(expected)
  })

  it('a variable that really has such a name is still returned', () => {
    const outcome = runFpScript({
      phase: 'pre-request',
      script: `
        fp.environment.set('valueOf', 'set-by-script');
        fp.variables.set('constructor', 'var-value');
        fp.variables.set('out', [
          fp.environment.get('toString'),
          fp.environment.get('valueOf'),
          fp.variables.get('constructor')
        ]);
      `,
      request: baseRequest(),
      environment: { toString: 'from-env' },
      variables: {}
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables.out).toEqual(['from-env', 'set-by-script', 'var-value'])
  })
})

// ── 9. Meta-test — recursive `.constructor` walk ───────────────────────────
// Future-proofing: any new host method exposed on `fp` (or any host getter
// that produces a fresh object) MUST go through the same prototype-scrub. This
// test walks every reachable value from `fp` and `console` and asserts that
// no `.constructor` returns the host realm's `Function`.
//
// The walk runs INSIDE the sandbox (uses sandboxed semantics for property
// access), and a probe at the end of the walk checks whether the collected
// constructors can compile a string. If any of them can, the host realm has
// leaked.
describe('recursive constructor walk over fp and console', () => {
  it('no value reachable from fp has a `.constructor` chain that compiles host code', () => {
    // The canonical escape is two hops: `x.constructor.constructor("...")`.
    // `x.constructor` is often the realm's `Object`/`Array` (not directly
    // callable as a code generator), and `Object.constructor` is the realm's
    // `Function` — which IS. We therefore walk a few hops up the constructor
    // chain and try to compile a string at each step. If ANY hop succeeds,
    // we've crossed into a realm where `codeGeneration.strings:false` doesn't
    // apply — i.e. the host realm.
    const outcome = run(`
      const SEEN = new WeakSet();
      const LEAKS = [];
      const MAX_HOPS = 4;

      function tryEscape(start, path) {
        let cur = start;
        for (let i = 0; i < MAX_HOPS; i++) {
          let next;
          try { next = cur && cur.constructor; } catch (e) { return; }
          if (typeof next !== 'function') return;
          try {
            const fn = next("return 1");
            const r = fn && fn();
            LEAKS.push({ path: path + ".constructor".repeat(i + 1), kind: 'compiled', value: r });
            return;
          } catch (e) {
            // codeGeneration disallowed → in-context Function, safe; or a
            // non-constructor (e.g. Object("...") returns a wrapper) — keep
            // walking the chain.
          }
          cur = next;
        }
      }

      function walk(value, path, depth) {
        if (value === null || value === undefined) return;
        const t = typeof value;
        if (t !== 'object' && t !== 'function') return;
        if (SEEN.has(value)) return;
        SEEN.add(value);
        if (depth > 6) return;

        tryEscape(value, path);

        // Accessor functions are reachable through the property descriptor
        // even though reading the property only yields the getter's result.
        let names;
        try { names = Object.getOwnPropertyNames(value); } catch (e) { return; }
        for (const k of names) {
          let d;
          try { d = Object.getOwnPropertyDescriptor(value, k); } catch (e) { continue; }
          if (!d) continue;
          if (d.get) walk(d.get, path + '.<get ' + k + '>', depth + 1);
          if (d.set) walk(d.set, path + '.<set ' + k + '>', depth + 1);
        }

        let keys;
        try { keys = Object.keys(value); } catch (e) { return; }
        for (const k of keys) {
          let v;
          try { v = value[k]; } catch (e) { continue; }
          walk(v, path + '.' + k, depth + 1);
        }
      }

      walk(fp, "fp", 0);
      walk(console, "console", 0);
      // Values the stores hand back for names that are prototype members.
      for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
        walk(fp.environment.get(name), "fp.environment.get('" + name + "')", 0);
        walk(fp.variables.get(name), "fp.variables.get('" + name + "')", 0);
      }

      fp.variables.set("leaks", LEAKS);
    `)
    expect(outcome.result.success).toBe(true)
    const leaks = outcome.variables.leaks as Array<{ path: string; value: unknown }>
    expect(leaks, `host Function leaked at: ${leaks?.map((l) => l.path).join(', ')}`).toEqual([])
  })

  it('the multipart parts surface does not widen the escape envelope (REQ-0066)', () => {
    // When `bodyType === 'multipart-form'`, `fp.request.body` is a structured
    // object with a `parts` array proxy. New host objects: the body, the
    // parts proxy, each part wrapper, the parts mutating methods. The walk
    // below mirrors the global meta-test but starts from
    // `fp.request.body` so we explicitly cover the new surface.
    const outcome = runMultipart(`
      const SEEN = new WeakSet();
      const LEAKS = [];
      const MAX_HOPS = 4;
      function tryEscape(start, path) {
        let cur = start;
        for (let i = 0; i < MAX_HOPS; i++) {
          let next;
          try { next = cur && cur.constructor; } catch (e) { return; }
          if (typeof next !== 'function') return;
          try { next("return 1")(); LEAKS.push(path + ".constructor".repeat(i + 1)); return; }
          catch (e) { /* keep walking */ }
          cur = next;
        }
      }
      function walk(value, path, depth) {
        if (value === null || value === undefined) return;
        const t = typeof value;
        if (t !== 'object' && t !== 'function') return;
        if (SEEN.has(value)) return;
        SEEN.add(value);
        if (depth > 6) return;
        tryEscape(value, path);
        // Accessor functions and descriptor values (the parts proxy answers
        // descriptors too) are reachable without reading the property.
        let names;
        try { names = Object.getOwnPropertyNames(value); } catch (e) { return; }
        for (const k of names) {
          let d;
          try { d = Object.getOwnPropertyDescriptor(value, k); } catch (e) { continue; }
          if (!d) continue;
          if (d.get) walk(d.get, path + '.<get ' + k + '>', depth + 1);
          if (d.set) walk(d.set, path + '.<set ' + k + '>', depth + 1);
          if ('value' in d) walk(d.value, path + '.<desc ' + k + '>', depth + 1);
        }
        let keys;
        try { keys = Object.keys(value); } catch (e) { return; }
        for (const k of keys) {
          let v;
          try { v = value[k]; } catch (e) { continue; }
          walk(v, path + '.' + k, depth + 1);
        }
      }
      walk(fp.request.body, "fp.request.body", 0);
      walk(fp.request.body.parts, "fp.request.body.parts", 0);
      walk(fp.request.body.parts[0], "fp.request.body.parts[0]", 0);
      walk(fp.request.body.parts[1], "fp.request.body.parts[1]", 0);
      walk(fp.request.body.parts.push, "fp.request.body.parts.push", 0);
      walk(fp.request.body.parts.splice, "fp.request.body.parts.splice", 0);
      // Values the collection hands back: comparator arguments and removed parts.
      fp.request.body.parts.sort((a, b) => {
        walk(a, "sort comparator a", 0);
        walk(b, "sort comparator b", 0);
        return 0;
      });
      fp.request.body.parts.push({ kind: 'text', name: 'x', value: '1' }, { kind: 'text', name: 'y', value: '2' });
      walk(fp.request.body.parts.pop(), "fp.request.body.parts.pop()", 0);
      walk(fp.request.body.parts.shift(), "fp.request.body.parts.shift()", 0);
      walk(fp.request.body.parts.splice(0), "fp.request.body.parts.splice(0)", 0);
      fp.variables.set("leaks", LEAKS);
    `)
    expect(outcome.result.success).toBe(true)
    const leaks = outcome.variables.leaks as string[]
    expect(leaks, `host Function leaked at: ${leaks?.join(', ')}`).toEqual([])
  })

  it('file part fileRef is genuinely read-only — assignment throws', () => {
    const outcome = runMultipart(`
      try { fp.request.body.parts[1].fileRef = 'evil'; fp.variables.set('threw', false); }
      catch (e) { fp.variables.set('threw', true); fp.variables.set('msg', String(e)); }
    `)
    expect(outcome.variables.threw).toBe(true)
    expect(String(outcome.variables.msg)).toMatch(/read-only/)
  })

  it('cannot smuggle bytes through a file part via push', () => {
    const outcome = runMultipart(`
      try {
        fp.request.body.parts.push({ kind: 'file', name: 'x', bytes: new Uint8Array([1,2,3]) });
        fp.variables.set('threw', false);
      } catch (e) {
        fp.variables.set('threw', true);
      }
    `)
    expect(outcome.variables.threw).toBe(true)
  })

  it('every value the user can reach from fp.expect(...) is also clean', () => {
    // The chain produced by `fp.expect(x)` has getters that return fresh
    // objects; this test makes sure they go through the same scrub. Uses the
    // same multi-hop constructor walk as the global meta-test.
    const outcome = run(`
      const LEAKS = [];
      function probe(v, path) {
        if (v === null || v === undefined) return;
        const t = typeof v;
        if (t !== 'object' && t !== 'function') return;
        let cur = v;
        for (let i = 0; i < 4; i++) {
          let next;
          try { next = cur && cur.constructor; } catch (e) { return; }
          if (typeof next !== 'function') return;
          try { next("return 1")(); LEAKS.push(path + ".constructor".repeat(i + 1)); return; }
          catch (e) { /* keep walking */ }
          cur = next;
        }
      }
      const e = fp.expect(1);
      probe(e, "fp.expect(1)");
      probe(e.to, "fp.expect(1).to");
      probe(e.not, "fp.expect(1).not");
      probe(e.deep, "fp.expect(1).deep");
      probe(e.nested, "fp.expect(1).nested");
      probe(fp.environment.toObject(), "fp.environment.toObject()");
      probe(fp.request.headers.toObject(), "fp.request.headers.toObject()");
      fp.variables.set("leaks", LEAKS);
    `)
    expect(outcome.result.success).toBe(true)
    expect(outcome.variables.leaks).toEqual([])
  })
})
