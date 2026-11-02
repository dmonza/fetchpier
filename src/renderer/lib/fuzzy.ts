/**
 * Subsequence fuzzy match: returns true when every character of `query`
 * appears in `text` in order (case-insensitive). Empty query matches
 * everything. Used by the command palette and the staged-file picker so
 * filtering feels the same across the app.
 */
export function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true
  const lText = text.toLowerCase()
  const lQuery = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < lText.length && qi < lQuery.length; i++) {
    if (lText[i] === lQuery[qi]) qi++
  }
  return qi === lQuery.length
}
