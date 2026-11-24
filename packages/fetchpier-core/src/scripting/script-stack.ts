/**
 * Stack traces a script produces, reduced to the script's own lines.
 *
 * A V8 stack from the sandbox mixes the user's script (`fp-<phase>-script.js`)
 * with host frames: `node:vm`, the engine's own files and whatever called it,
 * named by absolute path. Those paths and, for an error a host `fp` method threw,
 * the `displayErrors` header quoting a line of host source must not reach the
 * console, the CLI or a run file. The filter is an inclusion filter: only what is
 * known to be the script survives.
 */

/** The file name the vm gives the wrapped script of `phase`. */
export function scriptFileName(phase: 'pre-request' | 'post-response'): string {
  return `fp-${phase}-script.js`
}

const FRAME = /^\s+at /

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Keep, from `stack`: the `displayErrors` header (`<file>:<line>`, the source
 * line, the caret line, a blank line) only when it names `fileName`; the error's
 * own header (`Name: message`, every line of the message); and only the `at`
 * frames located in `fileName`. Everything else is dropped.
 */
export function scriptOnlyStack(stack: string, fileName: string): string {
  const file = escapeRegExp(fileName)
  const scriptLocation = new RegExp(`^${file}:\\d+$`)
  const scriptFrame = new RegExp(`^\\s+at (?:.*\\()?${file}:\\d+:\\d+\\)?$`)
  const lines = stack.split('\n')
  const kept: string[] = []
  let start = 0
  // Node prepends `<file>:<line>\n<source>\n[<caret>\n]\n` to an error that
  // leaves `runInContext` with `displayErrors`: a location line, then a blank
  // line at index 2 (no caret) or 3.
  const blank = lines.indexOf('')
  if ((blank === 2 || blank === 3) && /:\d+$/.test(lines[0] ?? '')) {
    if (scriptLocation.test(lines[0] ?? '')) kept.push(...lines.slice(0, blank + 1))
    start = blank + 1
  }
  let inFrames = false
  for (const line of lines.slice(start)) {
    if (FRAME.test(line)) {
      inFrames = true
      if (scriptFrame.test(line)) kept.push(line)
    } else if (!inFrames) {
      kept.push(line)
    }
  }
  return kept.join('\n')
}
