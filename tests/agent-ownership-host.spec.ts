import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { expect, it, vi } from 'vitest'
import type { HostAgent, HostContextShape, HostSubagentRun } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { LiveMnemonRuntime } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { startGuardedReview } from '../src/host/review-tools.ts'
import { startSubagent } from '../src/host/subagent-start.ts'
import { startWithContinuationTurns } from '../src/host/continuation-turn.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'
import { memoryGraphFixture } from './helpers/memory-graph.ts'

async function fixture(provider: 'spawn' | 'fork', hold: boolean | ((options: GenerateOptions) => boolean) = false, answer = false, providerName = provider as string) {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-ownership-host-'))
  const ctx = new Context()
  const memory = memoryGraphFixture()
  const runtime = new LiveMnemonRuntime(memory.graph, undefined, undefined, memory.extensions)
  let modelCalls = 0, toolTurns = 0, allowedCalls = 0, outsideCalls = 0
  class Model extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      modelCalls++
      if (JSON.stringify(options.messages).includes('Perform a synthetic review.')) {
        expect(JSON.stringify(options.messages.filter(message => message.role === 'system'))).toContain('Synthetic isolated reviewer.')
      }
      if (typeof hold === 'function' ? hold(options) : hold) await new Promise<void>((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        if (options.signal?.aborted) reject(options.signal.reason)
      })
      const modelTurn = ++toolTurns
      const name = answer ? 'mnemon_subagent_result' : modelTurn === 1 ? 'outside' : modelTurn === 2 ? 'allowed' : undefined
      if (name !== undefined) {
        const id = `ownership-${modelCalls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
        const requestId = JSON.stringify(options.messages.filter(message => message.role === 'system')).match(/requestId `([^`]+)`/u)?.[1]
        const args = answer ? JSON.stringify({ requestId, result: { answer: 'Synthetic answer.', citations: [] } }) : '{}'
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Synthetic review complete.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic review complete.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await loadTools(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await loadWorkingDirectory(ctx)
  await ctx.plugin(SubagentRuntime)
  const providerFiber = await ctx.plugin(await import(requireDsh.resolve(`@deepseek-ai/dsh-subagent-${provider}-in-process`)), { providerName })
  ctx.llm.registerAdapter(['fixture'], new Model())
  for (const name of ['allowed', 'outside']) ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] }, async execute() {
    if (name === 'allowed') allowedCalls++; else outsideCalls++
    return {}
  } })
  const host = ctx as unknown as HostContextShape
  const parent = await ctx.agentLoop.create(SessionId('ownership-parent'), { provider: 'fixture', model: 'synthetic' }, { cwd: directory })
  const coordinator = new MnemonSubagentCoordinator(host.subagents, runtime, host)
  const lifecycle = new MnemonLifecycle(host, coordinator, memory.graph.config, runtime)
  let stop: (() => void) | undefined
  const children: HostAgent[] = []
  ctx.on('agent/created', ({ agent }) => { if (agent.id !== parent.id) children.push(agent as unknown as HostAgent); return undefined })
  const begin = () => { stop = lifecycle.start(); return stop }
  const start = (signal = new AbortController().signal, creator = parent as unknown as HostAgent) => startGuardedReview(host, creator, ['allowed'], () => startWithContinuationTurns(host, creator, () => startSubagent(host.subagents, host.agents, provider, {
    parent: creator, label: 'Synthetic ownership review', prompt: [{ type: 'text', text: 'Perform a synthetic review.' }], signal,
    toolFilter: { allow: ['allowed'] }, persona: 'Synthetic isolated reviewer.',
  }, host)))
  return { ctx, host, parent, coordinator, lifecycle, runtime, memory, children, begin, start, providerFiber, counts: () => ({ modelCalls, allowedCalls, outsideCalls }), async close() {
    stop?.(); coordinator.dispose(); runtime.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true })
  } }
}

it.each(['spawn', 'fork'] as const)('adopts roots and runs an isolated guarded %s child using real Host ownership', async provider => {
  const f = await fixture(provider)
  try {
    f.begin()
    expect(f.lifecycle.snapshot().activeAgents).toBe(1)
    const fresh = await f.ctx.agentLoop.create(SessionId('ownership-new-root'), { provider: 'fixture', model: 'synthetic' })
    expect(f.lifecycle.snapshot().activeAgents).toBe(2)
    const run = await f.start()
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(f.counts()).toEqual({ modelCalls: 3, allowedCalls: 1, outsideCalls: 0 })
    expect(f.lifecycle.snapshot().activeAgents).toBe(2)
    await run.dispose()
    expect(f.host.agents.get(run.id)).toBeUndefined()
    expect(f.memory.views.activeTurn(run.id)).toBeUndefined()
    await fresh.ctx.fiber.dispose()
  } finally { await f.close() }
})

it('guards a real nested creator before work, while the production coordinator rejects its depth', async () => {
  const f = await fixture('spawn', options => JSON.stringify(options.messages).includes('Hold the synthetic creator.'))
  let creator: HostSubagentRun | undefined, nested: HostSubagentRun | undefined
  try {
    f.begin()
    creator = await startSubagent(f.host.subagents, f.host.agents, 'spawn', {
      parent: f.parent as unknown as HostAgent, label: 'Synthetic resident creator',
      prompt: [{ type: 'text', text: 'Hold the synthetic creator.' }], signal: new AbortController().signal,
    }, f.host)
    await vi.waitFor(() => expect(f.counts().modelCalls).toBe(1))
    const parent = f.host.agents.get(creator.id)!
    const childCount = f.children.length
    await expect(f.coordinator.answer(parent, 'Synthetic question', [], new AbortController().signal)).rejects.toThrow(/depth/iu)
    expect(f.children).toHaveLength(childCount)
    expect(f.counts().modelCalls).toBe(1)
    // The internal adapter also preserves direct-creator ownership when a
    // caller explicitly permits deeper delegation than the coordinator does.
    nested = await f.start(new AbortController().signal, parent)
    await nested.result
    expect(f.counts()).toEqual({ modelCalls: 4, allowedCalls: 1, outsideCalls: 0 })
    await nested.dispose()
    expect(f.host.agents.get(nested.id)).toBeUndefined()
  } finally { await nested?.dispose(); await creator?.dispose(); await f.close() }
})

it.each(['spawn', 'fork'] as const)('stops a running %s child on abort and releases its memory pin', async provider => {
  const f = await fixture(provider, true)
  const controller = new AbortController()
  let run: HostSubagentRun | undefined
  try {
    f.begin()
    run = await f.start(controller.signal)
    await vi.waitFor(() => expect(f.counts().modelCalls).toBe(1))
    expect(f.memory.views.activeTurn(run.id)).toBeDefined()
    controller.abort(new Error('Synthetic cancellation'))
    await run.result
    await run.dispose()
    expect(f.host.agents.get(run.id)).toBeUndefined()
    expect(f.memory.views.activeTurn(run.id)).toBeUndefined()
    expect(f.counts().allowedCalls).toBe(0)
  } finally { await run?.dispose(); await f.close() }
})

it.each((['spawn', 'fork'] as const).flatMap(provider => (['guard', 'section'] as const).map(failure => ({ provider, failure }))))('admits no prompt or model call when $provider publication $failure fails', async ({ provider, failure }) => {
  const f = await fixture(provider)
  try {
    f.begin()
    if (failure === 'section') {
      const original = SystemPrompt.prototype.section
      vi.spyOn(SystemPrompt.prototype, 'section').mockImplementation(function (this: SystemPrompt, options) {
        if (options.text === 'Synthetic isolated reviewer.') throw new Error('Synthetic publication failure')
        return original.call(this, options)
      })
    } else f.ctx.on('agent/created', ({ agent }) => {
      vi.spyOn(agent.ctx.tools, 'guard').mockImplementation(() => { throw new Error('Synthetic publication failure') })
      return undefined
    }, { prepend: true })
    await expect(f.start()).rejects.toThrow('Synthetic publication failure')
    expect(f.counts()).toEqual({ modelCalls: 0, allowedCalls: 0, outsideCalls: 0 })
    expect(f.children.every(child => f.host.agents.get(child.id) === undefined)).toBe(true)
    for (const child of f.children) {
      expect(child.session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
      expect(f.memory.views.activeTurn(child.id)).toBeUndefined()
    }
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('selects the official spawn provider and records the coordinator result on the running Host', async () => {
  const f = await fixture('spawn', false, true)
  try {
    f.begin()
    const result = await f.coordinator.answer(f.parent as unknown as HostAgent, 'Synthetic question', [], new AbortController().signal)
    expect(result).toMatchObject({ answer: 'Synthetic answer.', citations: [], delegation: { provider: 'spawn' } })
    expect(f.counts().modelCalls).toBe(1)
    expect(f.host.agents.get(result.delegation.runId)).toBeUndefined()
  } finally { await f.close() }
})

it('discovers a preloaded custom provider after Mnemon recreation and configuration changes on the real Host', async () => {
  const f = await fixture('spawn', false, true, 'preloaded-local')
  let coordinator = f.coordinator
  const ask = () => coordinator.answer(f.parent as unknown as HostAgent, 'Synthetic question', [], new AbortController().signal)
  try {
    f.begin()
    await expect(ask()).resolves.toMatchObject({ answer: 'Synthetic answer.', delegation: { provider: 'preloaded-local' } })
    coordinator.dispose()
    coordinator = new MnemonSubagentCoordinator(f.host.subagents, f.runtime, f.host)
    await expect(ask()).resolves.toMatchObject({ delegation: { provider: 'preloaded-local' } })
    await f.providerFiber.update({ providerName: 'renamed-local' })
    // Older Cordis update() schedules its reload but returns void.
    await f.providerFiber.await()
    await expect(ask()).resolves.toMatchObject({ delegation: { provider: 'renamed-local' } })
    await f.providerFiber.dispose()
    await expect(ask()).rejects.toThrow('requires a non-inheriting DSH subagent provider')
    expect(f.counts().modelCalls).toBe(3)
  } finally { coordinator.dispose(); await f.close() }
})
