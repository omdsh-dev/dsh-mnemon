import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { COMPOSABLE_MEMORY_API_VERSION, type MemorySourceDefinition, type MemoryStrategyDefinition } from "../src/core/contracts/index.ts"
import {
  MemoryRuntime,
  defineMemorySource,
  defineMemoryStrategy,
  installMemory,
} from "../src/sdk/index.ts"

function source(typeId = 'example'): MemorySourceDefinition {
  return defineMemorySource({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION,
      kind: 'source',
      typeId,
      packageName: `dsh-mnemon-source-${typeId}`,
      role: 'external-memory',
      capabilities: ['project'],
      consistency: 'exact-snapshot',
    },
    create: context => ({
      facts: () => ({
        sourceInstanceKey: context.sourceInstanceKey,
        sourceTypeId: typeId,
        role: 'external-memory',
        availability: 'ready',
        revision: 'r1',
        capabilities: ['project'],
        routeIds: [],
        actionIds: [],
      }),
      project: () => ({ fragments: [] }),
    }),
  })
}

function strategy(typeId = 'example'): MemoryStrategyDefinition {
  return defineMemoryStrategy({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION,
      kind: 'strategy',
      typeId,
      packageName: `dsh-mnemon-strategy-${typeId}`,
      deterministic: true,
      supportedSourceRoles: ['external-memory'],
      maxSources: 4,
      maxRoutes: 4,
      maxActions: 4,
    },
    compose: () => ({ strategyTypeId: typeId, sources: [], explanation: 'Fixture.' }),
  })
}

async function host(): Promise<{ ctx: Context; runtime: MemoryRuntime }> {
  const ctx = new Context()
  const runtime = new MemoryRuntime()
  ctx.provide('mnemonMemory', runtime)
  return { ctx, runtime }
}

describe('Composable Memory extension SDK', () => {
  it('binds installMemory registration and disposer to the calling Cordis Fiber', async () => {
    const { ctx, runtime } = await host()
    const definition = source()
    const fiber = ctx.plugin({
      name: 'dsh-mnemon-source-example',
      inject: ['mnemonMemory'],
      apply(pluginContext) {
        installMemory(pluginContext, { sources: [definition] }, { instanceId: 'example-work', artifactDigest: 'sha256:fixture' })
      },
    })
    await fiber.await()

    expect(runtime.contributionSnapshot()).toMatchObject({
      revision: 1,
      sources: [{
        instanceKey: 'source:example-work',
        provenance: { packageName: 'dsh-mnemon-source-example', entryId: 'example-work', artifactDigest: 'sha256:fixture' },
      }],
      strategies: [],
    })
    await fiber.dispose()
    expect(runtime.contributionSnapshot()).toMatchObject({ revision: 2, sources: [], strategies: [] })
  })

  it('supports two configured instances of one Source definition without mixing identity', async () => {
    const { ctx, runtime } = await host()
    const definition = source('notion')
    const work = ctx.plugin({ inject: ['mnemonMemory'], apply: child => installMemory(child, { sources: [definition] }, { instanceId: 'notion-work' }) })
    const personal = ctx.plugin({ inject: ['mnemonMemory'], apply: child => installMemory(child, { sources: [definition] }, { instanceId: 'notion-personal' }) })
    await Promise.all([work.await(), personal.await()])
    expect(runtime.contributionSnapshot().sources.map(item => item.instanceKey)).toEqual(['source:notion-work', 'source:notion-personal'])
    await work.dispose()
    expect(runtime.contributionSnapshot().sources.map(item => item.instanceKey)).toEqual(['source:notion-personal'])
    await personal.dispose()
  })

  it('fails loud on duplicate instance identity and preserves the first owner', async () => {
    const { ctx, runtime } = await host()
    const definition = source()
    const first = ctx.plugin({ inject: ['mnemonMemory'], apply: child => installMemory(child, { sources: [definition] }, { instanceId: 'same' }) })
    await first.await()
    const duplicate = ctx.plugin({ inject: ['mnemonMemory'], apply: child => installMemory(child, { sources: [definition] }, { instanceId: 'same' }) })
    await expect(duplicate.await()).rejects.toThrow('already installed')
    expect(runtime.contributionSnapshot().sources).toHaveLength(1)
    await first.dispose()
  })

  it('requires direct child mounts to supply stable identity and rejects mixed plugin kinds', async () => {
    const { ctx } = await host()
    const unidentified = ctx.plugin({ inject: ['mnemonMemory'], apply: child => installMemory(child, { sources: [source()] }) })
    await expect(unidentified.await()).rejects.toThrow('stable Loader Entry id')

    const mixed = ctx.plugin({
      inject: ['mnemonMemory'],
      apply: child => installMemory(child, { sources: [source()], strategies: [strategy()] }, { instanceId: 'mixed' }),
    })
    await expect(mixed.await()).rejects.toThrow('cannot install both')
  })

  it('notifies generation hosts with complete immutable snapshots', async () => {
    const { ctx, runtime } = await host()
    const listener = vi.fn()
    const unsubscribe = runtime.onContributionsChanged(listener)
    const fiber = ctx.plugin({ inject: ['mnemonMemory'], apply: child => installMemory(child, { strategies: [strategy()] }, { instanceId: 'strategy' }) })
    await fiber.await()
    const snapshot = listener.mock.calls[0]![0]
    expect(snapshot).toMatchObject({ revision: 1, strategies: [{ instanceKey: 'strategy:strategy' }] })
    expect(Object.isFrozen(snapshot)).toBe(true)
    await fiber.dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

})
