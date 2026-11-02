/**
 * The packages core resolves at run time through `createRequire`, rather than a
 * static import.
 *
 * The distinction is a packaging contract, not a style preference. A bundler
 * inlines what it can follow; a specifier reached through a require built at run
 * time is opaque to it and survives into the output as a resolution performed on
 * the consumer's disk. So a consumer that **bundles** core — `@fetchpier/cli`
 * does, because core is `private: true` and unresolvable from the registry —
 * inherits the obligation to install these itself. One that **depends** on core
 * normally (the desktop app) gets them transitively and needs to do nothing.
 *
 * That asymmetry is what this list exists to make visible: it is invisible in
 * both manifests, and the failure it produces is silent in the worst way. A
 * missing `libsodium-wrappers` surfaces as `MODULE_NOT_FOUND` inside
 * `verifyKeyAgainstChallenge`, whose `catch` reports it to the user as an
 * invalid workspace key.
 *
 * Deliberately not re-exported from `src/index.ts`: this is a build-time fact
 * for tests and packaging, and routing it through the barrel would carry it into
 * the cold-path bundle for no runtime purpose.
 *
 * Guarded from both ends — see `runtime-dynamic-deps.test.ts` (the list matches
 * the call sites) and `@fetchpier/cli`'s `published-dependencies.test.ts` (the
 * bundling consumer declares every entry).
 */
export const DYNAMIC_RUNTIME_DEPENDENCIES: readonly string[] = ['libsodium-wrappers']
