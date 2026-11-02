import { request } from 'undici'
import semver from 'semver'
import type { UpdateCheckResponse, UpdateCheckErrorKind } from '../../shared/types'

const PRODUCTS_URL = 'https://public.sincrum.com/products.json'
const PRODUCT_NAME = 'fetchpier'
const FETCH_TIMEOUT_MS = 8000

interface ProductEntry {
  name: string
  version: string
}

function isProductEntry(value: unknown): value is ProductEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.version === 'string'
}

function extractProducts(parsed: unknown): ProductEntry[] | null {
  if (!parsed || typeof parsed !== 'object') return null
  const products = (parsed as Record<string, unknown>).products
  if (!Array.isArray(products)) return null
  const out: ProductEntry[] = []
  for (const item of products) {
    if (!isProductEntry(item)) return null
    out.push(item)
  }
  return out
}

function fail(errorKind: UpdateCheckErrorKind, message?: string): UpdateCheckResponse {
  return { ok: false, errorKind, message }
}

/**
 * Fetches the remote product catalogue and determines whether a newer
 * version of Fetchpier is available. Defensive — every failure mode
 * maps to a typed `UpdateCheckErrorKind`.
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  // Egress goes through `undici` (REQ-0061 network egress invariant): the same
  // HTTP stack `@fetchpier/core` uses for user requests, never Node's global
  // `fetch`. `request` does not throw on non-2xx — it returns `statusCode`.
  let response: Awaited<ReturnType<typeof request>>
  try {
    response = await request(PRODUCTS_URL, { signal: controller.signal })
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') {
      return fail('timeout')
    }
    return fail('network', err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    // Drain the body so the socket can be released back to the pool.
    await response.body.dump().catch(() => undefined)
    return fail('network', `HTTP ${response.statusCode}`)
  }

  let raw: string
  try {
    raw = await response.body.text()
  } catch (err) {
    return fail('network', err instanceof Error ? err.message : String(err))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('invalid-json', 'Response body is not valid JSON')
  }

  const products = extractProducts(parsed)
  if (!products) return fail('invalid-json', 'Unexpected schema for products.json')

  const match = products.find((p) => p.name.toLowerCase() === PRODUCT_NAME)
  if (!match) return fail('product-not-found')

  const publishedVersion = match.version.trim()
  if (!semver.valid(publishedVersion)) return fail('invalid-version', publishedVersion)

  const fetchedAt = new Date().toISOString()
  const normalizedCurrent = semver.valid(currentVersion.trim())
  if (!normalizedCurrent) {
    return {
      ok: true,
      data: {
        currentVersion,
        publishedVersion,
        isNewer: true,
        fetchedAt
      }
    }
  }

  return {
    ok: true,
    data: {
      currentVersion: normalizedCurrent,
      publishedVersion,
      isNewer: semver.gt(publishedVersion, normalizedCurrent),
      fetchedAt
    }
  }
}
