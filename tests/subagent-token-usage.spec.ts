import { Context } from '@deepseek-ai/cordis'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry, {
  type ProjectionCheckpoint,
  type ProjectionDefinition,
} from '@deepseek-ai/dsh-session-projection'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MnemonSessionListState } from '../src/client/dsh-context.ts'
import {
  createScopedUseSessions,
  mountSubagentTokenUsageOverride,
  scopeSubagentTokenUsage,
} from '../src/client/subagent-token-usage.tsx'
import type { HostSessionEvent } from "../src/host/dsh.ts"
import {
  MNEMON_SUBAGENT_TOKEN_USAGE_KEY as key,
  mnemonSubagentTokenUsageProjectionDefinition as projection,
  registerMnemonSubagentTokenUsageProjection,
  type MnemonSubagentTokenUsageState,
  type MnemonTokenUsageProjection,
} from "../src/host/subagent-token-usage.ts"

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    mnemonSubagentTokenUsage: MnemonTokenUsageProjection | null
  }
  interface SessionProjectionStateMap {
    mnemonSubagentTokenUsage: MnemonSubagentTokenUsageState
  }
}

describe('Mnemon subagent token-usage projection', () => {
  function event(type: string, data: Record<string, unknown> = {}): HostSessionEvent {
    return { type, data }
  }

  function usage(
    kind: 'chunk' | 'message',
    turn: number,
    step: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ): HostSessionEvent {
    const value = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
    return kind === 'chunk'
      ? event('assistant/chunk', { turn, step, chunk: { type: 'usage', usage: value } })
      : event('assistant/message', { turn, step, usage: value })
  }

  it('ignores a fork seed and totals only usage after the child descriptor', () => {
    let state = projection.init()
    state = projection.apply(state, usage('message', 0, 0, 1_000, 100, 200, 50))
    expect(projection.wire.view(state)).toBeNull()

    state = projection.apply(state, event('subagent/descriptor'))
    state = projection.apply(state, usage('chunk', 1, 0, 10, 2, 3, 4))
    state = projection.apply(state, usage('message', 1, 0, 12, 5, 3, 4))
    state = projection.apply(state, usage('message', 1, 1, 7, 1, 2, 0))

    expect(projection.wire.view(state)).toEqual({
      uncachedInputTokens: 19,
      outputTokens: 6,
      cacheReadTokens: 5,
      cacheWriteTokens: 4,
    })
  })

  it('replaces same-step samples and resets again at a later descriptor', () => {
    let state = projection.apply(projection.init(), event('subagent/descriptor'))
    state = projection.apply(state, usage('chunk', 1, 0, 8, 1))
    const duplicate = projection.apply(state, usage('chunk', 1, 0, 8, 1))
    expect(duplicate).toBe(state)

    state = projection.apply(state, event('subagent/descriptor'))
    expect(projection.wire.view(state)).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('registers through the optional projection service without making it a core dependency', () => {
    const register = vi.fn()
    const inject = vi.fn((_services: string[], callback: (ctx: unknown) => void) => {
      callback({ sessionProjections: { register } })
    })
    registerMnemonSubagentTokenUsageProjection({ inject } as never)

    expect(inject).toHaveBeenCalledWith(['sessionProjections'], expect.any(Function))
    expect(register).toHaveBeenCalledWith(projection)
  })

  it.each([null, undefined, [], 'invalid', { turn: 1, step: 0, chunk: null }])(
    'ignores malformed event data without changing child usage: %j',
    (data) => {
      const state = projection.apply(projection.init(), event('subagent/descriptor'))
      expect(projection.apply(state, { type: 'assistant/chunk', data })).toBe(state)
    },
  )
})

describe('Mnemon subagent token usage host registry', () => {
  const definition = projection satisfies ProjectionDefinition<typeof key, MnemonSubagentTokenUsageState>
  const contexts: Context[] = []

  afterEach(async () => {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  })

  function harness() {
    const ctx = new Context()
    contexts.push(ctx)
    const sessions = new SessionStore(ctx)
    const registry = new SessionProjectionRegistry(ctx)
    registry.register(definition)
    const session = sessions.create(SessionId('projection-fixture'))
    return { ctx, registry, session }
  }

  function descriptor(session: Session) {
    return session.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable', provider: 'fixture', label: 'Projection regression',
    }))
  }

  function usage(session: Session, step: number, inputTokens: number, outputTokens: number) {
    return session.append('assistant/message', {
      turn: 1,
      step,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'Synthetic result.' }], source: { provider: 'fixture', model: 'fixture' } }),
      stream: [],
      usage: { inputTokens, outputTokens, cacheReadTokens: 3, cacheWriteTokens: 4 },
    }, { surfaceOp: 'append' })
  }

  const expectedUsage = {
    uncachedInputTokens: 19,
    outputTokens: 6,
    cacheReadTokens: 6,
    cacheWriteTokens: 8,
  }

  it('serves empty and ordinary session history without child usage', () => {
    const { registry, session } = harness()
    expect(registry.snapshot(session)).toEqual({ asOfSeq: -1, values: { [key]: null } })

    usage(session, 0, 1_000, 100)
    expect(registry.snapshot(session)).toEqual({ asOfSeq: 0, values: { [key]: null } })
    expect(registry.restore({}, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount).snapshot).toEqual(registry.snapshot(session))
  })

  it('serves attached and detached child history without counting inherited usage', () => {
    const { registry, session } = harness()
    usage(session, 0, 1_000, 100)
    descriptor(session)
    usage(session, 0, 100, 10)
    descriptor(session)
    usage(session, 0, 10, 2)
    usage(session, 0, 12, 5)
    usage(session, 1, 7, 1)

    const expected = { asOfSeq: session.seq - 1, values: { [key]: expectedUsage } }
    expect(registry.snapshot(session)).toEqual(expected)
    expect(registry.restore({}, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount).snapshot).toEqual(expected)
  })

  it('restores JSON checkpoints and replaces a same-step sample after restart', () => {
    const { registry, session } = harness()
    descriptor(session)
    usage(session, 0, 10, 2)
    const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
    expect(registry.viewCheckpoint(checkpoint)).toEqual({ [key]: {
      uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
    } })

    usage(session, 0, 12, 5)
    usage(session, 1, 7, 1)
    const restarted = harness().registry
    const floor = restarted.restoreFloor(checkpoint)!
    const restored = restarted.restore(checkpoint, session.snapshotEvents().slice(floor), floor, session.header, session.inheritedEventCount)

    expect(restored.snapshot).toEqual({ asOfSeq: session.seq - 1, values: { [key]: expectedUsage } })
    expect(restored.checkpoint).toEqual(registry.checkpoint(session))
    expect(restored.checkpoint[key]?.ver).toBe(1)
    expect(restored.checkpoint[key]?.val).toMatchObject({
      descriptorSeen: true, totals: expectedUsage, last: { turn: 1, step: 1 },
    })
    expect(registry.viewCheckpoint(checkpoint)[key]?.uncachedInputTokens).toBe(10)
  })

  it('emits validated child-local changes without duplicate streaming samples', () => {
    const { registry, session } = harness()
    const changed = vi.fn()
    registry.onChanged(changed)
    usage(session, 0, 1_000, 100)
    expect(changed).not.toHaveBeenCalled()

    const start = descriptor(session)
    const sample = usage(session, 0, 10, 2)
    usage(session, 0, 10, 2)
    expect(changed.mock.calls.map(([, changedKey, value, seq]) => ({ key: changedKey, value, seq }))).toEqual([
      { key, value: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, seq: start.seq },
      { key, value: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, seq: sample.seq },
    ])
  })

  it('refolds the complete log when a checkpoint version is obsolete', () => {
    const { registry, session } = harness()
    descriptor(session)
    usage(session, 0, 12, 5)
    usage(session, 1, 7, 1)
    const checkpoint: ProjectionCheckpoint = {
      [key]: { ver: 0, seq: (session.seq - 1) as ProjectionCheckpoint[string]['seq'], val: null },
    }

    expect(registry.restoreFloor(checkpoint)).toBe(0)
    expect(registry.viewCheckpoint(checkpoint)).toEqual({})
    expect(registry.restore(checkpoint, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount).snapshot.values).toEqual({ [key]: expectedUsage })
  })
})

describe('Mnemon subagent catalog token override', () => {
  const generic = {
    uncachedInputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 200,
    cacheWriteTokens: 50,
  }

  const child = {
    uncachedInputTokens: 12,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  }

  const PARENT = 'parent'
  const CHILD = 'child'

  function sessions(): MnemonSessionListState {
    return {
      ids: [PARENT, CHILD],
      current: PARENT,
      phase: 'ready',
      subagentsByParent: {},
      byId: {
        [PARENT]: {
          id: PARENT, displayTitle: 'Parent', running: false, blank: false, updatedAt: 1,
          projectionValues: { tokenUsage: generic },
        },
        [CHILD]: {
          id: CHILD, displayTitle: 'Child', origin: 'subagent', parentId: PARENT,
          running: false, blank: false, updatedAt: 1,
          projectionValues: { tokenUsage: generic, mnemonSubagentTokenUsage: child },
        },
      },
    } as MnemonSessionListState
  }

  function tokenUsage(state: MnemonSessionListState, id: string): unknown {
    return (state.byId[id]?.projectionValues as Readonly<Record<string, unknown>> | undefined)?.tokenUsage
  }

  it('rewrites only subagent rows and caches the transformed snapshot', () => {
    const state = sessions()
    const scoped = scopeSubagentTokenUsage(state)

    expect(scoped).not.toBe(state)
    expect(scopeSubagentTokenUsage(state)).toBe(scoped)
    expect(scoped.byId[PARENT]).toBe(state.byId[PARENT])
    expect(tokenUsage(scoped, CHILD)).toEqual(child)
    expect(tokenUsage(state, CHILD)).toEqual(generic)
  })

  it('keeps the official aggregate when a legacy child has no scoped projection', () => {
    const state = sessions()
    state.byId[CHILD] = {
      ...state.byId[CHILD]!,
      projectionValues: { tokenUsage: generic, mnemonSubagentTokenUsage: null } as never,
    }

    expect(scopeSubagentTokenUsage(state)).toBe(state)
    expect(tokenUsage(state, CHILD)).toEqual(generic)
  })

  it('preserves the selector hook contract while presenting child-local usage', () => {
    const state = sessions()
    const base: SnapshotSelectorHook<MnemonSessionListState> = selector => selector(state)
    const useSessions = createScopedUseSessions(base)

    expect(useSessions(value => tokenUsage(value, CHILD))).toEqual(child)
    expect(useSessions(value => tokenUsage(value, PARENT))).toEqual(generic)
  })

  it('shadows the official lineage component and reuses its actions and locale', () => {
    const entries: StoredEntry[] = []
    let changed = (): void => {}
    let shadow: ((props: Record<string, unknown>) => ReactElement) | undefined
    const disposeShadow = vi.fn()
    const unsubscribe = vi.fn()
    const register = vi.fn((_options: Record<string, unknown>, component: unknown) => {
      shadow = component as typeof shadow
      return disposeShadow
    })
    const slots = {
      entries: vi.fn(() => entries),
      subscribe: vi.fn((_key: string, listener: () => void) => {
        changed = listener
        return unsubscribe
      }),
      register,
    }
    const dispose = mountSubagentTokenUsageOverride({ slots } as never)
    const actions = vi.fn(() => ({ openChild: vi.fn(), refresh: vi.fn(), setCatalogOpen: vi.fn() }))
    const official = vi.fn(() => null)
    const officialEntry: StoredEntry = {
      component: official,
      options: {},
      locale: 'subagent',
      inject: actions as never,
    }
    entries.push(officialEntry)
    changed()

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.session.header.lineage',
      priority: -100,
      locale: 'subagent',
      inject: actions,
    }), expect.any(Function))

    const state = sessions()
    const useSessions: SnapshotSelectorHook<MnemonSessionListState> = selector => selector(state)
    const element = shadow!({ useSessions })
    expect(element.type).toBe(official)
    expect((element.props as { useSessions: SnapshotSelectorHook<MnemonSessionListState> }).useSessions(
      value => tokenUsage(value, CHILD),
    )).toEqual(child)

    entries.splice(0)
    changed()
    expect(disposeShadow).toHaveBeenCalledTimes(1)
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
