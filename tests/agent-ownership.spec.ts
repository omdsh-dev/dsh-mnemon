import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import type { HostAgent, HostContextShape, HostSubagentRun, HostSubagentsService, ToolExecution } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { startGuardedReview } from '../src/host/review-tools.ts'
import { startSubagent } from '../src/host/subagent-start.ts'
import { startWithContinuationTurns } from '../src/host/continuation-turn.ts'
import type { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { sessionLog } from './fixtures/session-log.ts'

// The two source Host contracts: rootOf becomes authoritative at subagent/start;
// lineageOf publishes the same exact-instance binding earlier at agent/created.
function fixture(lineage: boolean) {
  const live = new Map<string, HostAgent>()
  const owners = new Map<HostAgent, HostAgent>()
  const ancestry = new Map<HostAgent, string[]>()
  const listeners = new Map<string, Set<(event: any) => unknown>>()
  const contexts: Context[] = []
  const agent = (id: string, header = {}) => {
    const ctx = new Context()
    contexts.push(ctx)
    const value = { id, status: 'idle', ctx, session: { ...sessionLog(), header }, followup: vi.fn(), steer: vi.fn(), inject: vi.fn() } as unknown as HostAgent
    live.set(id, value)
    return value
  }
  const rootOf = (value: HostAgent) => {
    const owner = owners.get(value)
    if (live.get(value.id) !== value || owner === undefined || live.get(owner.id) !== owner) throw new Error('agent has no active runtime owner')
    return owner
  }
  const host = {
    agents: { get: (id: string) => live.get(id), list: () => [...live.values()] },
    subagents: { rootOf, ...(lineage ? { lineageOf: (value: HostAgent) => {
      try { const root = rootOf(value); return root === value ? undefined : { root, ancestors: ancestry.get(value) ?? [root.id] } } catch { return undefined }
    } } : {}) },
    on(name: string, callback: (...args: never[]) => unknown) {
      const listener = callback as (event: any) => unknown
      const set = listeners.get(name) ?? new Set()
      set.add(listener); listeners.set(name, set)
      return () => { set.delete(listener) }
    },
  }
  const emit = (name: string, event: unknown) => { for (const listener of listeners.get(name) ?? []) listener(event) }
  const root = agent('root')
  owners.set(root, root)
  const publish = (child: HostAgent, parent = root) => {
    const treeRoot = owners.get(parent) ?? parent
    ancestry.set(child, [...(ancestry.get(parent) ?? []), parent.id])
    if (lineage) owners.set(child, treeRoot)
    emit('agent/created', { agent: child, source: 'fresh' })
    owners.set(child, treeRoot)
    emit('subagent/start', { id: child.id, local: true, parentSessionId: parent.id })
  }
  return { host, root, agent, live, owners, listeners, emit, publish, async close() { for (const ctx of contexts) await ctx.fiber.dispose() } }
}

describe.each([false, true])('subagent-owned runtime lineage (lineageOf=%s)', lineage => {
  it('adopts live roots, installs newly created roots and excludes unmanaged or delegated instances', async () => {
    const f = fixture(lineage)
    const fork = f.agent('ordinary-fork', { parentSession: f.root.id })
    f.owners.set(fork, fork)
    const child = f.agent('child') // Metadata does not establish ownership.
    f.owners.set(child, f.root)
    f.agent('unmanaged', { origin: 'subagent', parentSession: f.root.id })
    const coordinator = { snapshot: () => ({}) } as unknown as MnemonSubagentCoordinator
    const lifecycle = new MnemonLifecycle(f.host as unknown as HostContextShape, coordinator, resolveConfig({ lifecycleEnabled: false }))
    let stop: (() => void) | undefined
    try {
      stop = lifecycle.start()
      expect(lifecycle.snapshot().activeAgents).toBe(2)
      const fresh = f.agent('fresh')
      f.owners.set(fresh, fresh)
      f.emit('agent/created', { agent: fresh, source: 'fresh' })
      expect(lifecycle.snapshot().activeAgents).toBe(3)
      await (fresh.ctx as unknown as Context).fiber.dispose()
      stop()
      expect(lifecycle.snapshot().activeAgents).toBe(0)
      expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true)
    } finally { stop?.(); await f.close() }
  })

  it('composes and guards the child before its first work, then removes all observers and guards', async () => {
    const f = fixture(lineage)
    const child = f.agent('child')
    const guards = new Set<(execution: ToolExecution) => string | undefined>()
    const section = vi.fn(), restrict = vi.fn()
    Object.assign(child.ctx, { systemPrompt: { section, getSectionOrder: () => 10 }, tools: { restrict, guard(callback: (execution: ToolExecution) => string | undefined) { guards.add(callback); return () => guards.delete(callback) } } })
    const dispose = vi.fn(async () => {})
    const result = Promise.withResolvers<{ output: []; stopReason: string }>()
    const subagents = Object.assign(f.host.subagents, {
      list: () => ['spawn'], getProvider: () => ({ capabilities: { outputSchema: true, depthLimit: true }, prepareContinuable() {} }),
      async startActivation() {
        f.publish(child)
        // Both source contracts publish their authoritative relation before admitting work.
        expect(section).toHaveBeenCalledOnce()
        expect(restrict).toHaveBeenCalledWith({ allow: ['result'] })
        expect([...guards].some(guard => guard({ name: 'outside', agent: child, signal: new AbortController().signal }))).toBe(true)
        return { childId: child.id, result: result.promise, dispose }
      },
    }) as unknown as HostSubagentsService
    let run: HostSubagentRun | undefined
    try {
      run = await startWithContinuationTurns(f.host, f.root, () => startGuardedReview(f.host, f.root, ['result'], () => startSubagent(subagents, f.host.agents, 'spawn', {
        parent: f.root, label: 'Synthetic review', prompt: [{ type: 'text', text: 'Synthetic task' }], signal: new AbortController().signal,
        persona: 'Synthetic reviewer', toolFilter: { allow: ['result'] },
      }, f.host)))
      expect(run.localAgent).toBe(child)
      expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true)
      result.resolve({ output: [], stopReason: 'completed' })
      await run.result
      await run.dispose()
      expect(guards.size).toBe(0)
      expect(dispose).toHaveBeenCalledOnce()
    } finally { await f.close() }
  })

  it.each(['foreign', 'replaced-child', 'replaced-root'] as const)('refuses %s ownership before granting a review tool guard', async kind => {
    const f = fixture(lineage)
    const child = f.agent('child')
    const guard = vi.fn(() => () => {})
    Object.assign(child.ctx, { tools: { guard } })
    const foreign = f.agent('foreign')
    f.owners.set(foreign, foreign)
    const dispose = vi.fn(async () => {})
    try {
      await expect(startGuardedReview(f.host, f.root, ['result'], async () => {
        if (kind === 'replaced-child') f.agent('child')
        if (kind === 'replaced-root') f.agent('root')
        f.publish(child, kind === 'foreign' ? foreign : f.root)
        return { id: child.id, localAgent: child, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose }
      })).rejects.toThrow()
      expect(guard).not.toHaveBeenCalled()
      expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true)
    } finally { await f.close() }
  })

  it('does not guard an indirect descendant published in the same async start scope', async () => {
    const f = fixture(lineage)
    const direct = f.agent('direct'), indirect = f.agent('indirect'), sibling = f.agent('sibling')
    f.publish(sibling)
    const directGuard = vi.fn(() => () => {}), indirectGuard = vi.fn(() => () => {})
    Object.assign(direct.ctx, { tools: { guard: directGuard } })
    Object.assign(indirect.ctx, { tools: { guard: indirectGuard } })
    let run: HostSubagentRun | undefined
    try {
      run = await startGuardedReview(f.host, f.root, ['result'], async () => {
        f.publish(indirect, sibling)
        f.publish(direct)
        return { id: direct.id, localAgent: direct, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
      })
      expect(directGuard).toHaveBeenCalledOnce()
      expect(indirectGuard).not.toHaveBeenCalled()
    } finally { await run?.dispose(); await f.close() }
  })
})

it('does not grant a legacy registry-owned replacement the stale Agent object\'s review guard', async () => {
  const f = fixture(false)
  const child = f.agent('child')
  const replacement = f.agent('child')
  f.owners.set(replacement, f.root)
  const guard = vi.fn(() => () => {})
  Object.assign(child.ctx, { tools: { guard } })
  const { subagents: _subagents, ...host } = f.host
  const legacy = { ...host, agents: { ...host.agents, isOwnedBy: (id: string, owner: HostAgent) => f.owners.get(f.live.get(id)!) === owner } }
  try {
    await expect(startGuardedReview(legacy, f.root, ['result'], async () => {
      f.emit('agent/created', { agent: child })
      return { id: child.id, localAgent: child, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
    })).rejects.toThrow('did not publish')
    expect(guard).not.toHaveBeenCalled()
  } finally { await f.close() }
})
