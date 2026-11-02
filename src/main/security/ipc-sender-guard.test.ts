import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { installIpcSenderGuard, isTrustedSender, type IpcSenderEvent } from './ipc-sender-guard'

const TRUSTED = 'file:///app/out/renderer/index.html'
const isTrustedUrl = (url: string): boolean => url === TRUSTED

type Listener = (event: IpcSenderEvent, ...args: unknown[]) => unknown

/** Just enough of `ipcMain`: an EventEmitter plus the invoke-handler registry. */
class FakeIpcMain extends EventEmitter {
  private readonly handlers = new Map<string, Listener>()
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener)
  }
  handleOnce(channel: string, listener: Listener): void {
    this.handlers.set(channel, (event, ...args) => {
      this.handlers.delete(channel)
      return listener(event, ...args)
    })
  }
  async invoke(channel: string, event: IpcSenderEvent, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler(event, ...args)
  }
}

const topFrame = (url: string): IpcSenderEvent => ({ senderFrame: { url, parent: null } })
const subFrame = (url: string): IpcSenderEvent => ({
  senderFrame: { url, parent: { url: TRUSTED } }
})
const noFrame: IpcSenderEvent = { senderFrame: null }

let ipc: FakeIpcMain
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ipc = new FakeIpcMain()
  installIpcSenderGuard(ipc, isTrustedUrl)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

describe('isTrustedSender', () => {
  it('trusts the top-level frame of an app document only', () => {
    expect(isTrustedSender(topFrame(TRUSTED), isTrustedUrl)).toBe(true)
    expect(isTrustedSender(topFrame('https://example.com/'), isTrustedUrl)).toBe(false)
    expect(isTrustedSender(subFrame(TRUSTED), isTrustedUrl)).toBe(false)
    expect(isTrustedSender(noFrame, isTrustedUrl)).toBe(false)
  })

  it('treats a frame that throws on access as untrusted', () => {
    const event = {
      get senderFrame(): never {
        throw new Error('Render frame was disposed')
      }
    } as IpcSenderEvent
    expect(isTrustedSender(event, isTrustedUrl)).toBe(false)
  })
})

describe('installIpcSenderGuard — invoke handlers', () => {
  it('passes arguments and the return value through for a trusted sender', async () => {
    ipc.handle('demo:echo', (_event, a, b) => `${a}-${b}`)
    await expect(ipc.invoke('demo:echo', topFrame(TRUSTED), 'x', 2)).resolves.toBe('x-2')
  })

  it.each([
    ['a foreign document', topFrame('https://example.com/')],
    ['a sub-frame of an app document', subFrame(TRUSTED)],
    ['a sender whose frame is gone', noFrame]
  ])('rejects %s without running the handler', async (_label, event) => {
    const handler = vi.fn()
    ipc.handle('demo:secret', handler)
    await expect(ipc.invoke('demo:secret', event)).rejects.toThrow(
      'Untrusted IPC sender for "demo:secret"'
    )
    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('guards handleOnce the same way', async () => {
    const handler = vi.fn(() => 'ok')
    ipc.handleOnce('demo:once', handler)
    await expect(ipc.invoke('demo:once', topFrame('https://example.com/'))).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('installIpcSenderGuard — message listeners', () => {
  it.each(['on', 'addListener', 'once'] as const)(
    '%s delivers to a trusted sender and drops an untrusted one',
    (method) => {
      const listener = vi.fn()
      ipc[method]('demo:msg', listener)
      ipc.emit('demo:msg', topFrame('https://example.com/'), 'nope')
      expect(listener).not.toHaveBeenCalled()
      ipc.emit('demo:msg', topFrame(TRUSTED), 'yes')
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(topFrame(TRUSTED), 'yes')
    }
  )

  it.each(['removeListener', 'off'] as const)(
    '%s with the original listener removes the guarded one',
    (method) => {
      const listener = vi.fn()
      ipc.on('demo:msg', listener)
      ipc[method]('demo:msg', listener)
      expect(ipc.listenerCount('demo:msg')).toBe(0)
    }
  )
})

describe('installIpcSenderGuard — installation', () => {
  it('is idempotent: a second install does not wrap twice', async () => {
    installIpcSenderGuard(ipc, isTrustedUrl)
    ipc.handle('demo:x', () => 'ok')
    await expect(ipc.invoke('demo:x', noFrame)).rejects.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
