import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, expect, it } from 'vitest'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { HostAgent, HostContextShape, HostSession } from '../src/host/dsh.ts'
import type { DocumentView } from 'dsh-mnemon-source-documents/contracts'
import type { Insight, PreparedMemoryPlacement } from 'dsh-mnemon-source-memory-spaces/contracts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { startSubagent } from '../src/host/subagent-start.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { executeTool, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

// The released Host hides detached task sessions (#435). Activation-owned master requires
// ordinary task roots: ACP and the sidebar may list those roots, but child ownership and
// memory results must remain the same. Exercise DSH's real persisted-session query and ACP.
const activationTrees = typeof (SubagentRuntime.prototype as unknown as { rootOf?: unknown }).rootOf === 'function'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))
const sessionQuery = await import(requireDsh.resolve('@deepseek-ai/dsh-session-query'))
// DSH's ACP agent plugin takes its message stream from `config.stream`, as its own tests give it one.
const acp = await import(requireDsh.resolve('@deepseek-ai/dsh-acp')) as { inject: string[]; apply(ctx: Context, config: object): void }

type Message = GenerateOptions['messages'][number]
type Reply = string | { name: string; args: Record<string, unknown> }
type Header = NonNullable<HostSession['header']> & { id: string }
const text = (message: Message) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')

const CANDIDATE = 'Release checklist: run the staged rollout first, then approve the release.'
const CHILD_STEP = 'Run the maintenance step.'

/** Only the model is scripted: the subagent runtime, tools, storage and Session persistence are real. */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly respond: (options: GenerateOptions) => Reply) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.respond(options)
    const id = `call-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
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

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })

/** DSH's ACP agent on this host over an in-memory message stream: the session ids its `session/list` offers. */
async function acpSessionList(ctx: Context): Promise<() => Promise<string[]>> {
  const toAgent = new TransformStream<object, object>()
  const fromAgent = new TransformStream<object, object>()
  await ctx.plugin({
    inject: acp.inject,
    apply: (scoped: Context) => acp.apply(scoped, { provider: 'scripted', model: 'fixture', sessionListPageSize: 100, stream: { readable: toAgent.readable, writable: fromAgent.writable } }),
  })
  const writer = toAgent.writable.getWriter()
  const reader = fromAgent.readable.getReader()
  let calls = 0
  const call = async (method: string, params: object): Promise<unknown> => {
    const id = ++calls
    await writer.write({ jsonrpc: '2.0', id, method, params })
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error('the ACP stream closed')
      const message = value as { id?: number; result?: unknown; error?: unknown }
      if (message.id !== id) continue
      if (message.error !== undefined) throw new Error(`${method}: ${JSON.stringify(message.error)}`)
      return message.result
    }
  }
  await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  return async () => ((await call('session/list', {})) as { sessions: Array<{ sessionId: string }> }).sessions.map(session => session.sessionId).sort()
}

/**
 * A real DSH host with Mnemon's lifecycle, DSH's spawn provider, Session query and ACP agent, no live
 * conversations, and `plain`: a finished session created as main created a task Agent's, through
 * `agents.create` with only a cwd, which ACP lists. ACP leaves out a session that is still attached.
 */
async function host(reply?: (project: string) => Record<string, unknown>) {
  const f = await compositionFixture({ taskAgentModel: { mode: 'fixed', provider: 'scripted', model: 'fixture' } })
  const project = (await f.memorySpace()).id
  const ctx = new Context()
  let stop: (() => void) | undefined
  disposers.push(async () => { stop?.(); await ctx.fiber.dispose(); await f.dispose() })
  const adapter = new ScriptedAdapter(options => {
    if (options.sessionId === 'plain') return 'Noted.'
    if (options.messages.some(message => message.role === 'user' && text(message).includes(CHILD_STEP))) return 'Maintenance step done.'
    // The Save to memory writer stores the candidate in the project space, then reports.
    const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
    const terminal = system.match(/Completion protocol: call `([^`]+)`/u)?.[1]
    const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
    if (terminal === undefined || requestId === undefined) throw new Error('writer completion capability is missing')
    if (reply !== undefined) return { name: terminal, args: { requestId, result: reply(project) } }
    if (!options.messages.some(message => message.role === 'tool')) return { name: 'mnemon_remember', args: { content: CANDIDATE, memoryBodyId: project } }
    return { name: terminal, args: { requestId, result: { summary: 'Saved the release checklist.', action: 'stored', memoryBodyIds: [project] } } }
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(sessionQuery.default)
  await ctx.plugin(SystemPrompt)
  await loadTools(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (activationTrees) await ctx.plugin((await import(requireDsh.resolve('@deepseek-ai/dsh-session-title'))).default, { fallbackMaxWords: 12, fallbackMaxBytes: 120, maxTitleBytes: 512 })
  await loadWorkingDirectory(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['scripted'], adapter)
  const dsh = ctx as unknown as HostContextShape
  let coordinator = new MnemonSubagentCoordinator(dsh.subagents, f.live, dsh)
  let lifecycle = new MnemonLifecycle(dsh, coordinator, f.config, f.live)
  let stopTools = registerTools(dsh, f.live, coordinator, f.extensions)
  stop = lifecycle.start()
  const agents = (ctx as unknown as { agents: { create(options: object): Promise<{ agent: { followup(message: unknown): void; whenIdle(): Promise<void> }; dispose(): Promise<void> }> } }).agents
  const plain = await agents.create({ sessionId: SessionId('plain'), meta: { cwd: f.workspace }, agentOptions: { provider: 'scripted', model: 'fixture' } })
  plain.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
  await plain.agent.whenIdle()
  await plain.dispose()
  const listed = await acpSessionList(ctx)
  const query = (ctx as unknown as { sessionQuery: { listSessions(): Promise<ReadonlyArray<{ header: Header }>> } }).sessionQuery
  /** Every stored session's header by id, as Session query reads them. */
  const sessions = async () => new Map((await query.listSessions()).map(record => [record.header.id, record.header]))
  expect(ctx.agents.list()).toEqual([])
  const restartMnemon = () => {
    stop?.(); stopTools(); coordinator.dispose()
    coordinator = new MnemonSubagentCoordinator(dsh.subagents, f.live, dsh)
    lifecycle = new MnemonLifecycle(dsh, coordinator, f.config, f.live)
    stopTools = registerTools(dsh, f.live, coordinator, f.extensions)
    stop = lifecycle.start()
  }
  return { f, ctx, dsh, get lifecycle() { return lifecycle }, project, sessions, listed, restartMnemon }
}

it("preserves Save to memory and task visibility on the active Host without borrowing a conversation", async () => {
  const h = await host()
  expect(await h.listed()).toEqual(['plain'])

  const result = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)

  expect(result).toMatchObject({ delegated: true, action: 'stored', memoryBodyIds: [h.project] })
  await expectTaskVisibility(h, 1)
  const sessions = await h.sessions()
  // With no conversation, the receipt names the task Agent: a session of its own, outside any lineage.
  const task = sessions.get(result.sessionId)
  expect(task).toMatchObject({ cwd: h.f.workspace })
  expect(task?.origin).toBe(activationTrees ? undefined : 'subagent')
  expect(task?.parentSession).toBeUndefined()
  expect(task?.delegationDepth ?? 0).toBe(0)
  // Its writer is its child, one level deep, as before.
  expect([...sessions.values()].filter(header => header.parentSession === result.sessionId))
    .toEqual([expect.objectContaining({ id: result.runId, origin: 'subagent', delegationDepth: 1 })])
  expect(h.ctx.agents.list()).toEqual([])
}, 30_000)

it.each(['runtime', 'skills'] as const)("runs a standalone %s task and its owned child with the active Host session visibility", async kind => {
  const h = await host()
  const signal = new AbortController().signal

  const operation = async (task: HostAgent) => {
    const run = await startSubagent(h.dsh.subagents, h.dsh.agents, 'spawn', { label: 'Mnemon test child', prompt: [{ type: 'text', text: CHILD_STEP }], parent: task, signal })
    const result = await run.result
    await run.dispose()
    return { task: task.id, child: run.id, result }
  }
  const outcome = kind === 'runtime'
    ? await h.lifecycle.runRuntimeMaintenanceTask({ storage: 'workspace', workspaceId: h.f.workspace }, signal, operation)
    : await h.lifecycle.runSkillTask(h.f.workspace, signal, operation)

  expect(outcome.result).toMatchObject({ output: [{ type: 'text', text: 'Maintenance step done.' }], stopReason: 'completed' })
  await expectTaskVisibility(h, 1)
  const sessions = await h.sessions()
  expect(sessions.get(outcome.task)).toMatchObject({ cwd: h.f.workspace })
  expect(sessions.get(outcome.task)?.origin).toBe(activationTrees ? undefined : 'subagent')
  expect(sessions.get(outcome.task)?.parentSession).toBeUndefined()
  expect(sessions.get(outcome.child)).toMatchObject({ origin: 'subagent', parentSession: outcome.task, delegationDepth: 1 })
  expect(h.ctx.agents.list()).toEqual([])
}, 30_000)

it('answers evidence queries without a conversation and cleans up its task and child', async () => {
  const h = await host(() => ({ answer: 'Run the staged rollout first.', citations: [] }))
  const result = await h.lifecycle.answerTask('', 'What should run first?', [], h.f.workspace)
  expect(result).toMatchObject({ answer: 'Run the staged rollout first.', citations: [], delegation: { provider: 'spawn' } })
  await expectTaskVisibility(h, 1)
  expect(h.ctx.agents.list()).toEqual([])
  expect((await h.sessions()).get(result.delegation.runId)).toMatchObject({ origin: 'subagent', delegationDepth: 1 })
}, 30_000)

it('proposes Memory Space metadata without a conversation and respects Host task visibility', async () => {
  const h = await host(project => ({ summary: 'Prepared release metadata.', updates: [
    { memoryBodyId: project, title: 'Release planning', description: 'Release decisions and staged rollout checklists.' },
  ] }))
  const result = await h.lifecycle.maintainMetadata('', [h.project], h.f.workspace)
  expect(result).toMatchObject({ delegated: true, provider: 'spawn', updates: [
    { memoryBodyId: h.project, title: 'Release planning', description: 'Release decisions and staged rollout checklists.' },
  ] })
  await expectTaskVisibility(h, 1)
  expect(h.ctx.agents.list()).toEqual([])
}, 30_000)

it('creates and archives a Document without a conversation, retaining its content and memory index', async () => {
  const h = await host(project => ({ action: 'planned', summary: 'Release checklist archive.', memoryBodyId: project }))
  const created = await h.lifecycle.mutateDocumentTask('', { action: 'create', title: 'Release checklist', content: CANDIDATE }, h.f.workspace)
  expect(created.success).toBe(true)
  const id = created.document!.id
  const archived = await h.lifecycle.archiveDocument('', id, h.f.workspace)
  expect(archived).toMatchObject({ success: true, document: { id, status: 'archived' } })
  const scope = { storage: 'workspace' as const, workspaceId: h.f.workspace }
  const stored = await h.f.graph.source('documents', scope).read<DocumentView>('document', { id })
  expect(stored.content).toBe(CANDIDATE)
  const recalled = await h.f.graph.source('memory-spaces', scope).read<{ results: Insight[] }>('search', {
    query: stored.contentHash, mode: 'keyword', memoryBodyIds: [h.project], limit: 10,
  })
  expect(recalled.results.some(item => item.content.includes(stored.contentHash) && item.content.includes('.mnemon/documents/archived/'))).toBe(true)
  await expectTaskVisibility(h, 2)
  expect(h.ctx.agents.list()).toEqual([])
}, 30_000)

it('chooses an eligible Memory Space Provider without a conversation and respects Host task visibility', async () => {
  const h = await host(() => ({ providerId: 'holographic', reason: 'Keep synthetic release records local.', confidence: 'high' }))
  const body = { name: 'Release planning', description: 'Release decisions and staged rollout checklists.' }
  const prepared = await h.f.graph.source('memory-spaces').read<PreparedMemoryPlacement>('prepare-body-placement', {
    ...body, placement: { mode: 'automatic', rules: { allowedProviderIds: ['holographic'] } },
  })
  const result = await h.lifecycle.placeProviderTask('', body, prepared, h.f.workspace)
  expect(prepared.candidates.map(candidate => candidate.id)).toContain(result.providerId)
  expect(result.providerId).toBe('holographic')
  await expectTaskVisibility(h, 1)
  expect(h.ctx.agents.list()).toEqual([])
}, 30_000)

async function expectTaskVisibility(h: Awaited<ReturnType<typeof host>>, count: number) {
  const listed = await h.listed()
  if (!activationTrees) {
    expect(listed).toEqual(['plain'])
    return
  }
  expect(listed).toContain('plain')
  const tasks = listed.filter(id => id !== 'plain')
  expect(tasks).toHaveLength(count)
  for (const id of tasks) {
    expect(id).toMatch(/^mnemon-task-v1-/)
    const header = (await h.sessions()).get(id)
    expect(header?.origin).toBeUndefined()
    expect(header?.parentSession).toBeUndefined()
  }
}

it.skipIf(!activationTrees)('keeps a titled completed task outside conversation automation after Mnemon is recreated', async () => {
  const h = await host()
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  h.restartMnemon()
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(saved.sessionId), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    expect(h.lifecycle.snapshot()).toMatchObject({ activeAgents: 0, sessionAvailable: false })
    const title = task.agent.session.snapshotEvents().findLast(event => event.type === 'session/title')
    expect(title?.data).toMatchObject({ title: 'Mnemon · Save to memory' })
    const runtime = h.f.graph.source('runtime')
    const before = await runtime.read('snapshot')
    const attempt = await executeTool(task.agent.ctx, { name: 'mnemon_runtime_memory',
      arguments: { action: 'add', target: 'user', content: 'A completed task must not write this.' },
      agent: task.agent, callId: 'finished-task-probe' as ToolExecutionInput['callId'], signal: new AbortController().signal })
    expect(attempt.isError).toBe(true)
    expect(JSON.stringify(attempt)).toContain('This Mnemon task has finished')
    expect(await runtime.read('snapshot')).toEqual(before)
  } finally { await task.dispose() }
  await expectTaskVisibility(h, 1)
})
