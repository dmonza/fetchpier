/**
 * Deterministic, non-cryptographic 64-bit string hash (cyrb64).
 *
 * Used for cheap change-detection (e.g. "does the current request content differ
 * from its saved baseline?"). It is **not** a security primitive: it defends
 * against accidental drift, not adversarial collisions. The 64-bit width keeps
 * the per-comparison collision probability negligible for a single pairwise
 * check, which is all the dirty-state model performs.
 *
 * Output: a fixed 16-character lowercase hex string (two 32-bit halves), stable
 * across runs and platforms for the same input.
 */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const hi = (h2 >>> 0).toString(16).padStart(8, '0')
  const lo = (h1 >>> 0).toString(16).padStart(8, '0')
  return hi + lo
}
