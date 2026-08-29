import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { HostConnectionHandle, HostRpcHandler } from '../src/contracts.ts'
import type { MnemonLifecycle } from '../src/lifecycle.ts'
import { createActivationHandler, createPackHandler, createReadHandler, createWriteHandler, MNEMON_ACTIVATION_CHANNEL, MNEMON_PACK_CHANNEL, MNEMON_READ_CHANNEL, MNEMON_WRITE_CHANNEL, registerRpc } from '../src/rpc.ts'
import type { RuntimeMemoryController } from '../src/runtime-memory.ts'
import { MnemonService } from '../src/service.ts'
import type { MnemonPackManager } from '../src/pack.ts'
import type { LiveMnemonRuntime, MnemonRuntimeGraph } from '../src/live-runtime.ts'
import type { VersionUpdateManager } from '../src/version-updates.ts'
import { DEFAULT_THREE_TIER_TOPOLOGY, MemoryCatalog, MemoryKernel, MemoryTopologyManager, registerDefaultMemorySystem } from '../src/memory-system/index.ts'

function fakeService(writeEnabled = true): MnemonService {
  return {
    config: resolveConfig({ writeEnabled }),
    status: vi.fn(async () => ({ healthy: true })),
    statusSummary: vi.fn(() => ({ healthy: true, memoryBodies: [] })),
    embeddingStatus: vi.fn(async () => ({ available: true, model: 'nomic-embed-text', totalInsights: 2, embedded: 1, coverage: '50%' })),
    updateProviderService: vi.fn(async (providerId, settings) => ({ providerId, configured: true, settings, configuredSecrets: [] })),
    memoryBodies: {
      providerServices: vi.fn(() => ({ providers: [], items: [], generatedAt: 'now' })),
    },
    bodyDirectory: vi.fn(() => ({ items: [{ id: 'project', name: 'Project', description: 'Project memory.', active: true, providerEnabled: true }], providers: [], total: 1, activeCount: 1, directory: '/tmp/mnemon/data', generatedAt: 'now' })),
    bodies: vi.fn(async () => ({ items: [], total: 0, activeCount: 0, directory: '/tmp/mnemon/data', generatedAt: 'now' })),
    graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: 'now' })),
    list: vi.fn(async () => ({ items: [], total: 0, generatedAt: 'now' })),
    entities: vi.fn(async () => ({ items: [], insights: [] })),
    search: vi.fn(async request => ({ query: request.query, mode: 'smart', results: [] })),
    related: vi.fn(async () => []),
    remember: vi.fn(async () => ({ action: 'added' })),
    link: vi.fn(async () => ({ status: 'linked' })),
    forget: vi.fn(async () => ({ status: 'deleted' })),
    prepareBodyPlacement: vi.fn(request => ({
      prompt: request.placement?.prompt ?? '',
      candidates: [{ id: 'mnemon-native' }],
      appliedRules: ['preference:balanced'],
      selectorBrief: 'eligible providers',
    })),
    createBody: vi.fn(async request => ({ id: '00000000-0000-4000-8000-000000000001', name: request.name, description: request.description, active: request.active ?? false })),
    updateBody: vi.fn((id, request) => ({ id, name: request.name ?? id, description: request.description ?? '', active: request.active ?? false })),
    updateBodyMetadata: vi.fn(updates => updates),
    reconnectBody: vi.fn(async id => ({ id, name: id, description: '', active: true, healthy: true })),
    deleteBody: vi.fn(async id => ({ id, name: id, description: '', active: false })),
  } as unknown as MnemonService
}

describe('Mnemon RPC', () => {
  it('leases the Serving generation for scoped Source management requests', async () => {
    const service = fakeService()
    const release = vi.fn()
    const generation = {
      managementCatalog: vi.fn(async () => ({ generationId: 'generation:test', sources: [] })),
      executeManagement: vi.fn(async request => ({ revision: request.mode === 'read' ? 'r1' : 'r2', value: { operation: request.operation } })),
    }
    const memoryComposition = { acquire: vi.fn(() => ({ generation, release })) }
    const graph = {
      config: service.config,
      service,
      runtimeMemory: {},
      documents: {},
      storage: {},
      packs: {},
      memoryComposition,
    } as unknown as MnemonRuntimeGraph
    const runtime = {
      route: vi.fn(() => ({
        graph,
        selectedWorkspace: { id: 'workspace-1', title: 'Workspace', path: '/tmp/workspace' },
        selectedRoot: '/tmp/data', effectiveRoot: '/tmp/data', aligned: true,
      })),
    } as unknown as LiveMnemonRuntime

    await expect(createReadHandler(runtime)('source-management-catalog', { workspaceId: 'workspace-1', sessionId: 'session-1' }))
      .resolves.toMatchObject({ ok: true, value: { generationId: 'generation:test' } })
    expect(generation.managementCatalog).toHaveBeenCalledWith({ storage: 'global', workspaceId: '/tmp/workspace', sessionId: 'session-1' })

    await expect(createReadHandler(runtime)('source-management-read', {
      workspaceId: 'workspace-1', sourceInstanceKey: 'source:git/work', operation: 'repository', input: { branch: 'main' },
    })).resolves.toMatchObject({ ok: true, value: { revision: 'r1' } })
    expect(generation.executeManagement).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceInstanceKey: 'source:git/work', mode: 'read', operation: 'repository', confirmed: false,
    }))

    await expect(createWriteHandler(runtime)('source-management-mutate', {
      workspaceId: 'workspace-1', sourceInstanceKey: 'source:git/work', operation: 'refresh', input: {}, expectedRevision: 'r1', confirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { revision: 'r2' } })
    expect(generation.executeManagement).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceInstanceKey: 'source:git/work', mode: 'mutate', operation: 'refresh', expectedRevision: 'r1', confirmed: true,
    }))
    expect(release).toHaveBeenCalledTimes(3)
  })

  it('adapts the legacy Memory Spaces UI endpoints to the scoped Serving Source', async () => {
    const service = fakeService()
    const release = vi.fn()
    const generation = {
      managementCatalog: vi.fn(async () => ({
        generationId: 'generation:provider-ui',
        sources: [{
          sourceInstanceKey: 'source:mnemon-source-memory-spaces', sourceTypeId: 'memory-spaces', packageName: 'dsh-mnemon-source-memory-spaces',
          role: 'durable-evidence', availability: 'ready', revision: 'spaces-r7', capabilities: ['status'],
          management: { label: 'Memory Spaces', description: 'Provider-backed namespaces.' },
        }],
      })),
      executeManagement: vi.fn(async request => ({
        revision: request.mode === 'mutate' ? 'spaces-r8' : 'spaces-r7',
        value: request.operation === 'body-directory'
          ? { items: [{ id: 'external-body', provider: { id: 'work-account' } }], providers: [{ id: 'work-account' }], total: 1, activeCount: 1, directory: '/external', generatedAt: 'now' }
          : { providerId: 'work-account', enabled: true, configured: true, settings: { endpoint: 'https://vector.example' }, configuredSecrets: ['apiKey'] },
      })),
    }
    const graph = {
      config: service.config,
      service,
      runtimeMemory: {},
      documents: {},
      storage: {},
      packs: {},
      memoryComposition: { acquire: vi.fn(() => ({ generation, release })) },
    } as unknown as MnemonRuntimeGraph
    const runtime = {
      route: vi.fn(() => ({ graph, selectedRoot: '/tmp', effectiveRoot: '/tmp', aligned: true })),
    } as unknown as LiveMnemonRuntime

    await expect(createReadHandler(runtime)('body-directory', {})).resolves.toMatchObject({
      ok: true,
      value: { items: [{ id: 'external-body', provider: { id: 'work-account' } }], providers: [{ id: 'work-account' }] },
    })
    expect(service.bodyDirectory).not.toHaveBeenCalled()

    await expect(createWriteHandler(runtime)('provider-service-update', {
      providerId: 'work-account', settings: { endpoint: 'https://vector.example', apiKey: 'browser-secret' }, enabled: true,
    })).resolves.toMatchObject({
      ok: true,
      value: { providerId: 'work-account', configuredSecrets: ['apiKey'] },
    })
    expect(generation.executeManagement).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceInstanceKey: 'source:mnemon-source-memory-spaces', mode: 'mutate', operation: 'provider-service-update',
      expectedRevision: 'spaces-r7', confirmed: true,
    }))
    expect(service.updateProviderService).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('exposes the active descriptor and enforces manual data-plane participation', async () => {
    const service = fakeService()
    const catalog = new MemoryCatalog()
    registerDefaultMemorySystem(catalog)
    const topology = new MemoryTopologyManager(catalog, DEFAULT_THREE_TIER_TOPOLOGY)
    topology.configureLayer('memory-spaces', { enabled: false })
    const memoryKernel = new MemoryKernel(catalog, topology)
    const graph = {
      config: service.config,
      service,
      runtimeMemory: {},
      documents: {},
      storage: {},
      packs: {},
      memoryKernel,
    } as unknown as MnemonRuntimeGraph
    const runtime = {
      route: vi.fn(() => ({ graph, selectedRoot: '/tmp', effectiveRoot: '/tmp', aligned: true })),
    } as unknown as LiveMnemonRuntime
    const read = createReadHandler(runtime)

    await expect(read('memory-system', {})).resolves.toMatchObject({
      ok: true,
      value: { topology: { layers: expect.arrayContaining([expect.objectContaining({ id: 'memory-spaces', enabled: false })]) } },
    })
    await expect(read('search', { query: 'blocked' })).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('memory layer memory-spaces is disabled') },
    })
    await expect(read('bodies', {})).resolves.toMatchObject({ ok: true })
    expect(service.search).not.toHaveBeenCalled()
  })

  it('exposes runtime snapshots and routes hot-memory writes through its controller', async () => {
    const runtimeMemory = {
      snapshot: vi.fn(() => ({ entries: [], targets: {} })),
      mutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'memory', entryCount: 1, usage: { used: 5, limit: 10240 }, added: 'hello' })),
    } as unknown as RuntimeMemoryController
    await expect(createReadHandler(fakeService(), undefined, runtimeMemory)('runtime-memory', {})).resolves.toMatchObject({ ok: true, value: { entries: [] } })
    await expect(createWriteHandler(fakeService(), undefined, runtimeMemory)('runtime-memory', { action: 'add', target: 'memory', content: 'hello', importance: 'normal', branches: ['main'] })).resolves.toMatchObject({ ok: true, value: { added: 'hello' } })
    expect(runtimeMemory.mutate).toHaveBeenCalledWith({ action: 'add', target: 'memory', content: 'hello', importance: 'normal', branches: ['main'] })

    const lifecycle = { runtime: vi.fn(async () => ({ success: true, message: 'Entry added after archival.', target: 'memory', entryCount: 2, usage: { used: 20, limit: 10240 }, added: 'world' })) } as unknown as MnemonLifecycle
    await expect(createWriteHandler(fakeService(), lifecycle, runtimeMemory)('runtime-memory', { sessionId: 'session-1', action: 'add', target: 'memory', content: 'world', branches: ['release/v2'] })).resolves.toMatchObject({ ok: true, value: { added: 'world' } })
    expect(lifecycle.runtime).toHaveBeenCalledWith('session-1', { action: 'add', target: 'memory', content: 'world', branches: ['release/v2'] })

    await expect(createWriteHandler(fakeService(), undefined, runtimeMemory)('runtime-memory', { action: 'add', target: 'memory', content: 'invalid', branches: ['main', 42] })).resolves.toMatchObject({
      ok: false,
      error: { message: 'branches must be an array of strings' },
    })
    expect(runtimeMemory.mutate).toHaveBeenCalledOnce()
    expect(lifecycle.runtime).toHaveBeenCalledOnce()
  })

  it('dispatches read operations and rejects unknown endpoints', async () => {
    const service = fakeService()
    await expect(createReadHandler(service)('search', { query: 'SQLite' })).resolves.toMatchObject({ ok: true, value: { query: 'SQLite' } })
    await expect(createReadHandler(service)('graph', {})).resolves.toMatchObject({ ok: true, value: { nodes: [] } })
    await expect(createReadHandler(service)('bodies', {})).resolves.toMatchObject({ ok: true, value: { items: [], total: 0 } })
    await expect(createReadHandler(service)('body-directory', {})).resolves.toMatchObject({ ok: true, value: { total: 1 } })
    await expect(createReadHandler(service)('body-reconnect', { memoryBodyId: 'project' })).resolves.toMatchObject({ ok: true, value: { id: 'project', healthy: true } })
    await expect(createReadHandler(service)('status-summary', {})).resolves.toMatchObject({ ok: true, value: { healthy: true } })
    await expect(createReadHandler(service)('embedding-status', {})).resolves.toMatchObject({ ok: true, value: { available: true, coverage: '50%' } })
    await expect(createReadHandler(service)('provider-services', {})).resolves.toMatchObject({ ok: true, value: { items: [] } })
    await expect(createReadHandler(service)('list', { category: 'decision' })).resolves.toMatchObject({ ok: true, value: { total: 0 } })
    await expect(createReadHandler(service)('entities', { entity: 'SQLite' })).resolves.toMatchObject({ ok: true, value: { insights: [] } })
    await expect(createReadHandler(service)('nope', {})).resolves.toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'unknown read endpoint: nope', details: { issues: [] } },
    })
    expect(service.reconnectBody).toHaveBeenCalledWith('project')
  })

  it('keeps Provider credential values Host-only on both compatibility channels', async () => {
    const service = fakeService()
    const providerServices = vi.fn((options: { includeSecrets?: boolean } = {}) => ({
      providers: [],
      items: [{
        providerId: 'openviking', configured: true, enabled: true,
        settings: { endpoint: 'https://memory.example' }, configuredSecrets: ['apiKey'],
        ...(options.includeSecrets === true ? { secretValues: { apiKey: 'provider-secret' } } : {}),
      }],
      generatedAt: 'now',
    }))
    service.memoryBodies.providerServices = providerServices as never

    await expect(createReadHandler(service)('provider-services', {})).resolves.toMatchObject({
      ok: true,
      value: { items: [expect.not.objectContaining({ secretValues: expect.anything() })] },
    })
    await expect(createWriteHandler(service)('provider-services', {})).resolves.toMatchObject({
      ok: true,
      value: { items: [expect.not.objectContaining({ secretValues: expect.anything() })] },
    })
    expect(providerServices).toHaveBeenNthCalledWith(1)
    expect(providerServices).toHaveBeenNthCalledWith(2)
  })

  it('checks versions on the read channel and keeps explicit updates on the management channel', async () => {
    const versions = {
      currentDshMnemonVersion: '0.1.2',
      check: vi.fn(async () => ({ checkedAt: 'now', components: [{ id: 'mnemon', current: '0.2.0' }] })),
      update: vi.fn(async (component: string) => ({ component, updated: true, restartRequired: component === 'dsh-mnemon' })),
    } as unknown as VersionUpdateManager
    await expect(createReadHandler(fakeService(), undefined, undefined, undefined, versions)('versions', {})).resolves.toMatchObject({ ok: true, value: { checkedAt: 'now' } })
    await expect(createReadHandler(fakeService(), undefined, undefined, undefined, versions)('status', {})).resolves.toMatchObject({ ok: true, value: { dshMnemonVersion: '0.1.2' } })
    await expect(createWriteHandler(fakeService(false), undefined, undefined, versions)('version-update', { component: 'dsh-mnemon' })).resolves.toMatchObject({ ok: true, value: { updated: true } })
    await expect(createWriteHandler(fakeService(), undefined, undefined, versions)('version-update', { component: 'other' })).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(versions.update).toHaveBeenCalledWith('dsh-mnemon')
  })

  it('returns one cached turn-activity projection while preserving the legacy endpoint', async () => {
    const service = fakeService()
    const lifecycle = {
      turnActivities: vi.fn(() => ({
        cursor: 12,
        activities: [{ turn: 2, count: 1, names: ['mnemon_recall'], recalls: 1, writes: 0, documentSearches: 0, inspections: 0, failures: 0 }],
      })),
    } as unknown as MnemonLifecycle

    await expect(createReadHandler(service, lifecycle)('turn-activities', { sessionId: 'session-1' })).resolves.toMatchObject({ ok: true, value: { cursor: 12 } })
    await expect(createReadHandler(service, lifecycle)('turn-activity', { sessionId: 'session-1', turn: 2 })).resolves.toMatchObject({ ok: true, value: { recalls: 1 } })
    expect(lifecycle.turnActivities).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed enum values at the service boundary', async () => {
    const config = resolveConfig({ cliPath: '/fake/mnemon' })
    const service = Object.create(MnemonService.prototype) as MnemonService
    Object.assign(service, {
      config,
      runner: { runJson: vi.fn(), effectiveDataDir: () => '/tmp', effectiveStore: () => 'default' },
    })
    await expect(createReadHandler(service)('search', { query: 'x', mode: 'anything' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', details: {} },
    })
  })

  it('forces human Tab writes to user provenance', async () => {
    const service = fakeService()
    await createWriteHandler(service)('remember', { content: 'A durable preference' })
    expect(service.remember).toHaveBeenCalledWith(expect.objectContaining({ source: 'user' }))
  })

  it('deletes a Memory Space through the management channel', async () => {
    const service = fakeService()
    await expect(createWriteHandler(service)('body-delete', { memoryBodyId: 'project' })).resolves.toMatchObject({ ok: true, value: { id: 'project' } })
    expect(service.deleteBody).toHaveBeenCalledWith('project')
  })

  it('allows only activation state through the narrow control endpoint', async () => {
    const service = fakeService()
    const handler = createActivationHandler(service)

    await expect(handler('body', { memoryBodyId: ' project ', active: true, sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      value: { id: 'project', active: true },
    })
    expect(service.updateBody).toHaveBeenCalledWith('project', { active: true })

    await expect(handler('body', { memoryBodyId: 'project', active: true, name: 'renamed' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: 'unsupported activation fields: name' },
    })
    await expect(handler('body', { memoryBodyId: 'project', active: 'true' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: 'active must be a boolean' },
    })
    await expect(handler('body-update', { memoryBodyId: 'project', active: true })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: 'unknown activation endpoint: body-update' },
    })
  })

  it('keeps activation disabled in read-only mode', async () => {
    const service = fakeService(false)
    await expect(createActivationHandler(service)('body', { memoryBodyId: 'project', active: true })).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'dsh-mnemon is configured read-only (writeEnabled: false)' },
    })
    expect(service.updateBody).not.toHaveBeenCalled()
  })

  it('keeps the legacy management-channel reconnect route for older clients', async () => {
    const service = fakeService()
    await expect(createWriteHandler(service)('body-reconnect', { memoryBodyId: 'project' })).resolves.toMatchObject({ ok: true, value: { id: 'project', healthy: true } })
    expect(service.reconnectBody).toHaveBeenCalledWith('project')
  })

  it('updates provider service settings without creating a Memory Space', async () => {
    const service = fakeService()
    await expect(createWriteHandler(service)('provider-service-update', {
      providerId: 'openviking', settings: { endpoint: 'http://127.0.0.1:1933' }, clearSecrets: ['apiKey'], enabled: false,
    })).resolves.toMatchObject({ ok: true, value: { providerId: 'openviking', configured: true } })
    expect(service.updateProviderService).toHaveBeenCalledWith('openviking', { endpoint: 'http://127.0.0.1:1933' }, ['apiKey'], false)
    expect(service.createBody).not.toHaveBeenCalled()
  })

  it('resolves automatic provider placement through the bound Agent before creating a Memory Space', async () => {
    const service = fakeService()
    const decision = {
      mode: 'automatic' as const,
      providerId: 'mnemon-native' as const,
      decidedBy: 'rules' as const,
      reason: 'Graph support is required.',
      confidence: 'high' as const,
      candidateProviderIds: ['mnemon-native' as const],
      appliedRules: ['requires:graph'],
      decidedAt: '2026-08-16T00:00:00.000Z',
    }
    const lifecycle = {
      placeProvider: vi.fn(async () => decision),
    } as unknown as MnemonLifecycle

    await expect(createWriteHandler(service, lifecycle)('body-create', {
      sessionId: 'session-1',
      name: '产品知识',
      description: '精确记录产品决策并维护关系。',
      placement: {
        mode: 'automatic',
        prompt: '共享不是重点，优先可解释性。',
        rules: { dataBoundary: 'local-only', requiredCapabilities: ['graph'] },
      },
      providerConnections: {
        holographic: { dataPath: '/tmp/holographic.json', defaultTrust: 0.6, minTrust: 0.4 },
      },
    })).resolves.toMatchObject({ ok: true, value: { name: '产品知识' } })

    expect(service.prepareBodyPlacement).toHaveBeenCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ prompt: '共享不是重点，优先可解释性。' }),
      providerConnections: { holographic: { dataPath: '/tmp/holographic.json', defaultTrust: 0.6, minTrust: 0.4 } },
    }))
    expect(lifecycle.placeProvider).toHaveBeenCalledWith('session-1', {
      name: '产品知识',
      description: '精确记录产品决策并维护关系。',
    }, expect.objectContaining({ selectorBrief: 'eligible providers' }))
    expect(service.createBody).toHaveBeenCalledWith(expect.objectContaining({ placement: expect.any(Object) }), undefined, decision)
  })

  it('applies AI-generated Memory Space metadata only after exact selected-space validation', async () => {
    const service = fakeService()
    const maintained = {
      delegated: true as const,
      runId: 'metadata-1',
      provider: 'spawn',
      summary: 'Updated project metadata.',
      updates: [{ memoryBodyId: 'project', title: '产品决策', description: '记录稳定的产品范围与取舍，在规划和复盘产品方向时召回。' }],
    }
    const lifecycle = { maintainMetadata: vi.fn(async () => maintained) } as unknown as MnemonLifecycle

    await expect(createWriteHandler(service, lifecycle)('body-metadata-maintain', {
      sessionId: 'session-1', memoryBodyIds: ['project'],
    })).resolves.toMatchObject({ ok: true, value: { runId: 'metadata-1' } })

    expect(lifecycle.maintainMetadata).toHaveBeenCalledWith('session-1', ['project'], undefined)
    expect(service.updateBodyMetadata).toHaveBeenCalledWith(maintained.updates)
  })

  it('does not commit when metadata maintenance returns no valid updates', async () => {
    const service = fakeService()
    const maintained = {
      delegated: true as const,
      runId: 'metadata-2',
      provider: 'spawn',
      summary: 'No valid metadata.',
      updates: [],
    }
    const lifecycle = { maintainMetadata: vi.fn(async () => maintained) } as unknown as MnemonLifecycle

    await expect(createWriteHandler(service, lifecycle)('body-metadata-maintain', {
      sessionId: 'session-1', memoryBodyIds: ['project'],
    })).resolves.toMatchObject({ ok: true, value: { runId: 'metadata-2', updates: [] } })

    expect(service.updateBodyMetadata).not.toHaveBeenCalled()
  })

  it('routes supervised Tab writeback through an independent task Agent', async () => {
    const service = fakeService()
    const lifecycle = {
      workspaceRoot: vi.fn(() => undefined),
      superviseTask: vi.fn(async () => ({ delegated: true, sessionId: 'session-1', runId: 'child-1', provider: 'spawn', summary: 'stored', action: 'stored', memoryBodyIds: ['project'] })),
    } as unknown as MnemonLifecycle
    await expect(createWriteHandler(service, lifecycle)('supervise', { sessionId: 'session-1', content: 'A candidate', idempotencyKey: 'message-1' })).resolves.toMatchObject({ ok: true, value: { delegated: true, runId: 'child-1' } })
    expect(lifecycle.superviseTask).toHaveBeenCalledWith('session-1', 'A candidate', 'message-1', undefined)
    expect(service.remember).not.toHaveBeenCalled()
  })

  it('exposes the DSH model catalog for independent task Agent settings', async () => {
    const service = fakeService()
    const catalog = {
      effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
      failures: [],
    }
    const lifecycle = { taskAgentModels: vi.fn(async () => catalog) } as unknown as MnemonLifecycle

    await expect(createReadHandler(service, lifecycle)('task-agent-models', { includeCatalog: false })).resolves.toEqual({ ok: true, value: catalog })
    expect(lifecycle.taskAgentModels).toHaveBeenCalledWith(false)
  })

  it('routes sessionless supervised work through a workspace task Agent', async () => {
    const service = fakeService()
    const lifecycle = {
      workspaceRoot: vi.fn(() => undefined),
      superviseTask: vi.fn(async () => ({ delegated: true, sessionId: 'task-1', runId: 'child-1', provider: 'spawn', summary: 'stored', action: 'stored', memoryBodyIds: ['project'] })),
    } as unknown as MnemonLifecycle
    await expect(createWriteHandler(service, lifecycle)('supervise', { content: 'A workspace candidate' })).resolves.toMatchObject({ ok: true, value: { sessionId: 'task-1' } })
    expect(lifecycle.superviseTask).toHaveBeenCalledWith('', 'A workspace candidate', undefined, undefined)
  })

  it('routes project Documents reads and controlled mutations through the bound session', async () => {
    const service = fakeService()
    const lifecycle = {
      documents: vi.fn(() => ({ activeCount: 1, archivedCount: 0, documents: [] })),
      document: vi.fn(() => ({ id: 'doc-1', content: '# Design' })),
      searchDocuments: vi.fn(async () => ({ query: 'design', results: [] })),
      mutateDocument: vi.fn(async () => ({ success: true, action: 'created', document: { id: 'doc-2' } })),
      archiveDocument: vi.fn(async () => ({ success: true, action: 'archived', document: { id: 'doc-1' } })),
    } as unknown as MnemonLifecycle

    await expect(createReadHandler(service, lifecycle)('documents', { sessionId: 'session-1' })).resolves.toMatchObject({ ok: true, value: { activeCount: 1 } })
    await expect(createReadHandler(service, lifecycle)('document', { sessionId: 'session-1', id: 'doc-1' })).resolves.toMatchObject({ ok: true, value: { content: '# Design' } })
    await expect(createReadHandler(service, lifecycle)('document-search', { sessionId: 'session-1', query: 'design', includeArchived: true })).resolves.toMatchObject({ ok: true, value: { query: 'design' } })
    await expect(createWriteHandler(service, lifecycle)('document', { sessionId: 'session-1', action: 'create', title: 'Design', content: '# Design', sourcePaths: ['src/index.ts'] })).resolves.toMatchObject({ ok: true, value: { action: 'created' } })
    await expect(createWriteHandler(service, lifecycle)('document', { sessionId: 'session-1', action: 'archive', id: 'doc-1' })).resolves.toMatchObject({ ok: true, value: { action: 'archived' } })

    expect(lifecycle.searchDocuments).toHaveBeenCalledWith('session-1', 'design', true, undefined)
    expect(lifecycle.mutateDocument).toHaveBeenCalledWith('session-1', { action: 'create', title: 'Design', content: '# Design', sourcePaths: ['src/index.ts'], sessionIds: ['session-1'] })
    expect(lifecycle.archiveDocument).toHaveBeenCalledWith('session-1', 'doc-1', undefined)
  })

  it('keeps Tab reads deterministic while delegating semantic writes', async () => {
    const service = fakeService()
    const lifecycle = {
      recall: vi.fn(),
      related: vi.fn(),
      remember: vi.fn(async () => ({ delegated: true, runId: 'write-1', provider: 'spawn', summary: 'stored', action: 'stored', memoryBodyIds: ['project'] })),
    } as unknown as MnemonLifecycle

    await expect(createReadHandler(service, lifecycle)('search', { sessionId: 'session-1', query: 'SQLite' })).resolves.toMatchObject({ ok: true, value: { query: 'SQLite', results: [] } })
    await expect(createReadHandler(service, lifecycle)('entities', { sessionId: 'session-1', entity: 'SQLite' })).resolves.toMatchObject({ ok: true, value: { insights: [] } })
    await expect(createReadHandler(service, lifecycle)('related', { sessionId: 'session-1', id: 'm1', memoryBodyId: 'project' })).resolves.toMatchObject({ ok: true, value: [] })
    await expect(createWriteHandler(service, lifecycle)('remember', { sessionId: 'session-1', content: 'Use SQLite', memoryBodyId: 'project' })).resolves.toMatchObject({ ok: true, value: { runId: 'write-1' } })
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'SQLite' }))
    expect(service.entities).toHaveBeenCalledWith('SQLite', undefined)
    expect(service.related).toHaveBeenCalledWith('m1', 2, undefined, undefined, 'project')
    expect(lifecycle.recall).not.toHaveBeenCalled()
    expect(lifecycle.related).not.toHaveBeenCalled()
    expect(lifecycle.remember).toHaveBeenCalledWith('session-1', expect.objectContaining({ content: 'Use SQLite', memoryBodyId: 'project', source: 'user' }))
    expect(service.remember).not.toHaveBeenCalled()
  })

  it('performs Agent query synthesis only after a deterministic direct search', async () => {
    const service = fakeService()
    const lifecycle = {
      answerTask: vi.fn(async () => ({ answer: 'SQLite.', citations: [], delegation: { runId: 'answer-1', provider: 'spawn' } })),
    } as unknown as MnemonLifecycle

    await expect(createReadHandler(service, lifecycle)('agent-search', { sessionId: 'session-1', query: 'database' })).resolves.toMatchObject({
      ok: true,
      value: { query: 'database', answer: 'SQLite.', delegation: { runId: 'answer-1' }, results: [] },
    })
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'database' }))
    expect(lifecycle.answerTask).toHaveBeenCalledWith('session-1', 'database', [], undefined)
  })

  it('adds lifecycle diagnostics to status without changing Mnemon runtime status', async () => {
    const service = fakeService()
    const lifecycle = {
      snapshot: vi.fn(() => ({ enabled: true, activeAgents: 1, sessionAvailable: true })),
    } as unknown as MnemonLifecycle
    await expect(createReadHandler(service, lifecycle)('status', { sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      value: { healthy: true, lifecycle: { enabled: true, activeAgents: 1, sessionAvailable: true } },
    })
    expect(lifecycle.snapshot).toHaveBeenCalledWith('session-1')
  })

  it('reports inspection/execution divergence, keeps direct workbench writes on the inspected graph, and fences Agent work', async () => {
    const selectedService = fakeService()
    selectedService.config.storageScope = 'workspace'
    const selectedGraph = {
      config: selectedService.config,
      service: selectedService,
      runtimeMemory: { snapshot: vi.fn(() => ({ entries: [] })) },
      documents: { forWorkspace: vi.fn(() => ({ snapshot: vi.fn(() => ({ workspaceRoot: '/tmp/workspace-two' })) })) },
      storage: { catalog: vi.fn(() => ({ activeRoot: '/tmp/workspace-two/.mnemon' })) },
      packs: {},
    } as unknown as MnemonRuntimeGraph
    const route = {
      graph: selectedGraph,
      selectedWorkspace: { id: 'workspace-2', title: 'Workspace Two', path: '/tmp/workspace-two' },
      effectiveWorkspace: { id: 'workspace-1', title: 'Workspace One', path: '/tmp/workspace-one' },
      selectedRoot: '/tmp/workspace-two/.mnemon',
      effectiveRoot: '/tmp/workspace-one/.mnemon',
      aligned: false,
    }
    const runtime = { route: vi.fn(() => route) } as unknown as LiveMnemonRuntime
    const lifecycle = {
      snapshot: vi.fn(() => ({ enabled: true })),
      supervise: vi.fn(),
      superviseTask: vi.fn(async () => ({ delegated: true, sessionId: 'task-1', runId: 'child-1' })),
      remember: vi.fn(async () => ({ delegated: true, runId: 'write-1' })),
    } as unknown as MnemonLifecycle

    await expect(createReadHandler(runtime, lifecycle)('status', { sessionId: 'session-1', workspaceId: 'workspace-2' })).resolves.toMatchObject({
      ok: true,
      value: {
        workspaceContext: {
          mode: selectedService.config.storageScope,
          selectedRoot: '/tmp/workspace-two/.mnemon',
          effectiveRoot: '/tmp/workspace-one/.mnemon',
          aligned: false,
          selectedWorkspace: { id: 'workspace-2' },
          effectiveWorkspace: { id: 'workspace-1' },
        },
      },
    })
    await expect(createWriteHandler(runtime, lifecycle)('remember', { sessionId: 'session-1', workspaceId: 'workspace-2', content: 'Inspect this workspace' })).resolves.toMatchObject({ ok: true })
    expect(selectedService.remember).toHaveBeenCalledWith(expect.objectContaining({ content: 'Inspect this workspace', source: 'user' }))

    await expect(createWriteHandler(runtime, lifecycle)('supervise', { sessionId: 'session-1', workspaceId: 'workspace-2', content: 'Run in the selected workspace' })).resolves.toMatchObject({ ok: true })
    expect(lifecycle.supervise).not.toHaveBeenCalled()
    expect(lifecycle.superviseTask).toHaveBeenCalledWith('session-1', 'Run in the selected workspace', undefined, '/tmp/workspace-two')

    route.aligned = true
    route.effectiveRoot = route.selectedRoot
    route.effectiveWorkspace = route.selectedWorkspace
    await expect(createWriteHandler(runtime, lifecycle)('remember', { sessionId: 'session-1', workspaceId: 'workspace-2', content: 'Use the aligned Agent path' })).resolves.toMatchObject({ ok: true })
    expect(lifecycle.remember).toHaveBeenCalledWith('session-1', expect.objectContaining({ content: 'Use the aligned Agent path' }))
    expect(selectedService.remember).toHaveBeenCalledTimes(1)
  })

  it('runs workspace-scoped maintenance without a selected conversation session', async () => {
    const selectedService = fakeService()
    selectedService.config.storageScope = 'workspace'
    const selectedWorkspace = { id: 'workspace-2', title: 'Workspace Two', path: '/tmp/workspace-two' }
    const runtime = {
      route: vi.fn(() => ({
        graph: {
          config: selectedService.config,
          service: selectedService,
          runtimeMemory: {},
          documents: { forWorkspace: vi.fn(() => ({})) },
          storage: {},
          packs: {},
        },
        selectedWorkspace,
        selectedRoot: '/tmp/workspace-two/.mnemon',
        effectiveRoot: '/tmp/global/.mnemon',
        aligned: false,
      })),
    } as unknown as LiveMnemonRuntime
    const maintained = {
      delegated: true as const,
      runId: 'metadata-task',
      provider: 'spawn',
      summary: 'updated',
      updates: [{ memoryBodyId: 'project', title: '产品决策', description: '记录稳定的产品范围与取舍，在规划和复盘产品方向时召回。' }],
    }
    const lifecycle = {
      maintainMetadata: vi.fn(async () => maintained),
      archiveDocument: vi.fn(async () => ({ success: true, action: 'archived', document: { id: 'doc-1' } })),
    } as unknown as MnemonLifecycle

    await expect(createWriteHandler(runtime, lifecycle)('body-metadata-maintain', {
      workspaceId: 'workspace-2', memoryBodyIds: ['project'],
    })).resolves.toMatchObject({ ok: true, value: { runId: 'metadata-task' } })
    await expect(createWriteHandler(runtime, lifecycle)('document', {
      workspaceId: 'workspace-2', action: 'archive', id: 'doc-1',
    })).resolves.toMatchObject({ ok: true, value: { action: 'archived' } })

    expect(lifecycle.maintainMetadata).toHaveBeenCalledWith('', ['project'], '/tmp/workspace-two')
    expect(lifecycle.archiveDocument).toHaveBeenCalledWith('', 'doc-1', '/tmp/workspace-two')
  })

  it('does not treat a browser workspace hint as an inspection override in global scope', async () => {
    const service = fakeService()
    const mutate = vi.fn()
    const graph = {
      config: service.config,
      service,
      runtimeMemory: { mutate },
      documents: {},
      storage: {},
      packs: {},
    } as unknown as MnemonRuntimeGraph
    const route = {
      graph,
      selectedWorkspace: { id: 'workspace-2', title: 'Workspace Two', path: '/tmp/workspace-two' },
      effectiveWorkspace: { id: 'workspace-1', title: 'Workspace One', path: '/tmp/workspace-one' },
      selectedRoot: '/tmp/global',
      effectiveRoot: '/tmp/global',
      aligned: true,
    }
    const runtime = { route: vi.fn(() => route) } as unknown as LiveMnemonRuntime
    const lifecycle = {
      runtime: vi.fn(async () => ({ success: true })),
      remember: vi.fn(async () => ({ delegated: true })),
    } as unknown as MnemonLifecycle

    await createWriteHandler(runtime, lifecycle)('runtime-memory', { sessionId: 'session-1', workspaceId: 'workspace-2', action: 'add', target: 'memory', content: 'Global hot memory' })
    expect(lifecycle.runtime).toHaveBeenCalledWith('session-1', expect.objectContaining({ content: 'Global hot memory' }))
    expect(mutate).not.toHaveBeenCalled()
    await createWriteHandler(runtime, lifecycle)('remember', { sessionId: 'session-1', workspaceId: 'workspace-2', content: 'Global durable memory' })
    expect(lifecycle.remember).toHaveBeenCalledWith('session-1', expect.objectContaining({ content: 'Global durable memory' }))
    expect(service.remember).not.toHaveBeenCalled()
  })

  it('always supplies the rc.2 authority object accepted and ignored by the alpha API', () => {
    const handle = vi.fn()
    const connection = { rpc: { handle } } as unknown as HostConnectionHandle
    registerRpc(connection, fakeService())
    expect(handle).toHaveBeenCalledWith(MNEMON_READ_CHANNEL, expect.any(Function), { authority: 'trusted-host' })
    expect(handle).toHaveBeenCalledWith(MNEMON_ACTIVATION_CHANNEL, expect.any(Function), { authority: 'trusted-host' })
    expect(handle).toHaveBeenCalledWith(MNEMON_WRITE_CHANNEL, expect.any(Function), { authority: 'loopback' })
  })

  it('retains explicit rc.2 promotion without branching on the DSH version', () => {
    const handle = vi.fn()
    const connection = { rpc: { handle } } as unknown as HostConnectionHandle
    registerRpc(connection, fakeService(), undefined, undefined, undefined, undefined, undefined, 'trusted-host')
    expect(handle).toHaveBeenCalledWith(MNEMON_WRITE_CHANNEL, expect.any(Function), { authority: 'trusted-host' })
  })

  it('keeps Pack backup and restore on a dedicated authenticated channel', async () => {
    const packs = {
      target: vi.fn(() => ({ root: '/tmp/mnemon', scope: 'custom' })),
      exportPack: vi.fn(async () => ({ fileName: 'backup.zip', base64: 'eA==' })),
      inspectPack: vi.fn(() => ({ archiveBytes: 1, manifest: { components: ['runtime'] } })),
      importPack: vi.fn(async () => ({ imported: true })),
    } as unknown as MnemonPackManager

    await expect(createPackHandler(packs)('target', {})).resolves.toMatchObject({ ok: true, value: { root: '/tmp/mnemon' } })
    await expect(createPackHandler(packs)('export', { scope: 'runtime' })).resolves.toMatchObject({ ok: true, value: { fileName: 'backup.zip' } })
    expect(packs.exportPack).toHaveBeenCalledWith('full')
    await expect(createPackHandler(packs)('inspect', { base64: 'eA==', fileName: 'backup.zip' })).resolves.toMatchObject({ ok: true, value: { archiveBytes: 1 } })
    await expect(createPackHandler(packs)('import', { base64: 'eA==', mode: 'replace', components: ['runtime'] })).resolves.toMatchObject({ ok: true, value: { imported: true } })
    expect(packs.importPack).toHaveBeenCalledWith('eA==', { mode: 'merge' })
    await expect(createPackHandler(packs, false)('import', { base64: 'eA==', mode: 'merge' })).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })

    const workspacePacks = { ...packs, target: vi.fn(() => ({ root: '/workspace/.mnemon', scope: 'workspace' })) } as unknown as MnemonPackManager
    const route = vi.fn(() => ({ graph: { packs: workspacePacks } }))
    const runtime = { route } as unknown as LiveMnemonRuntime
    await expect(createPackHandler(runtime)('target', { sessionId: 'session-1', workspaceId: 'workspace-1' })).resolves.toMatchObject({ ok: true, value: { root: '/workspace/.mnemon' } })
    expect(route).toHaveBeenCalledWith({ sessionId: 'session-1', workspaceId: 'workspace-1' })

    const handle = vi.fn()
    registerRpc({ rpc: { handle } } as unknown as HostConnectionHandle, fakeService(), undefined, undefined, undefined, packs)
    expect(handle).toHaveBeenCalledWith(MNEMON_PACK_CHANNEL, expect.any(Function), { authority: 'loopback' })
  })

  it('keeps the live write channel stable but rejects it in read-only mode', async () => {
    const handle = vi.fn()
    registerRpc({ rpc: { handle } } as unknown as HostConnectionHandle, fakeService(false))
    expect(handle).toHaveBeenCalledTimes(3)
    const writeHandler = handle.mock.calls.find(([channel]) => channel === MNEMON_WRITE_CHANNEL)?.[1] as HostRpcHandler
    await expect(writeHandler('remember', { content: 'blocked' })).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
  })
})
