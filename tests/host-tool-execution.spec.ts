import { describe, expect, it } from 'vitest'
import type { HostAgent, HostAgentContext, HostToolExecutionInput } from '../src/host/dsh.ts'
import { executeHostTool, usesToolBatchExecution } from '../src/host/tool-execution.ts'

type HostTools = NonNullable<HostAgentContext['tools']>
const input: HostToolExecutionInput = {
  callId: 'synthetic-admission', name: 'mnemon_subagent_result', arguments: { requestId: 'synthetic-challenge', result: {} },
  agent: { id: 'synthetic-parent' } as HostAgent, signal: new AbortController().signal,
}
function batchHost(execute: (input: unknown) => Promise<unknown>): HostTools {
  return { setExecutor: () => undefined, execute: execute as NonNullable<HostTools['execute']> }
}

describe('Host tool execution contracts', () => {
  it('uses the legacy contract once and keeps its owning service receiver', async () => {
    let received: unknown
    const result = { isError: false }
    const tools: HostTools = { async execute(value) { expect(this).toBe(tools); received = value; return result } }
    expect(usesToolBatchExecution(tools)).toBe(false)
    expect(await executeHostTool(tools, input)).toBe(result)
    expect(received).toBe(input)
  })

  it.each([false, true])('retains the matching authoritative batch outcome (isError=%s)', async isError => {
    const received: unknown[] = []
    const result = { isError }
    const tools = batchHost(async function (this: HostTools, value) {
      expect(this).toBe(tools)
      received.push(value)
      return { results: [{ callId: input.callId, result }], additionalContexts: [], concluded: false }
    })
    expect(usesToolBatchExecution(tools)).toBe(true)
    expect(await executeHostTool(tools, input)).toBe(result)
    expect(received).toEqual([{
      calls: [{ type: 'tool-call', id: 'synthetic-admission', name: 'mnemon_subagent_result', arguments: '{"requestId":"synthetic-challenge","result":{}}' }],
      agent: input.agent, signal: input.signal,
    }])
  })

  it.each([
    undefined,
    { results: [] },
    { results: [{ callId: 'foreign-call', result: { isError: false } }] },
    { results: [{ callId: input.callId, result: { isError: false } }, { callId: input.callId, result: { isError: true } }] },
    { results: [{ callId: input.callId, result: {} }] },
    { results: { length: 1, 0: { callId: input.callId, result: { isError: false } } } },
  ])('rejects malformed batch outcomes without another dispatch: %j', async outcome => {
    let calls = 0
    const tools = batchHost(async () => { calls++; return outcome })
    await expect(executeHostTool(tools, input)).rejects.toThrow('did not return the requested call outcome')
    expect(calls).toBe(1)
  })

  it('preserves executor failures without trying another input shape', async () => {
    const failure = new Error('Synthetic executor failure after dispatch')
    let calls = 0
    const tools = batchHost(async () => { calls++; throw failure })
    await expect(executeHostTool(tools, input)).rejects.toBe(failure)
    expect(calls).toBe(1)
  })

  it('rejects an unavailable tool execution service', async () => {
    await expect(executeHostTool({}, input)).rejects.toThrow('unavailable')
  })
})
