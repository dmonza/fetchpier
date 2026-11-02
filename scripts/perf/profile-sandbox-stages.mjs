// Profile where runFpScript spends its cold-start time by manually
// reproducing each stage and timing it independently. No tsx/loader needed.
import vm from 'node:vm'

const ALLOWED = [
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
]
const FORBIDDEN = [
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

const userScript = 'fp.environment.set("x", "1");'
const shadowParams = FORBIDDEN.join(', ')
const wrappedScript = `(function(${shadowParams}) { "use strict";\n${userScript}\n}).call(void 0);`
const allowedList = JSON.stringify(ALLOWED)
const isolateScript = `(() => {
  const allowed = new Set(${allowedList});
  const names = Object.getOwnPropertyNames(globalThis);
  for (const name of names) {
    if (!allowed.has(name)) {
      try { delete globalThis[name]; } catch { /* */ }
    }
  }
})();`

const ITER = Number(process.env.ITER ?? 5000)

function time(label, fn) {
  // warmup
  for (let i = 0; i < 200; i++) fn()
  const start = process.hrtime.bigint()
  for (let i = 0; i < ITER; i++) fn()
  const ns = Number(process.hrtime.bigint() - start)
  const per = ns / ITER / 1000 // µs
  console.log(
    `  ${label.padEnd(38)} ${per.toFixed(2).padStart(8)} µs/call   (${(ITER / (ns / 1e9)).toFixed(0)} ops/s)`
  )
  return per
}

console.log(`Per-stage timing over ${ITER} iterations each\n`)

// 1) createContext only
time('createContext', () => {
  const ctx = { fp: {}, console: {} }
  vm.createContext(ctx, { name: 'bench', codeGeneration: { strings: false, wasm: false } })
})

// 2) createContext + isolate globals
time('createContext + isolate-script', () => {
  const ctx = { fp: {}, console: {} }
  vm.createContext(ctx, { name: 'bench', codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(isolateScript, ctx, { filename: 'iso.js' })
})

// 3) createContext + isolate + runInContext(trivial)
time('full cold-start (one user script)', () => {
  const ctx = { fp: buildFp(), console: {} }
  vm.createContext(ctx, { name: 'bench', codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(isolateScript, ctx, { filename: 'iso.js' })
  vm.runInContext(wrappedScript, ctx, { timeout: 5000, filename: 'user.js' })
})

// 4) pre-compiled script; new context each time
const preCompiled = new vm.Script(wrappedScript, { filename: 'user.js' })
const preCompiledIsolate = new vm.Script(isolateScript, { filename: 'iso.js' })
time('new ctx + pre-compiled scripts', () => {
  const ctx = { fp: buildFp(), console: {} }
  vm.createContext(ctx, { name: 'bench', codeGeneration: { strings: false, wasm: false } })
  preCompiledIsolate.runInContext(ctx, { filename: 'iso.js' })
  preCompiled.runInContext(ctx, { timeout: 5000 })
})

// 5) Shared context; recompile each time (shows per-call compile cost)
const sharedCtx = { fp: buildFp(), console: {} }
vm.createContext(sharedCtx, { name: 'shared', codeGeneration: { strings: false, wasm: false } })
vm.runInContext(isolateScript, sharedCtx, { filename: 'iso.js' })
time('shared ctx + runInContext(compile+run)', () => {
  vm.runInContext(wrappedScript, sharedCtx, { timeout: 5000, filename: 'user.js' })
})

// 6) Shared context + pre-compiled — lower bound
time('shared ctx + pre-compiled.runInContext', () => {
  preCompiled.runInContext(sharedCtx, { timeout: 5000 })
})

function buildFp() {
  // Skeleton fp matching surface used by trivial script
  const env = {}
  return {
    environment: {
      set(k, v) {
        env[k] = String(v)
      },
      get(k) {
        return env[k]
      },
      remove(k) {
        delete env[k]
      },
      toObject() {
        return { ...env }
      }
    },
    variables: {
      set() {},
      get() {
        return undefined
      }
    },
    log() {},
    warn() {},
    error() {},
    request: { method: 'GET', url: '/', headers: {}, body: undefined },
    test() {},
    expect() {
      return { toBe() {} }
    }
  }
}
