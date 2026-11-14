import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, LlmError, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { expect, it } from 'vitest'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { RESULT_RETRY_TEXT } from '../src/host/continuation-turn.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { JsonlSessionPersistence } from './helpers/dsh-plugins.ts'
import { loadTools, loadWorkingDirectory, requireDsh } from './helpers/installed-dsh.ts'

const spawn = await import(requireDsh.resolve('@deepseek-ai/dsh-subagent-spawn-in-process'))
const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }

it.each([
  { operation: 'skill', failures: 0 },
  { operation: 'skill', failures: 1 },
  { operation: 'skill', failures: 2 },
  { operation: 'review', failures: 1 },
  { operation: 'review', failures: 2 },
] as const)('handles $failures malformed result responses in one $operation child (issue 636)', async ({ operation, failures }) => {
  const f = await compositionFixture({ idleReview: { enabled: false } })
  const ctx = new Context()
  let coordinator: MnemonSubagentCoordinator | undefined
  let stop: (() => void) | undefined
  const children: HostAgent[] = []
  let writes = 0
  let completions = 0
  let documentId: string | undefined
  class Model extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.sessionId === 'result-parent') {
        const text = 'Synthetic project decision settled.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const requestId = JSON.stringify(options.messages.filter(message => message.role === 'system')).match(/requestId `([^`]+)`/u)?.[1]
      expect(requestId).toBeDefined()
      const writing = operation === 'review' && writes === 0
      const name = writing ? 'mnemon_document_create' : 'mnemon_subagent_result'
      const input = writing ? { title: 'Synthetic result recovery', content: 'Keep one durable document after a rejected completion.' } : {
        requestId, result: operation === 'skill' ? { summary: 'Synthetic skill result.' }
          : { action: 'created', summary: 'Created one document.', documentIds: [documentId], memoryBodyIds: [] },
      }
      if (!writing) completions++
      const malformed = !writing && completions <= failures
      const args = JSON.stringify(input)
      const raw = malformed ? args.slice(0, -1) : args
      const id = `result-${writing ? 'write' : completions}` as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw }
      if (malformed) {
        // Match the published pi-ai adapter: usage, then MALFORMED_RESPONSE
        // before block-end/dispatch. Keep the original invalid stream for audit.
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        let detail = ''
        try { JSON.parse(raw) } catch (error) { detail = (error as Error).message }
        throw new LlmError(`Tool call "${name}": ${detail}`, 'MALFORMED_RESPONSE')
      }
      if (completions > 1) expect(JSON.stringify(options.messages)).toContain(RESULT_RETRY_TEXT)
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
    await loadTools(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await loadWorkingDirectory(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['fixture'], new Model())
    ctx.on('agent/created', ({ agent }) => { if (agent.id !== 'result-parent') children.push(agent as unknown as HostAgent); return undefined })
    ctx.on('tools/result', (execution, result) => {
      if (execution.name !== 'mnemon_document_create' || result.isError) return
      writes++
      documentId = (result.value as { document: { id: string } }).document.id
    })
    const host = ctx as unknown as HostContextShape
    coordinator = new MnemonSubagentCoordinator(host.subagents, f.live, host)
    registerTools(host, f.live, coordinator, f.extensions)
    const lifecycle = new MnemonLifecycle(host, coordinator, f.config, f.live)
    stop = lifecycle.start()
    const parent = await ctx.agentLoop.create(SessionId('result-parent'), { provider: 'fixture', model: 'synthetic' }, { cwd: f.workspace })
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Settle the synthetic project decision.' }] }))
    await parent.whenIdle()
    const work = operation === 'skill'
      ? coordinator.skillTask(parent as unknown as HostAgent, 'Synthetic skill', 'Return a short summary.', schema, 'Complete the synthetic task.', new AbortController().signal)
      : coordinator.review(parent as unknown as HostAgent, new AbortController().signal)
    if (failures === 2) await expect(work).rejects.toThrow('memory subagent stopped with error')
    else expect(await work).toMatchObject(operation === 'skill' ? { structured: { summary: 'Synthetic skill result.' } } : { action: 'created', documentIds: [documentId] })
    expect(children).toHaveLength(1)
    expect(completions).toBe(failures === 0 ? 1 : 2)
    expect(writes).toBe(operation === 'review' ? 1 : 0)
    const events = children[0]!.session.snapshotEvents()
    const corrections = events.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes(RESULT_RETRY_TEXT))
    expect(corrections).toHaveLength(failures === 0 ? 0 : 1)
    expect(ctx.agents.get(SessionId(children[0]!.id))).toBeUndefined()
    if (operation === 'review') expect(await f.graph.source('documents').read('snapshot')).toMatchObject({ activeCount: 1 })
  } finally { stop?.(); coordinator?.dispose(); await ctx.fiber.dispose(); await f.dispose() }
}, 20_000)
