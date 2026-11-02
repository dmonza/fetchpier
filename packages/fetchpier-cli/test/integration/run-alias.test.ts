import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Command } from 'commander'

// Capture the options each invocation hands to the engine without running it.
const executeRun = vi.fn().mockResolvedValue({
  summary: { requests: { failed: 0 }, tests: { failed: 0 }, scriptErrors: 0 }
})
vi.mock('../../src/commands/request/run', () => ({
  executeRun: (...a: unknown[]) => executeRun(...a)
}))

// Imported after the mock is registered.
const { registerRequestCommand } = await import('../../src/commands/request')
const { registerRunAlias } = await import('../../src/commands/run')

async function parse(argv: string[]): Promise<unknown> {
  executeRun.mockClear()
  const program = new Command()
  program.exitOverride()
  registerRunAlias(program)
  registerRequestCommand(program)
  await program.parseAsync(['node', 'fp', ...argv])
  return executeRun.mock.calls[0]?.[0]
}

describe('fp run is an alias of fp request run', () => {
  beforeEach(() => executeRun.mockClear())

  it('produces identical run options', async () => {
    const viaAlias = await parse(['run', 'auth/login.http', '--bail', '--env', 'staging'])
    const viaCanonical = await parse([
      'request',
      'run',
      'auth/login.http',
      '--bail',
      '--env',
      'staging'
    ])
    expect(viaAlias).toEqual(viaCanonical)
  })
})
