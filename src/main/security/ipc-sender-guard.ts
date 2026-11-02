import type { RendererUrlPolicy } from './renderer-origin'

/** The part of an `IpcMainEvent` / `IpcMainInvokeEvent` the guard reads. */
export interface IpcSenderEvent {
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null
}

type Listener = (event: IpcSenderEvent, ...args: unknown[]) => unknown

/** The registration surface of `ipcMain` the guard patches. */
interface GuardableIpc {
  handle(channel: string, listener: Listener): void
  handleOnce(channel: string, listener: Listener): void
  on(channel: string, listener: Listener): unknown
  once(channel: string, listener: Listener): unknown
  addListener(channel: string, listener: Listener): unknown
  removeListener(channel: string, listener: Listener): unknown
  off(channel: string, listener: Listener): unknown
}

const INSTALLED = Symbol.for('fetchpier.ipcSenderGuard')

/**
 * A message is trusted only when it comes from the top-level frame of one of
 * the app's own renderer documents. A disposed frame (`senderFrame` null, or a
 * getter that throws after a navigation) is not trusted.
 */
export function isTrustedSender(event: IpcSenderEvent, isTrustedUrl: RendererUrlPolicy): boolean {
  try {
    const frame = event.senderFrame
    return frame !== null && frame.parent === null && isTrustedUrl(frame.url)
  } catch {
    return false
  }
}

function senderUrl(event: IpcSenderEvent): string {
  try {
    return event.senderFrame?.url ?? '<no frame>'
  } catch {
    return '<disposed frame>'
  }
}

/**
 * Wraps every IPC registration method so each handler and listener — present
 * and future — runs only for a trusted sender. Installed once, before any
 * handler is registered; registering through `ipcMain` is then enough, no
 * per-handler opt-in exists to forget.
 *
 * Untrusted invoke calls reject (the renderer's `invoke` sees the error);
 * untrusted messages are dropped. Both are logged with the channel and the
 * sender's URL only — never the payload.
 */
export function installIpcSenderGuard(ipc: GuardableIpc, isTrustedUrl: RendererUrlPolicy): void {
  const marked = ipc as GuardableIpc & { [INSTALLED]?: true }
  if (marked[INSTALLED]) return
  marked[INSTALLED] = true

  const refuse = (channel: string, event: IpcSenderEvent): void => {
    console.warn(`[ipc] Refused "${channel}" from untrusted sender ${senderUrl(event)}`)
  }

  const guardInvoke =
    (channel: string, listener: Listener): Listener =>
    (event, ...args) => {
      if (!isTrustedSender(event, isTrustedUrl)) {
        refuse(channel, event)
        throw new Error(`Untrusted IPC sender for "${channel}"`)
      }
      return listener(event, ...args)
    }

  // original listener → channel → guarded wrapper, so removeListener/off with
  // the original function still finds what was actually registered.
  const wrappers = new WeakMap<Listener, Map<string, Listener>>()
  const guardMessage = (channel: string, listener: Listener): Listener => {
    let byChannel = wrappers.get(listener)
    if (!byChannel) wrappers.set(listener, (byChannel = new Map()))
    let wrapped = byChannel.get(channel)
    if (!wrapped) {
      wrapped = (event, ...args) => {
        if (!isTrustedSender(event, isTrustedUrl)) return refuse(channel, event)
        return listener(event, ...args)
      }
      byChannel.set(channel, wrapped)
    }
    return wrapped
  }
  const registered = (channel: string, listener: Listener): Listener =>
    wrappers.get(listener)?.get(channel) ?? listener

  const handle = ipc.handle.bind(ipc)
  const handleOnce = ipc.handleOnce.bind(ipc)
  const on = ipc.on.bind(ipc)
  const once = ipc.once.bind(ipc)
  const addListener = ipc.addListener.bind(ipc)
  const removeListener = ipc.removeListener.bind(ipc)
  const off = ipc.off.bind(ipc)

  ipc.handle = (channel, listener) => handle(channel, guardInvoke(channel, listener))
  ipc.handleOnce = (channel, listener) => handleOnce(channel, guardInvoke(channel, listener))
  ipc.on = (channel, listener) => on(channel, guardMessage(channel, listener))
  ipc.once = (channel, listener) => once(channel, guardMessage(channel, listener))
  ipc.addListener = (channel, listener) => addListener(channel, guardMessage(channel, listener))
  ipc.removeListener = (channel, listener) => removeListener(channel, registered(channel, listener))
  ipc.off = (channel, listener) => off(channel, registered(channel, listener))
}
