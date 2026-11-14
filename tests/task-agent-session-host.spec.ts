import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { HostAgent, HostContextShape, HostSession, HostSubagentRun } from '../src/host/dsh.ts'
import type { DocumentView } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import type { Insight, MemorySpaceCatalog, MemorySpaceView, PreparedMemoryPlacement } from 'dsh-mnemon-source-memory-spaces/contracts'
import { startWithContinuationTurns } from '../src/host/continuation-turn.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { startGuardedReview } from '../src/host/review-tools.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { startSubagent } from '../src/host/subagent-start.ts'
import { registerTools } from '../src/host/tools.ts'
import { createPluginMessage } from '../src/host/plugin-message.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { executeTool, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'
import { memoryGraphFixture } from './helpers/memory-graph.ts'

// The released Host hides detached task sessions (#435). Activation-owned master requires
// ordinary task roots, discoverable through ACP. The WebUI hides non-current blank roots;
// do not inject conversation turns to force visibility. Exercise persistence and ACP.
const activationTrees = typeof (SubagentRuntime.prototype as unknown as { rootOf?: unknown }).rootOf === 'function'
// DSH 0.2.0's one-shot children have no managed continuation descriptor or public
// activation start. Keep their original task coverage; cold-child prompt cases need 0.2.1+.
const managedActivations = typeof (SubagentRuntime.prototype as unknown as { startActivation?: unknown }).startActivation === 'function'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))
const sessionQuery = await import(requireDsh.resolve('@deepseek-ai/dsh-session-query'))
// DSH's ACP agent plugin takes its message stream from `config.stream`, as its own tests give it one.
const acp = await import(requireDsh.resolve('@deepseek-ai/dsh-acp')) as { inject: string[]; apply(ctx: Context, config: object): void }

describe('task agent session host', () => {
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

it.skipIf(!managedActivations).each([false, true])('isolates task completion notices while preserving concurrent parent input (%s)', async concurrentInput => {
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



it.skipIf(!managedActivations || activationTrees)('an unmarked legacy child cannot gain memory from automatic cold resume', async () => {
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



for (const kind of ['root', 'child'] as const) {
  it.skipIf(kind === 'child' && !managedActivations)(`direct human continuation can archive a Document from ${kind}`, async () => {
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
}


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
})

describe('agent ownership host', () => {
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

  it.skipIf(typeof SubagentRuntime.prototype !== 'object' || !('resolveName' in SubagentRuntime.prototype))('keeps repeated memory workers recognizable and addressable after completion (#616)', async () => {
    const f = await fixture('spawn', false, true)
    try {
      await f.ctx.plugin(sessionQuery.default)
      const caller = f.parent as unknown as HostAgent
      const signal = new AbortController().signal
      const runs = await Promise.all([1, 2].map(() => f.coordinator.answer(caller, 'Synthetic question', [], signal)))
      const service = f.ctx.subagents as unknown as {
        listDescendants(id: string): Promise<Array<{ id: string; name: string }>>
        resolveName(agent: unknown, name: string, signal: AbortSignal): Promise<string>
      }
      const catalog = await service.listDescendants(f.parent.id)
      expect(catalog).toHaveLength(2)
      expect(new Set(catalog.map(child => child.name)).size).toBe(2)
      for (const child of catalog) {
        expect(child.name).toMatch(/^mnemon-answer-[a-f0-9]{16}$/u)
        expect(await service.resolveName(f.parent, child.name, signal)).toBe(child.id)
        expect(runs.some(run => run.delegation.runId === child.id)).toBe(true)
        expect(f.host.agents.get(child.id)).toBeUndefined()
      }
    } finally { await f.close() }
  })

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
      } else {
        vi.spyOn(Object.getPrototypeOf(f.ctx.tools) as typeof f.ctx.tools, 'guard').mockImplementation(() => { throw new Error('Synthetic publication failure') })
      }
      await expect(f.start()).rejects.toThrow('Synthetic publication failure')
      expect(f.counts()).toEqual({ modelCalls: 0, allowedCalls: 0, outsideCalls: 0 })
      expect(f.host.agents.list?.().filter(agent => agent.id !== f.parent.id)).toEqual([])
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
      await f.providerFiber.await()
      await expect(ask()).resolves.toMatchObject({ delegation: { provider: 'renamed-local' } })
      await f.providerFiber.dispose()
      await expect(ask()).rejects.toThrow('requires a non-inheriting DSH subagent provider')
      expect(f.counts().modelCalls).toBe(3)
    } finally { coordinator.dispose(); await f.close() }
  })
})

describe('asynchronous Recall with the real DSH host', () => {
  type Response = string | { name: string; args: Record<string, unknown> }
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  class SessionReads extends SessionQueryEngine {
    override async searchSessions(): Promise<never> { throw new Error('unexpected full-text session search') }
    override async searchEvents(): Promise<never> { throw new Error('unexpected full-text event search') }
  }

  class AsyncAdapter extends LlmAdapter {
    private calls = 0
    constructor(private readonly respond: (options: GenerateOptions) => Response | Promise<Response>) { super() }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const response = await this.respond(options)
      options.signal?.throwIfAborted()
      const id = `test-call-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
      if (typeof response === 'string') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: response }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
      } else {
        const args = JSON.stringify(response.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: response.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: response.name, arguments: args } }
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: typeof response === 'string' ? 'stop' : 'tool-calls' } }
    }
  }

  async function gate(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    const aborted = Promise.withResolvers<void>()
    const abort = () => aborted.reject(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      signal?.throwIfAborted()
      await Promise.race([promise, aborted.promise])
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  interface CompatibleSubagentContinuation {
    followup?(parent: Agent, childId: SessionId, content: ContentBlock[], options: { source: { kind: 'user' }; signal: AbortSignal }): Promise<unknown>
    sendMessage?(sender: Agent, targetId: SessionId, content: ContentBlock[], options: { signal: AbortSignal }): Promise<unknown>
  }

  async function continueChild(runtime: SubagentRuntime, parent: Agent, childId: SessionId, content: ContentBlock[]): Promise<void> {
    const compatible = runtime as unknown as CompatibleSubagentContinuation
    const signal = new AbortController().signal
    if (typeof compatible.sendMessage === 'function') { await compatible.sendMessage(parent, childId, content, { signal }); return }
    if (typeof compatible.followup === 'function') { await compatible.followup(parent, childId, content, { source: { kind: 'user' }, signal }); return }
    throw new TypeError('Unsupported DSH subagent continuation API')
  }

  async function harness(respond: (options: GenerateOptions) => Response | Promise<Response>) {
    const root = await mkdtemp(join(tmpdir(), 'mnemon-async-host-'))
    const ctx = new Context()
    const memory = memoryGraphFixture()
    const runtime = new LiveMnemonRuntime(memory.graph, undefined, undefined, memory.extensions)
    let stop: (() => void) | undefined
    cleanups.push(async () => {
      try { await ctx.fiber.dispose() } finally {
        stop?.()
        runtime.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionReads)
    await ctx.plugin(SystemPrompt)
    await loadTools(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new AsyncAdapter(respond))
    const host = ctx as unknown as HostContextShape
    const coordinator = new MnemonSubagentCoordinator(host.subagents, runtime)
    const lifecycle = new MnemonLifecycle(host, coordinator, memory.graph.config, runtime)
    registerTools(host, runtime, coordinator, memory.extensions)
    stop = lifecycle.start()
    const children: Agent[] = []
    const recalls: ToolExecutionResult[] = []
    ctx.on('agent/created', ({ agent }): undefined => { if (agent.session.header.origin === 'subagent') children.push(agent) })
    ctx.on('tools/result', (execution, result) => { if (execution.name === 'mnemon_recall') recalls.push(result) })
    ctx.tools.register({
      name: 'test_start_child',
      description: 'Start one asynchronous child.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(_args, execution) {
        if (execution.agent === undefined) throw new Error('test tool requires an Agent')
        const subagents = ctx.subagents as unknown as { rootOf?: unknown; startContinuable?: (spec: unknown) => Promise<unknown>; startActivation?: (spec: unknown) => Promise<{ childId: string; messageId?: string }> }
        const spec = { provider: 'spawn', label: 'Recall task', request: { parent: execution.agent, prompt: [{ type: 'text', text: 'Recall release history.' }] }, signal: execution.signal }
        if (typeof subagents.startContinuable === 'function') return subagents.startContinuable(spec)
        const activation = await subagents.startActivation!(typeof subagents.rootOf === 'function'
          ? { provider: spec.provider, label: spec.label, ...spec.request, signal: spec.signal, delivery: 'parent' }
          : { ...spec, delivery: 'parent' })
        return { childId: activation.childId, messageId: activation.messageId }
      },
    })
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const runParent = async () => {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
      await parent.whenIdle()
    }
    return { ...memory, ctx, runtime, lifecycle, parent, children, recalls, runParent }
  }

  it('keeps the dispatch authority after parent completion, a later turn and a runtime swap', async () => {
    const release = Promise.withResolvers<void>()
    let parentCalls = 0
    let childCalls = 0
    const value = await harness(async options => {
      if (options.sessionId === 'parent') return parentCalls++ === 0 ? { name: 'test_start_child', args: {} } : 'Parent done.'
      if (childCalls++ === 0) {
        await gate(release.promise, options.signal)
        return { name: 'mnemon_recall', args: { query: 'release history' } }
      }
      return 'Child done.'
    })
    await value.runParent()
    expect(value.children).toHaveLength(1)
    const child = value.children[0]!
    await vi.waitFor(() => expect(childCalls).toBe(1), { timeout: 5_000 })
    const dispatchView = value.views.activeTurn(child.id)!.view.id
    expect(value.views.activeTurn(value.parent.id)).toBeUndefined()
    const replacement = memoryGraphFixture(['replacement'])
    value.runtime.swap(replacement.graph)
    await value.runParent()
    expect(value.runtime.forAgent(child as unknown as HostAgent)).toBe(value.graph)
    expect(value.views.activeTurn(child.id)!.view.id).toBe(dispatchView)
    expect(value.lifecycle.snapshot().activeAgents).toBe(1)
    release.resolve()
    await vi.waitFor(() => expect(value.ctx.agents.get(child.id)).toBeUndefined(), { timeout: 5_000 })
    expect(value.recalls).toEqual([expect.objectContaining({ isError: false, value: expect.objectContaining({ results: [expect.objectContaining({ memoryBodyId: 'project' })] }) })])
    expect(value.search).toHaveBeenCalledOnce()
    expect(replacement.search).not.toHaveBeenCalled()
    expect(value.views.activeTurn(child.id)).toBeUndefined()
    expect(value.runtime.forAgent(child as unknown as HostAgent)).toBe(replacement.graph)
  }, 15_000)

  it('gives a cold-resumed child a new pin and retrieval budget instead of replaying its previous activation', async () => {
    let parentCalls = 0
    let childCalls = 0
    const value = await harness(options => {
      if (options.sessionId === 'parent') return parentCalls++ === 0 ? { name: 'test_start_child', args: {} } : 'Parent done.'
      const step = childCalls++ % 4
      return step === 3 ? 'Child done.' : { name: 'mnemon_recall', args: { query: step === 0 ? 'release history' : step === 1 ? 'release details' : 'one query too many' } }
    })
    await value.runParent()
    expect(value.children).toHaveLength(1)
    const child = value.children[0]!
    await vi.waitFor(() => expect(value.ctx.agents.get(child.id)).toBeUndefined(), { timeout: 5_000 })
    expect(value.search).toHaveBeenCalledTimes(2)
    const replacement = memoryGraphFixture(['replacement'])
    value.runtime.swap(replacement.graph)
    await continueChild(value.ctx.subagents, value.parent, child.id, [{ type: 'text', text: 'Recall release history again.' }])
    await vi.waitFor(() => expect(value.ctx.agents.get(child.id)).toBeUndefined(), { timeout: 5_000 })
    expect(value.children).toHaveLength(2)
    expect(value.children[1]!.id).toBe(child.id)
    expect(value.children[1]).not.toBe(child)
    expect(replacement.search).toHaveBeenCalledTimes(2)
    expect(value.recalls).toHaveLength(6)
    expect(value.recalls.every(result => !result.isError)).toBe(true)
    expect(value.recalls[3]).toMatchObject({ value: { query: 'release history', results: [expect.objectContaining({ memoryBodyId: 'replacement' })] } })
    expect(value.views.activeTurn(child.id)).toBeUndefined()
    expect(replacement.views.activeTurn(child.id)).toBeUndefined()
  }, 15_000)
})

describe('remember target host (#387)', () => {
  type Message = GenerateOptions['messages'][number]
  type Reply = string | { name: string; args: Record<string, unknown> }
  const text = (message: Message) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')

  class RememberAdapter extends LlmAdapter {
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

  async function host(attempts: () => string[], options: { query?: boolean } = {}) {
    const f = await compositionFixture()
    const project = await f.memorySpace()
    const spaces = f.graph.source('memory-spaces')
    const trials = await spaces.mutate<MemorySpaceView>('body-create', { name: 'Tool trial batch 3', description: 'Results of tool trial batch 3: what each tool did in the third test batch.', providerId: 'holographic', active: true })
    await spaces.mutate('remember', { memoryBodyId: trials.id, content: 'Batch 3 opened with the search tool.', category: 'fact', source: 'external' })
    await spaces.mutate('body-update', { memoryBodyId: trials.id, active: false })
    const ctx = new Context()
    const tried: string[] = []
    const seen: string[] = []
    const resumed: string[] = []
    const adapter = new RememberAdapter(options => {
      if (options.sessionId === 'parent') return 'Noted.'
      const users = options.messages.filter(message => message.role === 'user').map(text)
      const resume = users.findLastIndex(message => message.includes('RESUME:'))
      if (resume >= 0) {
        const after = options.messages.slice(options.messages.findLastIndex(message => message.role === 'user' && text(message).includes('RESUME:')) + 1)
        const answered = after.filter(message => message.role === 'tool').map(text)
        if (answered.length === 0) return { name: 'mnemon_remember', args: { content: 'Resumed: the index rebuild took four minutes.', memoryBodyId: trials.id } }
        resumed.push(...answered)
        return 'Done.'
      }
      const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
      const terminal = system.match(/Completion protocol: call `([^`]+)`/u)?.[1]
      const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
      if (terminal === undefined || requestId === undefined) throw new Error('writer completion capability is missing')
      const results = options.messages.filter(message => message.role === 'tool').map(text)
      seen.splice(0, seen.length, ...results)
      const plan = attempts()
      const step = results.length
      if (step < plan.length) {
        tried.push(plan[step]!)
        return { name: 'mnemon_remember', args: { content: 'Tool trial batch 3: the search tool returned stale results until the index was rebuilt.', memoryBodyId: plan[step]! } }
      }
      return { name: terminal, args: { requestId, result: { summary: 'Saved the batch 3 finding.', action: 'stored', memoryBodyIds: [plan.at(-1)!] } } }
    })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    if (options.query === true) await ctx.plugin(sessionQuery.default)
    await ctx.plugin(SystemPrompt)
    await loadTools(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['scripted'], adapter)
    const dshHost = ctx as unknown as HostContextShape
    const coordinator = new MnemonSubagentCoordinator(dshHost.subagents, f.live, dshHost)
    const lifecycle = new MnemonLifecycle(dshHost, coordinator, f.config, f.live)
    registerTools(dshHost, f.live, coordinator, f.extensions)
    const stop = lifecycle.start()
    disposers.push(async () => { stop(); await ctx.fiber.dispose(); await f.dispose() })
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'scripted', model: 'fixture' }, { cwd: f.workspace })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'We just finished tool trial batch 3.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const directory = async () => new Map((await spaces.read<MemorySpaceCatalog>('body-directory')).items.map(body => [body.id, body]))
    const holds = async (id: string, words: string) => ((await spaces.read<{ results: Array<{ memoryBodyId?: string; content: string }> }>('search', { query: words, memoryBodyIds: [id] })).results)
      .some(result => result.content.includes(words))
    const refusals = () => seen.filter(result => /requested for Memory Space|is switched off/u.test(result))
    const agents = (ctx as unknown as { agents: { get(id: string): { whenIdle(): Promise<void> } | undefined } }).agents
    return { coordinator, dsh: dshHost, agents, parent: parent as unknown as HostAgent, project: project.id, trials: trials.id, tried, refusals, resumed, directory, holds }
  }

  it('writes where mnemon_remember named, though another space describes the memory better', async () => {
    let plan: string[] = []
    const h = await host(() => plan)
    plan = [h.trials, h.project]
    const result = await h.coordinator.remember(h.parent, { content: 'Tool trial batch 3: the search tool returned stale results until the index was rebuilt.', memoryBodyId: h.project }, new AbortController().signal)
    expect(h.tried).toEqual([h.trials, h.project])
    expect(h.refusals()).toEqual([expect.stringContaining(`requested for Memory Space ${JSON.stringify(h.project)}`)])
    expect(result).toMatchObject({ delegated: true, memoryBodyIds: [h.project] })
    expect(result).not.toHaveProperty('activatedMemoryBodyIds')
    expect(await h.holds(h.project, 'stale results')).toBe(true)
    const spaces = await h.directory()
    expect(spaces.get(h.trials)?.active).toBe(false)
  })

  it('never switches on an inactive space the caller did not name', async () => {
    let plan: string[] = []
    const h = await host(() => plan)
    plan = [h.trials, h.project]
    const result = await h.coordinator.remember(h.parent, { content: 'Tool trial batch 3: the search tool returned stale results until the index was rebuilt.' }, new AbortController().signal)
    expect(h.refusals()).toEqual([expect.stringContaining(`Memory Space ${JSON.stringify(h.trials)} is switched off`)])
    expect(result).toMatchObject({ memoryBodyIds: [h.project] })
    expect((await h.directory()).get(h.trials)?.active).toBe(false)
  })

  it('refuses a switched-off space a model named before any writer runs', async () => {
    let plan: string[] = []
    const h = await host(() => plan)
    plan = [h.trials]
    await expect(h.coordinator.remember(h.parent, { content: 'Tool trial batch 3: the search tool returned stale results until the index was rebuilt.', memoryBodyId: h.trials }, new AbortController().signal))
      .rejects.toThrow(`Memory Space ${JSON.stringify(h.trials)} (Tool trial batch 3) is switched off, and a write would switch it back on.`)
    expect(h.tried).toEqual([])
    expect((await h.directory()).get(h.trials)?.active).toBe(false)
  })

  it('writes to a switched-off space the user picked, switches it on and says so', async () => {
    let plan: string[] = []
    const h = await host(() => plan)
    plan = [h.trials]
    const result = await h.coordinator.remember(h.parent, { content: 'Tool trial batch 3: the search tool returned stale results until the index was rebuilt.', memoryBodyId: h.trials }, new AbortController().signal, { activateTarget: true })
    expect(h.refusals()).toEqual([])
    expect(result).toMatchObject({ memoryBodyIds: [h.trials], activatedMemoryBodyIds: [h.trials] })
    expect((await h.directory()).get(h.trials)?.active).toBe(true)
  })

  it('refuses memory tools to a writer that finished, when another Agent sends it a message', async () => {
    let plan: string[] = []
    const h = await host(() => plan, { query: true })
    plan = [h.project]
    const signal = new AbortController().signal
    const result = await h.coordinator.remember(h.parent, { content: 'Tool trial batch 3: the search tool returned stale results until the index was rebuilt.', memoryBodyId: h.project }, signal)
    expect(result.memoryBodyIds).toEqual([h.project])
    const subagents = h.dsh.subagents as unknown as { sendMessage?(sender: HostAgent, target: string, content: unknown, options: { signal: AbortSignal }): Promise<unknown> }
    let delivered = false
    try {
      await subagents.sendMessage?.(h.parent, result.runId, [{ type: 'text', text: 'RESUME: save the rebuild time too.' }], { signal })
      delivered = subagents.sendMessage !== undefined
    } catch { /* This DSH keeps a finished child finished. */ }
    await h.agents.get(result.runId)?.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(h.resumed).toEqual(delivered ? [expect.stringContaining('This Mnemon task has finished')] : [])
    expect((await h.directory()).get(h.trials)?.active).toBe(false)
  })
})
