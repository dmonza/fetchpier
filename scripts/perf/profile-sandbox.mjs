// CPU profiling harness for runFpScript cold-start.
// Node 24+ executes TypeScript directly via type-stripping.
// Run with:
//   node --cpu-prof --cpu-prof-dir=coverage/perf/profiles scripts/perf/profile-sandbox.mjs
import { runFpScript } from '../../src/main/scripting/fp-sandbox.ts'

const baseRequest = {
  method: 'GET',
  url: 'https://api.example.com/users/1',
  headers: { 'Content-Type': 'application/json' }
}

const trivialScript = 'fp.environment.set("x", "1");'
const ITERATIONS = Number(process.env.ITER ?? 20000)

// Warmup — let V8 optimise
for (let i = 0; i < 500; i++) {
  runFpScript({
    phase: 'pre-request',
    script: trivialScript,
    request: baseRequest,
    environment: {},
    variables: {}
  })
}

console.log(`Running trivial sandbox ${ITERATIONS} times…`)
const start = performance.now()
for (let i = 0; i < ITERATIONS; i++) {
  runFpScript({
    phase: 'pre-request',
    script: trivialScript,
    request: baseRequest,
    environment: {},
    variables: {}
  })
}
const elapsed = performance.now() - start
console.log(
  `total ${elapsed.toFixed(1)} ms — ${(elapsed / ITERATIONS).toFixed(3)} ms/call — ${(
    (ITERATIONS / elapsed) *
    1000
  ).toFixed(0)} ops/sec`
)
