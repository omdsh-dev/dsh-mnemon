import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { HostAgent, HostContextShape, HostSession } from '../src/host/dsh.ts'
import type { DocumentView } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import type { Insight, PreparedMemoryPlacement } from 'dsh-mnemon-source-memory-spaces/contracts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { startSubagent } from '../src/host/subagent-start.ts'
import { registerTools } from '../src/host/tools.ts'
import { createPluginMessage } from '../src/host/plugin-message.ts'
import { createRuntimeGraph } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { executeTool, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

// The released Host hides detached task sessions (#435). Activation-owned master requires
// ordinary task roots, discoverable through ACP. The WebUI hides non-current blank roots;
// do not inject conversation turns to force visibility. Exercise persistence and ACP.
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
async function host(reply?: (project: string) => Record<string, unknown>, followup?: (options: GenerateOptions) => Reply | undefined) {
  const f = await compositionFixture({ taskAgentModel: { mode: 'fixed', provider: 'scripted', model: 'fixture' } })
  const project = (await f.memorySpace()).id
  const ctx = new Context()
  let stop: (() => void) | undefined
  const completionRequests = new Map<string, string>()
  disposers.push(async () => { stop?.(); await ctx.fiber.dispose(); await f.dispose() })
  const adapter = new ScriptedAdapter(options => {
    const next = followup?.(options)
    if (next !== undefined) return next
    if (options.sessionId === 'plain') return 'Noted.'
    if (options.messages.some(message => message.role === 'user' && text(message).includes(CHILD_STEP))) return 'Maintenance step done.'
    // The Save to memory writer stores the candidate in the project space, then reports.
    const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
    const terminal = system.match(/Completion protocol: call `([^`]+)`/u)?.[1]
    const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
    if (terminal === undefined || requestId === undefined) throw new Error('writer completion capability is missing')
    completionRequests.set(options.sessionId!, requestId)
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
  return { f, ctx, dsh, get lifecycle() { return lifecycle }, project, sessions, listed, restartMnemon, completionRequests }
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

it.each(['root', 'child'] as const)('ends a continued %s task grant before an automatic message and permits the next user request', async kind => {
  let target = ''
  const results: string[] = []
  const h = await host(undefined, options => {
    if (options.sessionId !== target) return undefined
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('FOLLOWUP_'))
    if (at < 0) return 'No request.'
    const replies = options.messages.slice(at + 1).filter(message => message.role === 'tool')
    if (replies.length === 0) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: text(options.messages[at]!) } }
    results.push(...replies.map(text))
    return 'Settled.'
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  target = kind === 'root' ? saved.sessionId : saved.runId!
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    for (const [content, human] of [['FOLLOWUP_FIRST: rollback threshold is 0.5%.', true], ['FOLLOWUP_AUTO_MUST_NOT_WRITE', false], ['FOLLOWUP_SECOND: retain images for 48 hours.', true]] as const) {
      task.agent.followup(human ? createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } }) : createPluginMessage(content, 'instructions') as never)
      await task.agent.whenIdle()
    }
    const snapshot = JSON.stringify((await h.f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries)
    expect(snapshot).toContain('FOLLOWUP_FIRST')
    expect(snapshot).not.toContain('FOLLOWUP_AUTO_MUST_NOT_WRITE')
    expect(snapshot).toContain('FOLLOWUP_SECOND')
    expect(results).toHaveLength(3)
    expect(results[1]).toContain('This Mnemon task has finished')
    expect(h.f.graph.composableTurns.activeTurn(target)).toBeUndefined()
    expect(h.lifecycle.snapshot()).toMatchObject({ activeAgents: 0 })
  } finally { await task.dispose() }
}, 30_000)

it('uses the current memory storage when a resumed child has a parent pinned to an older runtime', async () => {
  let target = ''
  const h = await host(undefined, options => {
    if (options.sessionId !== target) return undefined
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).includes('NEW_STORAGE'))
    if (options.messages.slice(at + 1).some(message => message.role === 'tool')) return 'Done.'
    return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'NEW_STORAGE: use the current storage root.' } }
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  const parent = await h.ctx.agents.resume({ resumeSessionId: SessionId(saved.sessionId), agentOptions: { provider: 'scripted', model: 'fixture' } })
  const lease = await h.f.live.executions.workflow(parent.agent as unknown as HostAgent, 'scope-test', new AbortController().signal)
  const current = createRuntimeGraph(resolveConfig({ ...h.f.config, dataDir: join(h.f.root, 'new-memory-root') }), h.f.workspace, h.f.extensions)
  h.f.live.swap(current)
  target = saved.runId!
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    task.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'NEW_STORAGE: save the decision here.' }], source: { kind: 'user' } }))
    await task.agent.whenIdle()
    expect(JSON.stringify((await current.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries)).toContain('NEW_STORAGE')
    expect(JSON.stringify((await h.f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries)).not.toContain('NEW_STORAGE')
  } finally { await task.dispose(); lease.release(); await parent.dispose() }
}, 30_000)

it('does not let an automatic continuation obtain memory tools through a fresh delegated child', async () => {
  const results: string[] = []
  const h = await host(undefined, options => {
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).includes('AUTO_DELEGATE'))
    if (at < 0) return undefined
    const replies = options.messages.slice(at + 1).filter(message => message.role === 'tool')
    if (replies.length === 0) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'AUTO_DELEGATE_MUST_NOT_WRITE' } }
    results.push(...replies.map(text))
    return 'Done.'
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(saved.sessionId), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    const run = await startSubagent(h.dsh.subagents, h.dsh.agents, 'spawn', { label: 'Automatic relay', prompt: [{ type: 'text', text: 'AUTO_DELEGATE: write another decision.' }], parent: task.agent as unknown as HostAgent, signal: new AbortController().signal })
    try { await run.result } finally { await run.dispose() }
    expect(JSON.stringify((await h.f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries)).not.toContain('AUTO_DELEGATE_MUST_NOT_WRITE')
    expect(results.join('\n')).toContain('This Mnemon task has finished')
  } finally { await task.dispose() }
}, 30_000)

it('saves fresh memory from a continued task without reopening the original result', async () => {
  const followupFact = 'Fresh followup: deployment images are retained for 48 hours.'
  let target = ''
  let project = ''
  const results: string[] = []
  const h = await host(undefined, options => {
    if (options.sessionId === target) {
      const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('NEW_SAVE'))
      const replies = options.messages.slice(at + 1).filter(message => message.role === 'tool')
      if (replies.length === 0) return { name: 'mnemon_remember', args: { content: followupFact, memoryBodyId: project } }
      results.push(...replies.map(text))
      return 'The followup is saved.'
    }
    if (!options.messages.some(message => message.role === 'user' && text(message).includes(followupFact))) return undefined
    if (!options.messages.some(message => message.role === 'tool')) return { name: 'mnemon_remember', args: { content: followupFact, memoryBodyId: project } }
    const requestId = JSON.stringify(options.messages.filter(message => message.role === 'system')).match(/requestId `([^`]+)`/u)?.[1]
    if (requestId === undefined) throw new Error('new task completion request is missing')
    return { name: 'mnemon_subagent_result', args: { requestId, result: { summary: 'Saved the followup.', action: 'stored', memoryBodyIds: [project] } } }
  })
  project = h.project
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  const original = structuredClone(saved)
  const originalSessions = await h.sessions()
  target = saved.sessionId
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    task.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'NEW_SAVE: save the deployment image retention decision.' }], source: { kind: 'user' } }))
    await task.agent.whenIdle()
    const matches = await h.f.graph.source('memory-spaces', { storage: 'workspace', workspaceId: h.f.workspace }).read<{ results: Insight[] }>('search', { query: 'retained', mode: 'keyword', memoryBodyIds: [project], limit: 10 })
    expect(matches.results.map(item => item.content), results.join('\n')).toContain(followupFact)
    expect(saved).toEqual(original)
    expect(results.join('\n')).not.toMatch(/Error:|task has finished/)
    const fresh = [...await h.sessions()].filter(([id]) => !originalSessions.has(id))
    // Released Hosts identify detached task roots as subagents, so their normal
    // Remember path writes directly. Activation-owned roots delegate a new writer.
    expect(fresh).toHaveLength(activationTrees ? 1 : 0)
    if (fresh[0] !== undefined) expect(fresh[0][1].parentSession).toBe(target)
  } finally { await task.dispose() }
}, 30_000)

it.each(['root', 'child'] as const)('allows current-policy reads but refuses disabled writes in a continued %s task', async kind => {
  let target = ''
  const results: string[] = []
  const h = await host(undefined, options => {
    if (options.sessionId !== target) return undefined
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('READ_ONLY_CONTINUE'))
    const replies = options.messages.slice(at + 1).filter(message => message.role === 'tool')
    if (replies.length === 0) return { name: 'mnemon_recall', args: { query: 'Release checklist', mode: 'keyword' } }
    if (replies.length === 1) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'READ_ONLY_MUST_NOT_WRITE' } }
    results.push(...replies.map(text))
    return 'Read complete; write refused.'
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  const current = createRuntimeGraph(resolveConfig({ ...h.f.config, writeEnabled: false }), h.f.workspace, h.f.extensions)
  h.f.live.swap(current)
  target = kind === 'root' ? saved.sessionId : saved.runId!
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    task.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'READ_ONLY_CONTINUE: read the checklist and try a new write.' }], source: { kind: 'user' } }))
    await task.agent.whenIdle()
    expect(results).toHaveLength(2)
    expect(results[0]).toContain(CANDIDATE)
    expect(results[1]).toContain('read-only')
    expect(results.join('\n')).not.toContain('This Mnemon task has finished')
    expect(JSON.stringify((await current.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries)).not.toContain('READ_ONLY_MUST_NOT_WRITE')
  } finally { await task.dispose() }
}, 30_000)

it('rejects the expired completion request while allowing a new user write in the same child history', async () => {
  let target = ''
  let expired = ''
  const results: string[] = []
  const h = await host(undefined, options => {
    if (options.sessionId !== target) return undefined
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('EXPIRED_COMPLETION'))
    const replies = options.messages.slice(at + 1).filter(message => message.role === 'tool')
    if (replies.length === 0) return { name: 'mnemon_subagent_result', args: { requestId: expired, result: { summary: 'Overwrite the old result', action: 'stored', memoryBodyIds: [] } } }
    if (replies.length === 1) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'New user decision after the old task settled.' } }
    results.push(...replies.map(text))
    return 'New decision saved.'
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  target = saved.runId!
  expired = h.completionRequests.get(target)!
  expect(expired).toBeTruthy()
  h.restartMnemon()
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    task.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'EXPIRED_COMPLETION: continue with a new memory decision.' }], source: { kind: 'user' } }))
    await task.agent.whenIdle()
    expect(results).toHaveLength(2)
    expect(results[0]).toMatch(/already settled|no longer active/)
    expect(JSON.stringify((await h.f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries), results[1]).toContain('New user decision after the old task settled.')
    expect(saved).toMatchObject({ action: 'stored', summary: 'Saved the release checklist.', memoryBodyIds: [h.project] })
  } finally { await task.dispose() }
}, 30_000)

it.each(['cancel', 'prepare failure'] as const)('releases continuation authority after %s and accepts the next user turn', async fault => {
  let target = ''
  const h = await host(undefined, options => {
    if (options.sessionId !== target) return undefined
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('RECOVER_'))
    const request = options.messages[at]!
    if (options.messages.slice(at + 1).some(message => message.role === 'tool')) return 'Saved.'
    return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: text(request) } }
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  target = saved.sessionId
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const pending = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let armed = fault === 'cancel'
  const stop = task.agent.ctx.on('agent/pre-step', async (step, next) => {
    const decision = await next()
    if (step.agent === task.agent && armed) { armed = false; entered!(); await gate }
    return decision
  }, { prepend: true })
  const prepare = fault === 'prepare failure' ? vi.spyOn(h.f.live.executions, 'turn').mockRejectedValueOnce(new Error('Fixture View preparation failed')) : undefined
  try {
    task.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'RECOVER_FAILED_REQUEST' }], source: { kind: 'user' } }))
    if (fault === 'cancel') {
      await pending
      expect(h.f.live.forAgent(task.agent as unknown as HostAgent).composableTurns.activeTurn(target)).toBeDefined()
      task.agent.cancel({ kind: 'user' })
      release!()
    }
    await task.agent.whenIdle()
    expect(h.f.live.forAgent(task.agent as unknown as HostAgent).composableTurns.activeTurn(target)).toBeUndefined()
    task.agent.followup(createPluginMessage('RECOVER_AUTO_REQUEST', 'instructions') as never)
    await task.agent.whenIdle()
    task.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'RECOVER_NEW_USER_REQUEST' }], source: { kind: 'user' } }))
    await task.agent.whenIdle()
    const snapshot = JSON.stringify((await h.f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries)
    expect(snapshot).not.toContain('RECOVER_FAILED_REQUEST')
    expect(snapshot).not.toContain('RECOVER_AUTO_REQUEST')
    expect(snapshot).toContain('RECOVER_NEW_USER_REQUEST')
  } finally { release?.(); prepare?.mockRestore(); stop(); await task.dispose() }
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
    expect(task.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    const runtime = h.f.graph.source('runtime')
    const before = await runtime.read<RuntimeMemorySnapshot>('snapshot')
    const attempt = await executeTool(task.agent.ctx, { name: 'mnemon_runtime_memory',
      arguments: { action: 'add', target: 'user', content: 'A completed task must not write this.' },
      agent: task.agent, callId: 'finished-task-probe' as ToolExecutionInput['callId'], signal: new AbortController().signal })
    expect(attempt.isError).toBe(true)
    expect(JSON.stringify(attempt)).toContain('This Mnemon task has finished')
    // Snapshot generation time changes even when the persisted revision/data do not.
    expect(await runtime.read('snapshot')).toEqual({ ...before, generatedAt: expect.any(String) })
  } finally { await task.dispose() }
  await expectTaskVisibility(h, 1)
})

it.each(['root', 'child'] as const)('continues a completed %s task on a new user turn after Mnemon recreation', async kind => {
  const results: string[] = []
  let target = ''
  const h = await host(undefined, options => {
    if (options.sessionId !== target) return undefined
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).includes('Continue this task:'))
    if (at < 0) return 'No new request.'
    const calls = options.messages.slice(at + 1).filter(message => message.role === 'tool')
    if (calls.length === 0) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'Manual continuation: retain the deployment image for 48 hours.' } }
    results.push(...calls.map(text))
    return 'The new request is complete.'
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  target = kind === 'root' ? saved.sessionId : saved.runId!
  h.restartMnemon()
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    task.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue this task: add the image retention decision.' }], source: { kind: 'user' } }))
    await task.agent.whenIdle()
    expect(results).toHaveLength(1)
    expect(results.join('\n')).not.toContain('This Mnemon task has finished')
    const snapshot = await h.f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')
    expect(JSON.stringify(snapshot.entries), results.join('\n')).toContain('Manual continuation: retain the deployment image for 48 hours.')
    expect(h.lifecycle.snapshot()).toMatchObject({ activeAgents: 0, sessionAvailable: false })
    expect(saved).toMatchObject({ action: 'stored', memoryBodyIds: [h.project] })
  } finally { await task.dispose() }
}, 30_000)

it.each([false, true])('isolates task completion notices while preserving concurrent parent input (%s)', async concurrentInput => {
  let target = ''
  let parentCalls = 0
  const h = await host(undefined, options => {
    if (options.sessionId === 'old-parent-notice') {
      parentCalls++
      expect(options.messages.some(message => message.role === 'user' && message.source?.kind === 'subagent-settled')).toBe(false)
      if (options.messages.some(message => message.role === 'user' && text(message).startsWith('PARENT_NEW_USER'))) return 'New parent request handled.'
      if (options.messages.some(message => message.role === 'tool')) return 'Old task corrected.'
      return { name: 'mnemon_runtime_memory', args: { action: 'remove', target: 'memory', old_text: 'CHILD_OWN_NEW_DECISION' } }
    }
    if (options.sessionId !== target) return undefined
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('CHILD_OWN'))
    if (at < 0) return 'No request.'
    if (options.messages.slice(at + 1).some(message => message.role === 'tool')) return 'CHILD_OWN_NEW_DECISION stored.'
    return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'CHILD_OWN_NEW_DECISION' } }
  })
  const parent = await h.ctx.agents.create({ sessionId: SessionId('old-parent-notice'), meta: { cwd: h.f.workspace }, agentOptions: { provider: 'scripted', model: 'fixture' } })
  const saved = await h.lifecycle.supervise(parent.agent.id, CANDIDATE)
  target = saved.runId!
  let submitted = false
  const stop = h.ctx.on('agent/inbox/inserted', ({ message }) => {
    const source = message.source as { kind: string; senderSessionId?: string }
    if (concurrentInput && source.kind === 'subagent-settled' && source.senderSessionId === target) {
      submitted = true
      parent.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'PARENT_NEW_USER: say hello.' }], source: { kind: 'user' } }))
    }
  })
  try {
    const subagents = h.ctx.subagents as unknown as { prompt(request: object, signal: AbortSignal): Promise<unknown>; waitForTreeWork?(agent: unknown): Promise<boolean>; waitForChildren?(agent: unknown): Promise<boolean> }
    await subagents.prompt({ parentSessionId: parent.agent.id, childSessionId: target, mode: 'continuable', requestId: 'review-parent-notice', content: [{ type: 'text', text: 'CHILD_OWN: save my new decision in this child conversation.' }], delivery: 'queue' }, new AbortController().signal)
    await (subagents.waitForTreeWork?.(parent.agent) ?? subagents.waitForChildren!(parent.agent))
    await parent.agent.whenIdle()
    expect(submitted).toBe(concurrentInput)
    expect(parentCalls).toBe(concurrentInput ? 1 : 0)
    expect(JSON.stringify((await h.f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries)).toContain('CHILD_OWN_NEW_DECISION')
  } finally { stop(); await parent.dispose() }
}, 30_000)



it.skipIf(activationTrees)('an unmarked legacy child cannot gain memory from automatic cold resume', async () => {
  let target = ''
  const replies: string[] = []
  const h = await host(undefined, options => {
    if (options.sessionId !== target) return undefined
    const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('LEGACY_AUTO'))
    if (at < 0) return 'No request.'
    const calls = options.messages.slice(at + 1).filter(message => message.role === 'tool')
    if (calls.length === 0) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'memory', content: 'LEGACY_AUTO_MUST_NOT_WRITE' } }
    replies.push(...calls.map(text))
    return 'Done.'
  })
  const originalStart = h.dsh.subagents.startActivation!.bind(h.dsh.subagents)
  h.dsh.subagents.startActivation = (spec) => {
    const { childId: _id, ...legacy } = spec
    return originalStart(legacy)
  }
  const legacyRoot = await h.ctx.agents.create({ sessionId: SessionId('legacy-root-before-upgrade'), meta: { origin: 'subagent', cwd: h.f.workspace }, agentOptions: { provider: 'scripted', model: 'fixture' } })
  const saved = await h.lifecycle.supervise(legacyRoot.agent.id, CANDIDATE)
  await legacyRoot.dispose()
  await h.sessions()
  target = saved.runId!
  expect(target).not.toMatch(/^mnemon-/)
  h.restartMnemon()
  const parent = await h.ctx.agents.resume({ resumeSessionId: SessionId(saved.sessionId), agentOptions: { provider: 'scripted', model: 'fixture' } })
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    task.agent.followup(createPluginMessage('LEGACY_AUTO: write again.', 'instructions') as never)
    await task.agent.whenIdle()
    expect(JSON.stringify((await h.f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries), replies.join('\n')).not.toContain('LEGACY_AUTO_MUST_NOT_WRITE')
  } finally { await task.dispose(); await parent.dispose() }
}, 30_000)



it('a continued child can delegate a new human request', async () => {
  let target = ''
  const h = await host(undefined, options => {
    if (options.sessionId === target) return 'New request complete.'
    if (!options.messages.some(message => message.role === 'user' && text(message).includes('FRESH_DELEGATE'))) return undefined
    const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
    const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
    if (requestId === undefined) throw new Error('new task result request missing')
    return { name: 'mnemon_subagent_result', args: { requestId, result: { answer: 'The new task completed.', citations: [] } } }
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  target = saved.runId!
  let outcome: unknown
  let stop: (() => void) | undefined
  const attach = (agent: HostAgent) => {
    stop = agent.ctx.on('agent/pre-step', (async (step: { agent: HostAgent; step: number }, next: () => Promise<unknown>) => {
      const decision = await next()
      if (step.agent === agent && step.step === 1) {
        expect(h.f.live.forAgent(agent).composableTurns.activeTurn(target)).toBeDefined()
        try { outcome = await h.lifecycle.answer(target, 'FRESH_DELEGATE: answer this new question.', []) }
        catch (error) { outcome = error }
      }
      return decision
    }) as never, { prepend: true })
  }
  const message = 'Please delegate a fresh answer task.'
  if (activationTrees) {
    const parent = await h.ctx.agents.resume({ resumeSessionId: SessionId(saved.sessionId), agentOptions: { provider: 'scripted', model: 'fixture' } })
    const observe = h.ctx.on('agent/created', ({ agent }) => { if (agent.id === target) attach(agent as unknown as HostAgent); return undefined })
    try {
      await (h.ctx.subagents as unknown as { prompt(request: object, signal: AbortSignal): Promise<unknown> }).prompt({ childSessionId: target, requestId: 'review-delegate', content: [{ type: 'text', text: message }], delivery: 'queue' }, new AbortController().signal)
      await (h.ctx.subagents as unknown as { waitForTreeWork(agent: unknown): Promise<boolean> }).waitForTreeWork(parent.agent)
      expect(outcome).toMatchObject({ answer: 'The new task completed.' })
    } finally { observe(); stop?.(); await parent.dispose() }
  } else {
    const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
    attach(task.agent as unknown as HostAgent)
    try {
      task.agent.followup(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }))
      await task.agent.whenIdle()
      expect(outcome).toMatchObject({ answer: 'The new task completed.' })
    } finally { stop?.(); await task.dispose() }
  }
}, 30_000)



it.each(['root', 'child'] as const)('direct human continuation can archive a Document from %s', async kind => {
  let target = ''
  let project = ''
  let documentId = ''
  const replies: string[] = []
  const h = await host(undefined, options => {
    if (options.sessionId === target) {
      const at = options.messages.findLastIndex(message => message.role === 'user' && text(message).startsWith('ARCHIVE_NEW'))
      if (at < 0) return 'No request.'
      const calls = options.messages.slice(at + 1).filter(message => message.role === 'tool')
      if (calls.length === 0) return { name: 'mnemon_document_manage', args: { action: 'archive', id: documentId } }
      replies.push(...calls.map(text))
      return 'Settled.'
    }
    if (!options.messages.some(message => message.role === 'user' && text(message).includes('[dsh-mnemon:delegated document-archive]'))) return undefined
    const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
    const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
    return { name: 'mnemon_subagent_result', args: { requestId, result: { action: 'planned', summary: 'Requested archive.', memoryBodyId: project } } }
  })
  project = h.project
  const created = await h.lifecycle.mutateDocumentTask('', { action: 'create', title: 'Archive request', content: CANDIDATE }, h.f.workspace)
  documentId = created.document!.id
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  target = kind === 'root' ? saved.sessionId : saved.runId!
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(kind === 'child' ? saved.sessionId : target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  try {
    const content = [{ type: 'text' as const, text: 'ARCHIVE_NEW: archive this Document now.' }]
    if (kind === 'child') {
      const subagents = h.ctx.subagents as unknown as { prompt(request: object, signal: AbortSignal): Promise<unknown>; waitForTreeWork?(agent: unknown): Promise<boolean>; waitForChildren?(agent: unknown): Promise<boolean> }
      await subagents.prompt({ parentSessionId: task.agent.id, childSessionId: target, mode: 'continuable', requestId: 'archive-continuation', content, delivery: 'queue' }, new AbortController().signal)
      await (subagents.waitForTreeWork?.(task.agent) ?? subagents.waitForChildren!(task.agent))
    } else task.agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    await task.agent.whenIdle()
    const stored = await h.f.graph.source('documents', { storage: 'workspace', workspaceId: h.f.workspace }).read<DocumentView>('document', { id: documentId })
    expect(stored.status, replies.join('\n')).toBe('archived')
  } finally { await task.dispose() }
}, 30_000)


it('first human steer receives fresh View guidance after an automatic first step', async () => {
  let target = ''
  let humanPrompt = ''
  const h = await host(undefined, options => {
    if (options.sessionId !== target) return undefined
    if (options.messages.some(message => message.role === 'user' && text(message).startsWith('HUMAN_STEER'))) {
      humanPrompt = JSON.stringify(options.messages)
      return 'Fresh user request handled.'
    }
    return { name: 'mnemon_recall', args: { query: 'Automatic query must refuse', mode: 'keyword' } }
  })
  const saved = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)
  target = saved.runId!
  const task = await h.ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: { provider: 'scripted', model: 'fixture' } })
  let steered = false
  const stop = h.ctx.on('tools/result', (execution) => {
    if (execution.agent?.id !== target || steered) return
    steered = true
    task.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'HUMAN_STEER: handle this fresh request.' }], source: { kind: 'user' } }))
  })
  try {
    task.agent.followup(createPluginMessage('Automatic first step.', 'instructions') as never)
    await task.agent.whenIdle()
    expect(steered).toBe(true)
    expect(humanPrompt).toContain('This is a new user request in a completed Mnemon task conversation.')
  } finally { stop(); await task.dispose() }
}, 30_000)
