import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import type { HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))

type Reply = string | { name: string; args: Record<string, unknown> }

/** Only the model is scripted: the subagent runtime, tools and storage are real. */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly respond: (options: GenerateOptions) => Reply) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.respond(options)
    const id = `compaction-${++this.calls}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
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

// Issue #356: with USER.md full, a profile write starts a compaction child.
it('compacts a full USER.md through a memory subagent and keeps the parent conversation out of it', async () => {
  const f = await compositionFixture({ runtimeMemory: { userLimitBytes: 120 } })
  const ctx = new Context()
  let stop: (() => void) | undefined
  const parentRequests: Array<GenerateOptions['messages']> = []
  const children: Agent[] = []
  const writes: ToolExecutionResult[] = []
  const childTools: string[][] = []
  let parentCalls = 0
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await loadTools(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(options => {
      if (options.sessionId === 'parent') {
        parentRequests.push(options.messages)
        const content = [...profile, pending][parentCalls++]
        return content === undefined ? 'Saved your preferences.' : { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'user', content } }
      }
      childTools.push((options.tools ?? []).map(tool => tool.name))
      const system = options.system ?? JSON.stringify(options.messages.filter(message => message.role === 'system'))
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
    ctx.on('tools/result', (execution, result) => {
      if (execution.name === 'mnemon_runtime_memory') writes.push(result)
    })
    const host = ctx as unknown as HostContextShape
    const coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    const lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
    registerTools(host, f.live, coordinator, f.extensions)
    stop = lifecycle.start()
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: f.workspace })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Remember how I like answers.' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    expect(writes.map(write => write.isError)).toEqual([false, false, false])
    expect(children).toHaveLength(1)
    // The child sees only its result tool and Mnemon's instructions, never the parent's memory tools; on
    // DSH 0.2.1 Mnemon registers both in the child's own scope.
    expect(childTools).toEqual([['mnemon_subagent_result']])
    const child = children[0]!
    await vi.waitFor(() => expect(ctx.agents.get(child.id)).toBeUndefined(), { timeout: 5_000 })
    const snapshot = JSON.stringify(await f.graph.source('runtime').read('snapshot'))
    expect(snapshot).toContain(compacted)
    expect(snapshot).toContain(pending)
    expect(snapshot).not.toContain(profile[0])
    // The result came back to Mnemon alone: no settlement notice reached or woke the parent.
    expect(parentRequests).toHaveLength(4)
    const sources = parentRequests.flat().map(message => (message as { source?: { kind?: string } }).source?.kind)
    expect(sources).not.toContain('subagent-settled')
    expect(parent.status).toBe('idle')
    expect(coordinator.snapshot()).toMatchObject({ compactions: 1, failures: 0 })
  } finally {
    stop?.()
    await ctx.fiber.dispose()
    await f.dispose()
  }
}, 20_000)
