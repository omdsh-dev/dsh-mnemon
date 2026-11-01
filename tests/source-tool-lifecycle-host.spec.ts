import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import holographic from 'dsh-mnemon-provider-holographic'
import * as spaces from 'dsh-mnemon-source-memory-spaces'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))
const fork = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-fork-in-process'))
type Reply = string | { name: string; args: Record<string, unknown> }
class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly respond: (options: GenerateOptions) => Reply) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.respond(options)
    const id = `lifecycle-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
    if (typeof reply === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    } else {
      const args = JSON.stringify(reply.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.name, arguments: args } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: typeof reply === 'string' ? 'stop' : 'tool-calls' } }
  }
}

async function harness(respond: (options: GenerateOptions) => Reply, configure?: (f: Awaited<ReturnType<typeof compositionFixture>>) => Promise<void>) {
  const f = await compositionFixture()
  const ctx = new Context()
  let stop: (() => void) | undefined
  let stopTools: (() => void) | undefined
  let coordinator: MnemonSubagentCoordinator | undefined
  const dispose = async () => { stop?.(); stopTools?.(); coordinator?.dispose(); await ctx.fiber.dispose(); await f.dispose() }
  try {
    await configure?.(f)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(fork, { providerName: 'fork' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(respond))
    const host = ctx as unknown as HostContextShape
    coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    stopTools = registerTools(host, f.live, coordinator, f.extensions)
    stop = new MnemonLifecycle(host, coordinator, f.config, f.live).start()
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: f.workspace })
    const turn = async (text: string) => {
      parent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await parent.whenIdle()
    }
    return { ...f, ctx, coordinator, parent: parent as unknown as HostAgent, turn, dispose }
  } catch (error) { await dispose(); throw error }
}

it('updates an already loaded Agent schema and keeps Documents/Runtime usable with Memory Spaces absent', async () => {
  const requests: string[][] = []
  let calls = 0
  const f = await harness(options => {
    requests.push((options.tools ?? []).map(tool => tool.name))
    if (calls++ === 0) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'Synthetic retained runtime fact.' } }
    if (calls === 2) return { name: 'mnemon_document_create', args: { title: 'Synthetic record', content: 'Synthetic project record with no Memory Spaces.' } }
    return 'Done.'
  }, async f => { await f.releases[2]!() })
  try {
    await f.turn('Record the synthetic runtime fact and Document.')
    expect(requests[0]).toHaveLength(7)
    expect(requests[0]).not.toContain('mnemon_recall')
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content: 'Synthetic retained runtime fact.' })] })
    expect(await f.graph.source('documents').read('snapshot')).toMatchObject({ activeCount: 1 })
    const receipts = f.parent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(receipts).toHaveLength(2)
    expect(JSON.stringify(receipts)).not.toContain('"isError":true')
    const release = await f.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
      await spaces.installMemorySpaces(ctx, [{ instanceId: holographic.id, module: holographic, config: undefined }])
    } }, { instanceId: 'mnemon-source-memory-spaces' })
    await f.turn('Inspect the next model schema.')
    expect(requests.at(-1)).toHaveLength(17)
    expect(requests.at(-1)).toContain('mnemon_recall')
    await release()
    await f.turn('Inspect the schema after disabling the Source again.')
    expect(requests.at(-1)).toHaveLength(7)
  } finally { await f.dispose() }
}, 20_000)

it.each(['spawn', 'fork'] as const)('starts a %s review with only registered optional tools', async provider => {
  for (const absent of ['documents', 'runtime'] as const) {
    const childRequests: string[][] = []
    const f = await harness(options => {
      if (options.sessionId === 'parent') return 'A completed synthetic checkpoint.'
      childRequests.push((options.tools ?? []).map(tool => tool.name))
      const system = options.system ?? JSON.stringify(options.messages.filter(message => message.role === 'system'))
      const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
      if (!requestId) throw new Error('Missing completion capability')
      return { name: 'mnemon_subagent_result', args: { requestId, result: { summary: 'Checkpoint reviewed.', action: 'skipped', memoryBodyIds: [], documentIds: [] } } }
    }, async f => { f.config.idleReview.provider = provider; await f.releases[absent === 'documents' ? 1 : 0]!() })
    try {
      await f.turn('Review this synthetic checkpoint.')
      await expect(f.coordinator.review(f.parent, new AbortController().signal)).resolves.toMatchObject({ delegated: true, action: 'skipped' })
      expect(childRequests).toHaveLength(1)
      expect(childRequests[0]?.toSorted()).toEqual(absent === 'documents' ? ['mnemon_runtime_memory', 'mnemon_subagent_result']
        : ['mnemon_document_create', 'mnemon_document_search', 'mnemon_subagent_result'])
    } finally { await f.dispose() }
  }
}, 20_000)

it.each(['absent', 'read-only', 'scoped'] as const)('skips review without a writable target when Sources are %s', async state => {
  let childRequests = 0
  const f = await harness(options => {
    if (options.sessionId !== 'parent') childRequests++
    return 'Checkpoint.'
  }, async f => {
    if (state === 'absent') { await f.releases[0]!(); await f.releases[1]!() }
    if (state === 'read-only') f.config.writeEnabled = false
    if (state === 'scoped') await f.mount(scoped, { instanceId: 'scoped', config: { writableSourceKeys: [] } })
  })
  try {
    await f.turn('A synthetic checkpoint with no applicable writable target.')
    await expect(f.coordinator.review(f.parent, new AbortController().signal)).resolves.toMatchObject({ delegated: false, action: 'skipped' })
    expect(childRequests).toBe(0)
    if (state !== 'absent') expect(f.ctx.tools.schemas()).toHaveLength(17)
  } finally { await f.dispose() }
}, 20_000)

it('keeps a surviving in-flight Source call alive while another family is removed', async () => {
  let calls = 0
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let callSignal: AbortSignal | undefined
  const f = await harness(() => calls++ === 0
    ? { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'Synthetic in-flight fact.' } }
    : 'Saved.')
  try {
    f.ctx.on('tools/execute', async (execution, next) => {
      if (execution.name === 'mnemon_runtime_memory') {
        callSignal = execution.signal
        entered.resolve()
        await release.promise
      }
      return next()
    })
    const pending = f.turn('Save this synthetic fact.')
    await entered.promise
    await f.releases[2]!()
    expect(f.ctx.tools.schemas()).toHaveLength(7)
    expect(callSignal?.aborted).toBe(false)
    release.resolve()
    await pending
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ entries: [expect.objectContaining({ content: 'Synthetic in-flight fact.' })] })
  } finally { release.resolve(); await f.dispose() }
}, 20_000)

it('keeps global tool families while a workspace View selects only Runtime', async () => {
  const requests: string[][] = []
  const f = await harness(options => {
    requests.push((options.tools ?? []).map(tool => tool.name))
    return 'A narrow workspace View.'
  }, async f => { await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: ['source:mnemon-source-runtime'] } }) })
  try {
    await f.turn('Use the narrow synthetic workspace View.')
    expect(requests[0]).toHaveLength(17)
    const turn = await f.graph.composableTurns.beginTurn('narrow-view', { storage: 'custom', workspaceId: f.workspace, agentId: f.parent.id, sessionId: f.parent.id })
    expect(turn.view.actionOffers.map(offer => offer.sourceInstanceKey)).toEqual(['source:mnemon-source-runtime'])
    expect(f.ctx.tools.schemas()).toHaveLength(17)
    f.graph.composableTurns.endTurn(turn.turnId)
  } finally { await f.dispose() }
}, 20_000)
