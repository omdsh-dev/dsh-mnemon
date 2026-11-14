import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionUnavailableError } from '../src/core/generation.ts'
import { TurnActivityProjection } from '../src/host/activity.ts'
import { memoryReadPresentation, memoryWritePresentation, namedToolPresentation, parseMnemonActivityMeta } from '../src/host/activity-presentation.ts'
import { contextIsActive, isInactiveContextError } from '../src/host/agent-compat.ts'
import { AgentMemoryTurn, openAgentStep, openAgentTurn } from '../src/host/agent-memory-turn.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { HostAgent, HostContextShape, HostSession, HostSessionEvent } from '../src/host/dsh.ts'
import { MnemonLifecycle } from '../src/host/lifecycle.ts'
import { MemoryExecutions } from '../src/host/memory-executions.ts'
import { reviewCheckpoint } from '../src/host/review-checkpoint.ts'
import { LiveMnemonRuntime } from '../src/host/runtime.ts'
import { sessionTurnEvents } from '../src/host/session-events.ts'
import { captureTurn, TurnSkillUseProjection } from '../src/host/skill-trajectory.ts'
import type { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { subagentFailureDetail } from '../src/host/subagent-receipts.ts'
import { sessionLog } from './fixtures/session-log.ts'
import { memoryGraphFixture } from './helpers/memory-graph.ts'

describe('Host memory execution ownership', () => {
  const releases: Array<() => void> = []
  afterEach(() => { for (const release of releases.splice(0).reverse()) release() })

  function fixture() {
    const memory = memoryGraphFixture()
    const live = new LiveMnemonRuntime(memory.graph, undefined, undefined, memory.extensions)
    const agent = { id: 'root', session: { header: {}, ...sessionLog() } } as unknown as HostAgent
    const owner = new AgentMemoryTurn(agent, live)
    releases.push(() => { owner.dispose(); live.dispose() })
    return { ...memory, live, agent, owner, signal: new AbortController().signal }
  }

  it('supports the Node 20 Promise API advertised by the package', async () => {
    const f = fixture()
    const unsupported = vi.spyOn(Promise, 'withResolvers').mockImplementation(() => { throw new Error('unavailable on Node 20') })
    try { await f.owner.begin(1); expect(f.owner.current).toBeDefined() }
    finally { unsupported.mockRestore() }
  })

  it('does not acquire resources for an already canceled operation', async () => {
    const f = fixture()
    const bind = vi.spyOn(f.live, 'bindAgentRuntime')
    await expect(f.live.executions.workflow(f.agent, 'read', AbortSignal.abort(new Error('canceled')))).rejects.toThrow('canceled')
    expect(bind).not.toHaveBeenCalled()
    expect(f.snapshot).not.toHaveBeenCalled()
  })

  it('releases a failed preparation so the next operation can own the Agent', async () => {
    const f = fixture()
    vi.spyOn(f.views, 'beginTurn').mockRejectedValueOnce(new Error('cannot prepare'))
    await expect(f.live.executions.workflow(f.agent, 'read', f.signal)).rejects.toThrow('cannot prepare')
    await f.owner.begin(1)
    expect(f.owner.current?.context.turnId).toBe('root:1')
  })

  it('keeps shared preparation alive when only one waiting caller cancels', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    const prepare = f.views.beginTurn.bind(f.views)
    const begin = vi.spyOn(f.views, 'beginTurn').mockImplementationOnce(async (...args) => {
      await gate.promise
      return prepare(...args)
    })
    const canceled = new AbortController()
    const first = f.live.executions.workflow(f.agent, 'read', canceled.signal)
    const second = f.live.executions.workflow(f.agent, 'write', f.signal)
    const failed = expect(first).rejects.toThrow('one caller canceled')
    await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce())
    canceled.abort(new Error('one caller canceled'))
    await failed
    expect(begin.mock.calls[0]![3]?.aborted).toBe(false)
    gate.resolve()
    const execution = await second
    expect(f.views.activeTurn('root')).toBe(execution.context)
    execution.release()
    expect(f.views.activeTurn('root')).toBeUndefined()
  })

  it('waits for canceled preparation cleanup before a replacement turn binds', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    const prepare = f.views.beginTurn.bind(f.views)
    const begin = vi.spyOn(f.views, 'beginTurn').mockImplementationOnce(async (...args) => {
      await gate.promise
      return prepare(...args)
    })
    const canceled = new AbortController()
    const background = f.live.executions.workflow(f.agent, 'read', canceled.signal)
    const failed = expect(background).rejects.toThrow('canceled')
    await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce())
    canceled.abort(new Error('canceled'))
    await failed
    const foreground = f.owner.begin(1)
    expect(begin).toHaveBeenCalledOnce()
    gate.resolve()
    await foreground
    expect(f.views.activeTurn('root')).toBe(f.owner.current?.context)
    expect(begin).toHaveBeenCalledTimes(2)
  })

  it('reserves foreground preparation and lends its View without transferring ownership', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    const prepare = f.views.beginTurn.bind(f.views)
    const begin = vi.spyOn(f.views, 'beginTurn').mockImplementationOnce(async (...args) => {
      await gate.promise
      return prepare(...args)
    })
    const foreground = f.owner.begin(1)
    const borrowed = f.live.executions.workflow(f.agent, 'read', f.signal)
    gate.resolve()
    await foreground
    const execution = await borrowed
    expect(begin).toHaveBeenCalledOnce()
    expect(execution.context).toBe(f.owner.current?.context)
    execution.release()
    expect(f.views.activeTurn('root')).toBe(execution.context)
    f.owner.end()
    expect(f.views.activeTurn('root')).toBeUndefined()
    expect(execution.signal.aborted).toBe(false)
  })

  it('resolves the new runtime after maintenance drains, including a canceled handoff', async () => {
    const f = fixture()
    const replacement = memoryGraphFixture(['replacement'])
    const background = await f.live.executions.workflow(f.agent, 'write', f.signal)
    const first = f.owner.begin(1).catch(error => error as Error)
    const next = f.owner.begin(2)
    f.live.swap(replacement.graph)
    expect(f.live.forAgent(f.agent)).toBe(f.graph)
    background.release()
    expect(await first).toBeInstanceOf(Error)
    await next
    expect(f.owner.current?.graph).toBe(replacement.graph)
    expect(f.owner.current?.context.turnId).toBe('root:2')
  })

  it('aborts owned maintenance on runtime disposal and rejects new operations', async () => {
    const f = fixture()
    const execution = await f.live.executions.workflow(f.agent, 'write', f.signal)
    f.live.dispose()
    expect(execution.signal.aborted).toBe(true)
    execution.release()
    await expect(f.live.executions.workflow(f.agent, 'read', f.signal)).rejects.toThrow('disposed')
  })
})

describe('Cordis context lifetime compatibility', () => {
  it('checks the published Cordis lifetime and accepts adapters without a fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name: 'mnemon-context-lifetime', apply() {} })
    expect(contextIsActive({ fiber })).toBe(true)
    await fiber.dispose()
    expect(contextIsActive({ fiber })).toBe(false)
    expect(contextIsActive(undefined)).toBe(true)
  })

  it('recognizes wrapped inactive errors without hiding unrelated failures or looping on causes', () => {
    const inactive = Object.assign(new Error('localized'), { code: 'INACTIVE_EFFECT' })
    expect(isInactiveContextError(new Error('Review interrupted', { cause: inactive }))).toBe(true)
    expect(isInactiveContextError(new Error('cannot create effect on inactive context'))).toBe(true)
    const unrelated = new Error('Provider mentioned an inactive context')
    Object.assign(unrelated, { cause: unrelated })
    expect(isInactiveContextError(unrelated)).toBe(false)
    expect(() => contextIsActive({ fiber: { assertActive() { throw unrelated } } })).toThrow(unrelated)
  })
})

describe('Mnemon lifecycle with the real DSH SystemPrompt', () => {
  function setup() {
    const agentContext = new Context()
    const prompt = new SystemPrompt(agentContext, {})
    const events: HostSessionEvent[] = [{ type: 'turn/start', data: { turn: 1 } }]
    const agent = {
      id: 'real-prompt-session',
      status: 'running',
      session: { ...sessionLog(events) },
      ctx: agentContext as never,
      followup: vi.fn(),
      steer: vi.fn(),
      inject: vi.fn(), cancel: vi.fn(),
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
            scope, routes: [], actionOffers: [], readGrants: [], diagnostics: [],
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
    const coordinator = { isFinishedTask: () => false, snapshot: vi.fn(() => ({ recalls: 0, writes: 0, answers: 0, reviews: 0, failures: 0 })) } as unknown as MnemonSubagentCoordinator
    const host = {
      agents: { get: (id: string) => id === agent.id ? agent : undefined, roots: () => [agent] },
      on: vi.fn(() => vi.fn()),
    } as unknown as HostContextShape
    const lifecycle = new MnemonLifecycle(host, coordinator, config, runtimeSource as never)
    return { agent, events, prompt, composableTurns, runtimeSource, lifecycle }
  }

  it('pins and injects the first-turn Wake inside the awaited assembly boundary', async () => {
    const { agent, prompt, composableTurns, runtimeSource, lifecycle } = setup()
    const stop = lifecycle.start()

    const assembly = await prompt.assemble({ agent, signal: new AbortController().signal } as never)

    expect(composableTurns.beginTurn).toHaveBeenCalledWith('real-prompt-session:1', {
      storage: 'global',
      sessionId: 'real-prompt-session',
      agentId: 'real-prompt-session',
    }, 'agent.root-turn', expect.any(AbortSignal))
    expect(assembly.sections.some(section => section.name === 'mnemon:runtime-memory-protocol')).toBe(false)
    expect(assembly.contexts).not.toContainEqual(expect.objectContaining({ name: 'mnemon:runtime-memory' }))
    expect(runtimeSource.bindAgentRuntime).toHaveBeenCalledOnce()
    expect(lifecycle.memoryView(agent.id)).toMatchObject({ id: 'view-first-turn', state: 'active', memoryText: 'First-turn Wake', turn: 1 })
    stop()
    expect(composableTurns.endTurn).toHaveBeenCalledWith('real-prompt-session:1')
  })

  it('assembles a turn without memory while no composition serves, then pins again', async () => {
    const { agent, events, prompt, composableTurns, lifecycle } = setup()
    const pin = composableTurns.beginTurn.getMockImplementation()!
    composableTurns.beginTurn.mockRejectedValue(new MemoryCompositionUnavailableError({
      state: 'incomplete', contributionRevision: 2, sourceInstanceKeys: [],
      diagnostics: [{ code: 'missing-strategy', message: 'No Memory Strategy contribution is installed.' }],
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = lifecycle.start()
    try {
      const assembly = await prompt.assemble({ agent, signal: new AbortController().signal } as never)
      await prompt.assemble({ agent, signal: new AbortController().signal } as never)

      expect(composableTurns.beginTurn).toHaveBeenCalledOnce()
      expect(assembly.contexts).not.toContainEqual(expect.objectContaining({ name: 'mnemon:runtime-memory' }))
      expect(lifecycle.memoryView(agent.id)).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('No Memory Strategy contribution is installed.'))

      events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } })
      composableTurns.beginTurn.mockImplementation(pin)
      await prompt.assemble({ agent, signal: new AbortController().signal } as never)
      expect(lifecycle.memoryView(agent.id)).toMatchObject({ id: 'view-first-turn', state: 'active', turn: 2 })
    } finally {
      stop()
      warn.mockRestore()
    }
  })

  it('still fails a turn whose View preparation fails for another reason', async () => {
    const { agent, prompt, composableTurns, lifecycle } = setup()
    composableTurns.beginTurn.mockRejectedValue(new Error('Strategy compose failed'))
    const stop = lifecycle.start()
    try {
      await expect(prompt.assemble({ agent, signal: new AbortController().signal } as never)).rejects.toThrow('Strategy compose failed')
    } finally { stop() }
  })
})

describe('large session hot paths (issue 632)', () => {
  function longSession(tail: HostSessionEvent[]): HostSession {
    const length = 46_000
    const events = new Map(tail.map((event, index) => [length - tail.length + index, { ...event, seq: length - tail.length + index }]))
    const eventAt = vi.fn((seq: number): HostSessionEvent | undefined => seq < 0 || seq >= length ? undefined
      : events.get(seq) ?? { seq, type: 'fixture/old', data: { text: 'x'.repeat(1_400) } })
    return {
      seq: length,
      eventAt,
      snapshotEvents: vi.fn((from?: number, to?: number) => {
        if (from === undefined || to === undefined || to - from > 256) throw new Error('unbounded session read')
        return Array.from({ length: Math.max(0, to - from) }, (_, index) => eventAt(from + index)!).filter(Boolean)
      }),
      surface: { nodes: [...events.keys()] },
    } as HostSession
  }

  it('finds current turn and step without materializing the old transcript', () => {
    const session = longSession([{ type: 'turn/start', data: { turn: 400 } }, { type: 'step/start', data: { turn: 400, step: 2 } }])
    const agent = { session } as HostAgent
    expect(openAgentTurn(agent)).toBe(400)
    expect(openAgentStep(agent)).toEqual({ turn: 400, step: 2 })
    expect(vi.mocked(session.eventAt).mock.calls.length).toBeLessThan(600)
  })

  it('reads a completed visible checkpoint and the contained child error from the tail', () => {
    const session = longSession([
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember the SQLite decision.' }] } },
      { type: 'turn/end', data: { turn: 400, reason: { error: { code: 'MODEL', message: 'Synthetic failure' } } } },
    ])
    expect(reviewCheckpoint(session, 1_000)).toContain('Remember the SQLite decision.')
    expect(subagentFailureDetail({ localAgent: { session } } as never, { stopReason: 'failed' } as never)).toBe('MODEL: Synthetic failure')
    expect(vi.mocked(session.eventAt).mock.calls.length).toBeLessThan(600)
  })

  it('keeps historical receipts across pages and reads only new events on refresh', () => {
    const events: HostSessionEvent[] = Array.from({ length: 2_000 }, (_, seq) => ({ seq, type: 'fixture/padding', data: {} }))
    events[0] = { seq: 0, type: 'turn/start', data: { turn: 1 } }
    events[254] = { seq: 254, type: 'tool/call', data: { turn: 1, callId: 'memory', name: 'mnemon_remember' } }
    events[255] = { seq: 255, type: 'tool/call', data: { turn: 1, callId: 'skill', name: 'skill', arguments: { name: 'old-skill' } } }
    events[256] = { seq: 256, type: 'tool/result', data: { turn: 1, message: { source: { callId: 'memory' } } } }
    events[257] = { seq: 257, type: 'tool/result', data: { turn: 1, message: { source: { callId: 'skill' } } } }
    events[1_999] = { seq: 1_999, type: 'turn/end', data: { turn: 1 } }
    const session = { ...sessionLog(events), get seq() { return events.length } }
    const read = vi.spyOn(session, 'snapshotEvents')
    const activity = new TurnActivityProjection(), skills = new TurnSkillUseProjection()
    expect(activity.snapshotSession(session).activities).toMatchObject([{ turn: 1, count: 1, names: ['mnemon_remember'] }])
    expect(skills.snapshot(session)).toEqual([{ turn: 1, skills: [{ name: 'old-skill', by: 'model' }] }])
    expect(captureTurn(sessionTurnEvents(session, 1), 1)).toMatchObject({ toolCalls: 2, skills: ['old-skill'] })
    expect(read.mock.calls.every(([from, to]) => from !== undefined && to !== undefined && to - from <= 256)).toBe(true)
    read.mockClear()
    activity.snapshotSession(session); skills.snapshot(session)
    expect(read).not.toHaveBeenCalled()
    events.push({ seq: 2_000, type: 'turn/start', data: { turn: 2 } }, { seq: 2_001, type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'new-skill' } } })
    expect(skills.snapshot(session)).toHaveLength(2)
    expect(activity.snapshotSession(session).activities[0]?.count).toBe(1)
    expect(read.mock.calls).toEqual([[2_000, 2_002], [2_000, 2_002]])
    events.splice(0)
    expect(activity.snapshotSession(session).activities).toEqual([])
    expect(skills.snapshot(session)).toEqual([])
  })

  it('does not rescan a long open turn at every tool guard or step', () => {
    const events: HostSessionEvent[] = [{ seq: 0, type: 'turn/start', data: { turn: 3 } }, { seq: 1, type: 'step/start', data: { turn: 3, step: 1 } }]
    const session = { ...sessionLog(events), get seq() { return events.length } }
    const agent = { session } as HostAgent
    expect(openAgentStep(agent)).toEqual({ turn: 3, step: 1 })
    const read = vi.spyOn(session, 'snapshotEvents')
    for (let seq = 2; seq < 5_000; seq++) events.push({ seq, type: 'fixture/padding', data: {} })
    expect(openAgentTurn(agent)).toBe(3)
    read.mockClear()
    expect(openAgentStep(agent)).toEqual({ turn: 3, step: 1 })
    expect(openAgentTurn(agent)).toBe(3)
    expect(read).not.toHaveBeenCalled()
    events.push({ seq: 5_000, type: 'step/end', data: { turn: 3, step: 1 } })
    expect(openAgentStep(agent)).toBeUndefined()
    expect(openAgentTurn(agent)).toBe(3)
    events.push({ seq: 5_001, type: 'turn/end', data: { turn: 3 } })
    expect(openAgentTurn(agent)).toBeUndefined()
    expect(read.mock.calls).toEqual([[5_000, 5_001], [5_001, 5_002]])
  })
})

describe('TurnActivityProjection and activity presentation', () => {
  function call(seq: number, turn: number, callId: string, name: string): HostSessionEvent {
    return { type: 'tool/call', seq, data: { turn, step: 1, callId, name, arguments: '{}' } }
  }

  function result(seq: number, turn: number, callId: string, failed = false, meta?: unknown): HostSessionEvent {
    return {
      type: 'tool/result',
      seq,
      data: {
        turn,
        step: 1,
        message: { source: { callId } },
        ...(failed ? { error: { name: 'Error', code: 'failed' } } : {}),
        ...(meta === undefined ? {} : { meta }),
      },
    }
  }

  describe('TurnActivityProjection', () => {
    it('counts only settled successes by semantic category and reports failures separately', () => {
      const projection = new TurnActivityProjection()
      const events = [
        call(1, 1, 'recall', 'mnemon_recall'), result(2, 1, 'recall'),
        call(3, 1, 'documents', 'mnemon_document_search'), result(4, 1, 'documents'),
        call(5, 1, 'write-failed', 'mnemon_remember'), result(6, 1, 'write-failed', true),
        call(7, 1, 'status', 'mnemon_status'), result(8, 1, 'status'),
        call(9, 1, 'write-pending', 'mnemon_runtime_memory'),
      ]

      expect(projection.snapshot(events)).toEqual({
        cursor: 9,
        activities: [{
          turn: 1,
          count: 4,
          names: ['mnemon_recall', 'mnemon_document_search', 'mnemon_remember', 'mnemon_status'],
          recalls: 1,
          writes: 0,
          documentSearches: 1,
          inspections: 1,
          failures: 1,
          retrieved: [],
          writebacks: [],
        }],
      })

      events.push(result(10, 1, 'write-pending'))
      expect(projection.snapshot(events).activities[0]).toMatchObject({ count: 5, writes: 1, failures: 1 })
      expect(projection.snapshot(events).activities[0]).toMatchObject({ count: 5, writes: 1, failures: 1 })
    })

    it('projects only tool-authored bounded reads and committed writebacks', () => {
      const projection = new TurnActivityProjection()
      const readMeta = memoryReadPresentation('documents', 'search')({ query: 'release' }, {
        results: [{ id: 'doc-1', title: 'Release plan', content: 'Ship after the final verification.' }],
        ignored: { credential: 'secret' },
      })
      const committedMeta = memoryWritePresentation('runtime', 'mutate')({
        action: 'add', target: 'memory', content: 'Use pnpm verify before release.',
      }, { success: true, added: 'Use pnpm verify before release.' })
      const pendingMeta = memoryWritePresentation('memory-spaces', 'remember')({ content: 'Not durable yet.' }, {
        memoryReceipt: { status: 'succeeded', completion: 'accepted' },
      })
      const events = [
        call(1, 3, 'read', 'mnemon_document_search'), result(2, 3, 'read', false, readMeta),
        call(3, 3, 'write', 'mnemon_runtime_memory'), result(4, 3, 'write', false, committedMeta),
        call(5, 3, 'pending', 'mnemon_remember'), result(6, 3, 'pending', false, pendingMeta),
      ]

      expect(projection.snapshot(events).activities[0]).toMatchObject({
        retrieved: [{ callId: 'read', toolName: 'mnemon_document_search', sourceTypeId: 'documents', operationId: 'search',
          items: [{ id: 'doc-1', title: 'Release plan', excerpt: 'Ship after the final verification.' }] }],
        writebacks: [{ callId: 'write', toolName: 'mnemon_runtime_memory', sourceTypeId: 'runtime', operationId: 'mutate',
          item: { id: 'mutate', title: 'Use pnpm verify before release.' } }],
      })
      expect(projection.snapshot(events).activities[0]!.writebacks).toHaveLength(1)
      expect(JSON.stringify(projection.snapshot(events))).not.toContain('credential')
    })

    it('names a removal by the text it removed and an item without text only by its id', () => {
      const removed = memoryWritePresentation('runtime', 'mutate')({ action: 'remove', target: 'memory', old_text: 'Checkout p75 LCP target is 2.5 s.' }, { success: true })
      const forgotten = memoryWritePresentation('memory-spaces', 'forget')({ id: 'memory-7', memoryBodyId: 'lumen' }, { success: true })
      expect(removed).toMatchObject({ item: { id: 'mutate', title: 'Checkout p75 LCP target is 2.5 s.' } })
      expect(forgotten).toMatchObject({ item: { id: 'memory-7', title: 'memory-7' } })
    })

    it('resets when the durable event log is replaced by a shorter session', () => {
      const projection = new TurnActivityProjection()
      projection.snapshot([call(1, 1, 'first', 'mnemon_recall'), result(2, 1, 'first')])

      expect(projection.snapshot([call(1, 2, 'second', 'mnemon_status')])).toEqual({ cursor: 1, activities: [] })
    })

    it('records a committed create-only Document as a visible document writeback', () => {
      const projection = new TurnActivityProjection()
      const meta = memoryWritePresentation('documents', 'create')({ title: 'Rollout follow-up', content: 'Separate new evidence.' }, {
        action: 'created', memoryReceipt: { status: 'succeeded', completion: 'committed', committedAt: '2026-09-08T00:00:00.000Z' },
      })
      const events = [call(1, 1, 'created', 'mnemon_document_create'), result(2, 1, 'created', false, meta)]
      expect(projection.snapshot(events).activities[0]).toMatchObject({
        writes: 1, names: ['mnemon_document_create'], writebacks: [{ toolName: 'mnemon_document_create', sourceTypeId: 'documents',
          operationId: 'create', item: { title: 'Rollout follow-up', excerpt: 'Separate new evidence.' } }],
      })
    })
  })

  describe('Unicode-safe activity summaries (#548)', () => {
    it.each(['add', 'replace', 'remove'])('keeps a runtime %s title well formed at a supplementary-character boundary', action => {
      const content = 'x'.repeat(158) + '\u{1F600}' + ' retained memory'
      const args = { action, target: 'memory', ...(action === 'remove' ? { old_text: content } : { content }) }
      const meta = namedToolPresentation('mnemon_runtime_memory')(args, { success: true })

      expect(meta).toMatchObject({ item: { title: 'x'.repeat(158) + '…', excerpt: content } })
      expect(parseMnemonActivityMeta(JSON.parse(JSON.stringify(meta)), 'write', 'mnemon_runtime_memory').writeback?.item.title.isWellFormed()).toBe(true)
    })

    it.each([undefined, 'routeId'] as const)('bounds read metadata without splitting surrogate pairs (reference: %s)', referenceKey => {
      const entry = {
        id: 'i'.repeat(298) + '\u{20000}' + ' rest',
        title: 't'.repeat(158) + '\u{1F600}' + ' rest',
        content: 'c'.repeat(498) + '\u{1F600}' + ' rest',
      }
      const meta = memoryReadPresentation('documents', 'search', referenceKey)({ routeId: 'r'.repeat(598) + '\u{1F600}' + ' rest' }, { results: [entry] })
      expect(meta).toMatchObject({ items: [{ id: 'i'.repeat(298) + '…', title: 't'.repeat(158) + '…', excerpt: 'c'.repeat(498) + '…' }] })
      if (referenceKey !== undefined) expect(meta).toMatchObject({ reference: 'r'.repeat(598) + '…' })
      expect(parseMnemonActivityMeta(JSON.parse(JSON.stringify(meta)), 'read', 'mnemon_document_search').read?.items).toHaveLength(1)
    })

    it('bounds generic View write metadata using the same safe limits', () => {
      const meta = memoryWritePresentation(undefined, 'view-action', 'offerId')({
        offerId: 'o'.repeat(598) + '\u{1F600}' + ' rest',
        input: {
          id: 'i'.repeat(298) + '\u{20000}' + ' rest',
          title: 't'.repeat(158) + '\u{1F600}' + ' rest',
          content: 'c'.repeat(498) + '\u{1F600}' + ' rest',
        },
      }, { memoryReceipt: { status: 'succeeded', completion: 'committed', committedAt: '2026-11-02T00:00:00.000Z' } })
      expect(meta).toMatchObject({
        reference: 'o'.repeat(598) + '…',
        item: { id: 'i'.repeat(298) + '…', title: 't'.repeat(158) + '…', excerpt: 'c'.repeat(498) + '…' },
      })
      expect(parseMnemonActivityMeta(JSON.parse(JSON.stringify(meta)), 'write', 'mnemon_view_action').writeback).toBeDefined()
    })

    it.each([
      { title: 'a'.repeat(161), expected: 'a'.repeat(159) + '…' },
      { title: '文'.repeat(161), expected: '文'.repeat(159) + '…' },
      { title: 'a'.repeat(158) + '\u{1F600}', expected: 'a'.repeat(158) + '\u{1F600}' },
      { title: 'a'.repeat(157) + '\u{1F600}' + ' rest', expected: 'a'.repeat(157) + '\u{1F600}' + '…' },
    ])('preserves existing bounds and complete code points: %#', ({ title, expected }) => {
      const meta = memoryReadPresentation('documents', 'search')({}, { results: [{ id: 'document', title }] })
      expect(meta).toMatchObject({ items: [{ id: 'document', title: expected }] })
      expect(expected.length).toBeLessThanOrEqual(160)
    })
  })
})
