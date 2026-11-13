type Translate = (key: string, opts?: Record<string, unknown>) => string

/** Electron's `Error invoking remote method '<channel>': ` and the error class. */
const REMOTE_PREFIX = /^Error invoking remote method '[^']*': /
const CLASS_PREFIX = /^[A-Za-z]*Error: /

/** What follows `CODE: ` in the message, or `''`. */
function detailAfter(msg: string, code: string): string {
  const at = msg.indexOf(code)
  return msg.slice(at + code.length).replace(/^:\s*/, '')
}

/**
 * The text shown for a failed schema import. Each reason the import throws is
 * named by the code its message leads with (only the message crosses IPC), so
 * it is matched as a token and gets its translated message; any other failure
 * gets a translated generic message with the bare detail (never Electron's IPC
 * prefix or the error class).
 */
export function schemaImportErrorText(err: unknown, t: Translate): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('ENVIRONMENT_NAME_CONFLICT')) {
    const occupant = /environment "([^"]*)"/.exec(msg)?.[1] ?? ''
    return t('environment.errors.folderConflict', { name: occupant })
  }
  if (msg.includes('ENVIRONMENT_NAME_EMPTY')) return t('environment.errors.nameEmpty')
  if (msg.includes('TARGET_EXISTS')) {
    const name = /"([^"]*)"/.exec(detailAfter(msg, 'TARGET_EXISTS'))?.[1] ?? ''
    return t('schemaImport.errors.targetExists', { name })
  }
  if (msg.includes('FETCH_FAILED')) {
    return t('schemaImport.errors.fetchFailed', { detail: detailAfter(msg, 'FETCH_FAILED') })
  }
  if (msg.includes('FORMAT_UNDETECTED')) return t('schemaImport.errors.formatUndetected')
  if (msg.includes('PARSE_FAILED')) {
    return t('schemaImport.errors.parseFailed', { detail: detailAfter(msg, 'PARSE_FAILED') })
  }
  const message = msg.replace(REMOTE_PREFIX, '').replace(CLASS_PREFIX, '')
  // A file-system failure (writer or loader) leads with its Node code and
  // carries an absolute path: show the code only, in the user's language.
  const fsCode = /^(E[A-Z0-9]{2,}): /.exec(message)?.[1]
  if (fsCode) return t('schemaImport.errors.writeFailed', { code: fsCode })
  return t('schemaImport.errors.importFailed', { message })
}
