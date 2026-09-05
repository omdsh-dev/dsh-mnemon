import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import type { HostAgent, HostContextShape, HostSessionEvent } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MemoryExecutions } from '../src/host/memory-executions.ts'
import type { MnemonSubagentCoordinator } from '../src/host/subagent.ts'

describe('Mnemon lifecycle with the real DSH SystemPrompt', () => {
  it('pins and injects the first-turn Wake inside the awaited assembly boundary', async () => {
    const agentContext = new Context()
    const prompt = new SystemPrompt(agentContext, {})
    const events: HostSessionEvent[] = [{ type: 'turn/start', data: { turn: 1 } }]
    const agent = {
      id: 'real-prompt-session',
      status: 'running',
      session: { events },
      ctx: agentContext as never,
      followup: vi.fn(),
      steer: vi.fn(),
      inject: vi.fn(),
    } satisfies HostAgent
    const config = resolveConfig({ cliPath: '/fake/mnemon' })
    const pinnedTurns = new Map<string, object>()
    const composableTurns = {
      beginTurn: vi.fn(async (turnId: string, scope: object) => {
        const context = {
          turnId,
          view: {
            id: 'view-first-turn', digest: 'digest-first-turn', runtimeGeneration: 'generation:first',
            createdAt: '2026-08-23T00:00:00.000Z', strategyTypeId: 'default-three-tier', strategyInstanceKey: 'strategy:default',
            projection: [{ id: 'runtime:first', sourceInstanceKey: 'source:runtime', mode: 'eager', text: 'First-turn Wake', revision: 'r1' }],
            routes: [], actionOffers: [], readGrants: [], diagnostics: [],
          },
          scope,
          startedAt: '2026-08-23T00:00:00.000Z',
        }
        pinnedTurns.set(turnId, context)
        return context
      }),
      turn: vi.fn((turnId: string) => pinnedTurns.get(turnId)),
      memoryWake: vi.fn(() => ({
        viewId: 'view-first-turn',
        viewDigest: 'digest-first-turn',
        text: 'First-turn Wake',
        sections: [{ layerId: 'runtime', mode: 'eager', text: 'First-turn Wake' }],
      })),
      endTurn: vi.fn((turnId: string) => pinnedTurns.delete(turnId)),
    }
    const binding = {
      forAgent: vi.fn(() => ({ config, composableTurns, memoryComposition: { generation: () => ({ sourceInstances: () => [] }) } })),
      bindAgentRuntime: vi.fn(() => vi.fn()),
    }
    const runtimeSource = { ...binding, executions: new MemoryExecutions(binding as never) }
    const coordinator = { snapshot: vi.fn(() => ({ recalls: 0, writes: 0, answers: 0, reviews: 0, failures: 0 })) } as unknown as MnemonSubagentCoordinator
    const host = {
      agents: { get: (id: string) => id === agent.id ? agent : undefined, roots: () => [agent] },
      on: vi.fn(() => vi.fn()),
    } as unknown as HostContextShape
    const lifecycle = new MnemonLifecycle(host, coordinator, config, runtimeSource as never)
    const stop = lifecycle.start()

    const assembly = await prompt.assemble({ agent, signal: new AbortController().signal } as never)

    expect(composableTurns.beginTurn).toHaveBeenCalledWith('real-prompt-session:1', {
      storage: 'global',
      sessionId: 'real-prompt-session',
      agentId: 'real-prompt-session',
    }, 'agent.root-turn', expect.any(AbortSignal))
    expect(assembly.sections.some(section => section.name === 'mnemon:runtime-memory-protocol')).toBe(false)
    // The Wake no longer travels as a shared runtime-context contribution; it is
    // appended as a dsh-mnemon message so it cannot invalidate other plugins' context.
    expect(assembly.contexts).not.toContainEqual(expect.objectContaining({ name: 'mnemon:runtime-memory' }))
    expect(runtimeSource.bindAgentRuntime).toHaveBeenCalledOnce()
    expect(lifecycle.memoryView(agent.id)).toMatchObject({ id: 'view-first-turn', state: 'active', memoryText: 'First-turn Wake', turn: 1 })
    stop()
    expect(composableTurns.endTurn).toHaveBeenCalledWith('real-prompt-session:1')
  })
})
