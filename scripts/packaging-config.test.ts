import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import yaml from 'js-yaml'

// Coverage for the macOS signing inputs declared in `electron-builder.yml`
// (CI-004).
//
// The risk this guards is narrow and was real: `electron-builder.yml` named two
// entitlements documents that did not exist in the repository, and nothing
// noticed. Unsigned builds never resolve those paths — `findSigningIdentity`
// returns null and signing is skipped — so the gap is invisible until the first
// machine with a signing certificate in its keychain runs `package:mac`, which
// then fails inside `@electron/osx-sign`. The whole defect class is "a config
// key points at a path nobody ships", and nothing linked the two.
//
// Two deliberate shapes here:
//
//  - Everything is driven off the entitlements-bearing keys the config ACTUALLY
//    declares, never off two hardcoded paths. Adding `entitlementsLoginHelper`
//    tomorrow puts it under the same assertions with no edit to this file —
//    which is the point, since pinning literals would only guard today's two
//    instances of a class defect.
//  - Filesystem and parsing only. This runs on the Windows dev box and the
//    Linux CI runner, where `codesign` does not exist. Verifying an actual
//    signature is the manual macOS check, not this.

const REPO_ROOT = resolve(__dirname, '..')

// Not this project's invention: these are exactly the three keys in
// `app-builder-lib/templates/entitlements.mac.plist`, the file electron-builder
// signs with when the config does NOT override the path. `allow-jit` and
// `allow-unsigned-executable-memory` are what V8 needs under hardened runtime;
// `disable-library-validation` is what lets the Helper apps and the Electron
// framework load, and electron-builder warns it is required whenever hardened
// runtime is combined with ad-hoc signing (MacTargetHelper.js).
const REQUIRED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
]

// Permits a debugger to attach. Apple's notary service rejects any submission
// that carries it — a failure that only surfaces after a full upload, which is
// why it is cheaper to assert here.
const FORBIDDEN_ENTITLEMENTS = ['com.apple.security.get-task-allow']

// Every `mac:` key that can name an entitlements document, and the filename
// electron-builder would auto-discover in `directories.buildResources` for it.
// `entitlementsLoginHelper` has no auto-discovered name: `getOptionsForFile`
// reads it from the config or not at all.
const ENTITLEMENT_KEYS: ReadonlyArray<{ key: string; conventionalName?: string }> = [
  { key: 'entitlements', conventionalName: 'entitlements.mac.plist' },
  { key: 'entitlementsInherit', conventionalName: 'entitlements.mac.inherit.plist' },
  { key: 'entitlementsLoginHelper' }
]

interface BuilderConfig {
  directories?: { buildResources?: string }
  mac?: Record<string, unknown>
  asar?: unknown
  electronFuses?: Record<string, unknown>
}

const config = yaml.load(
  readFileSync(resolve(REPO_ROOT, 'electron-builder.yml'), 'utf8')
) as BuilderConfig

const mac = config.mac ?? {}
const buildResourcesDir = resolve(REPO_ROOT, config.directories?.buildResources ?? 'build')

const declared = ENTITLEMENT_KEYS.filter(({ key }) => typeof mac[key] === 'string').map(
  (entry) => ({ ...entry, declaredPath: mac[entry.key] as string })
)

/**
 * Reads the subset of the plist grammar these documents use and returns the
 * boolean each key is set to. Throws on anything it does not recognize, so a
 * malformed document fails here rather than inside `codesign` — a missing file
 * produces a clear error, a malformed one does not.
 */
const readEntitlements = (filePath: string): Map<string, boolean> => {
  const raw = readFileSync(filePath, 'utf8')

  if (!/^\s*<\?xml version="1\.0" encoding="UTF-8"\?>/.test(raw)) {
    throw new Error(`${filePath}: missing the XML declaration`)
  }
  if (!raw.includes('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"')) {
    throw new Error(`${filePath}: missing the PLIST 1.0 doctype`)
  }

  const dict = /<plist version="1\.0">\s*<dict>([\s\S]*?)<\/dict>\s*<\/plist>\s*$/.exec(raw)
  if (dict === null) {
    throw new Error(`${filePath}: expected a single <dict> inside <plist version="1.0">`)
  }

  const entitlements = new Map<string, boolean>()
  // Strip comments first so a commented-out key never reads as granted.
  let body = dict[1].replace(/<!--[\s\S]*?-->/g, '')

  while (body.trim() !== '') {
    const pair = /^\s*<key>([^<]+)<\/key>\s*<(true|false)\/>/.exec(body)
    if (pair === null) {
      throw new Error(`${filePath}: unparsable entitlement near ${JSON.stringify(body.trim())}`)
    }
    entitlements.set(pair[1], pair[2] === 'true')
    body = body.slice(pair[0].length)
  }

  return entitlements
}

describe('macOS entitlements declared by electron-builder.yml', () => {
  // Guards the reverse drift of the original defect: deleting a config key
  // rather than the file it names. Without this, dropping both keys would empty
  // `declared` and every case below would vacuously pass.
  it('names an entitlements document for the app bundle and for the inherited processes', () => {
    expect(declared.map(({ key }) => key)).toEqual(
      expect.arrayContaining(['entitlements', 'entitlementsInherit'])
    )
  })

  // The entitlements are inert without it: electron-builder only applies them
  // when it signs, and the relaxations they grant only mean anything under the
  // hardened runtime. Flipping this off would quietly make every case below a
  // statement about a file nothing reads.
  it('keeps hardened runtime on, which is what makes the entitlements load-bearing', () => {
    expect(mac.hardenedRuntime).toBe(true)
  })

  for (const { key, conventionalName, declaredPath } of declared) {
    describe(`mac.${key} → ${declaredPath}`, () => {
      const absolutePath = resolve(REPO_ROOT, declaredPath)

      it('resolves to a well-formed entitlements document', () => {
        expect(existsSync(absolutePath), `${declaredPath} does not exist`).toBe(true)
        expect(() => readEntitlements(absolutePath)).not.toThrow()
      })

      it('grants the hardened-runtime entitlements Electron needs to launch', () => {
        const entitlements = readEntitlements(absolutePath)
        for (const entitlement of REQUIRED_ENTITLEMENTS) {
          expect(
            entitlements.get(entitlement),
            `${declaredPath} does not grant ${entitlement}`
          ).toBe(true)
        }
      })

      it('withholds the entitlements that would block notarization', () => {
        const entitlements = readEntitlements(absolutePath)
        for (const entitlement of FORBIDDEN_ENTITLEMENTS) {
          expect(entitlements.get(entitlement), `${declaredPath} grants ${entitlement}`).not.toBe(
            true
          )
        }
      })

      // Two mechanisms can name these files — the explicit config key and
      // auto-discovery from `directories.buildResources`. They must not be able
      // to disagree, or the repository ends up with a plist that looks adopted
      // and is never read.
      it('sits where electron-builder would have discovered it anyway', () => {
        expect(resolve(dirname(absolutePath))).toBe(buildResourcesDir)
        if (conventionalName !== undefined) {
          expect(basename(absolutePath)).toBe(conventionalName)
        }
      })
    })
  }
})

// CI-006 — the Electron fuses the packaged binary is flipped with. Fuses are
// compiled into the executable at package time, so nothing at runtime or in the
// e2e suite (which launches the development Electron binary) would notice one
// silently reverting. electron-builder also ignores an unknown key without a
// word, so a misspelled fuse would ship the insecure default.
const EXPECTED_FUSES: Readonly<Record<string, boolean>> = {
  // A copy of the signed binary must not double as a general-purpose Node.
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  // Only a validated app.asar may be loaded — no loose `app/` folder beside it.
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  enableCookieEncryption: true,
  // Stays on while the renderer is served from file:// — turning it off
  // requires serving the renderer from a custom protocol first.
  grantFileProtocolExtraPrivileges: true
}

// Every key `FuseOptionsV1` accepts in electron-builder 26.
const KNOWN_FUSE_KEYS = new Set([
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
  'resetAdHocDarwinSignature'
])

describe('Electron fuses declared by electron-builder.yml', () => {
  const fuses = config.electronFuses ?? {}

  it('flips every hardening fuse to the agreed value', () => {
    expect(fuses).toMatchObject(EXPECTED_FUSES)
  })

  it('declares only fuse names electron-builder recognizes', () => {
    const unknown = Object.keys(fuses).filter((key) => !KNOWN_FUSE_KEYS.has(key))
    expect(unknown, `unrecognized fuse keys would be ignored: ${unknown.join(', ')}`).toEqual([])
  })

  // `onlyLoadAppFromAsar` with no asar archive is an app that cannot start.
  it('keeps the app packaged as an asar archive', () => {
    expect(config.asar).not.toBe(false)
  })
})
