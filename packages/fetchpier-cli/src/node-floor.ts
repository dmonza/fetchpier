import { EXIT } from './exit-codes'

/**
 * Minimum Node.js the CLI supports, kept equal to `engines.node` in this
 * package's `package.json` by `node-floor.test.ts`.
 *
 * The number comes from `undici` (declared `engines.node: >=22.19.0`), which is
 * the request engine underneath `@fetchpier/core` — not from Electron, which
 * asks for far less and is absent from the CLI anyway.
 *
 * `engines` alone does not enforce anything: without `engine-strict` npm prints
 * an `EBADENGINE` warning and installs regardless. For a globally installed
 * binary that means the first symptom of an unsupported runtime is a stack
 * trace from inside a dependency, naming neither Node nor Fetchpier. This
 * module turns that into one sentence, before any work happens.
 *
 * It must stay import-light and side-effect-ordered first (see `fp.ts`): the
 * bundle's `require("undici")` runs at load time, so anything that would break
 * on an old runtime breaks before `main()` is reached.
 */
export const NODE_FLOOR = '22.19.0'

/** `[major, minor, patch]`, or `null` if the string is not a version we understand. */
function parse(version: string): [number, number, number] | null {
  // A nightly reports `25.0.0-nightly2026…`; the prerelease tag says nothing
  // about API availability here, so compare the numeric core and ignore it.
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return null

  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * The message to print when `version` is below {@link NODE_FLOOR}, or an empty
 * string when the runtime is fine.
 *
 * A version string that cannot be parsed is treated as fine: refusing to start
 * over a string this code failed to understand would be worse than letting the
 * run reach a real error.
 */
export function unsupportedNodeMessage(version: string): string {
  const actual = parse(version)
  const floor = parse(NODE_FLOOR)
  if (!actual || !floor) return ''

  for (let i = 0; i < 3; i++) {
    if (actual[i] > floor[i]) return ''
    if (actual[i] < floor[i]) {
      return (
        `fp requires Node.js ${NODE_FLOOR} or newer, but this is Node.js ${version}.\n` +
        `  Upgrade Node.js, or run fp under a newer one (nvm, fnm, volta).\n` +
        `  https://fetchpier.com`
      )
    }
  }

  return ''
}

const message = unsupportedNodeMessage(process.versions.node)
if (message) {
  process.stderr.write(`${message}\n`)
  process.exit(EXIT.UNSUPPORTED_NODE)
}
