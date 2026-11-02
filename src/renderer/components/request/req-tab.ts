import type { RequestEditorTab } from '@shared/types'

/**
 * The most relevant sub-tab to show the first time a request is opened, derived
 * from its method: methods that carry a payload open on Body, the rest on Params.
 * Only used as a fallback — once the user picks a tab it is persisted per request
 * (via `useUiStateStore`) and takes precedence.
 */
export function defaultReqTabForMethod(method: string): RequestEditorTab {
  const m = method.toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' ? 'body' : 'params'
}
