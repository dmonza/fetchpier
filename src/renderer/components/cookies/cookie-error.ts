/**
 * The text shown for a failed cookie-jar operation. An unreadable jar file is
 * named by the `COOKIE_JAR_UNREADABLE` token its message leads with (the code
 * does not survive IPC as a property) and gets its translated explanation; any
 * other failure keeps its own message.
 */
export function cookieErrorText(err: unknown, t: (key: string) => string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('COOKIE_JAR_UNREADABLE')) return t('cookies.errors.jarUnreadable')
  return msg
}
