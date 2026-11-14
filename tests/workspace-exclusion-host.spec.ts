import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { expect, it, vi } from 'vitest'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { createRuntimeGraph } from '../src/host/runtime.ts'
import { createStorageRoot } from '../src/host/storage-root.ts'
import { createReadHandler, createWriteHandler } from '../src/host/rpc.ts'
import { registerGuidance } from '../src/host/guidance.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { dsh021, executeTool, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

type Reply = string | { name: string; args: Record<string, unknown> }
class Model extends LlmAdapter {
  private calls = 0
  constructor(private readonly reply: (options: GenerateOptions) => Reply) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.reply(options)
    if (typeof reply === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    } else {
      const id = ToolCallId(`workspace-exclusion-${++this.calls}`), args = JSON.stringify(reply.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.name, arguments: args } }
    }
    yield { type: 'finish', reason: { kind: typeof reply === 'string' ? 'stop' : 'tool-calls' } }
  }
}

it.each((['native', 'ptc'] as const).flatMap(mode => (['custom', 'workspace', 'workspaces'] as const).map(storageScope => ({ mode, storageScope }))))('excludes a root and different-cwd child without disrupting conversation, then restores memory: %j', async ({ mode, storageScope }) => {
  const ctx = new Context()
  const f = await compositionFixture({ storageScope, runtimeMemory: { inheritToSubagents: true }, idleReview: { enabled: true, persistWatermark: true } }, {
    agents: { get: id => ctx.agents?.get(SessionId(id)) as unknown as HostAgent | undefined },
  })
  const other = join(f.root, 'other-workspace'); mkdirSync(other)
  await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Synthetic retained workspace fact.' })
  f.config.excludedWorkspaces = [f.workspace]
  let stop: (() => void) | undefined, stopTools: (() => void) | undefined, coordinator: MnemonSubagentCoordinator | undefined
  let parent: Awaited<ReturnType<typeof ctx.agents.create>> | undefined, child: typeof parent, fresh: typeof parent
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    if (mode === 'ptc') for (const [name, config] of [
      ['dsh-fs-local', { cwd: f.workspace }], ['dsh-subprocess-local', {}], ['dsh-sandbox-local', {}],
      ['dsh-sandbox-policy', { mode: 'read-only', workspaceRoot: f.workspace }], ['dsh-ptc-runtime-node', {}],
    ] as const) await ctx.plugin((await import(requireDsh.resolve(`@deepseek-ai/${name}`))).default, config)
    const selectPtc = await loadTools(ctx, mode === 'ptc' && !dsh021 ? 'both' : 'native')
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    const host = ctx as unknown as HostContextShape
    coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    stopTools = registerTools(host, f.live, coordinator, f.extensions)
    registerGuidance(host, f.live.config, f.live)
    const lifecycle = new MnemonLifecycle(host, coordinator, f.live.config, f.live)
    stop = lifecycle.start()
    const review = vi.spyOn(coordinator, 'review')
    const ordinary = vi.fn(async () => ({}))
    ctx.tools.register({ name: 'fixture_echo', description: 'Ordinary conversation tool.', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] }, execute: ordinary })
    ctx.on('agent/created', async ({ agent }) => { if (mode === 'ptc') await selectPtc(agent.ctx); return undefined })
    const errors: unknown[] = [], requests: GenerateOptions[] = [], counts = new Map<string, number>()
    let write = false
    ctx.on('agent/error', ({ error }) => { errors.push(error); return undefined })
    ctx.llm.registerAdapter(['fixture'], new Model(options => {
      requests.push(options)
      const count = counts.get(String(options.sessionId)) ?? 0; counts.set(String(options.sessionId), count + 1)
      if (count % 2 === 1) return 'Synthetic ordinary conversation completed.'
      const name = write ? 'mnemon_runtime_memory' : 'fixture_echo'
      const args = write ? { action: 'add', target: 'memory', content: 'Synthetic restored workspace fact.' } : {}
      return mode === 'native' ? { name, args } : { name: 'run_code', args: { description: 'Perform the requested operation.', code: `return await tools.${name}(${JSON.stringify(args)})` } }
    }))
    const turn = async (agent: Agent) => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete the synthetic project task.' }] }))
      await agent.whenIdle(); expect(errors).toEqual([])
    }
    parent = await ctx.agents.create({ sessionId: SessionId('excluded-parent'), meta: { cwd: f.workspace }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    child = await ctx.agents.create({ sessionId: SessionId('excluded-child'), parentAgent: parent.agent,
      meta: { origin: 'subagent', parentSession: parent.agent.id, cwd: other }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    await turn(parent.agent); await turn(child.agent)
    expect(ordinary).toHaveBeenCalledTimes(2)
    expect(review).not.toHaveBeenCalled()
    expect(lifecycle.snapshot(parent.agent.id).current?.nextReviewAt).toBeUndefined()
    expect(requests).toHaveLength(4)
    for (const request of requests) {
      expect(JSON.stringify(request.messages.filter(message => message.role === 'system')) + (request.system ?? '')).not.toMatch(/mnemon/iu)
      expect(JSON.stringify(request.messages)).not.toMatch(/MNEMON VIEW|Synthetic retained workspace fact|mnemon_/u)
      expect(request.messages.some(message => message.source?.kind === 'dsh-mnemon')).toBe(false)
      expect(request.tools?.some(tool => tool.name.startsWith('mnemon_'))).toBe(false)
    }
    for (const handle of [parent, child]) {
      expect(f.live.memoryParticipation(handle.agent as unknown as HostAgent).excluded).toBe(true)
      const blocked = await executeTool(handle.agent.ctx, { name: 'mnemon_runtime_memory', callId: ToolCallId('excluded-probe'),
        arguments: { action: 'add', target: 'memory', content: 'Must not be saved.' }, agent: handle.agent, signal: new AbortController().signal })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toMatch(/excludedWorkspaces|not available|not found|not allowed|denied/i)
    }
    const status = await createReadHandler(f.live, lifecycle)('status', { workspaceId: 'workspace', sessionId: parent.agent.id })
    expect(status).toMatchObject({ ok: true, value: { writeEnabled: false, workspaceContext: { participation: { excluded: true } } } })
    const blockedWrite = await createWriteHandler(f.live, lifecycle)('runtime-memory', { workspaceId: 'workspace', action: 'add', target: 'memory', content: 'Must not be saved.' })
    expect(blockedWrite).toMatchObject({ ok: false, error: { message: expect.stringContaining('excludedWorkspaces') } })
    expect(JSON.stringify(await f.graph.source('runtime').read('snapshot'))).not.toContain('Must not be saved.')

    f.live.swap(createRuntimeGraph({ ...f.config, excludedWorkspaces: [f.workspace, other] }, f.workspace, f.extensions))
    fresh = await ctx.agents.create({ sessionId: SessionId('fresh-excluded'), meta: { cwd: other }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    await turn(fresh.agent)
    // Even persistent-review bookkeeping must not create the excluded project's
    // memory directory. Shared global/custom storage already exists by design.
    if (storageScope !== 'custom') expect(existsSync(createStorageRoot(f.config, other).effectiveDataDir())).toBe(false)

    // The real graph swap represents a saved profile update. Existing files and
    // unrelated Host tools survive; the same live root can use memory again.
    f.live.swap(createRuntimeGraph({ ...f.config, excludedWorkspaces: [] }, f.workspace, f.extensions))
    write = true
    await turn(parent.agent)
    expect(JSON.stringify(requests.at(-2)!.messages)).toContain('Synthetic retained workspace fact.')
    const snapshot = JSON.stringify(await f.live.forAgent(parent.agent as unknown as HostAgent).source('runtime').read('snapshot'))
    expect(snapshot).toContain('Synthetic retained workspace fact.')
    expect(snapshot).toContain('Synthetic restored workspace fact.')
    expect(f.live.memoryParticipation(child.agent as unknown as HostAgent).excluded).toBe(false)
  } finally {
    await fresh?.dispose(); await child?.dispose(); await parent?.dispose(); stop?.(); stopTools?.(); coordinator?.dispose()
    await ctx.fiber.dispose(); await f.dispose()
  }
}, 30_000)
