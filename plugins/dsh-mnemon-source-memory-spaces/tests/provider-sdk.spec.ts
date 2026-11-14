import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import { MEMORY_PLACEMENT_CAPABILITIES, type MemoryPlacementCandidate, type MemoryPlacementCapability } from '../src/contracts.ts'
import { finalizeLlmPlacement, prepareMemoryPlacement, rulesOnlyPlacement } from '../src/provider-placement.ts'
import * as sdk from '../src/provider-sdk.ts'
import type { MemorySpaceProviderDefinition, MemorySpaceProviderModule, MemorySpaceProviderHost } from '../src/provider-sdk.ts'
import type { MemoryProviderAdapter } from '../src/providers/adapter.ts'
import { PrivateMemorySpaceProviderHost as ProviderHost } from '../src/providers/host.ts'
import { createMemorySpaceProviderPlugin } from '../src/providers/plugin.ts'
import { MemoryProviderAdapterRegistry } from '../src/providers/registry.ts'
import * as source from '../src/index.ts'
import { createMemorySpaceProviderFixture, mountMemorySpaceProvider } from '../src/testing.ts'
import { descriptor, provider } from './fixture.ts'
import { adapterRegistry, catalog, descriptors, providerEntries } from './providers.ts'
// @ts-expect-error Private parent implementations are not Provider author APIs.
import type { PrivateMemorySpaceProviderHost } from '../src/provider-sdk.ts'
// @ts-expect-error Snapshots carry private factories and remain inside the Source.
import type { MemorySpaceProviderSnapshot } from '../src/provider-sdk.ts'

function adapted(change: (definition: MemorySpaceProviderDefinition) => MemorySpaceProviderDefinition): MemorySpaceProviderModule<undefined> {
  return sdk.defineMemorySpaceProvider<undefined>({
    id: provider.id,
    apply(ctx, host) {
      return provider.apply(ctx, { install: (owner, definition) => host.install(owner, change(definition)) }, undefined)
    },
  })
}

describe('Provider SDK and independent module fixture', () => {
  it('exports driver contracts and author tools without parent implementation objects', () => {
    expectTypeOf<keyof MemorySpaceProviderHost>().toEqualTypeOf<'install'>()
    expectTypeOf<ReturnType<typeof source.installMemorySpaces>>().toEqualTypeOf<Promise<void>>()
    for (const key of ['PrivateMemorySpaceProviderHost', 'MemorySpaceProviderSnapshot', 'MemoryAdapterFactoryRegistry', 'MemoryProviderAdapterRegistry', 'MemoryProviderCatalog', 'digest', 'deepFreeze']) {
      expect(key in sdk).toBe(false)
    }
    expect('createMemorySpacesSource' in source).toBe(false)
    expect(sdk.defineMemorySpaceProvider).toBeTypeOf('function')
    expect(sdk.HttpMemoryProvider).toBeTypeOf('function')
    expect(sdk.runProcess).toBeTypeOf('function')
  })

  it('mounts the actual private-child protocol without a global Mnemon service', async () => {
    const released = vi.fn()
    const module = sdk.defineMemorySpaceProvider<undefined>({
      id: provider.id,
      apply(ctx, host) {
        expect(Object.keys(host)).toEqual(['install'])
        for (const service of ['mnemonMemory', 'mnemonMemorySpace', 'mnemonProvider']) expect(ctx.get(service, false)).toBeUndefined()
        ctx.effect(() => released)
        return provider.apply(ctx, host, undefined)
      },
    })
    const mounted = await mountMemorySpaceProvider(module, { instanceId: 'account', config: undefined })
    try {
      expect(mounted.registered).toBe(true)
      expect(Object.keys(mounted).sort()).toEqual(['createAdapter', 'descriptor', 'dispose', 'manifest', 'registered'])
      expect(mounted.descriptor).toMatchObject({ id: 'account', typeId: 'fixture' })
      expect(Object.isFrozen(mounted.manifest.capabilities)).toBe(true)
      expect(Object.isFrozen(mounted.descriptor)).toBe(true)
    } finally { await mounted.dispose() }
    expect(mounted.registered).toBe(false)
    expect(released).toHaveBeenCalledOnce()
  })

  it('tests two identical child ids under independent parents with separate driver state', async () => {
    const first = await mountMemorySpaceProvider(provider, { sourceInstanceId: 'work', instanceId: 'account', config: undefined })
    const second = await mountMemorySpaceProvider(provider, { sourceInstanceId: 'personal', instanceId: 'account', config: undefined })
    const { body, authority } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused', instanceId: 'account' })
    try {
      const work = first.createAdapter({ memoryBodies: authority, config: { timeoutMs: 100 } })
      const personal = second.createAdapter({ memoryBodies: authority, config: { timeoutMs: 100 } })
      expect(work.id).toBe('account')
      await work.remember(body, { content: 'work-only note' })
      expect((await work.search(body, { query: 'note' })).results).toHaveLength(1)
      expect((await personal.search(body, { query: 'note' })).results).toHaveLength(0)
      await first.dispose()
      expect(second.registered).toBe(true)
    } finally { await Promise.all([first.dispose(), second.dispose()]) }
  })

  it('validates registered factory capabilities when creating an adapter', async () => {
    const module = adapted(definition => ({
      ...definition,
      create: context => ({ ...definition.create(context), search: undefined } as unknown as sdk.MemoryProviderAdapter),
    }))
    const mounted = await mountMemorySpaceProvider(module, { config: undefined })
    const { authority } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    try {
      expect(() => mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 100 } })).toThrow('declares search')
    } finally { await mounted.dispose() }
  })

  it('cleans up failed or missing registrations through the real child Fiber', async () => {
    const released = vi.fn()
    const missing = sdk.defineMemorySpaceProvider<undefined>({ id: 'missing', apply(ctx) { ctx.effect(() => released) } })
    await expect(mountMemorySpaceProvider(missing, { config: undefined })).rejects.toThrow('did not install')
    expect(released).toHaveBeenCalledOnce()
    const failed = sdk.defineMemorySpaceProvider<undefined>({ id: provider.id, apply(ctx, host) {
      provider.apply(ctx, host, undefined)
      ctx.effect(() => released)
      throw new Error('child failed after registration')
    } })
    await expect(mountMemorySpaceProvider(failed, { config: undefined })).rejects.toThrow('child failed after registration')
    expect(released).toHaveBeenCalledTimes(2)
  })

  it('owns created adapter cleanup and prevents creation after disposal begins', async () => {
    const disposeAdapter = vi.fn(async () => undefined)
    const module = adapted(definition => ({ ...definition, create: context => ({ ...definition.create(context), dispose: disposeAdapter }) }))
    const mounted = await mountMemorySpaceProvider(module, { config: undefined })
    const { authority } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 100 } })
    const closing = mounted.dispose()
    expect(mounted.dispose()).toBe(closing)
    expect(() => mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 100 } })).toThrow('disposed')
    await closing
    expect(disposeAdapter).toHaveBeenCalledOnce()
    expect(mounted.registered).toBe(false)
  })

  it('reports adapter cleanup failures without leaving a child registered', async () => {
    const module = adapted(definition => ({ ...definition, create: context => ({ ...definition.create(context), dispose() { throw new Error('cleanup failed') } }) }))
    const mounted = await mountMemorySpaceProvider(module, { config: undefined })
    const { authority } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 100 } })
    await expect(mounted.dispose()).rejects.toThrow('cleanup failed')
    expect(mounted.registered).toBe(false)
  })
})

describe('Memory Spaces private Provider Fibers', () => {
  it('registers a Provider through a child Fiber closure and removes it with that Fiber', async () => {
    const ctx = new Context()
    const privateHost = new ProviderHost('memory-spaces-first')
    const entry = providerEntries.find(candidate => candidate.instanceId === 'openviking')!
    const fiber = ctx.plugin(createMemorySpaceProviderPlugin(entry, privateHost), entry.config)
    await fiber.await()

    expect(privateHost.snapshot().entries.map(candidate => candidate.instanceId)).toEqual(['openviking'])
    expect(ctx.get('mnemonProvider', false)).toBeUndefined()

    await fiber.dispose()
    expect(privateHost.snapshot().entries).toEqual([])
  })

  it('gives each Memory Spaces parent an isolated Provider host', async () => {
    const ctx = new Context()
    const first = new ProviderHost('memory-spaces-first')
    const second = new ProviderHost('memory-spaces-second')
    const entry = providerEntries.find(candidate => candidate.instanceId === 'honcho')!
    const fiber = ctx.plugin(createMemorySpaceProviderPlugin(entry, first), entry.config)
    await fiber.await()

    expect(first.snapshot().entries.map(candidate => candidate.instanceId)).toEqual(['honcho'])
    expect(second.snapshot().entries).toEqual([])
    await fiber.dispose()
  })
})

describe('MemoryProviderAdapterRegistry', () => {
  function adapter(id: MemoryProviderAdapter['id']): MemoryProviderAdapter {
    return {
      id,
      status: vi.fn(async () => ({ healthy: true })),
      search: vi.fn(async () => ({ results: [] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: '2026-08-19T00:00:00.000Z' })),
      list: vi.fn(async () => []),
      remember: vi.fn(async () => null),
    }
  }

  it('owns factory registration lifecycle and rejects duplicates', () => {
    const registry = new MemoryProviderAdapterRegistry()
    const factory = { id: 'mnemon-native' as const, scoreSemantics: { kind: 'provider-native' as const }, create: () => adapter('mnemon-native') }
    const dispose = registry.register(factory)
    expect(registry.ids()).toEqual(['mnemon-native'])
    expect(() => registry.register(factory)).toThrow('already registered')
    dispose()
    dispose()
    expect(registry.ids()).toEqual([])
  })

  it('contains every built-in provider behind factories', () => {
    expect(adapterRegistry().ids()).toEqual([
      'mnemon-native', 'openviking', 'honcho', 'mem0', 'hindsight', 'holographic', 'retaindb', 'byterover', 'supermemory',
    ])
  })

  it('rejects a factory that returns an adapter under another identity', () => {
    const registry = new MemoryProviderAdapterRegistry([{
      id: 'mnemon-native',
      create: () => adapter('openviking'),
    }])
    expect(() => registry.create({
      memoryBodies: {} as never,
      config: resolveMemorySpacesConfig({}),
    })).toThrow('returned openviking')
  })
})

describe('memory provider catalog', () => {
  const MEMORY_PROVIDER_CATALOG = descriptors
  const MEMORY_PROVIDER_IDS = descriptors.map(entry => entry.id)
  const memoryProviderDescriptor = catalog.descriptor.bind(catalog)
  const normalizeProviderMemoryConnection = catalog.normalizeMemory.bind(catalog)
  const normalizeProviderServiceConnection = catalog.normalizeService.bind(catalog)
  const normalizeProviderConnection = catalog.normalize.bind(catalog)
  const publicProviderConnection = catalog.public.bind(catalog)

  it('exposes Mnemon Native plus every supported third-party provider', () => {
    expect(MEMORY_PROVIDER_IDS).toEqual([
      'mnemon-native',
      'openviking',
      'honcho',
      'mem0',
      'hindsight',
      'holographic',
      'retaindb',
      'byterover',
      'supermemory',
    ])
    expect(MEMORY_PROVIDER_CATALOG).toHaveLength(9)
    expect(MEMORY_PROVIDER_CATALOG.filter(entry => entry.origin === 'third-party')).toHaveLength(8)
    expect(MEMORY_PROVIDER_CATALOG.filter(entry => entry.capabilities.entities).map(entry => entry.id)).toEqual([
      'mnemon-native',
      'hindsight',
      'holographic',
    ])
    expect(MEMORY_PROVIDER_CATALOG.map(entry => [entry.id, entry.workspaceBinding])).toEqual([
      ['mnemon-native', 'automatic'],
      ['openviking', 'provider-global'],
      ['honcho', 'provider-global'],
      ['mem0', 'provider-global'],
      ['hindsight', 'provider-global'],
      ['holographic', 'optional-override'],
      ['retaindb', 'provider-global'],
      ['byterover', 'optional-override'],
      ['supermemory', 'provider-global'],
    ])
    expect(memoryProviderDescriptor('byterover').capabilities).toMatchObject({ search: true, browse: false, graph: false, entities: false })
    expect(memoryProviderDescriptor('holographic').fields.find(field => field.key === 'dataPath')).toMatchObject({ scope: 'service', role: 'global-location' })
    expect(memoryProviderDescriptor('byterover').fields.find(field => field.key === 'defaultDirectory')).toMatchObject({ scope: 'service', role: 'global-location' })
  })

  it('normalizes provider defaults without exposing secrets to clients', () => {
    const connection = normalizeProviderConnection('supermemory', {
      endpoint: 'https://api.supermemory.ai/',
      apiKey: 'secret',
      containerTag: 'team',
      searchMode: 'hybrid',
    })
    expect(connection.endpoint).toBe('https://api.supermemory.ai')
    expect(publicProviderConnection('supermemory', connection)).toEqual({
      settings: {
        endpoint: 'https://api.supermemory.ai',
        containerTag: 'team',
        searchMode: 'hybrid',
      },
      configuredSecrets: ['apiKey'],
    })
  })

  it('separates reusable service fields from per-Memory-Space fields', () => {
    const mem0 = memoryProviderDescriptor('mem0')
    expect(mem0.fields.filter(field => field.scope === 'service').map(field => field.key)).toEqual(['endpoint', 'apiKey', 'mode'])
    expect(mem0.fields.filter(field => field.scope === 'memory').map(field => field.key)).toEqual(['userId', 'agentId', 'rerank'])
    expect(normalizeProviderServiceConnection('mem0', { endpoint: 'http://127.0.0.1:8888', mode: 'self-hosted' })).toEqual({ endpoint: 'http://127.0.0.1:8888', apiKey: '', mode: 'self-hosted' })
    expect(normalizeProviderMemoryConnection('mem0', { userId: 'alice' })).toEqual({ userId: 'alice', agentId: 'dsh', rerank: false })
    expect(() => normalizeProviderServiceConnection('mem0', { userId: 'alice' })).toThrow(/service setting/u)
  })

  it('preserves an existing secret when editing non-secret settings and clears it explicitly', () => {
    const previous = normalizeProviderConnection('mem0', {
      endpoint: 'https://api.mem0.ai',
      apiKey: 'secret',
      mode: 'platform',
      userId: 'alice',
      agentId: 'dsh',
    })
    const edited = normalizeProviderConnection('mem0', { userId: 'bob' }, previous)
    expect(edited.apiKey).toBe('secret')
    expect(edited.userId).toBe('bob')
    expect(normalizeProviderConnection('mem0', {}, edited, ['apiKey']).apiKey).toBe('')

    const supermemory = normalizeProviderConnection('supermemory', { apiKey: 'required-secret' })
    expect(normalizeProviderConnection('supermemory', {}, supermemory, ['apiKey']).apiKey).toBe('')
  })

  it('rejects unsupported provider settings and invalid select values', () => {
    expect(() => normalizeProviderConnection('retaindb', { unexpected: 'value' })).toThrow(/unsupported RetainDB setting/u)
    expect(() => normalizeProviderConnection('mem0', { mode: 'mystery' })).toThrow(/unsupported value/u)
    expect(() => normalizeProviderConnection('holographic', { defaultTrust: 2 })).toThrow(/within 0\.\.1/u)
    expect(() => normalizeProviderConnection('supermemory', { apiKey: 'secret', containerTag: 'invalid tag' })).toThrow(/container tag/u)
    expect(memoryProviderDescriptor('holographic').kind).toBe('local')
  })
})

describe('memory provider placement', () => {
  const candidates: MemoryPlacementCandidate[] = [
    {
      id: 'mnemon-native',
      label: 'Mnemon Native',
      kind: 'local',
      configured: true,
      summary: 'Official local-first semantic memory.',
      capabilities: {
        search: true, browse: true, graph: true, entities: true, related: true,
        remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'soft',
      },
    },
    {
      id: 'openviking',
      label: 'OpenViking',
      kind: 'remote',
      configured: true,
      summary: 'Shared remote memory with asynchronous extraction.',
      capabilities: {
        search: true, browse: true, graph: false, entities: false, related: false,
        remember: true, link: false, forget: false, writeMode: 'async-extracting', deletionMode: 'hard',
      },
    },
  ]

  it('applies hard rules before a model sees the eligible provider list', () => {
    const prepared = prepareMemoryPlacement({
      mode: 'automatic',
      prompt: '团队知识优先共享引擎。',
      rules: { dataBoundary: 'local-only', requiredCapabilities: ['graph'], preference: 'shared-first' },
    }, candidates)

    expect(prepared.candidates.map(candidate => candidate.id)).toEqual(['mnemon-native'])
    expect(prepared.appliedRules).toEqual(['data-boundary:local-only', 'requires:graph', 'preference:shared-first'])
    expect(prepared.selectorBrief).not.toContain('OpenViking')
    expect(rulesOnlyPlacement(prepared, () => new Date('2026-08-16T00:00:00.000Z'))).toMatchObject({
      providerId: 'mnemon-native',
      decidedBy: 'rules',
      confidence: 'high',
      decidedAt: '2026-08-16T00:00:00.000Z',
    })
  })

  it('keeps both configured providers eligible for LLM selection without connection secrets', () => {
    const prepared = prepareMemoryPlacement({
      mode: 'automatic',
      prompt: '长期团队共识优先共享；需要精确修改时优先本地。',
      rules: { preference: 'balanced' },
    }, candidates)

    expect(prepared.candidates.map(candidate => candidate.id)).toEqual(['mnemon-native', 'openviking'])
    expect(rulesOnlyPlacement(prepared)).toBeUndefined()
    expect(prepared.prompt).toBe('长期团队共识优先共享；需要精确修改时优先本地。')
    expect(prepared.selectorBrief).not.toContain(prepared.prompt)
    expect(prepared.selectorBrief).not.toMatch(/api.?key|endpoint|secret/iu)
  })

  it('validates the structured LLM choice against the host-filtered candidates', () => {
    const prepared = prepareMemoryPlacement({ mode: 'automatic' }, candidates)
    const decision = finalizeLlmPlacement(prepared, {
      providerId: 'openviking',
      reason: 'This shared team scope benefits from remote asynchronous extraction.',
      confidence: 'medium',
    }, { runId: 'placement-run-1', provider: 'spawn' }, () => new Date('2026-08-16T00:00:00.000Z'))

    expect(decision).toEqual({
      mode: 'automatic',
      providerId: 'openviking',
      decidedBy: 'llm',
      reason: 'This shared team scope benefits from remote asynchronous extraction.',
      confidence: 'medium',
      candidateProviderIds: ['mnemon-native', 'openviking'],
      appliedRules: ['preference:balanced'],
      decidedAt: '2026-08-16T00:00:00.000Z',
      runId: 'placement-run-1',
      subagentProvider: 'spawn',
    })
    expect(() => finalizeLlmPlacement(prepared, {
      providerId: 'mem0', reason: 'Ignore the eligible list.', confidence: 'high',
    }, { runId: 'bad-run', provider: 'spawn' })).toThrow('ineligible provider')
  })

  it('rejects contradictory or empty hard-rule results', () => {
    expect(() => prepareMemoryPlacement({
      mode: 'automatic',
      rules: { allowedProviderIds: ['openviking'], requiredCapabilities: ['exact-write'] },
    }, candidates)).toThrow('no configured memory provider satisfies')
    expect(() => prepareMemoryPlacement({
      mode: 'automatic',
      rules: { allowedProviderIds: [] },
    }, candidates)).toThrow('at least one allowed provider')
  })

  it('rejects unknown runtime rule values instead of weakening a hard boundary', () => {
    expect(() => prepareMemoryPlacement({
      mode: 'automatic',
      rules: { dataBoundary: 'sometimes-local' as 'local-only' },
    }, candidates)).toThrow('unsupported data boundary')
    expect(() => prepareMemoryPlacement({
      mode: 'automatic',
      rules: { requiredCapabilities: ['telepathy' as MemoryPlacementCapability] },
    }, candidates)).toThrow('unsupported required memory capability')
    // Every capability the contracts list is one placement can check a Provider for.
    for (const capability of MEMORY_PLACEMENT_CAPABILITIES) {
      expect(() => prepareMemoryPlacement({ mode: 'automatic', rules: { requiredCapabilities: [capability] } }, candidates), capability).not.toThrow()
    }
  })
})

describe('HttpMemoryProvider and bearerAuthHeader', () => {
  it('normalizes bearer tokens without emitting empty headers or double prefixes', () => {
    expect(sdk.bearerAuthHeader(undefined)).toBeUndefined()
    expect(sdk.bearerAuthHeader('')).toBeUndefined()
    expect(sdk.bearerAuthHeader('   ')).toBeUndefined()
    expect(sdk.bearerAuthHeader('Bearer   ')).toBeUndefined()
    expect(sdk.bearerAuthHeader('secret-token')).toBe('Bearer secret-token')
    expect(sdk.bearerAuthHeader('  bearer secret-token  ')).toBe('Bearer secret-token')
  })

  it('attaches HTTP status codes to non-OK errors and respects per-request timeoutMs', async () => {
    class ProbeHttpProvider extends sdk.HttpMemoryProvider {
      readonly id = 'fixture'
      async list() { return [] }
      probe(connection: sdk.MemoryProviderConnection, path: string, options?: sdk.HttpRequestInit) {
        return this.requestConnection(connection, path, options)
      }
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'upstream HTTP 404 text inside 502' }), { status: 502 }))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true })
      }))
    const { authority } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: '/unused' })
    const provider = new ProbeHttpProvider(authority, { label: 'Probe', fetch: fetchMock, requestTimeoutMs: 10_000 })

    await expect(provider.probe({ endpoint: 'https://probe.example' }, '/v1/items')).rejects.toMatchObject({
      message: 'Probe HTTP 502: upstream HTTP 404 text inside 502',
      status: 502,
    })
    await expect(provider.probe({ endpoint: 'https://probe.example' }, '/v1/slow', { timeoutMs: 25 })).rejects.toThrow('timed out after 25ms')
  })
})
