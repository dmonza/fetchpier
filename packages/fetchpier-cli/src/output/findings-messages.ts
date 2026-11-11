// English texts of the passive security findings rules, for the terminal and the
// HTML report. The engine returns rule ids only; the desktop has its own two
// locales. Same meaning on both surfaces; a completeness test pins the table to
// the catalog. No text states a verdict about the endpoint.

export interface FindingMessage {
  title: string
  rationale: string
  reference: string
}

export const FINDING_MESSAGES: Readonly<Record<string, FindingMessage>> = {
  'transport.plaintext': {
    title: 'Response received over plain HTTP',
    rationale: 'Anyone on the network path can read or alter this traffic.',
    reference: 'OWASP Transport Layer Security Cheat Sheet'
  },
  'transport.plaintext-credentials': {
    title: 'Credentials sent over plain HTTP',
    rationale: 'The credential travelled unencrypted and can be captured on the network path.',
    reference: 'OWASP Transport Layer Security Cheat Sheet'
  },
  'transport.https-downgrade': {
    title: 'Redirect moved the exchange to plain HTTP',
    rationale:
      'A server sent an encrypted request on to an unencrypted URL; what follows can be read or altered on the network path.',
    reference: 'OWASP Transport Layer Security Cheat Sheet; RFC 6797'
  },
  'tls.verification-disabled': {
    title: 'Certificate verification is turned off',
    rationale: "The server's identity was not checked; an impostor would have been accepted.",
    reference: 'RFC 9525; RFC 5280'
  },
  'tls.untrusted-certificate': {
    title: 'Server certificate is not trusted',
    rationale:
      'The certificate failed verification; the connection went ahead only because verification is off.',
    reference: 'RFC 5280 §6'
  },
  'tls.legacy-protocol': {
    title: 'Legacy TLS protocol negotiated',
    rationale: 'Versions older than TLS 1.2 are deprecated and have known weaknesses.',
    reference: 'RFC 8996'
  },
  'tls.non-aead-cipher': {
    title: 'Non-AEAD cipher negotiated',
    rationale:
      'CBC, RC4, 3DES and NULL ciphers lack authenticated encryption and have practical attacks.',
    reference: 'RFC 9325 §4.2'
  },
  'tls.no-forward-secrecy': {
    title: 'No forward secrecy',
    rationale:
      "A static RSA key exchange lets anyone who later obtains the server's key decrypt recorded traffic.",
    reference: 'RFC 9325 §7.3; NIST SP 800-52 Rev. 2'
  },
  'tls.certificate-expired': {
    title: 'Server certificate has expired',
    rationale: 'Clients that verify certificates refuse this connection.',
    reference: 'RFC 5280 §4.1.2.5'
  },
  'tls.certificate-expiring': {
    title: 'Server certificate expires soon',
    rationale: 'Renew it before clients start refusing the connection.',
    reference: 'RFC 5280 §4.1.2.5'
  },
  'tls.weak-key': {
    title: 'Weak certificate key',
    rationale:
      'RSA and DSA keys under 2048 bits, and EC keys under 256 bits, are below current minimums.',
    reference: 'NIST SP 800-57 Part 1'
  },
  'headers.hsts-missing': {
    title: 'Strict-Transport-Security is missing',
    rationale: 'Browsers may fall back to plain HTTP on a later visit.',
    reference: 'RFC 6797'
  },
  'headers.hsts-short-max-age': {
    title: 'Strict-Transport-Security max-age is short',
    rationale: 'A max-age under 180 days leaves a window in which browsers forget the policy.',
    reference: 'RFC 6797 §6.1.1; OWASP HTTP Headers Cheat Sheet'
  },
  'headers.nosniff-missing': {
    title: 'X-Content-Type-Options: nosniff is missing',
    rationale: 'Browsers may guess a different content type than the one declared.',
    reference: 'WHATWG Fetch Standard (X-Content-Type-Options)'
  },
  'headers.csp-missing': {
    title: 'Content-Security-Policy is missing',
    rationale: "Without a policy, an injected script runs with the page's full privileges.",
    reference: 'W3C Content Security Policy Level 3'
  },
  'headers.frame-protection-missing': {
    title: 'No framing protection',
    rationale: 'Another site can embed the page, which enables clickjacking.',
    reference: 'RFC 7034; CSP frame-ancestors'
  },
  'headers.cors-wildcard-credentials': {
    title: 'Wildcard CORS with credentials',
    rationale:
      'Allow-Origin * together with Allow-Credentials true is a contradiction browsers reject; it signals an over-broad policy.',
    reference: 'WHATWG Fetch Standard (CORS protocol)'
  },
  'headers.cors-reflected-origin': {
    title: 'CORS reflects the request Origin with credentials',
    rationale: 'Echoing any Origin with credentials lets any site read authenticated responses.',
    reference: 'OWASP Web Security Testing Guide: Cross-Origin Resource Sharing'
  },
  'headers.cors-null-origin': {
    title: 'CORS allows the null origin',
    rationale:
      'Sandboxed documents and some redirects carry the null origin, so allowing it allows any site that can produce it.',
    reference:
      'WHATWG Fetch Standard (CORS protocol); OWASP Web Security Testing Guide: Cross-Origin Resource Sharing'
  },
  'headers.version-disclosure': {
    title: 'Server software version disclosed',
    rationale: 'Version banners help match the server against known vulnerabilities.',
    reference: 'OWASP Web Security Testing Guide: Fingerprint Web Server'
  },
  'cookies.missing-secure': {
    title: 'Cookie set without Secure',
    rationale: 'Without the Secure attribute the browser also sends it over plain HTTP.',
    reference: 'RFC 6265 §4.1.2.5'
  },
  'cookies.missing-httponly': {
    title: 'Cookie set without HttpOnly',
    rationale: 'Page scripts can read it, so an injected script could steal it.',
    reference: 'RFC 6265 §4.1.2.6'
  },
  'auth.credentials-in-query': {
    title: 'Credential in the query string',
    rationale: 'URLs end up in logs, browser history and Referer headers.',
    reference: 'OWASP REST Security Cheat Sheet'
  },
  'cache.sensitive-cacheable': {
    title: 'Authenticated response may be cached',
    rationale: 'Without no-store or private, a shared cache may keep it and serve it to others.',
    reference: 'RFC 9111 §5.2.2'
  },
  'cache.set-cookie-cacheable': {
    title: 'Response that sets a cookie is cacheable by shared caches',
    rationale:
      "A shared cache may store the response, Set-Cookie included, and hand one user's cookie to others.",
    reference: 'RFC 9111 §5.2.2; RFC 6265'
  }
}

/** The texts of a rule; an id this version does not know reads as itself. */
export function findingMessage(ruleId: string): FindingMessage {
  return FINDING_MESSAGES[ruleId] ?? { title: ruleId, rationale: '', reference: '' }
}
