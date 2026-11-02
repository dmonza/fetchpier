import { describe, it, expect } from 'vitest'

import { installPermissionPolicy, isPermissionGranted, type PermissionSession } from './permissions'

const TRUSTED = 'file:///app/out/renderer/index.html'
const UNTRUSTED = 'https://example.com/'
const isTrustedUrl = (url: string): boolean => url === TRUSTED

describe('isPermissionGranted', () => {
  it.each(['clipboard-read', 'clipboard-sanitized-write'])(
    'grants %s to an app document',
    (permission) => {
      expect(isPermissionGranted(permission, TRUSTED, isTrustedUrl)).toBe(true)
    }
  )

  it.each(['clipboard-read', 'clipboard-sanitized-write'])(
    'refuses %s to a document that is not the app',
    (permission) => {
      expect(isPermissionGranted(permission, UNTRUSTED, isTrustedUrl)).toBe(false)
      expect(isPermissionGranted(permission, undefined, isTrustedUrl)).toBe(false)
    }
  )

  it.each([
    'notifications',
    'media',
    'geolocation',
    'display-capture',
    'openExternal',
    'fullscreen',
    'pointerLock',
    'hid',
    'serial',
    'usb',
    'fileSystem',
    'unknown'
  ])('refuses %s even to an app document', (permission) => {
    expect(isPermissionGranted(permission, TRUSTED, isTrustedUrl)).toBe(false)
  })
})

describe('installPermissionPolicy', () => {
  type Handlers = {
    request?: Parameters<PermissionSession['setPermissionRequestHandler']>[0]
    check?: Parameters<PermissionSession['setPermissionCheckHandler']>[0]
    device?: Parameters<PermissionSession['setDevicePermissionHandler']>[0]
  }

  function install(): Handlers {
    const handlers: Handlers = {}
    const session = {
      setPermissionRequestHandler: (h: Handlers['request']) => void (handlers.request = h),
      setPermissionCheckHandler: (h: Handlers['check']) => void (handlers.check = h),
      setDevicePermissionHandler: (h: Handlers['device']) => void (handlers.device = h)
    } as unknown as PermissionSession
    installPermissionPolicy(session, isTrustedUrl)
    return handlers
  }

  const webContents = (url: string): never => ({ getURL: () => url }) as never

  function request(handlers: Handlers, permission: string, url: string): boolean {
    let decision: boolean | undefined
    handlers.request!(
      webContents(url),
      permission as never,
      (granted: boolean) => {
        decision = granted
      },
      { requestingUrl: url } as never
    )
    if (decision === undefined) throw new Error('request handler never answered')
    return decision
  }

  it('answers permission requests with the policy', () => {
    const handlers = install()
    expect(request(handlers, 'clipboard-sanitized-write', TRUSTED)).toBe(true)
    expect(request(handlers, 'clipboard-read', UNTRUSTED)).toBe(false)
    expect(request(handlers, 'notifications', TRUSTED)).toBe(false)
  })

  it('answers permission checks with the policy, including checks with no webContents', () => {
    const handlers = install()
    expect(handlers.check!(webContents(TRUSTED), 'clipboard-read', 'file://', {} as never)).toBe(
      true
    )
    expect(
      handlers.check!(null, 'clipboard-read', 'file://', { requestingUrl: TRUSTED } as never)
    ).toBe(true)
    expect(handlers.check!(null, 'clipboard-read', 'file://', {} as never)).toBe(false)
    expect(handlers.check!(webContents(TRUSTED), 'media', 'file://', {} as never)).toBe(false)
  })

  it('denies every device permission (HID, serial, USB)', () => {
    const handlers = install()
    expect(handlers.device!({ deviceType: 'hid', origin: 'file://' } as never)).toBe(false)
  })
})
