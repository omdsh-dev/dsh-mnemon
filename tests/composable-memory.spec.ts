import { describe, expect, it, vi } from 'vitest'
import {
  COMPOSABLE_MEMORY_API_VERSION,
  type ComposableMemoryView,
  type MemoryJsonValue,
  type MemorySourceDefinition,
  type MemoryStrategyDefinition,
  type MemoryViewRequest,
} from "../src/core/contracts/index.ts"
import type { InstalledMemorySource, InstalledMemoryStrategy, MemoryContributionSnapshot } from '../src/core/contributions.ts'
import {
  MemoryCompositionGeneration,
  MemoryCompositionRunner,
  defineMemorySource,
  defineMemoryStrategy,
} from "../src/core/index.ts"

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

  it('executes only a pinned Route, enforces its schema/call budget, and truncates Evidence', async () => {
    const generation = new MemoryCompositionGeneration(contributions())
    const view = await generation.compose(REQUEST)
    const routeId = view.routes[0]!.id

    await expect(generation.executeRoute(view, routeId, { query: 'needle', unexpected: true }))
      .rejects.toThrow('unsupported property')
    const evidence = await generation.executeRoute(view, routeId, { query: 'needle' })
    expect(evidence.items.map(item => item.text)).toEqual(['abcdef', 'g'])
    expect(evidence.truncated).toBe(true)
    await expect(generation.executeRoute(view, routeId, { query: 'again' })).rejects.toThrow('budget is exhausted')
    await expect(generation.executeRoute(view, 'source:fixture/undeclared', { query: 'needle' })).rejects.toThrow('unavailable')
    await generation.dispose()
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
    const runner = new MemoryCompositionRunner()
    const result = await runner.run({ contributions: contributions(installedSource(sourceDefinition({ dispose })), bad), request: REQUEST })

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
    const result = await new MemoryCompositionRunner().run({ contributions: contributions(installedSource(), unstable), request: REQUEST })
    expect(result.report).toMatchObject({ state: 'rejected', diagnostics: [{ message: expect.stringContaining('not deterministic') }] })
  })

  it('reports incomplete assemblies without inventing hidden defaults', async () => {
    const runner = new MemoryCompositionRunner()
    await expect(runner.run({ contributions: { revision: 1, sources: [], strategies: [] } })).resolves.toMatchObject({
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
    const result = await new MemoryCompositionRunner().run({
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
