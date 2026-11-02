import { promises as fs } from 'node:fs'
import { X509Certificate, createPrivateKey } from 'node:crypto'

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** Wraps a node:crypto error so callers can surface a clean message to the UI. */
export class TlsImportError extends Error {
  constructor(
    public readonly reason: string,
    cause?: unknown
  ) {
    super(reason)
    this.name = 'TlsImportError'
    if (cause instanceof Error) this.cause = cause
  }
}

export interface ImportedFile {
  content: Buffer
  /** Useful for the import flow: number of CERTIFICATE blocks found in a PEM bundle (1 for keys, 1+ for CA bundles). */
  certCount?: number
}

/**
 * Read and validate a PEM-encoded certificate (single or bundle).
 * Accepts files containing one or more `-----BEGIN CERTIFICATE-----` blocks
 * and validates each via X509Certificate (which throws on garbage).
 */
export async function readPemCertFile(sourcePath: string): Promise<ImportedFile> {
  const content = await fs.readFile(sourcePath)
  const text = content.toString('utf-8')
  const blocks = text.match(PEM_CERT_RE)
  if (!blocks || blocks.length === 0) {
    throw new TlsImportError('No PEM CERTIFICATE block found in file')
  }
  for (const block of blocks) {
    try {
      new X509Certificate(block)
    } catch (err) {
      throw new TlsImportError('Invalid PEM certificate block', err)
    }
  }
  return { content, certCount: blocks.length }
}

/**
 * Read and validate a PEM-encoded private key. Accepts both unencrypted and
 * passphrase-protected keys; we do not try the passphrase at import time.
 */
export async function readPemKeyFile(sourcePath: string): Promise<ImportedFile> {
  const content = await fs.readFile(sourcePath)
  const text = content.toString('utf-8')
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    throw new TlsImportError('File does not contain a PEM PRIVATE KEY block')
  }
  // Try to parse without a passphrase. Unencrypted-but-invalid keys throw here;
  // encrypted keys also throw (OpenSSL has no passphrase to prompt with), and
  // we tolerate that — the real check happens at TLS handshake.
  try {
    createPrivateKey({ key: content, format: 'pem' })
  } catch (err) {
    if (!looksLikeEncryptedKeyError(err) && !isEncryptedKeyMaterial(text)) {
      throw new TlsImportError('Invalid PEM key', err)
    }
  }
  return { content }
}

function isEncryptedKeyMaterial(text: string): boolean {
  // RFC 1421/5958 markers for encrypted private keys.
  return /-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text) || /Proc-Type:\s*4,ENCRYPTED/.test(text)
}

function looksLikeEncryptedKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const message = err.message
  // Different OpenSSL versions surface "missing passphrase" differently.
  return (
    /passphrase|encrypted|bad decrypt|interrupted or cancelled/i.test(message) ||
    (err as NodeJS.ErrnoException).code === 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED' ||
    (err as NodeJS.ErrnoException).code === 'ERR_OSSL_PEM_BAD_PASSWORD_READ' ||
    (err as NodeJS.ErrnoException).code === 'ERR_MISSING_PASSPHRASE'
  )
}

/**
 * Read and structurally validate a PKCS#12 (.pfx / .p12) file.
 * We only check that the file is non-empty and begins with a DER SEQUENCE tag (0x30).
 * The passphrase is NOT tried at import time — it is verified at TLS handshake.
 */
export async function readPfxFile(sourcePath: string): Promise<ImportedFile> {
  const content = await fs.readFile(sourcePath)
  if (content.length < 2) {
    throw new TlsImportError('PFX file is empty or truncated')
  }
  if (content[0] !== 0x30) {
    throw new TlsImportError(
      'PFX file does not begin with a DER SEQUENCE tag (not a valid PKCS#12)'
    )
  }
  return { content }
}
