#!/usr/bin/env node
// Minimal V8 .cpuprofile analyzer — lists hottest frames by self + total time.
// Usage: node scripts/perf/analyze-cpuprof.mjs <file.cpuprofile> [topN]
import { readFileSync } from 'node:fs'

const [, , file, topStr] = process.argv
if (!file) {
  console.error('usage: node analyze-cpuprof.mjs <file.cpuprofile> [topN]')
  process.exit(1)
}
const top = Number(topStr ?? 25)
const prof = JSON.parse(readFileSync(file, 'utf8'))

const byId = new Map()
for (const n of prof.nodes) byId.set(n.id, n)

// timeDeltas[i] is the delta *before* samples[i] (V8 format)
const selfUs = new Map() // nodeId -> self time in us
for (let i = 0; i < prof.samples.length; i++) {
  const id = prof.samples[i]
  const delta = prof.timeDeltas[i] ?? 0
  selfUs.set(id, (selfUs.get(id) ?? 0) + delta)
}

// Compute totals by walking children
const childrenOf = new Map()
for (const n of prof.nodes) {
  for (const c of n.children ?? []) {
    if (!childrenOf.has(c)) childrenOf.set(c, [])
  }
}

function totalUs(id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id)
  memo.set(id, 0) // cycle guard
  let sum = selfUs.get(id) ?? 0
  const node = byId.get(id)
  for (const c of node?.children ?? []) sum += totalUs(c, memo)
  memo.set(id, sum)
  return sum
}

const memo = new Map()
const rows = []
for (const n of prof.nodes) {
  const self = selfUs.get(n.id) ?? 0
  if (self === 0 && !n.children?.length) continue
  rows.push({
    id: n.id,
    name: n.callFrame.functionName || '(anonymous)',
    url: (n.callFrame.url || '').replace(/^file:\/\/\//, '').replace(/\\/g, '/'),
    line: n.callFrame.lineNumber,
    self,
    total: totalUs(n.id, memo)
  })
}

rows.sort((a, b) => b.self - a.self)
const totalSampled = prof.samples.reduce((s, _, i) => s + (prof.timeDeltas[i] ?? 0), 0)

console.log(`Profile: ${file}`)
console.log(`Total sampled time: ${(totalSampled / 1000).toFixed(1)} ms`)
console.log(`Samples: ${prof.samples.length}   Nodes: ${prof.nodes.length}\n`)
console.log('Top by SELF time:')
console.log('  self ms   total ms  frame')
for (const r of rows.slice(0, top)) {
  const loc = r.url ? `  [${shortPath(r.url)}:${r.line + 1}]` : ''
  console.log(
    `  ${(r.self / 1000).toFixed(2).padStart(7)}  ${(r.total / 1000).toFixed(2).padStart(8)}  ${r.name}${loc}`
  )
}

function shortPath(p) {
  // strip leading workspace path (handles both legacy and current repo folder names)
  for (const marker of ['fetchpier/', 'open-rest-client/']) {
    const idx = p.indexOf(marker)
    if (idx >= 0) return p.slice(idx + marker.length)
  }
  return p
}
