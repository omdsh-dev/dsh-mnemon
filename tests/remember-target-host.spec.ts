import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, expect, it } from 'vitest'
import type { MemorySpaceCatalog, MemorySpaceView } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

// Issue #387: mnemon_remember named a Memory Space, and the delegated writer put the
// memory into another one whose description matched it better, switching that space
// back on. The writer now writes where the caller asked, or nowhere, and never switches
// on a space the caller did not name.

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))

type Message = GenerateOptions['messages'][number]
type Reply = string | { name: string; args: Record<string, unknown> }
const text = (message: Message) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')

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

/**
 * A real DSH host, spawned children included, over two Holographic spaces: `project`, active,
 * and `trials`, whose description matches the candidate better but which someone switched off.
 * `attempts` scripts the writer: the spaces it tries, in order, before it reports. `query`
 * loads DSH session query, which DSH 0.2.1 needs to continue a child that finished.
 */
async function host(attempts: () => string[], options: { query?: boolean } = {}) {
  const f = await compositionFixture()
  const project = await f.memorySpace()
  const spaces = f.graph.source('memory-spaces')
  const trials = await spaces.mutate<MemorySpaceView>('body-create', { name: 'Tool trial batch 3', description: 'Results of tool trial batch 3: what each tool did in the third test batch.', providerId: 'holographic', active: true })
  await spaces.mutate('remember', { memoryBodyId: trials.id, content: 'Batch 3 opened with the search tool.', category: 'fact', source: 'external' })
  await spaces.mutate('body-update', { memoryBodyId: trials.id, active: false })
  const ctx = new Context()
  const tried: string[] = []
  // Every tool result the writer has read so far, as its latest request carried them.
  const seen: string[] = []
  // What a finished writer read after another Agent's message resumed it.
  const resumed: string[] = []
  const adapter = new ScriptedAdapter(options => {
    if (options.sessionId === 'parent') return 'Noted.'
    const users = options.messages.filter(message => message.role === 'user').map(text)
    const resume = users.findLastIndex(message => message.includes('RESUME:'))
    if (resume >= 0) {
      // The resumed writer tries once to write into the space that is switched off.
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
  if (options.query === true) await ctx.plugin((await import(requireDsh.resolve('@deepseek-ai/dsh-session-query'))).default)
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
  // The writer tried the better-described space first and was held to the one named.
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
  // The receipt names where the memory went, whatever the writer reported.
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
  // DSH 0.2.1 resumes a finished child from its saved state; earlier DSH does not continue it.
  const subagents = h.dsh.subagents as unknown as { sendMessage?(sender: HostAgent, target: string, content: unknown, options: { signal: AbortSignal }): Promise<unknown> }
  let delivered = false
  try {
    await subagents.sendMessage?.(h.parent, result.runId, [{ type: 'text', text: 'RESUME: save the rebuild time too.' }], { signal })
    delivered = subagents.sendMessage !== undefined
  } catch { /* This DSH keeps a finished child finished. */ }
  await h.agents.get(result.runId)?.whenIdle()
  await new Promise(resolve => setTimeout(resolve, 200))
  // The resumed writer tried to write and read the refusal instead.
  expect(h.resumed).toEqual(delivered ? [expect.stringContaining('This Mnemon task has finished')] : [])
  // A write would have switched the space on.
  expect((await h.directory()).get(h.trials)?.active).toBe(false)
})
