import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'
import { nativeSkillPorts } from '../src/skill-dsh.ts'
const scope = { storage: 'custom' as const, workspaceId: '/workspace', sessionId: 'session' }
const signal = new AbortController().signal
const check = { label: 'Validate resources', command: 'node --test tests/check.mjs' }
it('uses the actual native foreground outcome and preserves the current agent scope', async () => {
  const agent = { options: {} }, execute = vi.fn(), adapter = { live: vi.fn().mockResolvedValue(agent) } as unknown as DshWorkspaceAdapter
  const ctx = { tools: { schemas: () => [{ name: 'bash' }], execute } } as unknown as Context
  const ports = nativeSkillPorts(ctx, adapter)
  for (const [result, status] of [
    [{ value: { kind: 'foreground', exitCode: 0, stdout: { text: 'Actual checks passed' } }, content: [] }, 'passed'],
    [{ value: { kind: 'foreground', exitCode: 1 }, content: [] }, 'failed'],
    [{ value: { kind: 'foreground', exitCode: 0, timedOut: true }, content: [] }, 'failed'],
    [{ value: { kind: 'foreground', exitCode: 0, aborted: true }, content: [] }, 'cancelled'],
    [{ value: { kind: 'foreground', exitCode: 0, sandbox: { denied: true } }, content: [] }, 'failed'],
    [{ value: { kind: 'background' }, content: [] }, 'failed'],
    [{ value: null, content: [] }, 'failed'],
    [{ isError: true, content: [{ type: 'text', text: 'Native policy denied this command' }] }, 'blocked'],
  ] as const) {
    execute.mockResolvedValue(result)
    expect((await ports.validate!(scope, '/private/check-copy', check, signal)).status).toBe(status)
  }
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'bash', agent, signal, arguments: expect.objectContaining({ workdir: '/private/check-copy', command: check.command }) }))
  const cancelled = new AbortController()
  execute.mockImplementation(async () => { cancelled.abort(); return { isError: true, content: [{ type: 'text', text: 'Cancelled' }] } })
  expect(await ports.validate!(scope, '/private/check-copy', check, cancelled.signal)).toMatchObject({ status: 'cancelled', exitCode: null })
})
it('requires the nested bash result through the native PTC transport and removes its listener', async () => {
  const stop = vi.fn(), agent = { options: {} }, adapter = { live: async () => agent } as unknown as DshWorkspaceAdapter
  let listener: (exec: { rootCallId: string; name: string }, result: unknown) => void
  const execute = vi.fn().mockImplementation(async args => { listener({ rootCallId: args.callId, name: 'bash' }, { value: { kind: 'foreground', exitCode: 7, stderr: { text: 'Assertion failed' } }, content: [] }); return { value: { output: 'outer transport completed' }, content: [] } })
  const ctx = { tools: { schemas: () => [{ name: 'run_code' }], get: () => ({}), execute }, get: () => ({ language: 'typescript' }), on: (_event: string, handler: typeof listener) => { listener = handler; return stop } } as unknown as Context
  expect(await nativeSkillPorts(ctx, adapter).validate!(scope, '/private/check-copy', check, signal)).toMatchObject({ status: 'failed', exitCode: 7, output: 'Assertion failed' })
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'run_code', agent, signal }))
  expect(stop).toHaveBeenCalledOnce()
})
