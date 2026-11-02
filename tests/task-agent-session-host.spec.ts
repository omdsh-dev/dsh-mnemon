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
import type { HostContextShape, HostSession } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { startSubagent } from '../src/host/subagent-start.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

// Issue #435: DSH persists the session of every task Agent Mnemon runs outside a conversation. Its
// sidebar and ACP session list leave out a session whose header has `origin: 'subagent'`, the origin
// DSH gives its own subagents. Without it, a finished task stayed listed as an untitled conversation
// under Ungrouped wherever DSH had no projection-cache record of it, and ACP always listed it. Here
// DSH's own ACP agent lists the stored sessions, as `dsh acp` serves them to an editor, and Session
// query reads their headers.

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
 * A real DSH host with Mnemon's lifecycle, DSH's spawn provider, Session query and ACP agent, one open
 * conversation, and `plain`: a finished session created as main created a task Agent's, through
 * `agents.create` with only a cwd, which ACP lists. ACP leaves out a session that is still attached.
 */
async function host() {
  const f = await compositionFixture()
  const project = (await f.memorySpace()).id
  const ctx = new Context()
  let stop: (() => void) | undefined
  disposers.push(async () => { stop?.(); await ctx.fiber.dispose(); await f.dispose() })
  const adapter = new ScriptedAdapter(options => {
    if (options.sessionId === 'parent' || options.sessionId === 'plain') return 'Noted.'
    if (options.messages.some(message => message.role === 'user' && text(message).includes(CHILD_STEP))) return 'Maintenance step done.'
    // The Save to memory writer stores the candidate in the project space, then reports.
    const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
    const terminal = system.match(/Completion protocol: call `([^`]+)`/u)?.[1]
    const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
    if (terminal === undefined || requestId === undefined) throw new Error('writer completion capability is missing')
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
  await loadWorkingDirectory(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['scripted'], adapter)
  const dsh = ctx as unknown as HostContextShape
  const coordinator = new MnemonSubagentCoordinator(dsh.subagents, f.live, dsh)
  const lifecycle = new MnemonLifecycle(dsh, coordinator, f.config, f.live)
  registerTools(dsh, f.live, coordinator, f.extensions)
  stop = lifecycle.start()
  // An ordinary conversation, which also supplies the task Agent's model route.
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'scripted', model: 'fixture' }, { cwd: f.workspace })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'What is our release process?' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  const agents = (ctx as unknown as { agents: { create(options: object): Promise<{ agent: { followup(message: unknown): void; whenIdle(): Promise<void> }; dispose(): Promise<void> }> } }).agents
  const plain = await agents.create({ sessionId: SessionId('plain'), meta: { cwd: f.workspace }, agentOptions: { provider: 'scripted', model: 'fixture' } })
  plain.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } }))
  await plain.agent.whenIdle()
  await plain.dispose()
  const listed = await acpSessionList(ctx)
  const query = (ctx as unknown as { sessionQuery: { listSessions(): Promise<ReadonlyArray<{ header: Header }>> } }).sessionQuery
  /** Every stored session's header by id, as Session query reads them. */
  const sessions = async () => new Map((await query.listSessions()).map(record => [record.header.id, record.header]))
  return { f, dsh, lifecycle, project, sessions, listed }
}

it("keeps a Save to memory task Agent out of DSH's ACP session list and any lineage, and its writer still saves", async () => {
  const h = await host()
  expect(await h.listed()).toEqual(['plain'])

  const result = await h.lifecycle.superviseTask('', CANDIDATE, undefined, h.f.workspace)

  expect(result).toMatchObject({ delegated: true, action: 'stored', memoryBodyIds: [h.project] })
  expect(await h.listed()).toEqual(['plain'])
  const sessions = await h.sessions()
  // With no conversation, the receipt names the task Agent: a session of its own, outside any lineage.
  const task = sessions.get(result.sessionId)
  expect(task).toMatchObject({ origin: 'subagent', cwd: h.f.workspace })
  expect(task?.parentSession).toBeUndefined()
  expect(task?.delegationDepth ?? 0).toBe(0)
  // Its writer is its child, one level deep, as before.
  expect([...sessions.values()].filter(header => header.parentSession === result.sessionId))
    .toEqual([expect.objectContaining({ id: result.runId, origin: 'subagent', delegationDepth: 1 })])
}, 30_000)

it("keeps a Runtime maintenance task Agent out of DSH's ACP session list, and its child still runs under it", async () => {
  const h = await host()
  const signal = new AbortController().signal

  const outcome = await h.lifecycle.runRuntimeMaintenanceTask({ storage: 'workspace', workspaceId: h.f.workspace }, signal, async task => {
    const run = await startSubagent(h.dsh.subagents, h.dsh.agents, 'spawn', { label: 'Mnemon test child', prompt: [{ type: 'text', text: CHILD_STEP }], parent: task, signal })
    const result = await run.result
    await run.dispose()
    return { task: task.id, child: run.id, result }
  })

  expect(outcome.result).toMatchObject({ output: [{ type: 'text', text: 'Maintenance step done.' }], stopReason: 'completed' })
  expect(await h.listed()).toEqual(['plain'])
  const sessions = await h.sessions()
  expect(sessions.get(outcome.task)).toMatchObject({ origin: 'subagent', cwd: h.f.workspace })
  expect(sessions.get(outcome.task)?.parentSession).toBeUndefined()
  expect(sessions.get(outcome.child)).toMatchObject({ origin: 'subagent', parentSession: outcome.task, delegationDepth: 1 })
}, 30_000)
