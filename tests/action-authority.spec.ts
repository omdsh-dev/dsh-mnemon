import { describe, expect, it, vi } from 'vitest'
import { authorizeMemoryAction } from '../src/host/action-authority.ts'
import type { HostAgent, ToolExecution } from '../src/host/dsh.ts'
import type { MemoryActionOffer } from '../src/core/contracts/index.ts'
const offer: MemoryActionOffer = { id: 'source:jobs/run-job', sourceInstanceKey: 'source:jobs', sourceActionId: 'run-job', description: 'Run the displayed reviewed execution plan.', capability: 'write', inputSchema: {}, authority: 'process-execution' }
const execution = (): ToolExecution => ({ signal: new AbortController().signal, name: 'mnemon_view_action', callId: 'call-1', agent: { id: 'session-1' } as HostAgent })
describe('external action authorization', () => {
  it('denies absent authority channels, agentless requests and every non-grant', async () => {
    expect(await authorizeMemoryAction({ get: () => undefined }, offer, execution(), () => true)).toBe(false)
    const request = vi.fn(async () => 'allowed-once')
    expect(await authorizeMemoryAction({ get: () => ({ request }) }, offer, { signal: new AbortController().signal }, () => true)).toBe(false)
    expect(request).not.toHaveBeenCalled()
    for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allow']) expect(await authorizeMemoryAction({ get: () => ({ request: async () => outcome }) }, offer, execution(), () => true)).toBe(false)
  })
  it('binds each approval to the displayed call and rechecks cancellation and live write policy', async () => {
    const request = vi.fn(async () => 'allowed-once'), exec = execution()
    expect(await authorizeMemoryAction({ get: () => ({ request }) }, offer, exec, () => true)).toBe(true)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ agent: exec.agent, callId: 'call-1', toolName: 'mnemon_view_action', signal: exec.signal, reason: expect.stringContaining('process-execution') }))
    let writable = true
    expect(await authorizeMemoryAction({ get: () => ({ request: async () => { writable = false; return 'allowed-once' } }) }, offer, exec, () => writable)).toBe(false)
    const controller = new AbortController()
    await expect(authorizeMemoryAction({ get: () => ({ request: async () => { controller.abort(); return 'allowed-once' } }) }, offer, { ...exec, signal: controller.signal }, () => true)).rejects.toThrow()
  })
})
