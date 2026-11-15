import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  COMPOSABLE_MEMORY_API_VERSION,
  type MemorySourceDefinition,
  type MemorySourceRuntime,
  type MemorySourceRuntimeContext,
  type MemoryStrategyDefinition,
  type MemoryViewContribution,
} from "../src/core/contracts/index.ts"
import type { InstalledMemoryPlugin, InstalledMemorySource, InstalledMemoryStrategy, MemoryContributionSnapshot } from '../src/core/contributions.ts'
import { defineMemoryPlugin, evaluateMemoryComposition } from '../src/core/index.ts'
import {
  defineMemorySource,
  defineMemoryStrategy,
  installMemory,
} from "../src/sdk/index.ts"
import { MemoryRuntime } from '../src/core/runtime.ts'
import * as sdk from 'dsh-mnemon/extension-sdk'
import type { MnemonMemoryService } from 'dsh-mnemon/extension-sdk'
// @ts-expect-error Engine implementations are not plugin author contracts.
import type { MemoryRuntime as ExcludedMemoryRuntime } from 'dsh-mnemon/extension-sdk'
// @ts-expect-error Installed records belong to Core, not the public wire protocol.
import type { InstalledMemorySource as ExcludedInstalledMemorySource } from 'dsh-mnemon/contracts'
// @ts-expect-error Registry snapshots are internal installation state.
import type { MemoryContributionSnapshot as ExcludedMemoryContributionSnapshot } from 'dsh-mnemon/contracts'
import { DEFAULT_MEMORY_VIEW_BUDGET, MemoryCompositionRunner, type MemoryTestOptions, type MemoryTestTurn } from 'dsh-mnemon/testing'
import { compositionFixture } from './fixtures/composition.ts'

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
  ctx.provide('mnemonMemory', runtime.service)
  return { ctx, runtime }
}

describe('Composable Memory extension SDK', () => {
  it('publishes an actual narrow, immutable service object instead of the engine', async () => {
    const { ctx, runtime } = await host()
    expect(ctx.mnemonMemory).toBe(runtime.service)
    expect(ctx.mnemonMemory).not.toBe(runtime)
    expect(Object.keys(ctx.mnemonMemory)).toEqual(['installContributions'])
    expect(Object.isFrozen(ctx.mnemonMemory)).toBe(true)
    for (const name of ['dispose', 'attachGeneration', 'contributionSnapshot', 'onContributionsChanged', 'contributions']) {
      expect(name in ctx.mnemonMemory).toBe(false)
    }
    await runtime.dispose()
    expect(() => ctx.mnemonMemory.installContributions({ sources: [source()] }, { instanceId: 'closed' })).toThrow('disposed')
  })

  it('accepts only definitions at the service boundary and validates before changing the registry', async () => {
    const { ctx, runtime } = await host()
    const release = ctx.mnemonMemory.installContributions({ sources: [source('work'), source('personal')] }, {
      instanceId: 'include:notes', effectiveDigest: 'backend:r1', artifactDigest: 'artifact:r1',
    })
    expect(runtime.contributionSnapshot().sources).toMatchObject([
      { instanceKey: 'source:include:notes/work', effectiveDigest: 'backend:r1', provenance: { entryId: 'include:notes', artifactDigest: 'artifact:r1' } },
      { instanceKey: 'source:include:notes/personal' },
    ])
    const snapshot = runtime.contributionSnapshot()
    expect(() => ctx.mnemonMemory.installContributions({ sources: [source()], strategies: [strategy(), strategy()] }, { instanceId: 'invalid-batch' })).toThrow('duplicated')
    expect(() => ctx.mnemonMemory.installContributions({}, { instanceId: 'empty' })).toThrow('one Source, Strategy or Strategy extension')
    expect(() => ctx.mnemonMemory.installContributions({ sources: [source()] }, { instanceId: ' ' })).toThrow('stable Loader Entry')
    expect(runtime.contributionSnapshot()).toEqual(snapshot)
    release()
    release()
    expect(runtime.contributionSnapshot()).toMatchObject({ revision: 2, sources: [], strategies: [] })
    await runtime.dispose()
  })

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

  it('requires direct child mounts to supply stable identity and supports both roles in one Fiber', async () => {
    const { ctx, runtime } = await host()
    const listener = vi.fn()
    runtime.onContributionsChanged(listener)
    const unidentified = ctx.plugin({ inject: ['mnemonMemory'], apply: child => installMemory(child, { sources: [source()] }) })
    await expect(unidentified.await()).rejects.toThrow('stable Loader Entry id')

    const mixed = ctx.plugin({
      inject: ['mnemonMemory'],
      apply: child => installMemory(child, { sources: [source()], strategies: [strategy()] }, { instanceId: 'mixed' }),
    })
    await mixed.await()
    expect(listener).toHaveBeenCalledOnce()
    expect(runtime.contributionSnapshot()).toMatchObject({ revision: 1,
      sources: [{ instanceKey: 'source:mixed' }], strategies: [{ instanceKey: 'strategy:mixed' }],
    })
    await mixed.dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(runtime.contributionSnapshot()).toMatchObject({ revision: 2, sources: [], strategies: [] })
  })

  it('installs nothing inside a dshmarket client-only shim Entry, whatever identity the plugin passes (#359)', async () => {
    const { ctx, runtime } = await host()
    const entries = new WeakMap<object, string>()
    ctx.provide('loader', { locate: (fiber: object) => entries.get(fiber) })
    const located = (entryId: string, install: (child: Context) => void) => ctx.plugin({ inject: ['mnemonMemory'], apply(child: Context) {
      entries.set(child.fiber, entryId)
      install(child)
    } })
    const shim = 'include:dsh-market:mkt-client-dsh-mnemon-source-example'
    const starter = located('include:mnemon-source-example', child => installMemory(child, { sources: [source()] }))
    const shims = [undefined, ' ', shim, 'example-explicit'].map(instanceId =>
      located(shim, child => installMemory(child, { sources: [source()] }, instanceId === undefined ? {} : { instanceId })))
    await Promise.all([starter, ...shims].map(fiber => fiber.await()))
    expect(runtime.contributionSnapshot().sources.map(item => item.instanceKey)).toEqual(['source:include:mnemon-source-example'])

    // Only the last segment names the mount.
    const ordinary = located('include:mkt-client-tools:notes', child => installMemory(child, { sources: [source()] }))
    await ordinary.await()
    expect(runtime.contributionSnapshot().sources.map(item => item.instanceKey)).toEqual(['source:include:mnemon-source-example', 'source:include:mkt-client-tools:notes'])
    await Promise.all([starter, ordinary, ...shims].map(fiber => fiber.dispose()))
    expect(runtime.contributionSnapshot().sources).toEqual([])
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

describe('public plugin SDK boundary', () => {
  it('types the only Context service as its contribution protocol', () => {
    void (undefined as unknown as [ExcludedMemoryRuntime, ExcludedInstalledMemorySource, ExcludedMemoryContributionSnapshot])
    expectTypeOf<Context['mnemonMemory']>().toEqualTypeOf<MnemonMemoryService>()
    expectTypeOf<keyof MnemonMemoryService>().toEqualTypeOf<'installContributions'>()
    expectTypeOf<MemorySourceRuntime['facts']>().toBeFunction()
    type Query = Parameters<NonNullable<MemorySourceRuntime['query']>>[0]
    type Mutation = Parameters<NonNullable<MemorySourceRuntime['mutate']>>[0]
    expectTypeOf<keyof Query['view']>().toEqualTypeOf<'id' | 'scope'>()
    expectTypeOf<keyof Mutation['view']>().toEqualTypeOf<'id' | 'scope'>()
    expectTypeOf<Mutation['grant']>().toEqualTypeOf<Query['grant'] | undefined>()
  })

  it('exports author tools without engine, registry or generation constructors', () => {
    expect(sdk.installMemory).toBeTypeOf('function')
    expect(sdk.defineMemorySource).toBeTypeOf('function')
    expect(sdk.defineMemoryStrategy).toBeTypeOf('function')
    expect(sdk.defineMemoryStrategyExtension).toBeTypeOf('function')
    for (const name of ['MemoryRuntime', 'MemoryContributionRegistry', 'MemoryGenerationHost', 'ComposableMemoryTurnManager']) {
      expect(name in sdk).toBe(false)
    }
  })
})

describe('independent plugin testing SDK', () => {
  const runners: MemoryCompositionRunner[] = []
  afterEach(async () => { for (const runner of runners.splice(0)) await runner.dispose() })

  function gate() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }

  async function fixture(options: MemoryTestOptions = {}, customize: (context: MemorySourceRuntimeContext) => Partial<MemorySourceRuntime> = () => ({})) {
    const runner = new MemoryCompositionRunner(options)
    runners.push(runner)
    const notesSource = defineMemorySource({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'notes', packageName: 'test-source-notes',
        role: 'notes', capabilities: ['project', 'read', 'write'], consistency: 'exact-snapshot',
        routes: [{ id: 'read', description: 'Read the captured note', capability: 'read', inputSchema: { type: 'object' }, maxCalls: 2 }],
        actions: [{ id: 'write', description: 'Write a note', capability: 'write', inputSchema: { type: 'object' } }],
        management: { label: 'Notes', description: 'Test notes' },
      },
      create: context => ({
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'notes', role: 'notes', availability: 'ready',
          revision: 'r1', capabilities: ['project', 'read', 'write'], routeIds: ['read'], actionIds: ['write'] }),
        project: request => ({ fragments: [{ id: 'note', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode, text: 'A note', revision: 'r1' }],
          readGrant: { id: 'grant', sourceInstanceKey: context.sourceInstanceKey, schema: 'test/notes-v1', value: null, revision: 'r1', consistency: 'exact-snapshot' } }),
        query: ({ view, route }) => ({ id: 'evidence', viewId: view.id, routeId: route.id, sourceInstanceKey: context.sourceInstanceKey,
          observedAt: '2026-08-30T00:00:00.000Z', items: [{ id: 'note', text: 'long captured evidence', provenance: { source: 'fixture' } }], truncated: false }),
        mutate: ({ view, offer }) => ({ id: 'receipt', viewId: view.id, offerId: offer.id, sourceInstanceKey: context.sourceInstanceKey,
          status: 'succeeded', completion: 'committed', committedAt: '2026-08-30T00:00:00.000Z' }),
        manage: request => ({ revision: 'r1', value: request.input }),
        ...customize(context),
      }),
    })
    const notesStrategy = defineMemoryStrategy({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'notes-view', packageName: 'test-strategy-notes',
        deterministic: true, supportedSourceRoles: ['notes'], maxSources: 1, maxRoutes: 1, maxActions: 1 },
      compose: (_request, sources) => ({ strategyTypeId: 'notes-view', explanation: 'Test notes', sources: sources.map(item => ({
        sourceInstanceKey: item.sourceInstanceKey, projection: { mode: 'eager', maxCharacters: 100 }, routeIds: item.routeIds, actionIds: item.actionIds,
      })) }),
    })
    const sourcePlugin = { inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [notesSource] }) } }
    const unmount = await runner.mount(sourcePlugin, { instanceId: 'work' })
    await runner.mount({ inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { strategies: [notesStrategy] }) } }, { instanceId: 'view' })
    return { runner, unmount, sourcePlugin }
  }

  it('composes a read-only combined plugin while private Fiber maintenance remains independent of View execution', async () => {
    const runner = new MemoryCompositionRunner()
    runners.push(runner)
    let refresh!: (value: string) => void
    let watching = false
    const unmount = await runner.mount({ inject: ['mnemonMemory'], apply(ctx: Context) {
      let content = 'original private data'
      ctx.effect(() => {
        watching = true
        refresh = value => { content = value }
        return () => { watching = false }
      })
      installMemory(ctx, {
        sources: [defineMemorySource({
          manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'private-tree', packageName: 'dsh-mnemon-paired',
            role: 'tree', capabilities: ['read'], consistency: 'exact-snapshot',
            routes: [{ id: 'open-node', description: 'Read the pinned private representation', capability: 'read', inputSchema: { type: 'object' }, maxCalls: 3,
            }],
          },
          create: context => ({
            facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'private-tree', role: 'tree', availability: 'ready',
              revision: content, capabilities: ['read'], routeIds: ['open-node'], actionIds: [] }),
            project: () => ({ fragments: [], readGrant: { id: 'pinned-tree', sourceInstanceKey: context.sourceInstanceKey,
              schema: 'private-tree/v1', value: content, revision: content, consistency: 'exact-snapshot' } }),
            query: ({ view, route, grant }) => ({ id: 'node', viewId: view.id, routeId: route.id, sourceInstanceKey: context.sourceInstanceKey,
              observedAt: '2026-08-31T00:00:00.000Z', truncated: false,
              items: [{ id: 'node', text: String(grant.value), provenance: { source: 'private-tree' } }],
            }),
          }),
        })],
        strategies: [defineMemoryStrategy({
          manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'paired', packageName: 'dsh-mnemon-paired',
            deterministic: true, supportedSourceRoles: ['tree'], maxSources: 1, maxRoutes: 1, maxActions: 1 },
          compose: (_request, sources) => ({ strategyTypeId: 'paired', explanation: 'Use my own Source or a compatible replacement.',
            sources: sources.map(item => ({ sourceInstanceKey: item.sourceInstanceKey,
              routeIds: item.routes.filter(route => route.capability === 'read').map(route => route.id),
            })),
          }),
        })],
      })
    } }, { instanceId: 'paired' })
    expect(watching).toBe(true)
    expect(runner.inspect().evaluation).toMatchObject({ state: 'ready', contributionRevision: 1 })
    const pinned = await runner.beginTurn()
    refresh('index refreshed privately')
    const next = await runner.beginTurn()
    const read = (turn: MemoryTestTurn) => turn.executeRoute(turn.view.routes[0]!.id, {})
    expect((await read(pinned)).items[0]!.text).toBe('original private data')
    expect((await read(next)).items[0]!.text).toBe('index refreshed privately')
    await unmount()
    expect(watching).toBe(false)
    await expect(runner.beginTurn()).rejects.toThrow('no Serving')
    expect((await read(pinned)).items[0]!.text).toBe('original private data')
  })

  it('exposes operations and immutable diagnostics, not engine handles', async () => {
    const { runner } = await fixture()
    const turn = await runner.beginTurn()
    expect(Object.keys(runner)).toEqual(['context'])
    expect('runtime' in runner).toBe(false)
    expect('generations' in runner).toBe(false)
    expect(Object.keys(turn).sort()).toEqual(['executeAction', 'executeRoute', 'release', 'view'])
    expectTypeOf<keyof MemoryTestTurn>().toEqualTypeOf<'view' | 'executeRoute' | 'executeAction' | 'release'>()
    const diagnostics = runner.inspect()
    expect(diagnostics).toMatchObject({ servingGenerationId: turn.view.runtimeGeneration, evaluation: { state: 'ready', sourceInstanceKeys: ['source:work'] } })
    expect(Object.isFrozen(diagnostics.evaluation.sourceInstanceKeys)).toBe(true)
    expect(JSON.parse(JSON.stringify(diagnostics))).toEqual(diagnostics)
    turn.release()
    turn.release()
    await expect(turn.executeRoute(turn.view.routes[0]!.id, {})).rejects.toThrow('released')
    await expect(turn.executeAction(turn.view.actionOffers[0]!.id, {}, () => true)).rejects.toThrow('released')
  })

  it('preserves View identity, input validation, authority denial, cancellation and call budgets', async () => {
    const { runner } = await fixture()
    const turn = await runner.beginTurn()
    const route = turn.view.routes[0]!.id
    const action = turn.view.actionOffers[0]!.id
    await expect(turn.executeAction(action, {}, () => false)).rejects.toThrow('not currently authorized')
    await expect(turn.executeAction(action, 'wrong schema', () => true)).rejects.toThrow('object')
    const aborted = new AbortController()
    aborted.abort(new Error('test cancelled'))
    await expect(turn.executeRoute(route, {}, aborted.signal)).rejects.toThrow('test cancelled')
    await expect(turn.executeRoute('another-source/read', {})).rejects.toThrow('unavailable')
    const evidence = await turn.executeRoute(route, {})
    expect(evidence).toMatchObject({ viewId: turn.view.id, routeId: route, sourceInstanceKey: 'source:work' })
    const receipt = await turn.executeAction(action, {}, () => true)
    expect(receipt).toMatchObject({ viewId: turn.view.id, offerId: action, status: 'succeeded' })
    await turn.executeRoute(route, {})
    await expect(turn.executeRoute(route, {})).rejects.toThrow('budget is exhausted')
  })

  it('retains the requested evidence budget instead of falling back to global defaults', async () => {
    const { runner } = await fixture()
    const budget = { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 5 }
    const turn = await runner.beginTurn({ budget })
    budget.maxEvidenceCharacters = 1_000
    const evidence = await turn.executeRoute(turn.view.routes[0]!.id, {})
    expect(evidence.items.reduce((count, item) => count + item.text.length, 0)).toBeLessThanOrEqual(5)
    expect(evidence.truncated).toBe(true)
  })

  it('accepts Host defaults and ceilings through public Source descriptors only', async () => {
    const identities: unknown[] = []
    const configuration = vi.fn()
    const { runner } = await fixture({
      sourceConfiguration(item) { identities.push(item); return { label: 'configured' } },
      sourceCapabilities: () => ['project', 'read'],
    }, context => { configuration(context.configuration); return {} })
    expect(identities[0]).toMatchObject({ sourceInstanceKey: 'source:work', manifest: { typeId: 'notes' }, provenance: { entryId: 'work' } })
    expect(Object.keys(identities[0] as object).sort()).toEqual(['manifest', 'provenance', 'sourceInstanceKey'])
    expect(Object.isFrozen(identities[0])).toBe(true)
    expect(configuration).toHaveBeenCalledWith({ label: 'configured' })
    const turn = await runner.beginTurn()
    expect(turn.view.actionOffers).toEqual([])
  })

  it('keeps management scoped and exercises confirmation/revision rejection through its public protocol', async () => {
    const manage = vi.fn<NonNullable<MemorySourceRuntime['manage']>>(request => ({ revision: 'r1', value: request.scope.workspaceId ?? null }))
    const { runner } = await fixture({}, () => ({ manage }))
    const scope = { storage: 'workspace' as const, workspaceId: '/work' }
    const client = await runner.managementClient('source:work', scope)
    scope.workspaceId = '/personal'
    expect((await client.read('read')).value).toBe('/work')
    await expect(runner.executeManagement({ sourceInstanceKey: 'source:work', scope, mode: 'mutate', operation: 'write', input: {}, confirmed: false, expectedRevision: 'r1' })).rejects.toThrow('confirmation')
    await expect(client.mutate('write', {}, { confirmed: true, expectedRevision: 'old' })).rejects.toThrow('revision conflict')
    await expect(client.mutate('write', {}, { confirmed: true })).resolves.toMatchObject({ revision: 'r1' })
    expect(manage).toHaveBeenCalledTimes(2)
  })

  it('holds a separate lease for an in-flight query after turn release and Source unload', async () => {
    const pending = gate()
    const started = gate()
    const disposed = vi.fn()
    const { runner, unmount } = await fixture({}, context => ({
      dispose: disposed,
      query: async ({ view, route }) => {
        started.resolve()
        await pending.promise
        return { id: 'read', viewId: view.id, routeId: route.id, sourceInstanceKey: context.sourceInstanceKey,
          observedAt: '2026-08-30T00:00:00.000Z', items: [], truncated: false }
      },
    }))
    const turn = await runner.beginTurn()
    const operation = turn.executeRoute(turn.view.routes[0]!.id, {})
    await started.promise
    await unmount()
    turn.release()
    expect(runner.inspect().drainingGenerationIds).toEqual([turn.view.runtimeGeneration])
    const closing = runner.dispose()
    try {
      await Promise.resolve()
      expect(disposed).not.toHaveBeenCalled()
      await expect(runner.beginTurn()).rejects.toThrow('disposed')
    } finally { pending.resolve() }
    await operation
    await closing
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('waits for in-flight action authorization even when the test closes its runner', async () => {
    const pending = gate()
    const started = gate()
    const disposed = vi.fn()
    const { runner } = await fixture({}, () => ({ dispose: disposed }))
    const turn = await runner.beginTurn()
    const operation = turn.executeAction(turn.view.actionOffers[0]!.id, {}, async () => {
      started.resolve()
      await pending.promise
      return true
    })
    await started.promise
    const closing = runner.dispose()
    try { expect(disposed).not.toHaveBeenCalled() }
    finally { pending.resolve() }
    await expect(operation).resolves.toMatchObject({ status: 'succeeded' })
    await closing
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('cleans up retained turns and the real Cordis service on idempotent disposal', async () => {
    const disposed = vi.fn()
    const { runner } = await fixture({}, () => ({ dispose: disposed }))
    const service = runner.context.mnemonMemory
    await runner.beginTurn()
    const closing = runner.dispose()
    expect(runner.dispose()).toBe(closing)
    await closing
    expect(disposed).toHaveBeenCalledOnce()
    expect(runner.context.get('mnemonMemory', false)).toBeUndefined()
    expect(() => service.installContributions({}, { instanceId: 'late' })).toThrow('disposed')
    await expect(runner.managementCatalog()).rejects.toThrow('disposed')
  })

  it('releases a pending composition instead of publishing a turn after disposal', async () => {
    const pending = gate()
    const started = gate()
    const disposed = vi.fn()
    const { runner } = await fixture({}, context => ({
      dispose: disposed,
      project: async request => {
        started.resolve()
        await pending.promise
        return { fragments: [], readGrant: { id: 'grant', sourceInstanceKey: context.sourceInstanceKey,
          schema: 'test/notes-v1', value: null, revision: request.expectedRevision, consistency: 'exact-snapshot' } }
      },
    }))
    const composition = expect(runner.beginTurn()).rejects.toThrow('disposed')
    await started.promise
    const closing = runner.dispose()
    try { expect(disposed).not.toHaveBeenCalled() }
    finally { pending.resolve() }
    await composition
    await closing
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('removes a registration left by a failed plugin and permits a clean retry', async () => {
    const { runner, sourcePlugin } = await fixture()
    await expect(runner.mount({ ...sourcePlugin, apply(ctx: Context) {
      sourcePlugin.apply(ctx)
      throw new Error('plugin startup failed')
    } }, { instanceId: 'failed' })).rejects.toThrow('plugin startup failed')
    expect(runner.inspect().evaluation.sourceInstanceKeys).toEqual(['source:work'])
    const unmount = await runner.mount(sourcePlugin, { instanceId: 'failed' })
    await unmount()
    await unmount()
    expect(runner.inspect().evaluation.sourceInstanceKeys).toEqual(['source:work'])
  })
})

describe('generation-owned Source configuration', () => {
  it('captures JSON defaults, digests changes and preserves a pinned generation', async () => {
    const defaults = { label: 'before', nested: { limit: 3 } }
    const captured: unknown[] = []
    const runner = new MemoryCompositionRunner({ sourceConfiguration: () => defaults })
    try {
      const sourcePlugin = { inject: ['mnemonMemory'], apply(ctx: Context) {
        installMemory(ctx, { sources: [defineMemorySource({
          manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'config', packageName: 'test-source-config', role: 'test', capabilities: ['project'], consistency: 'exact-snapshot' },
          create(context) {
            const configuration = context.configuration!
            captured.push(configuration)
            return {
              facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'config', role: 'test', availability: 'ready', revision: String(configuration.label), capabilities: ['project'], routeIds: [], actionIds: [] }),
              project: request => ({ fragments: [{ id: 'label', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode, text: String(configuration.label), revision: String(configuration.label) }] }),
            }
          },
        })] })
      } }
      const unmountSource = await runner.mount(sourcePlugin, { instanceId: 'source' })
      await runner.mount({ inject: ['mnemonMemory'], apply(ctx: Context) {
        installMemory(ctx, { strategies: [defineMemoryStrategy({
          manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'test', packageName: 'test-strategy', deterministic: true, supportedSourceRoles: ['test'], maxSources: 1, maxRoutes: 1, maxActions: 1 },
          compose: (_request, sources) => ({ strategyTypeId: 'test', sources: sources.map(item => ({ sourceInstanceKey: item.sourceInstanceKey, projection: { mode: 'eager', maxCharacters: 100 } })), explanation: 'Test only.' }),
        })] })
      } }, { instanceId: 'strategy' })
      const pinned = await runner.beginTurn()
      expect(pinned.view.projection[0]?.text).toBe('before')
      expect(Object.isFrozen(captured[0])).toBe(true)
      expect(Object.isFrozen((captured[0] as typeof defaults).nested)).toBe(true)
      defaults.label = 'after'
      await unmountSource()
      await runner.mount(sourcePlugin, { instanceId: 'source' })
      const next = await runner.beginTurn()
      expect(next.view.projection[0]?.text).toBe('after')
      expect(next.view.runtimeGeneration).not.toBe(pinned.view.runtimeGeneration)
      expect(pinned.view.projection[0]?.text).toBe('before')
      expect(runner.inspect().drainingGenerationIds).toContain(pinned.view.runtimeGeneration)
      pinned.release()
      next.release()
    } finally { await runner.dispose() }
  })
})

describe('Source composition failure boundaries', () => {
  const runners: MemoryCompositionRunner[] = []
  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.dispose()
    vi.useRealTimers()
  })

  async function fixture(required: string[] = [], timeoutMs = 50) {
    const runner = new MemoryCompositionRunner({ sourceTimeoutMs: timeoutMs })
    runners.push(runner)
    await runner.mount({ inject: ['mnemonMemory'], apply(ctx: Context) {
      installMemory(ctx, { strategies: [defineMemoryStrategy({
        manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'test', packageName: 'test-strategy',
          deterministic: true, supportedSourceRoles: ['notes'], maxSources: 4, maxRoutes: 4, maxActions: 4 },
        compose(request, sources) {
          expect(Object.keys(request).sort()).toEqual(['budget', 'scenario', 'scope'])
          expect(() => JSON.stringify(request)).not.toThrow()
          return { strategyTypeId: 'test', explanation: 'Explicit required and optional Sources.',
            sources: sources.map(item => ({ sourceInstanceKey: item.sourceInstanceKey,
              required: required.includes(item.sourceInstanceKey), projection: { mode: 'eager', maxCharacters: 100 },
              routeIds: item.routeIds, actionIds: item.actionIds })) }
        },
      })] })
    } }, { instanceId: 'strategy' })
    async function mount(id: string, overrides: (context: MemorySourceRuntimeContext) => Partial<MemorySourceRuntime> = () => ({})) {
      await runner.mount({ inject: ['mnemonMemory'], apply(ctx: Context) {
        installMemory(ctx, { sources: [defineMemorySource({
          manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'notes', packageName: 'test-source',
            role: 'notes', capabilities: ['project', 'read', 'write'], consistency: 'exact-snapshot',
            routes: [{ id: 'read', description: 'Read', capability: 'read', inputSchema: { type: 'object' }, maxCalls: 1 }],
            actions: [{ id: 'write', description: 'Write', capability: 'write', inputSchema: { type: 'object' } }],
            management: { label: 'Notes', description: 'Test Source' } },
          create(context) {
            return {
              facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'notes', role: 'notes',
                availability: 'ready', revision: 'r1', capabilities: ['project', 'read', 'write'], routeIds: ['read'], actionIds: ['write'] }),
              project: request => ({ fragments: [{ id: 'note', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode, text: id, revision: 'r1' }],
                readGrant: { id: context.sourceInstanceKey + '/grant', sourceInstanceKey: context.sourceInstanceKey,
                  schema: 'notes/v1', value: null, revision: 'r1', consistency: 'exact-snapshot' } }),
              manage: () => ({ revision: 'r1', value: id }),
              ...overrides(context),
            }
          },
        })] })
      } }, { instanceId: id })
    }
    await mount('good')
    return { runner, mount }
  }

  it('isolates optional facts failures and sanitizes View and management diagnostics', async () => {
    const { runner, mount } = await fixture()
    await mount('offline', () => ({ facts() { throw new Error('https://private.example?token=DO-NOT-EXPOSE') } }))
    const turn = await runner.beginTurn()
    expect(turn.view.projection.map(value => value.text)).toEqual(['good'])
    expect(turn.view.diagnostics).toEqual([{ code: 'source-facts-failed', contributionInstanceKey: 'source:offline',
      message: 'Memory Source source:offline facts() failed' }])
    const catalog = await runner.managementCatalog()
    expect(catalog.sources.map(item => item.availability)).toEqual(['ready', 'unavailable'])
    expect(catalog.diagnostics).toEqual(turn.view.diagnostics)
    expect(JSON.stringify({ view: turn.view, catalog })).not.toContain('DO-NOT-EXPOSE')
    await expect(runner.beginTurn()).resolves.toHaveProperty('view')
  })

  it('fails closed when the Strategy requires a Source with unavailable facts', async () => {
    const { runner, mount } = await fixture(['source:offline'])
    await mount('offline', () => ({ facts() { throw new Error('private reason') } }))
    await expect(runner.beginTurn()).rejects.toThrow('unavailable required Source runtime: source:offline')
    expect(runner.inspect().evaluation.state).toBe('ready')
  })

  it.each([false, true])('handles a project failure according to required=%s', async required => {
    const { runner, mount } = await fixture(required ? ['source:offline'] : [])
    await mount('offline', () => ({ project() { throw new Error('private reason') } }))
    if (required) {
      await expect(runner.beginTurn()).rejects.toThrow('Memory Source source:offline project() failed')
    } else {
      const { view } = await runner.beginTurn()
      expect(view.projection.map(value => value.text)).toEqual(['good'])
      expect(view.routes.map(value => value.sourceInstanceKey)).toEqual(['source:good'])
      expect(view.actionOffers.map(value => value.sourceInstanceKey)).toEqual(['source:good'])
      expect(view.readGrants.map(value => value.sourceInstanceKey)).toEqual(['source:good'])
      expect(view.diagnostics?.[0]?.code).toBe('source-project-failed')
    }
  })

  it('runs independent facts concurrently and times out hung Sources without leaking timers', async () => {
    vi.useFakeTimers()
    const { runner, mount } = await fixture()
    const started: string[] = []
    const signals: AbortSignal[] = []
    for (const id of ['slow-a', 'slow-b']) await mount(id, () => ({ facts(_request, signal) {
      started.push(id); signals.push(signal!)
      return new Promise(() => {})
    } }))
    const pending = runner.beginTurn()
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toEqual(['slow-a', 'slow-b'])
    await vi.advanceTimersByTimeAsync(50)
    const { view } = await pending
    expect(view.projection.map(value => value.text)).toEqual(['good'])
    expect(view.diagnostics?.map(value => value.code)).toEqual(['source-facts-timeout', 'source-facts-timeout'])
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards an optional late projection instead of mutating an already-published View', async () => {
    vi.useFakeTimers()
    const { runner, mount } = await fixture()
    const late = Promise.withResolvers<MemoryViewContribution>()
    let signal: AbortSignal | undefined
    await mount('slow', () => ({ project(_request, abort) { signal = abort; return late.promise } }))
    const pending = runner.beginTurn()
    await vi.advanceTimersByTimeAsync(50)
    const { view } = await pending
    const snapshot = JSON.stringify(view)
    expect(view.diagnostics?.[0]?.code).toBe('source-project-timeout')
    expect(signal?.aborted).toBe(true)
    late.resolve({ fragments: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.stringify(view)).toBe(snapshot)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['facts', 'project'] as const)('propagates cancellation during %s instead of degrading it', async phase => {
    const { runner, mount } = await fixture([], 10_000)
    const started = Promise.withResolvers<void>()
    let seen: AbortSignal | undefined
    const pendingRead = (_request: unknown, signal?: AbortSignal): Promise<never> => {
      seen = signal; started.resolve(); return new Promise(() => {})
    }
    await mount('slow', () => ({ [phase]: pendingRead }))
    const cancellation = new AbortController()
    const pending = runner.beginTurn({}, cancellation.signal)
    await started.promise
    const rejected = expect(pending).rejects.toThrow('stop composition')
    cancellation.abort(new Error('stop composition'))
    await rejected
    expect(seen?.aborted).toBe(true)
  })

  it('aborts a pending read when the public runner closes, without waiting for its deadline', async () => {
    const { runner, mount } = await fixture([], 10_000)
    const started = Promise.withResolvers<void>()
    await mount('slow', () => ({ facts() { started.resolve(); return new Promise(() => {}) } }))
    const pending = runner.beginTurn()
    await started.promise
    const rejected = expect(pending).rejects.toThrow('disposed')
    await runner.dispose()
    await rejected
  })

  it('does not turn malformed Source authority claims into a recoverable outage', async () => {
    const { runner, mount } = await fixture()
    await mount('invalid', context => ({ facts: () => ({ sourceInstanceKey: context.sourceInstanceKey,
      sourceTypeId: 'notes', role: 'notes', availability: 'ready', revision: 'r1',
      capabilities: ['forget'], routeIds: [], actionIds: [],
    }) }))
    await expect(runner.beginTurn()).rejects.toThrow('expand manifest capability')
  })
})

describe('Source-local operation cost', () => {
  it('does not probe unrelated Sources or recompose a View for a local read/write/route', async () => {
    const f = await compositionFixture()
    try {
      const generation = f.graph.memoryComposition.current()!
      const instances = generation.sourceInstances()
      const spies = Object.fromEntries(instances.map(item => [item.sourceTypeId,
        vi.spyOn(generation.sourceRuntime(item.sourceInstanceKey)!, 'facts')]))
      const documents = f.graph.source('documents')
      const created = await documents.mutate<{ document: { id: string } }>('mutate', { action: 'create', title: 'Local operation', content: 'Only this Source.' })
      expect(spies.documents).toHaveBeenCalledTimes(2)
      expect(spies.runtime).not.toHaveBeenCalled()
      expect(spies['memory-spaces']).not.toHaveBeenCalled()
      spies.documents!.mockClear()
      await documents.read('document', { id: created.document.id })
      expect(spies.documents).toHaveBeenCalledOnce()
      expect(spies.runtime).not.toHaveBeenCalled()
      expect(spies['memory-spaces']).not.toHaveBeenCalled()
      const scope = { storage: 'custom' as const, workspaceId: f.workspace, agentId: 'root' }
      const turn = await f.graph.composableTurns.beginTurn('read-turn', scope)
      Object.values(spies).forEach(spy => spy.mockClear())
      const read = await f.graph.source('documents', scope).forTurn(turn).route('search', { query: 'Only' })
      expect(read.items).toHaveLength(1)
      Object.values(spies).forEach(spy => expect(spy).not.toHaveBeenCalled())
    } finally { await f.dispose() }
  })
})

describe('memory plugin graph contract', () => {
  function graphSource(entryId: string, role: string): InstalledMemorySource {
    const definition = defineMemorySource({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: entryId,
        packageName: `dsh-mnemon-source-${entryId}`, role, capabilities: ['project'], consistency: 'exact-snapshot' },
      create: context => ({
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: entryId, role, availability: 'ready', revision: 'r1', capabilities: ['project'], routeIds: [], actionIds: [] }),
        project: () => ({ fragments: [] }),
      }),
    })
    return { kind: 'source', instanceKey: `source:${entryId}`, provenance: { packageName: definition.manifest.packageName, entryId }, definition }
  }

  function graphStrategy(entryId = 'base'): InstalledMemoryStrategy {
    const definition = defineMemoryStrategy({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: entryId,
        packageName: `dsh-mnemon-strategy-${entryId}`, deterministic: true, supportedSourceRoles: ['working-context', 'durable-evidence'], maxSources: 4, maxRoutes: 4, maxActions: 4 },
      compose: () => ({ strategyTypeId: entryId, sources: [], explanation: 'Fixture.' }),
    })
    return { kind: 'strategy', instanceKey: `strategy:${entryId}`, provenance: { packageName: definition.manifest.packageName, entryId }, definition }
  }

  function plugin(entryId: string, value: Parameters<typeof defineMemoryPlugin>[0]): InstalledMemoryPlugin {
    const descriptor = defineMemoryPlugin(value)
    return { kind: 'plugin', instanceKey: `plugin:${entryId}`, provenance: { packageName: descriptor.packageName, entryId }, descriptor }
  }

  function snapshot(sources: InstalledMemorySource[], plugins: InstalledMemoryPlugin[]): MemoryContributionSnapshot {
    return { revision: 1, sources, strategies: [graphStrategy()], plugins }
  }

  it('rejects a missing hard dependency before creating a generation', async () => {
    const work = graphSource('work', 'working-context')
    const result = await evaluateMemoryComposition({ contributions: snapshot([work], [
      plugin('work', { packageName: work.provenance.packageName, label: { en: 'Work', 'zh-CN': '工作' }, description: { en: 'Work.', 'zh-CN': '工作。' }, roles: ['source'], provides: [{ id: 'source.working-context' }] }),
      plugin('base', { packageName: 'dsh-mnemon-strategy-base', label: { en: 'Base', 'zh-CN': '基础' }, description: { en: 'Base.', 'zh-CN': '基础。' }, roles: ['strategy'], provides: [{ id: 'strategy.base' }], requires: ['source.durable-evidence'] }),
    ]) })
    expect(result.report).toMatchObject({ state: 'rejected', diagnostics: [{ message: expect.stringContaining('source.durable-evidence') }] })
  })

  it('rejects two active providers of one exclusive capability', async () => {
    const left = graphSource('left', 'working-context'), right = graphSource('right', 'working-context')
    const result = await evaluateMemoryComposition({ contributions: snapshot([left, right], [
      plugin('left', { packageName: left.provenance.packageName, label: { en: 'Left', 'zh-CN': '左' }, description: { en: 'Left.', 'zh-CN': '左。' }, roles: ['source'], provides: [{ id: 'source.primary', exclusive: true }] }),
      plugin('right', { packageName: right.provenance.packageName, label: { en: 'Right', 'zh-CN': '右' }, description: { en: 'Right.', 'zh-CN': '右。' }, roles: ['source'], provides: [{ id: 'source.primary', exclusive: true }] }),
    ]) })
    expect(result.report).toMatchObject({ state: 'rejected', diagnostics: [{ message: expect.stringContaining('source.primary') }] })
  })

  it('lets a legacy Source satisfy a semantic dependency from its runtime role', async () => {
    const durable = graphSource('legacy', 'durable-evidence')
    const result = await evaluateMemoryComposition({ contributions: snapshot([durable], [
      plugin('base', { packageName: 'dsh-mnemon-strategy-base', label: { en: 'Base', 'zh-CN': '基础' }, description: { en: 'Base.', 'zh-CN': '基础。' }, roles: ['strategy'], provides: [{ id: 'strategy.base' }], requires: ['source.durable-evidence'] }),
    ]) })
    expect(result.report.state).toBe('ready')
    await result.generation?.dispose()
  })
})
