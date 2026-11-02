// Escaping helpers shared by the XML and HTML reporters. Response bodies and
// test messages may contain `<`, `&`, quotes, etc.; both reporters embed
// untrusted text, so escaping is a correctness AND a safety requirement.

/** Escape text for an XML/HTML text node. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape text for a double-quoted XML/HTML attribute value. */
export function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Escape text destined for an HTML text node (same rules as XML text). */
export const escapeHtml = escapeXml
