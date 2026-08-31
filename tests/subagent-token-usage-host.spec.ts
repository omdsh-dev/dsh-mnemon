import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry, { type ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import LegacySessionProjectionRegistry, { type ProjectionDefinition as LegacyProjectionDefinition } from '@deepseek-ai/dsh-session-projection-legacy'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MNEMON_SUBAGENT_TOKEN_USAGE_KEY as key,
  mnemonSubagentTokenUsageProjectionDefinition as projection,
  type MnemonSubagentTokenUsageState,
  type MnemonTokenUsageProjection,
} from '../src/subagent-token-usage.ts'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    mnemonSubagentTokenUsage: MnemonTokenUsageProjection | null
  }
  interface SessionProjectionStateMap {
    mnemonSubagentTokenUsage: MnemonSubagentTokenUsageState
  }
}

declare module '@deepseek-ai/dsh-session-projection-legacy' {
  interface SessionProjectionMap {
    mnemonSubagentTokenUsage: MnemonTokenUsageProjection | null
  }
}

// Check the published contracts as well as their actual runtime consumers.
const currentDefinition = projection satisfies ProjectionDefinition<typeof key, MnemonSubagentTokenUsageState>
const legacyDefinition = projection satisfies LegacyProjectionDefinition<typeof key, MnemonSubagentTokenUsageState>

const generations = [
  {
    name: 'DSH 0.1.0-rc.8 (schema/view)',
    create(ctx: Context) {
      const registry = new LegacySessionProjectionRegistry(ctx)
      registry.register(legacyDefinition)
      return registry
    },
  },
  {
    name: 'active DSH (stateSchema/wire)',
    create(ctx: Context) {
      const registry = new SessionProjectionRegistry(ctx)
      registry.register(currentDefinition)
      return registry
    },
  },
] as const

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function harness(generation: typeof generations[number]) {
  const ctx = new Context()
  contexts.push(ctx)
  const sessions = new SessionStore(ctx)
  const registry = generation.create(ctx)
  const session = sessions.create(SessionId('projection-fixture'))
  return { ctx, registry, session }
}

function descriptor(session: Session) {
  return session.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'one-shot', provider: 'fixture', label: 'Projection regression',
  }))
}

function usage(session: Session, step: number, inputTokens: number, outputTokens: number) {
  return session.append('assistant/chunk', {
    turn: 1,
    step,
    chunk: {
      type: 'usage',
      usage: { inputTokens, outputTokens, cacheReadTokens: 3, cacheWriteTokens: 4 },
    },
  })
}

const expectedUsage = {
  uncachedInputTokens: 19,
  outputTokens: 6,
  cacheReadTokens: 6,
  cacheWriteTokens: 8,
}

describe.each(generations)('Mnemon projection with $name', (generation) => {
  it('serves empty and ordinary session history without child usage', () => {
    const { registry, session } = harness(generation)
    expect(registry.snapshot(session)).toEqual({ asOfSeq: -1, values: { [key]: null } })

    usage(session, 0, 1_000, 100)
    expect(registry.snapshot(session)).toEqual({ asOfSeq: 0, values: { [key]: null } })
    expect(registry.restore({}, session.events, 0).snapshot).toEqual(registry.snapshot(session))
  })

  it('serves attached and detached child history without counting inherited usage', () => {
    const { registry, session } = harness(generation)
    usage(session, 0, 1_000, 100)
    descriptor(session)
    usage(session, 0, 100, 10)
    descriptor(session)
    usage(session, 0, 10, 2)
    usage(session, 0, 12, 5)
    usage(session, 1, 7, 1)

    const expected = { asOfSeq: session.seq - 1, values: { [key]: expectedUsage } }
    expect(registry.snapshot(session)).toEqual(expected)
    expect(registry.restore({}, session.events, 0).snapshot).toEqual(expected)
  })

  it('restores JSON checkpoints and replaces a same-step sample after restart', () => {
    const { registry, session } = harness(generation)
    descriptor(session)
    usage(session, 0, 10, 2)
    const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
    expect(registry.viewCheckpoint(checkpoint)).toEqual({ [key]: {
      uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
    } })

    usage(session, 0, 12, 5)
    usage(session, 1, 7, 1)
    const restarted = harness(generation).registry
    const floor = restarted.restoreFloor(checkpoint)!
    const restored = restarted.restore(checkpoint, session.events.slice(floor), floor)

    expect(restored.snapshot).toEqual({ asOfSeq: session.seq - 1, values: { [key]: expectedUsage } })
    expect(restored.checkpoint).toEqual(registry.checkpoint(session))
    expect(restored.checkpoint[key]?.ver).toBe(1)
    expect(restored.checkpoint[key]?.val).toMatchObject({
      descriptorSeen: true, totals: expectedUsage, last: { turn: 1, step: 1 },
    })
    expect(registry.viewCheckpoint(checkpoint)[key]?.uncachedInputTokens).toBe(10)
  })

  it('emits validated child-local changes without duplicate streaming samples', () => {
    const { registry, session } = harness(generation)
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
    const { registry, session } = harness(generation)
    descriptor(session)
    usage(session, 0, 12, 5)
    usage(session, 1, 7, 1)
    const checkpoint = { [key]: { ver: 0, seq: session.seq - 1, val: null } }

    expect(registry.restoreFloor(checkpoint)).toBe(0)
    expect(registry.viewCheckpoint(checkpoint)).toEqual({})
    expect(registry.restore(checkpoint, session.events, 0).snapshot.values).toEqual({ [key]: expectedUsage })
  })
})

describe('Mnemon projection checkpoints across DSH generations', () => {
  for (const [source, target] of [[generations[0], generations[1]], [generations[1], generations[0]]] as const) {
    it(`preserves state from ${source.name} to ${target.name}`, () => {
      const { registry, session } = harness(source)
      descriptor(session)
      usage(session, 0, 10, 2)
      const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
      usage(session, 0, 12, 5)
      usage(session, 1, 7, 1)

      const targetRegistry = harness(target).registry
      const floor = targetRegistry.restoreFloor(checkpoint)!
      const restored = targetRegistry.restore(checkpoint, session.events.slice(floor), floor)
      expect(restored.snapshot).toEqual({ asOfSeq: session.seq - 1, values: { [key]: expectedUsage } })
      expect(restored.checkpoint).toEqual(registry.checkpoint(session))
    })
  }
})
