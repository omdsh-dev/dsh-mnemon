import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ComposableMemoryView,
  MemoryActionOffer,
  MemoryReadGrant,
  MemoryViewRoute,
  MemoryStrategyDefinition,
} from '../packages/contracts/src/index.ts'
import { DEFAULT_MEMORY_VIEW_BUDGET, MemoryGenerationHost } from '../packages/kernel/src/index.ts'
import { resolveConfig } from '../src/config.ts'
import { createMemorySpacesSource } from '../src/composable/source-memory-spaces.ts'
import { BUILTIN_MEMORY_BINDINGS } from '../src/composable/bindings.ts'
import {
  MEMORY_SPACE_PROVIDER_API_VERSION,
  PrivateMemorySpaceProviderHost,
  defineMemorySpaceProvider,
  type MemorySpaceProviderEntry,
  type MemorySpaceProviderManifest,
} from '../src/memory-spaces/provider-sdk.ts'
import { BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES, createMemorySpaceProviderPlugin } from '../src/plugins/memory-space-providers.ts'
import { MEMORY_PROVIDER_CATALOG } from '../src/providers/catalog.ts'
import { NORMALIZED_RELEVANCE_SCORE, type MemoryProviderAdapter } from '../src/providers/provider.ts'
import type { MemoryProviderAdapterRegistry } from '../src/providers/registry.ts'
import type { ProcessRunner } from '../src/process.ts'
import { createRunner } from '../src/runner.ts'
import { MnemonService } from '../src/service.ts'
import type { MemoryBody, MemoryProviderCapabilities, SearchRequest } from '../src/shared/contracts.ts'

const CAPABILITIES: MemoryProviderCapabilities = {
  search: true,
  browse: true,
  graph: false,
  entities: false,
  related: false,
  remember: true,
  link: false,
  forget: false,
  writeMode: 'exact',
  deletionMode: 'unsupported',
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) rmSync(directory, { recursive: true, force: true })
})

const MANIFEST: MemorySpaceProviderManifest = {
  apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION,
  kind: 'provider',
  typeId: 'vector-store',
  packageName: 'dsh-mnemon-provider-vector-store',
  version: '1.2.3',
  label: 'Vector Store',
  icon: { kind: 'glyph', value: 'V' },
  summary: 'A fixture Provider with an independently testable namespace and exact writes.',
  summaryI18nKey: 'fixture.provider.summary',
  origin: 'third-party',
  locality: 'remote',
  workspaceBinding: 'provider-global',
  capabilities: CAPABILITIES,
  fields: [
    { key: 'endpoint', label: 'Endpoint', i18nKey: 'fixture.provider.endpoint', scope: 'service', input: 'url', required: true },
    { key: 'apiKey', label: 'API key', i18nKey: 'fixture.provider.api-key', scope: 'service', input: 'secret', required: true },
    { key: 'collection', label: 'Collection', i18nKey: 'fixture.provider.collection', scope: 'memory', input: 'text', required: true },
  ],
  secrets: ['apiKey'],
  scoreSemantics: 'normalized-relevance',
}

interface FixtureConfig {
  endpoint: string
  apiKey: string
}

function fixtureModule(events: string[] = [], manifest: MemorySpaceProviderManifest = MANIFEST) {
  return defineMemorySpaceProvider<FixtureConfig>({
    id: 'vector-store',
    apply(ctx, host, config) {
      host.install(ctx, {
        manifest,
        create: runtimeContext => {
          events.push(`create:${runtimeContext.providerInstanceId}:${config.endpoint}`)
          const adapter: MemoryProviderAdapter = {
            id: 'vector-store',
            scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
            discover: vi.fn(async connection => [{
              externalId: 'collection:alpha',
              name: 'Alpha',
              description: 'Fixture namespace.',
              connection: { collection: String(connection.collection ?? 'alpha') },
            }]),
            status: vi.fn(async () => ({ healthy: true })),
            search: vi.fn(async (_body, request) => ({
              results: [{ id: 'fixture-1', content: `Found ${request.query}`, score: 0.91 }],
            })),
            graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: '2026-08-30T00:00:00.000Z' })),
            list: vi.fn(async () => []),
            remember: vi.fn(async (_body, request) => ({ action: 'stored', content: request.content })),
            dispose: vi.fn(() => { events.push(`dispose:${runtimeContext.providerInstanceId}`) }),
          }
          return adapter
        },
      })
    },
  })
}

function fixtureEntry(config: FixtureConfig, instanceId = 'work-account'): MemorySpaceProviderEntry<FixtureConfig> {
  return { instanceId, module: fixtureModule(), config }
}

function nativeAdapter(): MemoryProviderAdapter {
  return {
    id: 'mnemon-native',
    scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
    status: async () => ({ healthy: true }),
    search: async () => ({ results: [] }),
    graph: async () => ({ nodes: [], edges: [], generatedAt: '2026-08-30T00:00:00.000Z' }),
    list: async () => [],
    remember: async () => ({ action: 'stored' }),
  }
}

async function mountedSnapshot<Config>(entry: MemorySpaceProviderEntry<Config>, sourceId = 'memory-spaces-fixture') {
  const ctx = new Context()
  const host = new PrivateMemorySpaceProviderHost(sourceId)
  const fiber = ctx.plugin(createMemorySpaceProviderPlugin(entry, host), entry.config)
  await fiber.await()
  return { ctx, host, fiber, snapshot: host.snapshot() }
}

class FixtureMemorySpacesService {
  private adapter: MemoryProviderAdapter | undefined
  private disposed = false
  readonly body = {
    id: 'fixture-body',
    name: 'Fixture body',
    description: 'External Provider fixture.',
    active: true,
    dbPath: '',
    provider: {
      id: 'work-account', label: 'Vector Store', kind: 'remote', location: 'https://vector.example',
      apiKeyConfigured: true, settings: { collection: 'alpha' }, configuredSecrets: ['apiKey'], capabilities: CAPABILITIES,
    },
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  } satisfies MemoryBody

  readonly memoryBodies = {
    list: () => [this.body],
    active: () => [this.body],
  }

  withProviderAdapterRegistry(registry: MemoryProviderAdapterRegistry): this {
    return new FixtureMemorySpacesService().attach(registry) as this
  }

  attach(registry: ReturnType<(typeof import('../src/providers/registry.ts'))['createBuiltinMemoryProviderAdapterRegistry']>): this {
    this.adapter = registry.create({
      memoryBodies: this.memoryBodies as never,
      config: resolveConfig({}),
      nativeAdapter: nativeAdapter(),
    }).get('work-account')
    return this
  }

  memoryRevision(): string { return 'fixture-r1' }

  async search(request: SearchRequest) {
    if (this.adapter === undefined) throw new Error('fixture adapter is unavailable')
    return this.adapter.search(this.body, request)
  }

  async remember(request: { content: string }) {
    if (this.adapter === undefined) throw new Error('fixture adapter is unavailable')
    return this.adapter.remember(this.body, request)
  }

  async related() { return [] }
  async link() { return { action: 'linked' } }
  async forget() { return { action: 'forgotten' } }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.adapter?.dispose?.()
  }
}

describe('Memory Spaces Provider child-module conformance', () => {
  it('turns every bundled Provider into one complete module with descriptor, secret, capability and factory truth', async () => {
    expect(BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES).toHaveLength(9)
    for (const entry of BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES) {
      const { fiber, snapshot } = await mountedSnapshot(entry, `memory-spaces-${entry.instanceId}`)
      const installed = snapshot.entries[0]!
      const legacy = MEMORY_PROVIDER_CATALOG.find(provider => provider.id === entry.instanceId)!
      expect(installed.definition.manifest).toMatchObject({
        kind: 'provider',
        typeId: entry.instanceId,
        packageName: `dsh-mnemon-provider-${entry.instanceId}`,
        capabilities: legacy.capabilities,
        fields: legacy.fields,
        secrets: legacy.fields.filter(field => field.input === 'secret').map(field => field.key).sort(),
      })
      expect(snapshot.descriptors()).toEqual([expect.objectContaining({ id: entry.instanceId, label: legacy.label })])
      expect(() => JSON.stringify(installed.definition.manifest)).not.toThrow()
      await fiber.dispose()
    }
  })

  it('binds definition lifetime to the actual child Fiber and keeps separate parents isolated', async () => {
    const entry = fixtureEntry({ endpoint: 'https://vector.example', apiKey: 'secret-a' })
    const first = await mountedSnapshot(entry, 'memory-spaces-first')
    const second = new PrivateMemorySpaceProviderHost('memory-spaces-second')

    expect(first.snapshot.entries[0]).toMatchObject({
      childKey: 'memory-spaces-first/provider:work-account',
      instanceId: 'work-account',
      definition: { manifest: { typeId: 'vector-store' } },
    })
    expect(second.snapshot().entries).toEqual([])
    expect(first.ctx.get('mnemonProvider', false)).toBeUndefined()
    await first.fiber.dispose()
    expect(first.host.snapshot().entries).toEqual([])
  })

  it('produces an immutable stable digest, includes config changes by hash, and never exposes secret values', async () => {
    const first = await mountedSnapshot(fixtureEntry({ endpoint: 'https://vector.example', apiKey: 'secret-a' }))
    const repeat = await mountedSnapshot(fixtureEntry({ apiKey: 'secret-a', endpoint: 'https://vector.example' }))
    const changed = await mountedSnapshot(fixtureEntry({ endpoint: 'https://vector.example', apiKey: 'secret-b' }))

    expect(first.snapshot.digest).toBe(repeat.snapshot.digest)
    expect(changed.snapshot.digest).not.toBe(first.snapshot.digest)
    expect(JSON.stringify(first.snapshot)).not.toContain('secret-a')
    expect(Object.isFrozen(first.snapshot)).toBe(true)
    expect(Object.isFrozen(first.snapshot.entries[0]!.definition.manifest)).toBe(true)
    await Promise.all([first.fiber.dispose(), repeat.fiber.dispose(), changed.fiber.dispose()])
  })

  it('keeps presentation-only metadata out of the Generation digest while projecting it to clients', async () => {
    const presentationManifest: MemorySpaceProviderManifest = {
      ...MANIFEST,
      label: 'Vector Store (localized)',
      icon: { kind: 'glyph', value: 'VS' },
      summary: 'Localized fixture summary.',
      summaryI18nKey: 'fixture.provider.summary.localized',
      fields: MANIFEST.fields.map(field => ({
        ...field,
        label: `${field.label} localized`,
        i18nKey: `${field.i18nKey}.localized`,
        placeholder: `${field.key} placeholder`,
        help: `${field.key} help`,
      })),
    }
    const config = { endpoint: 'https://vector.example', apiKey: 'secret-a' }
    const first = await mountedSnapshot(fixtureEntry(config))
    const localized = await mountedSnapshot({
      instanceId: 'work-account',
      module: fixtureModule([], presentationManifest),
      config,
    })

    expect(localized.snapshot.digest).toBe(first.snapshot.digest)
    expect(localized.snapshot.descriptors()).toEqual([expect.objectContaining({
      id: 'work-account',
      label: 'Vector Store (localized)',
      icon: { kind: 'glyph', value: 'VS' },
      summaryI18nKey: 'fixture.provider.summary.localized',
    })])
    await Promise.all([first.fiber.dispose(), localized.fiber.dispose()])
  })

  it('integrates an external instance with the real Provider service catalog, discovery, recall and exact write path', async () => {
    const mounted = await mountedSnapshot(fixtureEntry({ endpoint: 'https://vector.example', apiKey: 'module-secret' }))
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-provider-conformance-'))
    temporaryDirectories.push(dataDir)
    const config = resolveConfig({ storageScope: 'custom', dataDir, cliPath: '/fake/mnemon' })
    const process = vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    const runner = createRunner(config, process)
    const base = new MnemonService(runner, config)
    const service = base.withProviderAdapterRegistry(mounted.snapshot.adapterRegistry(), mounted.snapshot.descriptors())

    await expect(service.updateProviderService('work-account', {
      endpoint: 'https://vector.example',
      apiKey: 'service-secret',
    })).resolves.toMatchObject({ providerId: 'work-account', enabled: true, configured: true })
    const body = service.memoryBodies.list().find(candidate => candidate.provider.id === 'work-account')!
    expect(body).toMatchObject({ provider: { id: 'work-account', label: 'Vector Store', apiKeyConfigured: true } })
    expect(JSON.stringify(body)).not.toContain('service-secret')

    await expect(service.search({ query: 'architecture', memoryBodyIds: [body.id] })).resolves.toMatchObject({
      results: [{ id: 'fixture-1', content: 'Found architecture', memoryBodyId: body.id, memoryProviderId: 'work-account' }],
    })
    await expect(service.remember({ content: 'Persist this.', memoryBodyId: body.id })).resolves.toMatchObject({ action: 'stored' })

    await service.dispose()
    await base.dispose()
    await mounted.fiber.dispose()
  })

  it('projects an external Provider through Source-scoped management without exposing credentials', async () => {
    const mounted = await mountedSnapshot(fixtureEntry({ endpoint: 'https://vector.example', apiKey: 'module-secret' }))
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-provider-management-'))
    temporaryDirectories.push(dataDir)
    const config = resolveConfig({ storageScope: 'custom', dataDir, cliPath: '/fake/mnemon' })
    const runner = createRunner(config, vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 })))
    const base = new MnemonService(runner, config)
    const runtime = createMemorySpacesSource(mounted.snapshot).create({
      sourceInstanceKey: 'source:memory-spaces-management',
      provenance: { packageName: 'dsh-mnemon-source-memory-spaces', entryId: 'memory-spaces-management' },
      binding: () => base as never,
    })
    const scope = { storage: 'custom' as const, workspaceId: dataDir }
    const before = await runtime.facts({ scope, scenario: 'management.test', budget: DEFAULT_MEMORY_VIEW_BUDGET })

    await expect(runtime.manage?.({
      scope,
      sourceInstanceKey: 'source:memory-spaces-management',
      mode: 'mutate',
      operation: 'provider-service-update',
      input: { providerId: 'work-account', settings: { endpoint: 'https://vector.example', apiKey: 'service-secret' }, enabled: true },
      expectedRevision: before.revision,
      confirmed: true,
    })).resolves.toMatchObject({ value: { providerId: 'work-account', enabled: true, configured: true, configuredSecrets: ['apiKey'] } })

    const providers = await runtime.manage?.({
      scope,
      sourceInstanceKey: 'source:memory-spaces-management',
      mode: 'read',
      operation: 'provider-services',
      input: {},
      confirmed: false,
    })
    expect(providers?.value).toMatchObject({
      providers: [{ id: 'work-account', typeId: 'vector-store', label: 'Vector Store' }],
      items: [{ providerId: 'work-account', enabled: true, configured: true, configuredSecrets: ['apiKey'] }],
    })
    expect(JSON.stringify(providers)).not.toContain('service-secret')

    await expect(runtime.manage?.({
      scope,
      sourceInstanceKey: 'source:memory-spaces-management',
      mode: 'read',
      operation: 'body-directory',
      input: {},
      confirmed: false,
    })).resolves.toMatchObject({ value: { items: [{ provider: { id: 'work-account', label: 'Vector Store' } }], providers: [{ id: 'work-account' }] } })

    await runtime.dispose?.()
    await base.dispose()
    await mounted.fiber.dispose()
  })

  it('runs an external fixture through private snapshot, Source recall, exact-write Receipt and generation-owned disposal', async () => {
    const events: string[] = []
    const entry: MemorySpaceProviderEntry<FixtureConfig> = {
      instanceId: 'work-account',
      module: fixtureModule(events),
      config: { endpoint: 'https://vector.example', apiKey: 'secret-a' },
    }
    const mounted = await mountedSnapshot(entry)
    const service = new FixtureMemorySpacesService()
    const definition = createMemorySpacesSource(mounted.snapshot)
    const runtime = definition.create({
      sourceInstanceKey: 'source:memory-spaces-fixture',
      provenance: { packageName: 'dsh-mnemon-source-memory-spaces', entryId: 'memory-spaces-fixture' },
      binding: () => service as never,
    })
    const facts = await runtime.facts({ scope: { storage: 'custom', workspaceId: '/fixture' }, scenario: 'provider.fixture', budget: DEFAULT_MEMORY_VIEW_BUDGET })
    expect(facts).toMatchObject({ availability: 'ready', routeIds: ['recall'], actionIds: ['remember'] })
    const projected = await runtime.project({
      scope: { storage: 'custom', workspaceId: '/fixture' },
      sourceInstanceKey: 'source:memory-spaces-fixture',
      includeProjection: true,
      mode: 'routed',
      maxCharacters: 1_000,
    })
    const grant = projected.readGrant as MemoryReadGrant
    const route: MemoryViewRoute = {
      id: 'source:memory-spaces-fixture/recall', sourceInstanceKey: 'source:memory-spaces-fixture', sourceRouteId: 'recall',
      description: 'fixture recall', capability: 'recall', inputSchema: {}, readGrantId: grant.id, maxCalls: 1,
    }
    const offer: MemoryActionOffer = {
      id: 'source:memory-spaces-fixture/remember', sourceInstanceKey: 'source:memory-spaces-fixture', sourceActionId: 'remember',
      description: 'fixture remember', capability: 'write', inputSchema: {},
    }
    const view = {
      id: 'view:fixture', digest: 'fixture', runtimeGeneration: 'generation:fixture', strategyInstanceKey: 'strategy:fixture',
      strategyTypeId: 'fixture', createdAt: '2026-08-30T00:00:00.000Z', scope: { storage: 'custom', workspaceId: '/fixture' },
      projection: projected.fragments, routes: [route], readGrants: [grant], actionOffers: [offer],
      consistency: { mode: 'namespace-pinned-live-read', sourceRevisions: { 'source:memory-spaces-fixture': 'fixture-r1' } }, explanation: 'fixture',
    } satisfies ComposableMemoryView

    await expect(runtime.query?.({ view, route, grant, input: { query: 'architecture' } })).resolves.toMatchObject({
      viewId: 'view:fixture', items: [{ id: 'fixture-1', text: 'Found architecture', score: 0.91 }],
    })
    await expect(runtime.mutate?.({ view, offer, input: { content: 'Remember the architecture.', memoryBodyId: 'fixture-body' } })).resolves.toMatchObject({
      viewId: 'view:fixture', status: 'succeeded', details: { memoryBodyId: 'fixture-body', result: { action: 'stored' } },
    })
    await runtime.dispose?.()
    expect(events).toEqual(['create:work-account:https://vector.example', 'dispose:work-account'])
    await mounted.fiber.dispose()
  })

  it('pins old Provider runtimes to a draining Generation until its root-turn lease releases', async () => {
    const events: string[] = []
    const oldModule = fixtureModule(events)
    const nextModule = fixtureModule(events)
    const oldProvider = await mountedSnapshot({
      instanceId: 'work-account', module: oldModule,
      config: { endpoint: 'https://old.vector.example', apiKey: 'old-secret' },
    })
    const nextProvider = await mountedSnapshot({
      instanceId: 'work-account', module: nextModule,
      config: { endpoint: 'https://next.vector.example', apiKey: 'next-secret' },
    })
    const strategy: MemoryStrategyDefinition = {
      manifest: {
        apiVersion: 'dsh-mnemon/v1', kind: 'strategy', typeId: 'fixture', packageName: 'dsh-mnemon-strategy-fixture',
        deterministic: true, supportedSourceRoles: ['durable-evidence'], maxSources: 1, maxRoutes: 1, maxActions: 1,
      },
      compose: (_request, sources) => ({
        strategyTypeId: 'fixture',
        sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, routeIds: ['recall'], actionIds: ['remember'] })),
        explanation: 'Provider drain fixture.',
      }),
    }
    const hostService = new FixtureMemorySpacesService()
    const generations = new MemoryGenerationHost({ bindings: new Map([[BUILTIN_MEMORY_BINDINGS.memorySpaces, hostService]]) })
    const contribution = (provider: typeof oldProvider.snapshot, revision: number) => ({
      revision,
      sources: [{
        kind: 'source' as const,
        instanceKey: 'source:memory-spaces-fixture',
        provenance: { packageName: 'dsh-mnemon-source-memory-spaces', entryId: 'memory-spaces-fixture' },
        definition: createMemorySpacesSource(provider),
        effectiveDigest: `providers:${provider.digest}`,
      }],
      strategies: [{
        kind: 'strategy' as const,
        instanceKey: 'strategy:fixture',
        provenance: { packageName: 'dsh-mnemon-strategy-fixture', entryId: 'fixture' },
        definition: strategy,
      }],
    })

    expect(generations.reconcile(contribution(oldProvider.snapshot, 1)).state).toBe('ready')
    const oldLease = generations.acquire()
    expect(generations.reconcile(contribution(nextProvider.snapshot, 2)).state).toBe('ready')
    expect(generations.inspect().drainingGenerationIds).toEqual([oldLease.id])
    expect(events).toEqual([
      'create:work-account:https://old.vector.example',
      'create:work-account:https://next.vector.example',
    ])

    oldLease.release()
    await vi.waitFor(() => expect(events).toContain('dispose:work-account'))
    expect(generations.inspect().drainingGenerationIds).toEqual([])
    await generations.dispose()
    expect(events.filter(event => event === 'dispose:work-account')).toHaveLength(2)
    await Promise.all([oldProvider.fiber.dispose(), nextProvider.fiber.dispose()])
  })

  it('rejects incomplete manifests, mismatched module identities, duplicate child identities and dishonest runtime capabilities', async () => {
    expect(() => defineMemorySpaceProvider({ id: 'Bad ID', apply() {} })).toThrow('module id')
    const ctx = new Context()
    const host = new PrivateMemorySpaceProviderHost('memory-spaces-errors')
    const dishonest = defineMemorySpaceProvider({
      id: 'dishonest',
      apply(child, bound) {
        bound.install(child, {
          manifest: { ...MANIFEST, typeId: 'dishonest', packageName: 'dsh-mnemon-provider-dishonest', capabilities: { ...CAPABILITIES, related: true } },
          create: () => ({ ...nativeAdapter(), id: 'dishonest' }),
        })
      },
    })
    const entry = { instanceId: 'same', module: dishonest, config: undefined }
    const first = ctx.plugin(createMemorySpaceProviderPlugin(entry, host), entry.config)
    await first.await()
    expect(() => host.snapshot().adapterRegistry().create({
      memoryBodies: {} as never, config: resolveConfig({}), nativeAdapter: nativeAdapter(),
    })).toThrow('declares related')

    const duplicate = ctx.plugin(createMemorySpaceProviderPlugin(entry, host), entry.config)
    await expect(duplicate.await()).rejects.toThrow('already installed')
    expect(host.snapshot().entries).toHaveLength(1)
    await first.dispose()

    const invalidSecrets = fixtureModule([], { ...MANIFEST, secrets: [] })
    const invalidSecretsFiber = ctx.plugin(createMemorySpaceProviderPlugin({
      instanceId: 'invalid-secrets', module: invalidSecrets, config: { endpoint: 'https://vector.example', apiKey: 'secret' },
    }, host), { endpoint: 'https://vector.example', apiKey: 'secret' })
    await expect(invalidSecretsFiber.await()).rejects.toThrow('must exactly match secret config fields')

    const invalidField = fixtureModule([], {
      ...MANIFEST,
      fields: MANIFEST.fields.map((field, index) => index === 0 ? { ...field, input: 'json' as never } : field),
    })
    const invalidFieldFiber = ctx.plugin(createMemorySpaceProviderPlugin({
      instanceId: 'invalid-field', module: invalidField, config: { endpoint: 'https://vector.example', apiKey: 'secret' },
    }, host), { endpoint: 'https://vector.example', apiKey: 'secret' })
    await expect(invalidFieldFiber.await()).rejects.toThrow('unsupported Memory Space Provider field input')
  })
})
