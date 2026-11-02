import type { HttpRequest, HttpResponse, ScriptExecutionResult } from '@shared/types'
import { runFpScript } from './fp-sandbox'

export interface ScriptContext {
  request: HttpRequest
  response?: HttpResponse
  environment: Record<string, string>
  variables: Record<string, unknown>
}

export interface ScriptRunOutcome {
  result: ScriptExecutionResult
  request: HttpRequest
  environment: Record<string, string>
  variables: Record<string, unknown>
}

export function executePreRequest(
  script: string,
  context: ScriptContext,
  timeoutMs?: number
): ScriptRunOutcome {
  const outcome = runFpScript({
    phase: 'pre-request',
    script,
    request: context.request,
    environment: context.environment,
    variables: context.variables,
    timeoutMs
  })
  return {
    result: outcome.result,
    request: outcome.request,
    environment: outcome.environment,
    variables: outcome.variables
  }
}

export function executePostResponse(
  script: string,
  context: ScriptContext,
  timeoutMs?: number
): ScriptRunOutcome {
  const outcome = runFpScript({
    phase: 'post-response',
    script,
    request: context.request,
    response: context.response,
    environment: context.environment,
    variables: context.variables,
    timeoutMs
  })
  return {
    result: outcome.result,
    request: outcome.request,
    environment: outcome.environment,
    variables: outcome.variables
  }
}
