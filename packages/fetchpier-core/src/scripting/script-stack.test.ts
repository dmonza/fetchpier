import { describe, expect, it } from 'vitest'
import { scriptFileName, scriptOnlyStack } from './script-stack'

const FILE = scriptFileName('post-response')

describe('scriptFileName', () => {
  it('names the wrapped script of each phase', () => {
    expect(scriptFileName('pre-request')).toBe('fp-pre-request-script.js')
    expect(scriptFileName('post-response')).toBe('fp-post-response-script.js')
  })
})

describe('scriptOnlyStack — inclusion filter', () => {
  it('keeps the header and the frames of the script file, drops every host frame', () => {
    const stack = [
      'Error: in f',
      `    at f (${FILE}:2:21)`,
      `    at ${FILE}:3:1`,
      '    at Script.runInContext (node:vm:149:12)',
      '    at runFpScript (/home/dev/app/fp-sandbox.ts:1117:8)',
      '    at C:\\Users\\dev\\app\\main.js:10:3',
      '    at file:///home/dev/node_modules/runner.js:302:11',
      '    at new Promise (<anonymous>)'
    ].join('\n')
    expect(scriptOnlyStack(stack, FILE)).toBe(
      ['Error: in f', `    at f (${FILE}:2:21)`, `    at ${FILE}:3:1`].join('\n')
    )
  })

  it('drops a host frame that comes before the script frame (an fp method threw)', () => {
    const stack = [
      'Error: fp.response.json(): body is not valid JSON',
      '    at Object.json (/home/dev/app/fp-sandbox.ts:934:17)',
      `    at ${FILE}:2:13`
    ].join('\n')
    expect(scriptOnlyStack(stack, FILE)).toBe(
      ['Error: fp.response.json(): body is not valid JSON', `    at ${FILE}:2:13`].join('\n')
    )
  })

  it('keeps a displayErrors header that names the script file', () => {
    const stack = [
      `${FILE}:2`,
      'let x = ;',
      '        ^',
      '',
      "SyntaxError: Unexpected token ';'",
      '    at new Script (node:vm:117:7)',
      '    at runFpScript (/home/dev/app/fp-sandbox.ts:1117:8)'
    ].join('\n')
    expect(scriptOnlyStack(stack, FILE)).toBe(
      [`${FILE}:2`, 'let x = ;', '        ^', '', "SyntaxError: Unexpected token ';'"].join('\n')
    )
  })

  it('drops a displayErrors header that names a host file and quotes host source', () => {
    const stack = [
      '/home/dev/app/fp-sandbox.ts:625',
      '          throw new Error(`fp.response.json(): body is not valid JSON`)',
      '          ^',
      '',
      'Error: fp.response.json(): body is not valid JSON',
      '    at Object.json (/home/dev/app/fp-sandbox.ts:934:17)',
      `    at ${FILE}:2:13`
    ].join('\n')
    expect(scriptOnlyStack(stack, FILE)).toBe(
      ['Error: fp.response.json(): body is not valid JSON', `    at ${FILE}:2:13`].join('\n')
    )
  })

  it('drops a host displayErrors header that has no caret line', () => {
    const stack = [
      'C:\\dev\\app\\host.js:7',
      'throw boom',
      '',
      'Error: boom',
      `    at ${FILE}:1:1`
    ].join('\n')
    expect(scriptOnlyStack(stack, FILE)).toBe(['Error: boom', `    at ${FILE}:1:1`].join('\n'))
  })

  it("drops the other phase's frames", () => {
    const stack = ['Error: x', '    at fp-pre-request-script.js:2:1', `    at ${FILE}:2:1`].join(
      '\n'
    )
    expect(scriptOnlyStack(stack, FILE)).toBe(['Error: x', `    at ${FILE}:2:1`].join('\n'))
  })

  it('does not take a host path that ends in the script name for the script file', () => {
    const stack = ['Error: x', `    at g (/home/dev/${FILE}:2:1)`, `    at /tmp/${FILE}:3:1`].join(
      '\n'
    )
    expect(scriptOnlyStack(stack, FILE)).toBe('Error: x')
  })

  it('keeps a multi-line message whole', () => {
    const stack = ['Error: first line', 'second line', `    at ${FILE}:4:2`].join('\n')
    expect(scriptOnlyStack(stack, FILE)).toBe(stack)
  })

  it('reduces a stack with no script frame to its header (a timeout)', () => {
    const stack = [
      'Error: Script execution timed out after 50ms',
      '    at Script.runInContext (node:vm:149:12)',
      '    at runFpScript (/home/dev/app/fp-sandbox.ts:1117:8)'
    ].join('\n')
    expect(scriptOnlyStack(stack, FILE)).toBe('Error: Script execution timed out after 50ms')
  })

  it('leaves a stack with no frames as it is', () => {
    expect(scriptOnlyStack('Error: only a header', FILE)).toBe('Error: only a header')
  })
})
