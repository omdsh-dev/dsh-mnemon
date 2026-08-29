import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstalledMemorySource, InstalledMemoryStrategy, MemorySourceDefinition } from '../packages/contracts/src/index.ts'
import { DEFAULT_MEMORY_VIEW_BUDGET, MemoryCompositionGeneration } from '../packages/kernel/src/index.ts'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from '../packages/strategy-default-three-tier/src/index.ts'
import { BUILTIN_MEMORY_BINDINGS } from '../src/composable/bindings.ts'
import { DOCUMENTS_MEMORY_SOURCE } from '../src/composable/source-documents.ts'
import { MEMORY_SPACES_SOURCE } from '../src/composable/source-memory-spaces.ts'
import { RUNTIME_MEMORY_SOURCE } from '../src/composable/source-runtime.ts'
import { resolveConfig } from '../src/config.ts'
import { createRuntimeGraph } from '../src/live-runtime.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0).reverse()) rmSync(path, { recursive: true, force: true })
})

function installedSource(definition: MemorySourceDefinition): InstalledMemorySource {
  return {
    kind: 'source',
    instanceKey: `source:test-${definition.manifest.typeId}`,
    provenance: { packageName: definition.manifest.packageName, entryId: `test-${definition.manifest.typeId}` },
    definition,
  }
}

const installedStrategy: InstalledMemoryStrategy = {
  kind: 'strategy',
  instanceKey: 'strategy:test-default-three-tier',
  provenance: { packageName: DEFAULT_THREE_TIER_VIEW_STRATEGY.manifest.packageName, entryId: 'test-default-three-tier' },
  definition: DEFAULT_THREE_TIER_VIEW_STRATEGY,
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mnemon-composable-builtins-'))
  temporary.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const graph = createRuntimeGraph(resolveConfig({ storageScope: 'custom', dataDir: join(root, 'data'), cliPath: '/fake/mnemon' }), workspace)
  const generation = new MemoryCompositionGeneration({
    revision: 1,
    sources: [RUNTIME_MEMORY_SOURCE, DOCUMENTS_MEMORY_SOURCE, MEMORY_SPACES_SOURCE].map(installedSource),
    strategies: [installedStrategy],
  }, {
    bindings: new Map<string, unknown>([
      [BUILTIN_MEMORY_BINDINGS.runtime, graph.runtimeMemory],
      [BUILTIN_MEMORY_BINDINGS.documents, graph.documents],
      [BUILTIN_MEMORY_BINDINGS.memorySpaces, graph.service],
    ]),
  })
  return { root, workspace, graph, generation }
}

function request(workspace: string) {
  return {
    scope: { storage: 'custom' as const, workspaceId: workspace, sessionId: 'session-1', agentId: 'agent-1' },
    scenario: 'test.root-turn',
    budget: { ...DEFAULT_MEMORY_VIEW_BUDGET },
  }
}

async function memorySpace(graph: ReturnType<typeof createRuntimeGraph>, withDataPlane = false) {
  graph.service.memoryBodies.updateProviderService('openviking', { endpoint: 'http://127.0.0.1:1933' })
  const body = await graph.service.memoryBodies.create({
    name: 'Composable test', description: 'Provider-backed test evidence.', active: true, providerId: 'openviking',
    connection: { targetUri: 'viking://user/composable/memories' },
  })
  if (withDataPlane) {
    const items: Array<{ id: string; content: string; score: number; createdAt: string }> = []
    const provider = {
      id: 'openviking',
      scoreSemantics: { kind: 'normalized-relevance' },
      status: async () => ({ healthy: true }),
      search: async (_body: unknown, search: { query: string }) => ({ results: items.filter(item => item.content.includes(search.query)) }),
      remember: async (_body: unknown, value: { content: string }) => {
        const item = { id: `item-${items.length + 1}`, content: value.content, score: 1, createdAt: new Date().toISOString() }
        items.push(item)
        return { id: item.id, action: 'stored' }
      },
    }
    ;(graph.service as unknown as { providers: Map<string, unknown> }).providers.set('openviking', provider)
  }
  return body
}

describe('built-in Composable View Memory plugins', () => {
  it('composes the three logical Sources through one default Strategy without changing their authorities', async () => {
    const { workspace, graph, generation } = fixture()
    await memorySpace(graph)
    await graph.runtimeMemory.mutate({ action: 'add', target: 'memory', content: 'Pinned runtime context', importance: 'critical' })
    await graph.documents.forWorkspace(workspace).mutate({ action: 'create', title: 'Architecture', content: 'Composable View Memory.' })

    const view = await generation.compose(request(workspace))
    expect(view.strategyTypeId).toBe('default-three-tier')
    expect(view.projection.map(fragment => fragment.sourceInstanceKey)).toEqual([
      'source:test-runtime', 'source:test-documents', 'source:test-memory-spaces',
    ])
    expect(view.projection[0]?.text).toContain('Pinned runtime context')
    expect(view.routes.map(route => route.sourceRouteId)).toEqual(expect.arrayContaining(['search', 'recall']))
    expect(view.readGrants.map(grant => grant.schema)).toEqual([
      'dsh-mnemon.documents/v1', 'dsh-mnemon.memory-spaces/v1',
    ])
    expect(JSON.stringify(view)).not.toContain('apiKey')

    await generation.dispose()
    graph.dispose()
  })

  it('pins the Documents namespace for routed reads while leaving the legacy controller API compatible', async () => {
    const { workspace, graph, generation } = fixture()
    const first = await graph.documents.forWorkspace(workspace).mutate({ action: 'create', title: 'First', content: 'grant-token first' })
    const view = await generation.compose(request(workspace))
    const second = await graph.documents.forWorkspace(workspace).mutate({ action: 'create', title: 'Second', content: 'grant-token second' })
    const route = view.routes.find(candidate => candidate.sourceRouteId === 'search')!
    const evidence = await generation.executeRoute(view, route.id, { query: 'grant-token', limit: 20 })

    expect(evidence.items.map(item => item.id)).toContain(first.document.id)
    expect(evidence.items.map(item => item.id)).not.toContain(second.document.id)
    const legacy = await graph.documents.forWorkspace(workspace).search('grant-token')
    expect(legacy.results.map(item => item.id)).toEqual(expect.arrayContaining([first.document.id, second.document.id]))

    await generation.dispose()
    graph.dispose()
  })

  it('binds mutation Receipts to the View and reads the native Provider only through a pinned Memory Space grant', async () => {
    const { workspace, graph, generation } = fixture()
    await memorySpace(graph, true)
    const initial = await generation.compose(request(workspace))
    const grant = initial.readGrants.find(candidate => candidate.schema === 'dsh-mnemon.memory-spaces/v1')!
    const memoryBodyIds = (grant.value as { memoryBodyIds: string[] }).memoryBodyIds
    expect(memoryBodyIds.length).toBeGreaterThan(0)
    const remember = initial.actionOffers.find(candidate => candidate.sourceActionId === 'remember')!
    const marker = `composable-provider-${Date.now()}`
    const receipt = await generation.executeAction(initial, remember.id, {
      content: `${marker} is durable provider evidence`, category: 'fact', memoryBodyId: memoryBodyIds[0]!,
    }, () => true)
    expect(receipt).toMatchObject({ viewId: initial.id, offerId: remember.id, status: 'succeeded' })

    const next = await generation.compose(request(workspace))
    const recall = next.routes.find(candidate => candidate.sourceRouteId === 'recall')!
    const evidence = await generation.executeRoute(next, recall.id, { query: marker, mode: 'keyword', limit: 10 })
    expect(evidence.items.some(item => item.text.includes(marker))).toBe(true)
    expect(evidence.items.every(item => (item.provenance as { memoryBodyId?: string }).memoryBodyId === memoryBodyIds[0])).toBe(true)

    await generation.dispose()
    graph.dispose()
  })

  it('rejects ambiguous role selection rather than inventing Source priority', async () => {
    const { workspace, graph, generation: fixtureGeneration } = fixture()
    const generation = new MemoryCompositionGeneration({
      revision: 2,
      sources: [installedSource(RUNTIME_MEMORY_SOURCE), {
        ...installedSource(RUNTIME_MEMORY_SOURCE),
        instanceKey: 'source:test-runtime-second',
        provenance: { packageName: RUNTIME_MEMORY_SOURCE.manifest.packageName, entryId: 'test-runtime-second' },
      }],
      strategies: [installedStrategy],
    }, { bindings: new Map([[BUILTIN_MEMORY_BINDINGS.runtime, graph.runtimeMemory]]) })
    await expect(generation.compose(request(workspace))).rejects.toThrow('ambiguous working-context Sources')
    await generation.dispose()
    await fixtureGeneration.dispose()
    graph.dispose()
  })
})
