import type { HostAgentContext, HostToolExecutionInput } from './dsh.ts'

type HostTools = NonNullable<HostAgentContext['tools']>
type Outcome = { isError: boolean }

/** DSH 0.2.2 exposes executor registration and batch dispatch together. */
export function usesToolBatchExecution(tools: HostTools): boolean {
  return typeof tools.setExecutor === 'function'
}

/** Preserve the Host's scoped executor, guards, policy and final result for one call. */
export async function executeHostTool(tools: HostTools, input: HostToolExecutionInput): Promise<Outcome> {
  if (tools.execute === undefined) throw new Error('The DSH tool execution service is unavailable')
  if (!usesToolBatchExecution(tools)) return tools.execute(input)
  const batchTools = tools as unknown as {
    execute(input: {
      calls: { type: 'tool-call'; id: string; name: string; arguments: string }[]
      agent: HostToolExecutionInput['agent']
      signal: AbortSignal
    }): Promise<{ results?: { callId?: string; result?: Outcome }[] } | undefined>
  }
  const batch = await batchTools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    agent: input.agent,
    signal: input.signal,
  })
  // No synthetic model-step log is supplied. PTC can still write its own audit
  // events, so admission must remain inside the real turn and await this drain.
  const results = batch?.results
  const result = results?.[0]
  if (!Array.isArray(results) || results.length !== 1 || result?.callId !== input.callId || typeof result.result?.isError !== 'boolean') {
    throw new Error('The DSH tool batch did not return the requested call outcome')
  }
  return result.result
}
