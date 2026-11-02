import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { expect, it, vi } from 'vitest'
import type { HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { dsh021, loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

// DSH 0.2.1 lists every local child among its conversation's subagents and resumes a finished one
// from its saved state when a message reaches it, with the conversation's tools and instructions
// rather than the ones Mnemon gave its run. Mnemon refuses such a child every memory tool (#387).
// tests/remember-target-host.spec.ts checks this for a writer Mnemon delegated; here it is the
// USER.md compaction child a conversation's own write starts. DSH 0.2.0 cannot resume a finished child.

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))

type Message = GenerateOptions['messages'][number]
type Reply = string | { name: string; args: Record<string, unknown> }
const text = (message: Message) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')

/** Only the model is scripted: the subagent runtime, tools and storage are real. */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly respond: (options: GenerateOptions) => Reply) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.respond(options)
    const id = `resume-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
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

const profile = ['User prefers concise answers without long preambles.', 'User prefers answers written in Simplified Chinese.']
const pending = 'Blockers first.'
const compacted = 'User prefers concise Simplified Chinese answers.'
const RESUME = 'RESUME: is there anything else to compact?'

it.skipIf(!dsh021)('refuses memory tools to a USER.md compaction child its conversation resumes after it settled', async () => {
  const f = await compositionFixture({ runtimeMemory: { userLimitBytes: 120 } })
  const ctx = new Context()
  let stop: (() => void) | undefined
  let parentCalls = 0
  const children: Agent[] = []
  // What each of the child's model requests offered, and what its resumed run read back.
  const requests: Array<{ resumed: boolean; tools: string[]; mnemonInstructions: boolean }> = []
  const resumedResults: string[] = []
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    // Resuming a finished child reads its Session through Session query, as in a profile.
    await ctx.plugin((await import(requireDsh.resolve('@deepseek-ai/dsh-session-query'))).default)
    await ctx.plugin(SystemPrompt)
    await loadTools(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(options => {
      if (options.sessionId === 'parent') {
        const content = [...profile, pending][parentCalls++]
        return content === undefined ? 'Noted.' : { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'user', content } }
      }
      const system = options.system ?? JSON.stringify(options.messages.filter(message => message.role === 'system'))
      const resumedAt = options.messages.findLastIndex(message => message.role === 'user' && text(message).includes(RESUME))
      requests.push({ resumed: resumedAt >= 0, tools: (options.tools ?? []).map(tool => tool.name).sort(), mnemonInstructions: system.includes('Completion protocol') })
      if (resumedAt >= 0) {
        // Resumed, the child tries to change USER.md once more, then replies with what it read.
        const answered = options.messages.slice(resumedAt + 1).filter(message => message.role === 'tool').map(text)
        if (answered.length === 0) return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'user', content: 'User prefers answers in English.' } }
        resumedResults.push(...answered)
        return 'Done.'
      }
      const terminal = system.match(/Completion protocol: call `([^`]+)`/u)?.[1]
      const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
      if (terminal === undefined || requestId === undefined) throw new Error('compaction completion capability is missing')
      return { name: terminal, args: { requestId, result: {
        summary: 'Merged the two answer preferences.', action: 'compacted',
        compactedEntries: [{ content: compacted, importance: 'normal', sourceIndexes: [1, 2] }],
      } } }
    }))
    ctx.on('agent/created', ({ agent }): undefined => {
      if (agent.session.header.origin === 'subagent') children.push(agent)
    })
    const host = ctx as unknown as HostContextShape
    const coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    const lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
    registerTools(host, f.live, coordinator, f.extensions)
    stop = lifecycle.start()
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: f.workspace })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Remember how I like answers.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    // The third write found USER.md full; its compaction child ran as Mnemon's task and settled.
    expect(children).toHaveLength(1)
    const child = children[0]!
    await vi.waitFor(() => expect(ctx.agents.get(child.id)).toBeUndefined(), { timeout: 10_000 })
    expect(requests).toEqual([{ resumed: false, tools: ['mnemon_subagent_result'], mnemonInstructions: true }])
    const runtime = f.graph.source('runtime')
    const before = await runtime.read<{ revision: string; entries: unknown[] }>('snapshot')
    expect(JSON.stringify(before.entries)).toContain(compacted)

    // The conversation messages the settled child, as a model or a person can from its subagent list.
    const subagents = ctx as unknown as { subagents: { sendMessage(sender: Agent, target: string, content: unknown[], options: { signal: AbortSignal }): Promise<unknown> } }
    await subagents.subagents.sendMessage(parent, child.id, [{ type: 'text', text: RESUME }], { signal: new AbortController().signal })
    await vi.waitFor(() => expect(resumedResults).toHaveLength(1), { timeout: 10_000 })

    // DSH resumed it outside Mnemon's delegation: with the conversation's tools, memory tools included.
    expect(requests.find(request => request.resumed)).toMatchObject({ mnemonInstructions: false, tools: expect.arrayContaining(['mnemon_runtime_memory']) })
    // Its write was refused, and USER.md holds what the compaction left.
    expect(resumedResults).toEqual([expect.stringContaining('This Mnemon task has finished')])
    const after = await runtime.read<{ revision: string; entries: unknown[] }>('snapshot')
    expect(after.revision).toBe(before.revision)
    expect(after.entries).toEqual(before.entries)
    // Once the resumed child settles, DSH's notice of it wakes the conversation for a fifth request;
    // let that turn end too before teardown.
    await vi.waitFor(() => expect(ctx.agents.get(child.id)?.status ?? 'idle').toBe('idle'), { timeout: 10_000 })
    await vi.waitFor(() => expect(parentCalls).toBe(5), { timeout: 10_000 })
    await parent.whenIdle()
  } finally {
    stop?.()
    await ctx.fiber.dispose()
    await f.dispose()
  }
}, 30_000)
