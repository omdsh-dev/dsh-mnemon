import type { HostAgentContext, HostToolExecutionInput } from './dsh.ts'

type HostTools = NonNullable<HostAgentContext['tools']>
type Outcome = { isError: boolean; error?: { info?: { code?: string } } }

export function usesToolBatchExecution(tools: HostTools): boolean {
  return typeof tools.setExecutor === 'function'
}

export async function executeHostTool(tools: HostTools, input: HostToolExecutionInput): Promise<Outcome> {
  if (tools.execute === undefined) throw new Error('The DSH tool execution service is unavailable')
  if (!usesToolBatchExecution(tools)) return tools.execute(input)
  const batchTools = tools as unknown as {
    execute(input: {
      calls: { type: 'tool-call'; id: string; name: string; arguments: string }[]
      agent?: HostToolExecutionInput['agent']
      signal: AbortSignal
    }): Promise<{ results?: { callId?: string; result?: Outcome }[] } | undefined>
  }
  const batch = await batchTools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    signal: input.signal,
  })
  const results = batch?.results
  const result = results?.[0]
  if (!Array.isArray(results) || results.length !== 1 || result?.callId !== input.callId || typeof result.result?.isError !== 'boolean') {
    throw new Error('The DSH tool batch did not return the requested call outcome')
  }
  return result.result
}
