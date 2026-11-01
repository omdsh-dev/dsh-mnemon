import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
import { expect, it, vi } from 'vitest'
import type { HostContextShape } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))

it('restores the quota on a real persisted parent resume before another child can start', async () => {
  const f = await compositionFixture({ idleReviewMs: 5_000, idleReview: { persistWatermark: true, minIntervalMs: 5_000, maxPerSession: 1 } })
  const ctx = new Context()
  let stop: (() => void) | undefined
  let childCalls = 0
  const watermark = join(f.graph.directory, 'state', 'idle-review', createHash('sha256').update('persistent-parent').digest('hex') + '.json')
  class Model extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.sessionId === 'persistent-parent') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Synthetic decision recorded in the conversation.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic decision recorded in the conversation.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      childCalls++
      // This is the first actual model request, after child creation and routing.
      expect(JSON.parse(readFileSync(watermark, 'utf8')).attempts).toBe(1)
      const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
      const name = system.match(/Completion protocol: call `([^`]+)`/u)?.[1]
      const requestId = system.match(/requestId `([^`]+)`/u)?.[1]
      if (name === undefined || requestId === undefined) throw new Error('missing completion capability')
      const args = JSON.stringify({ requestId, result: { action: 'skipped', summary: 'Synthetic checkpoint reviewed.', memoryBodyIds: [], documentIds: [] } })
      const id = 'watermark-complete' as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
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
    await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['scripted'], new Model())
    const host = ctx as unknown as HostContextShape
    const coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    registerTools(host, f.live, coordinator)
    let lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
    stop = lifecycle.start()
    let parent = await ctx.agents.create({ sessionId: SessionId('persistent-parent'), agentOptions: { provider: 'scripted', model: 'fixture' }, meta: { cwd: f.workspace } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const run = async () => {
      parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Please remember this synthetic project decision: ' + 'SQLite checkpoints. '.repeat(20) }], source: { kind: 'user' } }))
      await parent.agent.whenIdle()
    }
    await run(); await run()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(childCalls).toBe(1))
    await vi.waitFor(() => expect(lifecycle.snapshot('persistent-parent').current?.reviewRunning).toBe(false))
    await parent.dispose()
    stop()
    lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
    stop = lifecycle.start()
    parent = await ctx.agents.resume({ resumeSessionId: SessionId('persistent-parent'), agentOptions: { provider: 'scripted', model: 'fixture' } })
    expect(lifecycle.snapshot('persistent-parent').current).toMatchObject({ startSource: 'resume', idleReviewAttempts: 1, idleReviewPending: false, idleReviewWatermark: { state: 'ready', restoredAttempts: 1 } })
    await run(); await run()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(childCalls).toBe(1)
    expect(lifecycle.snapshot('persistent-parent').current?.idleReviewPending).toBe(false)
    await parent.dispose()
  } finally {
    stop?.()
    vi.useRealTimers()
    await ctx.fiber.dispose()
    await f.dispose()
  }
}, 20_000)
