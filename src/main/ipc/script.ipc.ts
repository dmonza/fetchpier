import { ipcMain } from 'electron'
import type { HttpRequest, HttpResponse, ScriptExecutionResult } from '../../shared/types'
import { executePreRequest, executePostResponse } from '../scripting/script-runner'

interface PreRequestArgs {
  script: string
  request: HttpRequest
  environment?: Record<string, string>
  variables?: Record<string, unknown>
}

interface PostResponseArgs {
  script: string
  request: HttpRequest
  response: HttpResponse
  environment?: Record<string, string>
  variables?: Record<string, unknown>
}

export function registerScriptHandlers(): void {
  ipcMain.handle(
    'script:execute-pre-request',
    async (_event, args: PreRequestArgs): Promise<ScriptExecutionResult> => {
      const outcome = executePreRequest(args.script, {
        request: args.request,
        environment: args.environment ?? {},
        variables: args.variables ?? {}
      })
      return outcome.result
    }
  )

  ipcMain.handle(
    'script:execute-post-response',
    async (_event, args: PostResponseArgs): Promise<ScriptExecutionResult> => {
      const outcome = executePostResponse(args.script, {
        request: args.request,
        response: args.response,
        environment: args.environment ?? {},
        variables: args.variables ?? {}
      })
      return outcome.result
    }
  )
}
