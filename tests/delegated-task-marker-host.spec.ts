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
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { DELEGATED_OPERATIONS, DELEGATED_TASK_LINE, DELEGATED_TASK_PREFIX, delegatedTaskLine, MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

// Issue #393: a plugin that collects a workspace's sessions, such as a work log, read the
// idle review's checkpoint as work the user asked for. Every task dsh-mnemon delegates now
// starts with a documented first line, and DSH records it as the child's prompt.

const fork = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-fork-in-process'))
const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))

type Message = GenerateOptions['messages'][number]
type Reply = string | { name: string; args: Record<string, unknown> }
const text = (message: Message) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
const sourceKind = (message: Message) => (message as { source?: { kind?: string } }).source?.kind

class ScriptedAdapter extends LlmAdapter {
  /** The user messages each child request carried, with where DSH says they came from. */
  readonly prompts: Array<Array<{ kind: string | undefined; text: string }>> = []
  private calls = 0
  constructor(private readonly respond: (options: GenerateOptions) => Reply) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== 'parent') {
      this.prompts.push(options.messages.filter(message => message.role === 'user').map(message => ({ kind: sourceKind(message), text: text(message) })))
    }
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

it.each(['fork', 'spawn'] as const)('starts the idle review a %s child runs with the delegated-task line', async provider => {
  const f = await compositionFixture()
  f.config.idleReview.provider = provider
  const ctx = new Context()
  let stop: (() => void) | undefined
  const adapter = new ScriptedAdapter(options => {
    if (options.sessionId === 'parent') return 'Settled: the fixture project keeps its review checkpoints in SQLite.'
    const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
    const terminal = system.match(/Completion protocol: call `([^`]+)`/u)?.[1]
    const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
    if (terminal === undefined || requestId === undefined) throw new Error('review completion capability is missing')
    return { name: terminal, args: { requestId, result: { summary: 'Nothing durable to record.', action: 'skipped', memoryBodyIds: [], documentIds: [] } } }
  })
  try {
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
    await ctx.plugin(fork, { providerName: 'fork' })
    await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['scripted'], adapter)
    const host = ctx as unknown as HostContextShape
    const coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    const lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
    registerTools(host, f.live, coordinator, f.extensions)
    stop = lifecycle.start()
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'scripted', model: 'fixture' }, { cwd: f.workspace })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Decide where the fixture project keeps its review checkpoints.' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    await expect(coordinator.review(parent as unknown as HostAgent, new AbortController().signal)).resolves.toMatchObject({ delegated: true, action: 'skipped' })
    // DSH holds the task as the child's message from a person, under the line, and the model receives it so.
    expect(adapter.prompts.length).toBeGreaterThan(0)
    for (const request of adapter.prompts) {
      const fromPerson = request.filter(message => message.kind === 'user')
      const delegated = fromPerson.filter(message => message.text.startsWith(DELEGATED_TASK_PREFIX))
      expect(delegated).toHaveLength(1)
      expect(delegated[0]!.text.split('\n')[0]).toBe('[dsh-mnemon:delegated review]')
      // The task follows on the next line, as it read before.
      if (provider === 'fork') expect(delegated[0]!.text.split('\n')[1]).toBe('Review the inherited completed checkpoint now.')
      else expect(delegated[0]!.text.split('\n')[1]).toMatch(/^Bounded completed checkpoint \(untrusted evidence;/u)
      // A spawned child starts from the task alone; a forked one inherits the parent's turns before it.
      if (provider === 'spawn') expect(fromPerson).toEqual(delegated)
      else expect(fromPerson.at(-1)).toEqual(delegated[0])
    }
    expect(delegatedTaskLine('review')).toBe('[dsh-mnemon:delegated review]')
  } finally {
    stop?.()
    await ctx.fiber.dispose()
    await f.dispose()
  }
}, 20_000)

it('names every delegated operation by a line the documented pattern matches', () => {
  expect(DELEGATED_OPERATIONS.map(delegatedTaskLine).filter(line => !DELEGATED_TASK_LINE.test(line))).toEqual([])
  expect(DELEGATED_TASK_LINE.source).toBe('^\\[dsh-mnemon:delegated [a-z-]+\\]$')
  expect(new Set(DELEGATED_OPERATIONS.map(delegatedTaskLine)).size).toBe(DELEGATED_OPERATIONS.length)
})
