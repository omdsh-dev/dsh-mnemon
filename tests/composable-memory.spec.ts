import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPOSABLE_MEMORY_API_VERSION,
  type ComposableMemoryView,
  type MemoryJsonValue,
  type MemorySourceDefinition,
  type MemorySourceRuntime,
  type MemoryStrategyDefinition,
  type MemoryViewRequest,
} from "../src/core/contracts/index.ts"
import type { InstalledMemorySource, InstalledMemoryStrategy, MemoryContributionSnapshot } from '../src/core/contributions.ts'
import { canonicalMemoryJson, jsonClone } from '../src/core/definitions.ts'
import {
  MemoryCompositionGeneration,
  MemoryGenerationHost,
  defineMemorySource,
  defineMemoryStrategy,
  evaluateMemoryComposition,
} from "../src/core/index.ts"
import * as core from '../src/core/plugin.ts'
import { MemoryRuntime } from '../src/core/runtime.ts'
import { installMemory } from '../src/sdk/index.ts'
import { MemoryCompositionRunner as TestingMemoryCompositionRunner } from 'dsh-mnemon/testing'
import type { DocumentMutationResult } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import * as capture from 'dsh-mnemon-strategy-auto-capture'
import * as light from 'dsh-mnemon-strategy-light-context'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import { compositionFixture } from './fixtures/composition.ts'

const REQUEST: MemoryViewRequest = {
  scope: { storage: 'workspace', workspaceId: '/workspace' },
  scenario: 'test',
  budget: {
    maxProjectionCharacters: 1_000,
    maxRoutes: 4,
    maxActions: 4,
    maxEvidenceResults: 2,
    maxEvidenceCharacters: 7,
  },
}

function sourceDefinition(options: {
  typeId?: string
  dispose?: () => void
  queryFailure?: boolean
  query?: (request: Parameters<NonNullable<MemorySourceRuntime['query']>>[0]) => void
} = {}): MemorySourceDefinition {
  const typeId = options.typeId ?? 'example'
  return defineMemorySource({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION,
      kind: 'source',
      typeId,
      packageName: `dsh-mnemon-source-${typeId}`,
      role: 'working-context',
      capabilities: ['project', 'search', 'write'],
      consistency: 'namespace-pinned-live-read',
      routes: [{
        id: 'search',
        description: 'Search bounded example evidence.',
        capability: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        maxCalls: 1,
        maxResults: 3,
        maxCharacters: 20,
      }],
      actions: [{
        id: 'remember',
        description: 'Remember one bounded fact.',
        capability: 'write',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      }],
      management: {
        label: 'Example',
        description: 'Schema-driven management metadata.',
        fields: [{ key: 'token', label: 'Token', input: 'secret', required: true, secret: true }],
      },
    },
    create(context) {
      return {
        facts: () => ({
          sourceInstanceKey: context.sourceInstanceKey,
          sourceTypeId: typeId,
          role: 'working-context',
          availability: 'ready',
          revision: 'source-r1',
          capabilities: ['project', 'search', 'write'],
          routeIds: ['search'],
          actionIds: ['remember'],
        }),
        project: request => ({
          fragments: request.maxCharacters <= 1 ? [] : [{
            id: `${context.sourceInstanceKey}/projection`,
            sourceInstanceKey: context.sourceInstanceKey,
            mode: request.mode,
            text: 'stable projection',
            revision: 'source-r1',
            provenance: { packageName: context.provenance.packageName },
          }],
          readGrant: {
            id: `${context.sourceInstanceKey}/grant`,
            sourceInstanceKey: context.sourceInstanceKey,
            schema: 'example/grant-v1',
            value: { namespaceIds: ['visible'] },
            revision: 'grant-r1',
            consistency: 'namespace-pinned-live-read',
          },
        }),
        manage: request => {
          if (request.mode === 'mutate' && request.expectedRevision !== 'source-r1') throw new Error('management revision conflict')
          return {
            revision: request.mode === 'mutate' ? 'source-r2' : 'source-r1',
            value: { operation: request.operation, mode: request.mode, input: request.input },
          }
        },
        query: async request => {
          options.query?.(request)
          if (options.queryFailure === true) throw new Error('query unavailable')
          return {
            id: 'evidence-1',
            viewId: request.view.id,
            routeId: request.route.id,
            sourceInstanceKey: context.sourceInstanceKey,
            observedAt: '2026-08-30T00:00:00.000Z',
            items: [
              { id: 'one', text: 'abcdef', provenance: { namespaceId: 'visible' } },
              { id: 'two', text: 'ghijkl', provenance: { namespaceId: 'visible' } },
              { id: 'three', text: 'mnopqr', provenance: { namespaceId: 'visible' } },
            ],
            truncated: false,
          }
        },
        mutate: request => ({
          id: 'receipt-1',
          viewId: request.view.id,
          offerId: request.offer.id,
          sourceInstanceKey: context.sourceInstanceKey,
          status: 'succeeded',
          completion: 'committed',
          committedAt: '2026-08-30T00:00:00.000Z',
          revision: 'source-r2',
        }),
        ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
      }
    },
  })
}

function strategyDefinition(compose?: MemoryStrategyDefinition['compose']): MemoryStrategyDefinition {
  return defineMemoryStrategy({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION,
      kind: 'strategy',
      typeId: 'test',
      packageName: 'dsh-mnemon-strategy-test',
      deterministic: true,
      supportedSourceRoles: ['working-context'],
      maxSources: 4,
      maxRoutes: 4,
      maxActions: 4,
    },
    compose: compose ?? ((_, facts) => ({
      strategyTypeId: 'test',
      explanation: 'Select the ready fixture Source.',
      sources: facts.map(fact => ({
        sourceInstanceKey: fact.sourceInstanceKey,
        projection: { mode: 'eager', maxCharacters: 100 },
        routeIds: ['search'],
        actionIds: ['remember'],
      })),
    })),
  })
}

function installedSource(definition = sourceDefinition(), instance = 'fixture'): InstalledMemorySource {
  return {
    kind: 'source',
    instanceKey: `source:${instance}`,
    provenance: { packageName: definition.manifest.packageName, entryId: instance, artifactDigest: 'sha256:source' },
    definition,
  }
}

function installedStrategy(definition = strategyDefinition(), instance = 'fixture'): InstalledMemoryStrategy {
  return {
    kind: 'strategy',
    instanceKey: `strategy:${instance}`,
    provenance: { packageName: definition.manifest.packageName, entryId: instance, artifactDigest: 'sha256:strategy' },
    definition,
  }
}

function contributions(source = installedSource(), strategy = installedStrategy()): MemoryContributionSnapshot {
  return { revision: 1, sources: [source], strategies: [strategy] }
}

describe('Composable View Memory compiler', () => {
  it('normalizes bounded Source presentation without rendering it to the model', async () => {
    const base = sourceDefinition()
    let presentation: unknown = {
      visibleItems: 2,
      totalItems: 3,
      items: [{ id: 'one', title: 'Visible item', excerpt: 'Source-authored preview' }],
    }
    const source = defineMemorySource({ ...base, create(context) {
      const runtime = base.create(context)
      return { ...runtime, async project(request) {
        return { ...await runtime.project(request), presentation: presentation as never }
      } }
    } })
    const generation = new MemoryCompositionGeneration(contributions(installedSource(source)))
    try {
      const view = await generation.compose(REQUEST)
      expect(view.sourcePresentations).toEqual([{
        sourceInstanceKey: 'source:fixture', mode: 'eager', visibleItems: 2, totalItems: 3,
        items: [{ id: 'one', title: 'Visible item', excerpt: 'Source-authored preview' }],
      }])
      expect(Object.isFrozen(view.sourcePresentations?.[0]?.items)).toBe(true)
      expect(JSON.stringify(view.projection)).not.toContain('Source-authored preview')

      for (const invalid of [
        { visibleItems: -1 },
        { visibleItems: 1, totalItems: 0 },
        { visibleItems: 0, items: [{ id: 'one', title: 'overflow' }] },
        { visibleItems: 2, items: [{ id: 'same', title: 'one' }, { id: 'same', title: 'two' }] },
        { visibleItems: 1, items: [{ id: 'one', title: 'x'.repeat(161) }] },
      ]) {
        presentation = invalid
        await expect(generation.compose(REQUEST)).rejects.toThrow('presentation')
      }
    } finally { await generation.dispose() }
  })

  it('pins trusted Strategy guidance in the digest and rejects malformed or oversized instructions', async () => {
    let guidance: unknown = { system: 'Instruction {{model}}', routing: 'Route only as offered', reminders: { read: 'Read only if needed' } }
    const base = strategyDefinition()
    const strategy = strategyDefinition((request, facts) => ({ ...base.compose(request, facts), guidance: guidance as never }))
    const generation = new MemoryCompositionGeneration(contributions(installedSource(), installedStrategy(strategy)))
    try {
      const first = await generation.compose(REQUEST)
      expect(first.guidance).toEqual(guidance)
      expect(Object.isFrozen(first.guidance?.reminders)).toBe(true)
      ;(guidance as { system: string }).system = 'Updated instruction'
      expect(first.guidance?.system).toBe('Instruction {{model}}')
      expect((await generation.compose(REQUEST)).digest).not.toBe(first.digest)
      for (const invalid of [1, [], null, { system: 12 }, { reminders: 'invalid' }, { reminders: { read: 1 } }, { system: 'x'.repeat(16_385) }]) {
        guidance = invalid
        await expect(generation.compose(REQUEST)).rejects.toThrow(/Strategy (guidance|reminder)/)
      }
    } finally { await generation.dispose() }
  })

  it('creates execution policies only on a read, shares them within a turn and isolates equal Views', async () => {
    const query = vi.fn()
    const createTurn = vi.fn(() => {
      let pending: Promise<import('../src/core/contracts/view.ts').MemoryEvidence> | undefined
      return { query: (_request: unknown, read: import('../src/core/contracts/view.ts').MemoryStrategyRead) => pending ??= read({ query: 'fixed' }) }
    })
    const definition = defineMemoryStrategy({ ...strategyDefinition(), createTurn })
    const generation = new MemoryCompositionGeneration(contributions(installedSource(sourceDefinition({ query })), installedStrategy(definition)))
    try {
      const view = await generation.compose(REQUEST)
      expect(createTurn).not.toHaveBeenCalled()
      const turn = {}, child = {}
      const route = view.routes[0]!.id
      const read = (execution: object) => generation.executeRoute(view, route, { query: 'user' }, undefined, REQUEST.budget, execution)
      const results = await Promise.all([read(turn), read(turn), read(child)])
      expect(results[0]).toEqual(results[1])
      expect(createTurn).toHaveBeenCalledTimes(2)
      expect(query).toHaveBeenCalledTimes(2)
    } finally { await generation.dispose() }
  })

  it('fences a Strategy continuation by schema, effective ceilings, dispatched calls and lifetime', async () => {
    const query = vi.fn()
    let continuation: import('../src/core/contracts/view.ts').MemoryStrategyRead | undefined
    const definition = defineMemoryStrategy({ ...strategyDefinition(), createTurn: () => ({
      async query(_request, read) {
        continuation = read
        await expect(read({ query: 'x', forbidden: true })).rejects.toThrow('unsupported property')
        const evidence = await read({ query: 'x' }, { maxResults: 999, maxCharacters: 999 })
        await expect(read({ query: 'second' })).rejects.toThrow('budget is exhausted')
        return evidence
      },
    }) })
    const generation = new MemoryCompositionGeneration(contributions(installedSource(sourceDefinition({ query })), installedStrategy(definition)))
    try {
      const view = await generation.compose(REQUEST)
      await generation.executeRoute(view, view.routes[0]!.id, { query: 'x' })
      expect(query).toHaveBeenCalledOnce()
      expect(query.mock.calls[0]![0].route).toMatchObject({ maxResults: 2, maxCharacters: 7 })
      await expect(continuation!({ query: 'late' })).rejects.toThrow('no longer active')
    } finally { await generation.dispose() }
  })

  it('compiles one Source and one Strategy into the normalized immutable View', async () => {
    const generation = new MemoryCompositionGeneration(contributions(), {
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    })
    const view = await generation.compose(REQUEST)

    expect(view).toMatchObject({
      id: expect.stringMatching(/^view:[a-f0-9]{64}$/),
      runtimeGeneration: expect.stringMatching(/^generation:[a-f0-9]{64}$/),
      strategyInstanceKey: 'strategy:fixture',
      strategyTypeId: 'test',
      projection: [{ sourceInstanceKey: 'source:fixture', mode: 'eager', text: 'stable projection' }],
      routes: [{ id: 'source:fixture/search', readGrantId: 'source:fixture/grant', maxCalls: 1 }],
      readGrants: [{ id: 'source:fixture/grant', value: { namespaceIds: ['visible'] } }],
      actionOffers: [{ id: 'source:fixture/remember', capability: 'write' }],
      consistency: { mode: 'namespace-pinned-live-read', sourceRevisions: { 'source:fixture': 'source-r1' } },
    })
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.readGrants[0]!.value)).toBe(true)
    expect(JSON.stringify({ projection: view.projection, routes: view.routes, actionOffers: view.actionOffers })).not.toContain('namespaceIds')

    const replay = await generation.compose(REQUEST)
    expect(replay.digest).toBe(view.digest)
    await generation.dispose()
  })

  it('executes only a pinned Route and omits whole over-budget items without rewriting their content', async () => {
    const generation = new MemoryCompositionGeneration(contributions())
    const view = await generation.compose(REQUEST)
    const routeId = view.routes[0]!.id

    await expect(generation.executeRoute(view, routeId, { query: 'needle', unexpected: true }))
      .rejects.toThrow('unsupported property')
    const evidence = await generation.executeRoute(view, routeId, { query: 'needle' })
    expect(evidence.items.map(item => item.text)).toEqual(['abcdef'])
    expect(evidence.truncated).toBe(true)
    await expect(generation.executeRoute(view, routeId, { query: 'again' })).rejects.toThrow('budget is exhausted')
    await expect(generation.executeRoute(view, 'source:fixture/undeclared', { query: 'needle' })).rejects.toThrow('unavailable')
    await generation.dispose()
  })

  it('narrows execution limits before the Source runs without mutating the pinned View', async () => {
    const query = vi.fn()
    const generation = new MemoryCompositionGeneration(contributions(installedSource(sourceDefinition({ query }))))
    try {
      const view = await generation.compose(REQUEST)
      const route = view.routes[0]!
      await expect(generation.executeRoute(view, route.id, { query: 'needle' }, undefined,
        { ...REQUEST.budget, maxEvidenceCharacters: 0 })).rejects.toThrow()
      expect(query).not.toHaveBeenCalled()
      const evidence = await generation.executeRoute(view, route.id, { query: 'needle' }, undefined,
        { ...REQUEST.budget, maxEvidenceCharacters: 3, maxEvidenceResults: 1 })
      expect(query.mock.calls[0]![0].route).toMatchObject({ maxCharacters: 3, maxResults: 1 })
      expect(evidence.items).toEqual([])
      expect(evidence.truncated).toBe(true)
      expect(route).toMatchObject({ maxCharacters: 7, maxResults: 2 })
    } finally { await generation.dispose() }
  })

  it('re-authorizes every ActionOffer and validates its Receipt binding', async () => {
    const generation = new MemoryCompositionGeneration(contributions())
    const view = await generation.compose(REQUEST)
    const offerId = view.actionOffers[0]!.id
    const deny = vi.fn(() => false)
    await expect(generation.executeAction(view, offerId, { text: 'fact' }, deny)).rejects.toThrow('not currently authorized')
    expect(deny).toHaveBeenCalledWith(view.actionOffers[0])
    await expect(generation.executeAction(view, offerId, { text: 'fact' }, () => true)).resolves.toMatchObject({
      viewId: view.id,
      offerId,
      status: 'succeeded',
      revision: 'source-r2',
    })
    await generation.dispose()
  })

  it('passes only operation identity and the owning Source grant to reads and writes', async () => {
    const observed = vi.fn()
    const definition = sourceDefinition()
    const owned = defineMemorySource({ ...definition, create(context) {
      const runtime = definition.create(context)
      return { ...runtime,
        query(request) { observed(request); return runtime.query!(request) },
        mutate(request) { observed(request); return runtime.mutate!(request) },
      }
    } })
    const other = defineMemorySource({ ...definition, create(context) {
      const runtime = definition.create(context)
      return { ...runtime, async project(request) {
        const contribution = await runtime.project(request)
        return {
          fragments: contribution.fragments.map(fragment => ({ ...fragment, text: 'private-personal-projection' })),
          readGrant: { ...contribution.readGrant!, value: { secret: 'private-personal-grant' } },
        }
      } }
    } })
    const generation = new MemoryCompositionGeneration({
      revision: 1, sources: [installedSource(owned, 'work'), installedSource(other, 'personal')],
      strategies: [installedStrategy()],
    })
    try {
      const view = await generation.compose(REQUEST)
      expect(view.readGrants).toHaveLength(2)
      await generation.executeRoute(view, 'source:work/search', { query: 'needle' })
      await generation.executeAction(view, 'source:work/remember', { text: 'fact' }, () => true)
      expect(observed).toHaveBeenCalledTimes(2)
      for (const [request] of observed.mock.calls) {
        expect(request.view).toEqual({ id: view.id, scope: REQUEST.scope })
        expect(Object.keys(request.view).sort()).toEqual(['id', 'scope'])
        expect(request.grant.sourceInstanceKey).toBe('source:work')
        expect(JSON.stringify(request)).not.toContain('source:personal')
        expect(JSON.stringify(request)).not.toContain('private-personal')
        expect(Object.isFrozen(request.view)).toBe(true)
        expect(Object.isFrozen(request.view.scope)).toBe(true)
        expect(Object.isFrozen(request.grant.value)).toBe(true)
        expect(Object.isFrozen(request.input)).toBe(true)
      }
    } finally { await generation.dispose() }
  })

  it('does not borrow another Source grant for a write-only contribution', async () => {
    const observed = vi.fn()
    const definition = sourceDefinition()
    const writeOnly = defineMemorySource({ ...definition, create(context) {
      const runtime = definition.create(context)
      return { ...runtime,
        project: () => ({ fragments: [] }),
        mutate(request) { observed(request); return runtime.mutate!(request) },
      }
    } })
    const strategy = strategyDefinition((_, facts) => ({
      strategyTypeId: 'test', explanation: 'One write-only Source and one readable Source.',
      sources: facts.map(fact => ({ sourceInstanceKey: fact.sourceInstanceKey,
        routeIds: fact.sourceInstanceKey === 'source:reader' ? ['search'] : [], actionIds: ['remember'],
      })),
    }))
    const generation = new MemoryCompositionGeneration({ revision: 1,
      sources: [installedSource(writeOnly, 'writer'), installedSource(definition, 'reader')],
      strategies: [installedStrategy(strategy)],
    })
    try {
      const view = await generation.compose(REQUEST)
      await generation.executeAction(view, 'source:writer/remember', { text: 'fact' }, () => true)
      const request = observed.mock.calls[0]![0]
      expect(request).not.toHaveProperty('grant')
      expect(request.view).toEqual({ id: view.id, scope: REQUEST.scope })
    } finally { await generation.dispose() }
  })

  it('requires selected Sources unless the Strategy explicitly permits degradation', async () => {
    const definition = sourceDefinition()
    const broken = defineMemorySource({ ...definition, create(context) {
      return { ...definition.create(context), project() { throw new Error('private upstream failure') } }
    } })
    const generation = new MemoryCompositionGeneration(contributions(installedSource(broken)))
    try {
      await expect(generation.compose(REQUEST)).rejects.toThrow('Memory Source source:fixture project() failed')
    } finally { await generation.dispose() }
  })

  it('keeps authenticated Source management outside View grants and revision-fences mutations', async () => {
    const generation = new MemoryCompositionGeneration(contributions())
    const catalog = await generation.managementCatalog(REQUEST.scope)
    expect(catalog).toMatchObject({
      generationId: generation.id,
      sources: [{
        sourceInstanceKey: 'source:fixture',
        sourceTypeId: 'example',
        availability: 'ready',
        revision: 'source-r1',
        management: { label: 'Example', fields: [{ key: 'token', secret: true }] },
      }],
    })
    expect(JSON.stringify(catalog)).not.toContain('sha256:source')

    await expect(generation.executeManagement({
      scope: REQUEST.scope,
      sourceInstanceKey: 'source:fixture',
      mode: 'read',
      operation: 'inspect',
      input: { query: 'safe' },
      confirmed: false,
    })).resolves.toEqual({ revision: 'source-r1', value: { operation: 'inspect', mode: 'read', input: { query: 'safe' } } })

    await expect(generation.executeManagement({
      scope: REQUEST.scope,
      sourceInstanceKey: 'source:fixture',
      mode: 'mutate',
      operation: 'update',
      input: { value: 'next' },
      expectedRevision: 'source-r1',
      confirmed: false,
    })).rejects.toThrow('explicit confirmation')
    await expect(generation.executeManagement({
      scope: REQUEST.scope,
      sourceInstanceKey: 'source:fixture',
      mode: 'mutate',
      operation: 'update',
      input: { value: 'next' },
      expectedRevision: 'stale',
      confirmed: true,
    })).rejects.toThrow('revision conflict')
    await expect(generation.executeManagement({
      scope: REQUEST.scope,
      sourceInstanceKey: 'source:fixture',
      mode: 'mutate',
      operation: 'update',
      input: { value: 'next' },
      expectedRevision: 'source-r1',
      confirmed: true,
    })).resolves.toMatchObject({ revision: 'source-r2', value: { mode: 'mutate' } })
    await generation.dispose()
  })

  it('rejects Strategy attempts to select undeclared capabilities and disposes the candidate', async () => {
    const dispose = vi.fn()
    const bad = installedStrategy(strategyDefinition((_, facts) => ({
      strategyTypeId: 'test',
      explanation: 'Invalid route escalation.',
      sources: [{ sourceInstanceKey: facts[0]!.sourceInstanceKey, routeIds: ['admin'] }],
    })))
    const result = await evaluateMemoryComposition({ contributions: contributions(installedSource(sourceDefinition({ dispose })), bad), request: REQUEST })

    expect(result.report).toMatchObject({ state: 'rejected', diagnostics: [{ code: 'composition-rejected', message: expect.stringContaining('unavailable route') }] })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('detects a non-deterministic Strategy before publishing a View', async () => {
    let pass = 0
    const unstable = installedStrategy(strategyDefinition((_, facts) => ({
      strategyTypeId: 'test',
      explanation: `pass-${++pass}`,
      sources: [{ sourceInstanceKey: facts[0]!.sourceInstanceKey }],
    })))
    const result = await evaluateMemoryComposition({ contributions: contributions(installedSource(), unstable), request: REQUEST })
    expect(result.report).toMatchObject({ state: 'rejected', diagnostics: [{ message: expect.stringContaining('not deterministic') }] })
  })

  it('reports incomplete assemblies without inventing hidden defaults', async () => {
    await expect(evaluateMemoryComposition({ contributions: { revision: 1, sources: [], strategies: [] } })).resolves.toMatchObject({
      report: {
        state: 'incomplete',
        diagnostics: [
          { code: 'missing-source' },
          { code: 'missing-strategy' },
        ],
      },
    })
  })

  it('rejects duplicate instance identity before any Source factory runs', async () => {
    const create = vi.fn(sourceDefinition().create)
    const definition = { ...sourceDefinition(), create }
    const duplicate = installedSource(definition, 'duplicate')
    const result = await evaluateMemoryComposition({
      contributions: { revision: 2, sources: [duplicate, duplicate], strategies: [installedStrategy()] },
    })
    expect(result.report).toMatchObject({ state: 'rejected', diagnostics: [{ message: expect.stringContaining('duplicated') }] })
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps manifests JSON-safe and rejects runtime objects or secrets in declarations', () => {
    const invalid = sourceDefinition()
    const manifest = { ...invalid.manifest, management: { label: 'Bad', description: 'Bad', client: new Map() } }
    expect(() => defineMemorySource({ ...invalid, manifest } as never)).toThrow('non-JSON object')
  })

  it('does not allow a View from another generation to execute', async () => {
    const first = new MemoryCompositionGeneration(contributions())
    const second = new MemoryCompositionGeneration({ ...contributions(), revision: 2 })
    const view = await first.compose(REQUEST)
    await expect(second.executeRoute(view as ComposableMemoryView, view.routes[0]!.id, { query: 'x' })).rejects.toThrow('different runtime generation')
    await first.dispose()
    await second.dispose()
  })

  it('requires JSON values at the route boundary', async () => {
    const generation = new MemoryCompositionGeneration(contributions())
    const view = await generation.compose(REQUEST)
    const cyclic: Record<string, MemoryJsonValue> = {}
    cyclic.self = cyclic
    await expect(generation.executeRoute(view, view.routes[0]!.id, cyclic)).rejects.toThrow()
    await generation.dispose()
  })
})

describe('Source-neutral Core entry', () => {
  it('mounts on plain Cordis without a DSH default service or built-in contribution', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(core)
    await fiber.await()
    const service = ctx.mnemonMemory
    expect(core.inject).toEqual([])
    expect(Object.keys(core).sort()).toEqual(['apply', 'inject', 'name', 'provide'])
    expect(Object.keys(service)).toEqual(['installContributions'])
    expect(Object.isFrozen(service)).toBe(true)
    await fiber.dispose()
    expect(() => service.installContributions({}, { instanceId: 'closed' })).toThrow('disposed')
    expect(ctx.get('mnemonMemory', false)).toBeUndefined()
  })

  it('supports third-party Source/Strategy turns without the default bundle and owns shutdown', async () => {
    const runner = new TestingMemoryCompositionRunner()
    const disposed = vi.fn()
    const source = defineMemorySource({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'external-notes',
        packageName: 'dsh-mnemon-external-notes', role: 'notes', capabilities: ['project'], consistency: 'exact-snapshot',
      },
      create: context => ({
        facts: () => ({
          sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'external-notes', role: 'notes',
          availability: 'ready', revision: 'r1', capabilities: ['project'], routeIds: [], actionIds: [],
        }),
        project: request => ({ fragments: [{
          id: 'note', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode,
          text: 'Only external notes', revision: 'r1',
        }] }),
        dispose: disposed,
      }),
    })
    const strategy = defineMemoryStrategy({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'notes-view', packageName: 'dsh-mnemon-external-notes-view',
        deterministic: true, supportedSourceRoles: ['notes'], maxSources: 1, maxRoutes: 1, maxActions: 1,
      },
      compose: (_request, facts) => ({ strategyTypeId: 'notes-view', explanation: 'Only selected notes', sources: facts.map(fact => ({
        sourceInstanceKey: fact.sourceInstanceKey, projection: { mode: 'eager', maxCharacters: 1_000 }, routes: [], actions: [],
      })) }),
    })
    try {
      await runner.mount({ inject: ['mnemonMemory'], apply(child: Context) {
        installMemory(child, { sources: [source] })
      } }, { instanceId: 'notes' })
      await runner.mount({ inject: ['mnemonMemory'], apply(child: Context) {
        installMemory(child, { strategies: [strategy] })
      } }, { instanceId: 'view' })
      const turn = await runner.beginTurn()
      try { expect(turn.view.projection.map(fragment => fragment.text)).toEqual(['Only external notes']) }
      finally { turn.release() }
    } finally { await runner.dispose() }
    expect(disposed).toHaveBeenCalledOnce()
  })
})

describe('Core JSON boundary validation without serialization', () => {
  it('retains frozen detached values, shared references, sparse arrays and negative zero', () => {
    const shared = { values: ['Unicode 中文 \u{1F600}', -0, null, true] }
    const sparse = new Array(3) as string[]
    sparse[1] = 'middle'
    const value = { shared, same: shared, sparse, nullPrototype: Object.assign(Object.create(null) as { note: string }, { note: 'kept' }) }
    const cloned = jsonClone(value, 'boundary')
    expect(cloned).toEqual(value)
    expect(cloned).not.toBe(value)
    expect(cloned.shared).not.toBe(shared)
    expect(cloned.same).toBe(cloned.shared)
    expect(Object.is(cloned.shared.values[1], -0)).toBe(true)
    expect(Object.hasOwn(cloned.sparse, 0)).toBe(false)
    expect(Object.hasOwn(cloned.sparse, 1)).toBe(true)
    expect(Object.isFrozen(cloned)).toBe(true)
    expect(Object.isFrozen(cloned.shared.values)).toBe(true)
    expect(Object.isFrozen(cloned.nullPrototype)).toBe(true)
    shared.values[0] = 'caller changed'
    expect(cloned.shared.values[0]).toBe('Unicode 中文 \u{1F600}')
  })

  it.each([
    undefined, () => undefined, Symbol('unsupported'), 1n, NaN, Infinity, -Infinity,
    new Date(), new Map(), new Set(), new Uint8Array([1]), Object.create({ inherited: true }) as unknown,
  ])('preserves canonical rejection for unsupported value %#', value => {
    for (const input of [value, { nested: value }, [value]]) {
      let expected: string | undefined
      try { canonicalMemoryJson(input, 'boundary') } catch (error) { expected = (error as Error).message }
      expect(expected).toBeDefined()
      expect(() => jsonClone(input, 'boundary')).toThrow(expected!)
    }
  })

  it('enforces the same depth and ancestor-cycle checks without rejecting shared subtrees', () => {
    let depth48: unknown = null
    for (let index = 0; index < 48; index++) depth48 = { nested: depth48 }
    expect(() => jsonClone(depth48, 'boundary')).not.toThrow()
    expect(() => jsonClone({ nested: depth48 }, 'boundary')).toThrow('boundary is nested too deeply')
    const cycle: { next?: unknown } = {}
    cycle.next = { back: cycle }
    expect(() => jsonClone(cycle, 'boundary')).toThrow('boundary contains a cycle')
    const shared = { value: 'allowed' }
    expect(jsonClone({ first: shared, second: shared }, 'boundary')).toEqual({ first: shared, second: shared })
  })

  it.each(['forEach', 'map'])('never allows a caller-owned %s override to bypass element checks', method => {
    for (const value of [NaN, new Date(0), () => undefined, undefined]) {
      const input = [value]
      Object.defineProperty(input, method, { value() {} })
      expect(() => jsonClone(input, 'boundary')).toThrow(/non-finite|non-JSON/u)
    }
    const cycle: unknown[] = []
    cycle.push(cycle)
    Object.defineProperty(cycle, method, { value() {} })
    expect(() => jsonClone(cycle, 'boundary')).toThrow('boundary contains a cycle')

    const valid = new Array(3) as string[]
    valid[1] = 'middle'
    Object.defineProperty(valid, method, { value: null })
    const result = jsonClone(valid, 'boundary')
    expect(result[1]).toBe('middle')
    expect(Object.hasOwn(result, 0)).toBe(false)
    expect(Object.hasOwn(result, method)).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('preserves canonical object visitation order when nested accessors affect later values', () => {
    const input = () => {
      const victim = { value: 0 }
      const trigger = {}
      Object.defineProperty(trigger, 'touch', { enumerable: true, get() { victim.value = NaN; return true } })
      return { z: victim, a: trigger }
    }
    expect(() => canonicalMemoryJson(input(), 'boundary')).toThrow('boundary contains a non-finite number')
    expect(() => jsonClone(input(), 'boundary')).toThrow('boundary contains a non-finite number')
  })

  it('does not stringify management payloads while canonical digests keep their exact representation', () => {
    const value = { z: [3, { z: 'last', a: 'first' }], a: 'start' }
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(jsonClone(value, 'boundary')).toEqual(value)
      expect(stringify).not.toHaveBeenCalled()
      expect(canonicalMemoryJson(value)).toBe('{"a":"start","z":[3,{"a":"first","z":"last"}]}')
      expect(stringify).toHaveBeenCalled()
    } finally { stringify.mockRestore() }
  })
})

describe('Memory generation lifecycle', () => {
  function source(instance: string, dispose: () => void = () => {}, fail = false): InstalledMemorySource {
    const definition = defineMemorySource({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION,
        kind: 'source',
        typeId: instance,
        packageName: `dsh-mnemon-source-${instance}`,
        role: 'fixture',
        capabilities: ['project'],
        consistency: 'exact-snapshot',
      },
      create: context => {
        if (fail) throw new Error(`factory failed: ${context.sourceInstanceKey}`)
        return {
          facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: instance, role: 'fixture', availability: 'ready' as const, revision: 'r1', capabilities: ['project' as const], routeIds: [], actionIds: [] }),
          project: () => ({ fragments: [] }),
          dispose,
        }
      },
    })
    return {
      kind: 'source',
      instanceKey: `source:${instance}`,
      provenance: { packageName: definition.manifest.packageName, entryId: instance },
      definition,
    }
  }

  function strategy(instance = 'default'): InstalledMemoryStrategy {
    const definition = defineMemoryStrategy({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION,
        kind: 'strategy',
        typeId: instance,
        packageName: `dsh-mnemon-strategy-${instance}`,
        deterministic: true,
        supportedSourceRoles: ['fixture'],
        maxSources: 10,
        maxRoutes: 10,
        maxActions: 10,
      },
      compose: () => ({ strategyTypeId: instance, sources: [], explanation: 'Fixture.' }),
    })
    return {
      kind: 'strategy',
      instanceKey: `strategy:${instance}`,
      provenance: { packageName: definition.manifest.packageName, entryId: instance },
      definition,
    }
  }

  function snapshot(revision: number, sources: InstalledMemorySource[], strategies: InstalledMemoryStrategy[] = [strategy()]): MemoryContributionSnapshot {
    return { revision, sources, strategies }
  }

  it('reports cleanup failures even after a Host attachment has detached', async () => {
    const runtime = new MemoryRuntime()
    runtime.installContributions({ sources: [source('failure', () => { throw new Error('provider close failed') })], strategies: [strategy()] })
    const attachment = runtime.attachGeneration()
    await expect(attachment.dispose()).rejects.toThrow('disposal failed')
    await expect(runtime.dispose()).rejects.toThrow('Memory Runtime cleanup failed')
  })

  it('publishes a complete candidate and drains the previous generation after its lease', async () => {
    const firstDisposed = vi.fn()
    const secondDisposed = vi.fn()
    const host = new MemoryGenerationHost()
    expect(host.reconcile(snapshot(1, [{ ...source('stable', firstDisposed), effectiveDigest: 'v1' }])).state).toBe('ready')
    const lease = host.acquire()
    const firstId = lease.id

    expect(host.reconcile(snapshot(2, [{ ...source('stable', secondDisposed), effectiveDigest: 'v2' }])).state).toBe('ready')
    expect(host.inspect()).toMatchObject({
      servingGenerationId: expect.not.stringMatching(firstId),
      drainingGenerationIds: [firstId],
    })
    expect(firstDisposed).not.toHaveBeenCalled()
    lease.release()
    await Promise.resolve()
    expect(firstDisposed).toHaveBeenCalledOnce()
    expect(host.inspect().drainingGenerationIds).toEqual([])
    await host.dispose()
    expect(secondDisposed).toHaveBeenCalledOnce()
  })

  it('preserves Serving when an additive candidate fails', async () => {
    const disposed = vi.fn()
    const host = new MemoryGenerationHost()
    host.reconcile(snapshot(1, [source('stable', disposed)]))
    const stable = host.current()
    const report = host.reconcile(snapshot(2, [source('stable'), source('broken', undefined, true)]))
    expect(report).toMatchObject({ state: 'rejected', diagnostics: [{ message: expect.stringContaining('factory failed') }] })
    expect(host.current()).toBe(stable)
    const lease = host.acquire()
    expect(lease.id).toBe(stable?.id)
    lease.release()
    await host.dispose()
  })

  it('fails closed for new turns after an explicitly required contribution is removed', async () => {
    const disposed = vi.fn()
    const host = new MemoryGenerationHost()
    host.reconcile(snapshot(1, [source('required', disposed)]))
    const lease = host.acquire()

    expect(host.reconcile(snapshot(2, [], [strategy()])).state).toBe('incomplete')
    expect(() => host.acquire()).toThrow('No Memory Source')
    expect(lease.generation.id).toBe(lease.id)
    expect(disposed).not.toHaveBeenCalled()
    lease.release()
    await Promise.resolve()
    expect(disposed).toHaveBeenCalledOnce()
    await host.dispose()
  })

  it('publishes a valid replacement when one of several optional Sources is removed', async () => {
    const firstDisposed = vi.fn()
    const secondDisposed = vi.fn()
    const host = new MemoryGenerationHost()
    expect(host.reconcile(snapshot(1, [source('first', firstDisposed), source('second', secondDisposed)])).state).toBe('ready')
    const previous = host.current()!.id
    expect(host.reconcile(snapshot(2, [source('first')])).state).toBe('ready')
    expect(host.current()?.id).not.toBe(previous)
    expect(host.inspect().servingGenerationId).toBe(host.current()?.id)
    await Promise.resolve()
    expect(firstDisposed).toHaveBeenCalledOnce()
    expect(secondDisposed).toHaveBeenCalledOnce()
    await host.dispose()
  })

  it('does not publish an incomplete initial assembly or infer a Strategy by priority', () => {
    const host = new MemoryGenerationHost()
    expect(host.reconcile(snapshot(1, [], [])).state).toBe('incomplete')
    expect(() => host.acquire()).toThrow('no Serving')
    expect(host.reconcile(snapshot(2, [source('one')], [strategy('one'), strategy('two')]))).toMatchObject({
      state: 'rejected',
      diagnostics: [{ message: expect.stringContaining('exactly one') }],
    })
  })

  it('waits for in-flight leases on shutdown and refuses new acquisitions immediately', async () => {
    const disposed = vi.fn()
    const host = new MemoryGenerationHost()
    host.reconcile(snapshot(1, [source('one', disposed)]))
    const lease = host.acquire()
    const shutdown = host.dispose()
    expect(() => host.acquire()).toThrow('disposed')
    expect(disposed).not.toHaveBeenCalled()
    lease.release()
    await shutdown
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('makes lease release idempotent', async () => {
    const disposed = vi.fn()
    const host = new MemoryGenerationHost()
    host.reconcile(snapshot(1, [source('one', disposed)]))
    const lease = host.acquire()
    host.reconcile(snapshot(2, [source('two')]))
    lease.release()
    lease.release()
    await Promise.resolve()
    expect(disposed).toHaveBeenCalledOnce()
    await host.dispose()
  })
})

describe('Composable Memory root-turn boundary', () => {
  const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
  async function fixture() { const value = await compositionFixture(); fixtures.push(value); return value }
  afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })

  it('retains dispatch authority until the last delegation and child turn release it', async () => {
    const { workspace, releases, graph } = await fixture()
    const scope = { storage: 'custom' as const, workspaceId: workspace, agentId: 'parent' }
    const parent = await graph.composableTurns.beginTurn('parent:1', scope)
    const first = graph.composableTurns.retainView(parent.view.id)
    const second = graph.composableTurns.retainView(parent.view.id)
    graph.composableTurns.endTurn(parent.turnId)
    await Promise.all(releases.map(release => release()))
    expect(graph.memoryComposition.inspect().drainingGenerationIds).toContain(parent.view.runtimeGeneration)
    first()
    first()
    expect(() => graph.composableTurns.pinTurn('child:1', { ...scope, workspaceId: '/other' }, parent.view.id)).toThrow('storage scope')
    const child = graph.composableTurns.pinTurn('child:1', { ...scope, agentId: 'child' }, parent.view.id)
    second()
    expect(child.view).toBe(parent.view)
    expect(graph.composableTurns.memoryWake(child.view.id).viewId).toBe(parent.view.id)
    expect(graph.memoryComposition.generation(parent.view.runtimeGeneration)).toBeDefined()
    graph.composableTurns.endTurn(child.turnId)
    expect(graph.composableTurns.get(parent.view.id)).toBeUndefined()
    expect(graph.memoryComposition.generation(parent.view.runtimeGeneration)).toBeUndefined()
  })

  it('assigns independent Route budgets to child executions sharing a dispatch View', async () => {
    const { workspace, graph } = await fixture()
    const scope = { storage: 'custom' as const, workspaceId: workspace, agentId: 'parent' }
    const parent = await graph.composableTurns.beginTurn('parent:1', scope)
    const child = graph.composableTurns.pinTurn('child:1', { ...scope, agentId: 'child' }, parent.view.id)
    const route = parent.view.routes.find(candidate => candidate.sourceRouteId === 'search')!
    await graph.composableTurns.executeRoute(parent.turnId, route.id, { query: 'bounded' })
    await expect(graph.composableTurns.executeRoute(parent.turnId, route.id, { query: 'bounded' })).resolves.toMatchObject({ output: { notRun: true } })
    const read = await graph.composableTurns.executeRoute(child.turnId, route.id, { query: 'bounded' })
    expect(read).toMatchObject({ viewId: parent.view.id })
    expect(read.output).not.toHaveProperty('notRun')
    graph.composableTurns.endTurn(child.turnId)
    const next = graph.composableTurns.pinTurn('child:1', { ...scope, agentId: 'child' }, parent.view.id)
    expect(next).not.toBe(child)
    await expect(graph.composableTurns.executeRoute(next.turnId, route.id, { query: 'bounded' })).resolves.toMatchObject({ viewId: parent.view.id })
  })

  it('joins concurrent beginnings, rejects scope reuse, and releases a cancelled composition', async () => {
    const { workspace, graph } = await fixture()
    const generation = graph.memoryComposition.current()!
    const original = generation.compose.bind(generation)
    const gate = Promise.withResolvers<void>()
    const compose = vi.spyOn(generation, 'compose').mockImplementation(async request => { await gate.promise; return original(request) })
    const scope = { storage: 'custom' as const, workspaceId: workspace, agentId: 'root' }
    const first = graph.composableTurns.beginTurn('root:join', scope)
    const second = graph.composableTurns.beginTurn('root:join', scope)
    await expect(graph.composableTurns.beginTurn('root:join', { ...scope, agentId: 'other' })).rejects.toThrow('another scope')
    gate.resolve()
    expect(await first).toBe(await second)
    expect(compose).toHaveBeenCalledOnce()
    graph.composableTurns.endTurn('root:join')
    const cancelled = graph.composableTurns.beginTurn('root:cancel', scope)
    graph.composableTurns.endTurn('root:cancel')
    await expect(cancelled).rejects.toThrow('ended during composition')
    expect(graph.composableTurns.activeTurn('root')).toBeUndefined()
  })

  it('does not publish a View after disposal while composition is pending', async () => {
    const { graph } = await fixture()
    const pending = graph.composableTurns.beginTurn('root:closing', { storage: 'custom', agentId: 'root' })
    graph.composableTurns.dispose()
    await expect(pending).rejects.toThrow('ended during composition')
    expect(graph.composableTurns.activeTurn('root')).toBeUndefined()
  })

  it('keeps in-flight Route I/O leased after its parent turn closes', async () => {
    const { graph } = await fixture()
    const turn = await graph.composableTurns.beginTurn('root:operation', { storage: 'custom', agentId: 'root' })
    const generation = graph.memoryComposition.current()!
    const route = turn.view.routes[0]!
    const gate = Promise.withResolvers<void>()
    vi.spyOn(generation, 'executeRoute').mockImplementation(async () => { await gate.promise; return {
      id: 'evidence:test', viewId: turn.view.id, routeId: route.id, sourceInstanceKey: route.sourceInstanceKey,
      observedAt: 'now', items: [], truncated: false,
    } })
    const call = graph.composableTurns.executeRoute(turn.turnId, route.id, {})
    graph.composableTurns.endTurn(turn.turnId)
    let closed = false
    const close = graph.memoryComposition.dispose().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    gate.resolve()
    await call
    await close
    expect(closed).toBe(true)
  })

  it('pins one View and renders its projection plus callable Route ids into the LLM Wake', async () => {
    const { workspace, graph } = await fixture()
    await graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Turn-pinned composable context.' })
    await graph.source('documents').mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Turn route', content: 'turn-route-token' })
    const turn = await graph.composableTurns!.beginTurn('agent-1:1', {
      storage: 'custom', workspaceId: workspace, sessionId: 'agent-1', agentId: 'agent-1',
    })
    const wake = graph.composableTurns!.memoryWake(turn.view.id)

    expect(wake.text).toContain('Turn-pinned composable context.')
    expect(wake.text).toContain('source:mnemon-source-documents/search')
    expect(wake.text).toContain('"inputSchema"')
    expect(wake.text).toContain('"required":["query"]')
    expect(wake.sections.map(section => section.layerId)).toEqual(['runtime', 'documents', 'memory-spaces'])
    expect(graph.composableTurns!.activeTurn('agent-1')).toBe(turn)

    graph.composableTurns!.endTurn(turn.turnId)
    graph.dispose()
  })

  it('executes Routes and reauthorized Actions against the exact leased generation', async () => {
    const { workspace, graph } = await fixture()
    const document = await graph.source('documents').mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Evidence', content: 'leased-route-token' })
    const turn = await graph.composableTurns!.beginTurn('agent-1:1', {
      storage: 'custom', workspaceId: workspace, sessionId: 'agent-1', agentId: 'agent-1',
    })
    const route = turn.view.routes.find(candidate => candidate.sourceRouteId === 'search')!
    const evidence = await graph.composableTurns!.executeRoute(turn.turnId, route.id, { query: 'leased-route-token' })
    expect(evidence.items.map(item => item.id)).toEqual([document.document.id])

    const offer = turn.view.actionOffers.find(candidate => candidate.sourceActionId === 'mutate')!
    await expect(graph.composableTurns!.executeAction(turn.turnId, offer.id, {
      action: 'add', target: 'memory', content: 'denied',
    }, () => false)).rejects.toThrow('not currently authorized')
    const receipt = await graph.composableTurns!.executeAction(turn.turnId, offer.id, {
      action: 'add', target: 'memory', content: 'authorized composable write',
    }, () => true)
    expect(receipt).toMatchObject({ viewId: turn.view.id, offerId: offer.id, status: 'succeeded' })
    expect((await graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.some(entry => entry.content === 'authorized composable write')).toBe(true)

    graph.composableTurns!.endTurn(turn.turnId)
    graph.dispose()
  })

  it('keeps a leased turn usable while explicit plugin removal fails closed for new turns', async () => {
    const { workspace, releases, graph } = await fixture()
    const turn = await graph.composableTurns!.beginTurn('agent-1:1', {
      storage: 'custom', workspaceId: workspace, sessionId: 'agent-1', agentId: 'agent-1',
    })
    await Promise.all(releases.map(release => release()))
    await expect(graph.composableTurns!.beginTurn('agent-2:1', {
      storage: 'custom', workspaceId: workspace, sessionId: 'agent-2', agentId: 'agent-2',
    })).rejects.toThrow('No Memory Source')
    expect(graph.composableTurns!.memoryWake(turn.view.id).viewId).toBe(turn.view.id)

    graph.composableTurns!.endTurn(turn.turnId)
    graph.dispose()
  })
})

describe('Composable View performance fences', () => {
  const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
  async function fixture() { const value = await compositionFixture(); fixtures.push(value); return value }
  afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })

  it.each(['default', 'additive'])('composes repeated three-Source Views within a bounded local control-plane budget (%s)', async mode => {
    const f = await fixture()
    const { workspace, graph } = f
    if (mode === 'additive') {
      await f.mount(scoped, { instanceId: 'scoped' })
      await f.mount(light, { instanceId: 'light' })
      await f.mount(capture, { instanceId: 'capture' })
    }
    await graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Performance fixture.' })
    await graph.source('documents').mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Performance', content: 'Bounded fixture.' })
    const generation = graph.memoryComposition!.current()!
    const request = {
      scope: { storage: 'custom' as const, workspaceId: workspace, sessionId: 'performance' },
      scenario: 'performance.fixture',
      budget: {
        maxProjectionCharacters: 65_536,
        maxRoutes: 16,
        maxActions: 16,
        maxEvidenceResults: 16,
        maxEvidenceCharacters: 16_384,
      },
    }

    const warm = await generation.compose(request)
    expect(warm.strategyExtensions?.length ?? 0).toBe(mode === 'additive' ? 3 : 0)
    const startedWall = performance.now()
    const startedCpu = process.cpuUsage()
    for (let index = 0; index < 100; index += 1) await generation.compose(request)
    const elapsedWall = performance.now() - startedWall
    const elapsedCpu = process.cpuUsage(startedCpu)
    const cpuMilliseconds = (elapsedCpu.user + elapsedCpu.system) / 1_000

    expect(cpuMilliseconds).toBeLessThan(2_000)
    expect(elapsedWall).toBeLessThan(15_000)
    graph.dispose()
  }, 30_000)
})
