import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as core from 'dsh-mnemon/core'
import * as sdk from 'dsh-mnemon/extension-sdk'
import type { MnemonMemoryService, MemorySourceRuntime } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION, type MemoryOperationSemantics } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner, type MemoryTestTurn } from 'dsh-mnemon/testing'
import * as providerSdk from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { createMemorySpaceProviderFixture, mountMemorySpaceProvider } from 'dsh-mnemon-source-memory-spaces/testing'
import provider from '../lib/external-provider.js'
// @ts-expect-error The installed SDK must not expose Core's engine.
import type { MemoryRuntime } from 'dsh-mnemon/extension-sdk'
// @ts-expect-error Installed records are not public author contracts.
import type { InstalledMemorySource } from 'dsh-mnemon/contracts'
// @ts-expect-error The Provider SDK must not expose its Source's private host.
import type { PrivateMemorySpaceProviderHost } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

describe('published author API', () => {
  it('installs both roles in one external package without adding a Context service or mutation interface', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      const remove = await runner.mount({ inject: ['mnemonMemory'], apply(ctx: Context) {
        sdk.installMemory(ctx, {
          sources: [sdk.defineMemorySource({
            manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'paired-notes', packageName: 'dsh-mnemon-paired',
              role: 'notes', capabilities: ['project'], consistency: 'exact-snapshot',
              projection: { actions: ['wake'], targets: ['records'], effects: [], representations: ['raw'], overflow: 'unavailable', retry: 'safe' },
            },
            create: context => ({
              facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'paired-notes', role: 'notes', availability: 'ready',
                revision: 'r1', capabilities: ['project'], routeIds: [], actionIds: [] }),
              project: request => ({ fragments: [{ id: 'note', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode,
                text: 'Author-owned format', revision: 'r1', result: { representation: 'raw', coverage: 'complete' } }] }),
            }),
          })],
          strategies: [sdk.defineMemoryStrategy({
            manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'paired-focus', packageName: 'dsh-mnemon-paired',
              deterministic: true, supportedSourceRoles: ['notes'], maxSources: 1, maxRoutes: 1, maxActions: 1 },
            compose: (_request, sources) => ({ strategyTypeId: 'paired-focus', explanation: 'Contribute both roles without prescribing storage.',
              sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, projection: { mode: 'eager', maxCharacters: 100 } })),
            }),
          })],
        })
      } }, { instanceId: 'paired' })
      expect(runner.inspect().evaluation).toMatchObject({ state: 'ready', contributionRevision: 1 })
      const turn = await runner.beginTurn()
      expect(turn.view.projection[0]?.text).toBe('Author-owned format')
      expect(turn.view.actionOffers).toEqual([])
      await remove()
      await expect(runner.beginTurn()).rejects.toThrow('no Serving')
    } finally { await runner.dispose() }
  })

  it('keeps Context and testing types independent of private engine types', async () => {
    expectTypeOf<Context['mnemonMemory']>().toEqualTypeOf<MnemonMemoryService>()
    expectTypeOf<keyof MnemonMemoryService>().toEqualTypeOf<'installContributions'>()
    expectTypeOf<MemoryOperationSemantics['actions'][number]>().toEqualTypeOf<'record' | 'wake' | 'read' | 'compress' | 'forget'>()
    type Query = Parameters<NonNullable<MemorySourceRuntime['query']>>[0]
    type Mutation = Parameters<NonNullable<MemorySourceRuntime['mutate']>>[0]
    expectTypeOf<keyof Query['view']>().toEqualTypeOf<'id' | 'scope'>()
    expectTypeOf<keyof Mutation['view']>().toEqualTypeOf<'id' | 'scope'>()
    expectTypeOf<keyof MemoryTestTurn>().toEqualTypeOf<'view' | 'executeRoute' | 'executeAction' | 'release'>()
    expect(Object.keys(core).sort()).toEqual(['apply', 'inject', 'name', 'provide'])
    for (const key of ['MemoryRuntime', 'MemoryContributionRegistry', 'MemoryGenerationHost']) expect(key in sdk).toBe(false)
    const runner = new MemoryCompositionRunner()
    try {
      expect(Object.keys(runner.context.mnemonMemory)).toEqual(['installContributions'])
      expect('runtime' in runner).toBe(false)
      expect('generations' in runner).toBe(false)
      expect(runner.inspect().evaluation.sourceInstanceKeys).toEqual([])
    } finally { await runner.dispose() }
  })

  it('tests a new Provider through the published module fixture, with no parent internals', async () => {
    for (const key of ['PrivateMemorySpaceProviderHost', 'MemorySpaceProviderSnapshot', 'MemoryProviderAdapterRegistry', 'MemoryProviderCatalog']) {
      expect(key in providerSdk).toBe(false)
    }
    const mounted = await mountMemorySpaceProvider(provider, { instanceId: 'account', config: undefined })
    try {
      const { authority, body } = createMemorySpaceProviderFixture(mounted.descriptor, {}, { dataDir: '/unused', instanceId: 'account' })
      const adapter = mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 100 } })
      expect(adapter.id).toBe('account')
      expect(mounted.registered).toBe(true)
      await adapter.remember!(body, { content: 'public fixture sentinel' })
      expect((await adapter.search(body, { query: 'sentinel' })).results).toMatchObject([{ content: 'public fixture sentinel' }])
    } finally { await mounted.dispose() }
    expect(mounted.registered).toBe(false)
  })
})
