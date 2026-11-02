// Scripting domain — the synchronous `fp` sandbox (node:vm), the pre/post
// script runners, the mini-chai assertion DSL and the XML parser. No Electron,
// no filesystem: pure CPU-bound execution. Threat model: SECURITY.md, "Scope".
export { executePreRequest, executePostResponse } from './script-runner'
export type { ScriptContext, ScriptRunOutcome } from './script-runner'
export { runFpScript, freezeHostSurface } from './fp-sandbox'
export type { FpSandboxInput, FpSandboxOutcome, ScriptPhase } from './fp-sandbox'
export { parseXmlSafe, MAX_XML_BYTES } from './xml-parser'
export type { Xml2JsonOptions } from './xml-parser'
export { AssertionError, createExpect } from './mini-chai'
