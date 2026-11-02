/**
 * The matching logic behind the startup-path audit.
 *
 * The audit is what keeps a ~198 ms win from eroding, so its own rules are
 * worth pinning: it has to catch the package, ignore the narrow subpath that
 * exists precisely to avoid it, and never fire on relative imports.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM helper, deliberately outside every tsconfig.
import { DISALLOWED, externalRequires, violationsIn } from './main-cold-path.mjs'

describe('externalRequires', () => {
  it('collects bare specifiers and ignores relative ones', () => {
    const source = `
      const a = require("electron");
      const b = require('./ipc/window.ipc');
      const c = require("../state/store");
      const d = require( "chokidar" );
    `
    expect([...externalRequires(source)].sort()).toEqual(['chokidar', 'electron'])
  })
})

describe('violationsIn', () => {
  it('passes an artifact that requires only permitted modules', () => {
    const source = `require("electron"); require("node:path"); require("@electron-toolkit/utils");`
    expect(violationsIn(source)).toEqual([])
  })

  it('accepts the narrow subpath while rejecting the barrel it stands in for', () => {
    // This distinction is the whole point of the subpath: same package, but the
    // artifact that carries the heavy dependencies is a different one.
    expect(violationsIn(`require("@fetchpier/core/atomic-write");`)).toEqual([])
    expect(violationsIn(`require("@fetchpier/core");`)).toEqual(['@fetchpier/core'])
  })

  it.each(Object.keys(DISALLOWED))('catches %s wherever it appears', (name) => {
    expect(violationsIn(`require("electron");\nrequire("${name}");`)).toEqual([name])
  })

  it('reports every offender, sorted, rather than stopping at the first', () => {
    const source = `require("undici"); require("chokidar"); require("@fetchpier/core");`
    expect(violationsIn(source)).toEqual(['@fetchpier/core', 'chokidar', 'undici'])
  })

  it('explains each disallowed dependency, so a failure is actionable', () => {
    for (const [name, reason] of Object.entries(DISALLOWED)) {
      expect(typeof reason, name).toBe('string')
      expect(reason.length, name).toBeGreaterThan(20)
    }
  })
})
