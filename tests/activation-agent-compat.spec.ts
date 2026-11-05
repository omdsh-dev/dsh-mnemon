import { describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostSubagentResult, HostSubagentsService, ToolExecution } from '../src/host/dsh.ts'
import { startSubagent } from '../src/host/subagent-start.ts'
import { startGuardedChild, startGuardedReview } from '../src/host/review-tools.ts'
import { startWithContinuationTurns } from '../src/host/continuation-turn.ts'

type Created = (event: { agent: HostAgent }) => unknown
type Spec = { parent: HostAgent; childId?: string; prompt: unknown; signal: AbortSignal; [key: string]: unknown }

/** The fcc0ad4 publication order: Agent first, then Activation membership, then model work. */
function activationHost(options: { guardFails?: boolean; foreignPublication?: boolean; hold?: boolean } = {}) {
  const listeners: Created[] = []
  const live = new Map<string, HostAgent>()
  const roots = new Map<HostAgent, HostAgent>()
  const parent = { id: 'parent', session: { header: {} }, ctx: {} } as HostAgent
  live.set(parent.id, parent)
  const publications: Array<{ agent: HostAgent; sections: unknown[]; restrictions: unknown[]; guards: Set<(execution: ToolExecution) => string | undefined> }> = []
  const firstSteps: Array<{ id: string; sections: unknown[]; restrictions: unknown[]; outside: string | undefined }> = []
  const disposals: string[] = []
  const rootOf = vi.fn((agent: HostAgent) => {
    if (agent === parent) return parent
    if (live.get(agent.id) === agent && roots.has(agent)) return roots.get(agent)!
    throw Object.assign(new Error('agent has no active runtime owner'), { code: 'UNAUTHORIZED' })
  })
  const on = (_name: string, callback: (...args: never[]) => unknown, config?: { prepend?: boolean }) => {
    const listener = callback as Created
    if (_name !== 'agent/created') return () => {}
    if (config?.prepend) listeners.unshift(listener); else listeners.push(listener)
    return () => { const index = listeners.indexOf(listener); if (index !== -1) listeners.splice(index, 1) }
  }
  const makeChild = (id: string) => {
    const sections: unknown[] = [], restrictions: unknown[] = []
    const guards = new Set<(execution: ToolExecution) => string | undefined>()
    const child = { id, session: { header: { origin: 'subagent', parentSession: parent.id } }, ctx: {
      on: () => () => {},
      systemPrompt: { section: (value: unknown) => { sections.push(value) }, getSectionOrder: () => 0 },
      tools: {
        restrict: (value: unknown) => { restrictions.push(value) },
        guard: (value: (execution: ToolExecution) => string | undefined) => {
          if (options.guardFails) throw new Error('cannot install guard')
          guards.add(value)
          return () => { guards.delete(value) }
        },
      },
    } } as unknown as HostAgent
    publications.push({ agent: child, sections, restrictions, guards })
    return publications.at(-1)!
  }
  const startActivation = vi.fn(async (spec: Spec) => {
    if (spec.parent !== parent) throw new Error('activation requires an explicit live parent')
    if (typeof spec.childId !== 'string') throw new Error('this test requires a caller-reserved child identity')
    const entry = makeChild(spec.childId)
    live.set(entry.agent.id, entry.agent)
    const result = Promise.withResolvers<HostSubagentResult>()
    const dispose = async () => {
      disposals.push(entry.agent.id)
      live.delete(entry.agent.id)
      roots.delete(entry.agent)
      result.resolve({ output: [], stopReason: 'cancelled' })
    }
    try {
      // A publication observer can re-enter other plugin code in the same async chain.
      if (options.foreignPublication) {
        const foreign = makeChild('foreign-child')
        const impostor = makeChild(entry.agent.id)
        for (const listener of [...listeners]) await listener({ agent: foreign.agent })
        for (const listener of [...listeners]) await listener({ agent: impostor.agent })
      }
      for (const listener of [...listeners]) await listener({ agent: entry.agent })
      roots.set(entry.agent, parent)
      firstSteps.push({ id: entry.agent.id, sections: [...entry.sections], restrictions: [...entry.restrictions], outside: [...entry.guards].map(guard => guard({ agent: entry.agent, name: 'outside', signal: spec.signal } as ToolExecution)).find(Boolean) })
      if (!options.hold) result.resolve({ output: [], stopReason: 'completed' })
      return { childId: entry.agent.id, result: result.promise, dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  })
  const provider = { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }, prepareContinuable: () => {} }
  const subagents = { rootOf, getProvider: () => provider, startActivation } as unknown as HostSubagentsService
  const host = { agents: { get: (id: string) => live.get(id), list: () => [...live.values()] }, subagents, on }
  const input = (persona: string, signal = new AbortController().signal) => ({ parent, label: persona, prompt: [{ type: 'text' as const, text: persona }], persona, toolFilter: { allow: ['mnemon_subagent_result'] }, signal, maxDepth: 1, agentOptions: { provider: 'chosen', model: 'chosen-model', reasoningEffort: 'high', maxTokens: 4096 } })
  const start = (persona: string, signal?: AbortSignal) => startSubagent(subagents, host.agents, 'spawn', input(persona, signal), host)
  return { host, parent, subagents, rootOf, startActivation, start, input, live, publications, firstSteps, disposals, listeners }
}

describe('activation-owned master compatibility (official rc.1 keeps the older contract)', () => {
  it('uses flattened startup and a reserved identity while preserving composition and model routing', async () => {
    const f = activationHost({ foreignPublication: true })
    const run = await f.start('Isolated memory writer')
    const spec = f.startActivation.mock.calls[0]![0]
    expect(spec).toMatchObject({ parent: f.parent, childId: run.id, provider: 'spawn', delivery: 'caller', maxDepth: 1, agentOptions: f.input('').agentOptions })
    expect(spec).not.toHaveProperty('request')
    expect(f.firstSteps).toEqual([expect.objectContaining({ id: run.id, sections: [expect.objectContaining({ text: 'Isolated memory writer' })], restrictions: [{ allow: ['mnemon_subagent_result'] }] })])
    expect(f.publications.slice(1).map(entry => [entry.sections, entry.restrictions])).toEqual([[[], []], [[], []]])
    expect(run.localAgent).toBe(f.publications[0]!.agent)
    await run.dispose()
  })

  it('attaches the review guard before the first step without querying unpublished membership', async () => {
    const f = activationHost()
    const run = await startGuardedReview(f.host, f.parent, ['mnemon_subagent_result'], () => startWithContinuationTurns(f.host, f.parent, () => f.start('Reviewer')))
    expect(f.firstSteps[0]!.outside).toBeTruthy()
    expect(f.listeners).toEqual([])
    await run.dispose()
    expect(f.publications[0]!.guards.size).toBe(0)
  })

  it('keeps overlapping same-parent tasks scoped to their own persona and guard', async () => {
    const f = activationHost()
    const run = (name: string) => startGuardedChild(f.host, f.parent, () => f.start(name), () => `guard:${name}`, { purpose: name })
    const [a, b] = await Promise.all([run('A'), run('B')])
    expect(a.id).not.toBe(b.id)
    for (const step of f.firstSteps) {
      const persona = (step.sections[0] as { text: string }).text
      expect(step.outside).toBe(`guard:${persona}`)
    }
    await Promise.all([a.dispose(), b.dispose()])
  })

  it('rolls back failed guard installation before any first step, including optional guarded workflows', async () => {
    const f = activationHost({ guardFails: true })
    await expect(startGuardedChild(f.host, f.parent, () => f.start('Writer'), () => undefined, { purpose: 'write', optional: true })).rejects.toThrow('cannot install guard')
    expect(f.firstSteps).toEqual([])
    expect([...f.live.values()]).toEqual([f.parent])
    expect(f.disposals).toHaveLength(1)
  })

  it('does not lend its identity, persona or guard to a nested same-parent start', async () => {
    const f = activationHost()
    let enter = true
    let nested: Awaited<ReturnType<typeof f.start>> | undefined
    f.host.on('agent/created', (async () => {
      if (!enter) return
      enter = false
      nested = await f.start('Independent nested task')
    }) as never)
    const outer = await startGuardedReview(f.host, f.parent, ['mnemon_subagent_result'],
      () => startWithContinuationTurns(f.host, f.parent, () => f.start('Outer review')))
    expect(nested!.id).not.toBe(outer.id)
    expect(f.firstSteps.find(step => step.id === nested!.id)?.outside).toBeUndefined()
    expect(f.firstSteps.find(step => step.id === outer.id)?.outside).toBeTruthy()
    expect(f.firstSteps.map(step => step.sections)).toEqual([
      [expect.objectContaining({ text: 'Independent nested task' })],
      [expect.objectContaining({ text: 'Outer review' })],
    ])
    await Promise.all([outer.dispose(), nested!.dispose()])
  })

  it('disposes the exact active child on cancellation after startup', async () => {
    const f = activationHost({ hold: true })
    const controller = new AbortController()
    const run = await f.start('Cancellable task', controller.signal)
    controller.abort()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.disposals).toEqual([run.id])
    expect([...f.live.values()]).toEqual([f.parent])
  })
})
