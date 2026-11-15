import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { installMemorySpaces } from '../src/index.ts'
import { defineMemorySpaceProvider, MEMORY_SPACE_PROVIDER_API_VERSION, NORMALIZED_RELEVANCE_SCORE } from '../src/provider-sdk.ts'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import type { ProcessRunner } from '../src/providers/process.ts'
import { createRunner } from '../src/runner.ts'
import type { MemorySpacesService } from '../src/service.ts'
import { descriptor, strategy } from './fixture.ts'
import { createRegistry, createService, installedCliStub } from './providers.ts'

const FAKE_CLI = installedCliStub()
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const SETTINGS = { endpoint: 'http://127.0.0.1:18889', apiKey: 'synthetic-key' }

function setup(writeEnabled = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-rediscovery-'))
  directories.push(dataDir)
  const config = resolveMemorySpacesConfig({ cliPath: FAKE_CLI, dataDir, writeEnabled })
  const runner = createRunner(config, vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 })))
  const registry = createRegistry(runner, true, () => new Date('2026-10-13T08:00:00.000Z'))
  return { registry, service: createService(runner, config, registry), config, runner }
}

const bank = (externalId: string, name = externalId) => ({ externalId, name, description: 'An upstream bank.', connection: { bankId: externalId, budget: 'mid' } })
/** Namespaces as each Provider's discovery reports them; `*` leaves a peer, user or agent open. */
const workspace = (id: string) => ({ externalId: id, name: id, description: 'A Honcho workspace.', connection: { workspace: id, userId: '*', agentId: '*' } })
const entity = (type: 'user' | 'agent', id: string) => ({ externalId: `${type}:${id}`, name: id, description: `A Mem0 ${type}.`,
  connection: type === 'user' ? { userId: id, agentId: '*', rerank: false } : { userId: '*', agentId: id, rerank: false } })
const store = (path: string) => ({ externalId: path, name: 'Holographic', description: 'Fact store', connection: { defaultTrust: 0.5, minTrust: 0.3 } })

/** A Provider whose namespaces the test changes, as someone working on the Provider side would. */
function upstream(id: 'hindsight' | 'honcho', namespaces: Array<ReturnType<typeof bank>>) {
  return {
    id,
    discover: vi.fn(async (_connection?: unknown, _signal?: AbortSignal) => namespaces.map(item => ({ ...item }))),
    status: vi.fn(async () => ({ healthy: true })),
    search: vi.fn(async () => ({ results: [] })),
    graph: vi.fn(async () => ({ nodes: [], edges: [], generatedAt: 'now' })),
    list: vi.fn(async () => []),
    remember: vi.fn(async () => ({ action: 'stored' })),
  }
}

function install(service: MemorySpacesService, adapter: ReturnType<typeof upstream>): void {
  ;(service as unknown as { providers: Map<string, unknown> }).providers.set(adapter.id, adapter)
}

const names = (service: { list(): Array<{ name: string; active: boolean }> }) => service.list().map(body => [body.name, body.active])
const disconnects = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { version: number; providers: Record<string, unknown[]> }

describe('Provider namespaces mounted when they are asked for again (#373)', () => {
  it('mounts a namespace the Provider gained, inactive, and leaves every mounted space as it is', () => {
    const { registry } = setup()
    const service = registry.resolveProviderService('hindsight', SETTINGS)
    registry.syncProviderService('hindsight', service, [bank('bank-a', 'Alice'), bank('bank-b', 'Team')])
    const [alice, team] = registry.list()
    registry.setActive(team!.id, false)
    registry.update(alice!.id, { name: 'Product insight' })
    const before = readFileSync(registry.providerRegistryPath, 'utf8')

    // The Provider renamed Alice, dropped Team and gained Research.
    const mounted = registry.mountDiscovered('hindsight', registry.resolveProviderService('hindsight', {}), [bank('bank-a', 'Alice, renamed'), bank('bank-c', 'Research')])
    expect(mounted.added.map(body => [body.name, body.active])).toEqual([['Research', false]])
    expect(names(registry)).toEqual([['Product insight', true], ['Team', false], ['Research', false]])
    const after = JSON.parse(readFileSync(registry.providerRegistryPath, 'utf8')) as { bodies: unknown[] }
    expect(after.bodies.slice(0, 2)).toEqual((JSON.parse(before) as { bodies: unknown[] }).bodies)

    // Asked again with nothing new: nothing is written at all.
    const written = readFileSync(registry.providerRegistryPath, 'utf8')
    expect(registry.mountDiscovered('hindsight', registry.resolveProviderService('hindsight', {}), [bank('bank-a'), bank('bank-c')]).added).toEqual([])
    expect(readFileSync(registry.providerRegistryPath, 'utf8')).toBe(written)
  })

  it('leaves a namespace a person disconnected disconnected, until the settings are saved again', async () => {
    const { registry } = setup()
    const service = registry.resolveProviderService('hindsight', SETTINGS)
    registry.syncProviderService('hindsight', service, [bank('bank-a', 'Alice'), bank('bank-b', 'Team')])
    await registry.remove(registry.list().find(body => body.name === 'Team')!.id)
    // Beside the registry, which keeps the layout every earlier build reads and writes.
    expect(disconnects(registry.disconnectsPath)).toEqual({ version: 1, providers: { hindsight: [{ externalId: 'bank-b', connection: { bankId: 'bank-b', budget: 'mid' } }] } })
    expect(JSON.parse(readFileSync(registry.providerRegistryPath, 'utf8'))).not.toHaveProperty('disconnected')

    const mounted = registry.mountDiscovered('hindsight', registry.resolveProviderService('hindsight', {}), [bank('bank-a'), bank('bank-b', 'Team')])
    expect(mounted).toEqual({ added: [], disconnected: 1 })
    expect(names(registry)).toEqual([['Alice', true]])

    // Saving the Provider's settings mounts what it reports, as it always did, and forgets the disconnect.
    registry.syncProviderService('hindsight', service, [bank('bank-a', 'Alice'), bank('bank-b', 'Team')])
    expect(names(registry)).toEqual([['Alice', true], ['Team', true]])
    expect(existsSync(registry.disconnectsPath)).toBe(false)
  })

  it('takes a space made by hand for the same bank, workspace or user as that namespace, whatever its other settings', async () => {
    const { registry } = setup()
    registry.syncProviderService('hindsight', registry.resolveProviderService('hindsight', SETTINGS), [bank('bank-a', 'Alice')])
    registry.syncProviderService('honcho', registry.resolveProviderService('honcho', SETTINGS), [])
    registry.syncProviderService('mem0', registry.resolveProviderService('mem0', SETTINGS), [])
    // Made on the Memory Spaces page: another recall budget, one peer of a workspace, one user with its agent.
    await registry.create({ name: 'Team, made here', description: 'A bank named by hand.', providerId: 'hindsight', connection: { bankId: 'team', budget: 'high' } })
    await registry.create({ name: 'W1 for Alice', description: 'One peer.', providerId: 'honcho', connection: { workspace: 'w1', userId: 'alice', agentId: 'dsh' } })
    await registry.create({ name: 'Alice in Mem0', description: 'One user.', providerId: 'mem0', connection: { userId: 'alice', agentId: 'dsh' } })

    const asked = (providerId: 'hindsight' | 'honcho' | 'mem0', discovered: Parameters<typeof registry.mountDiscovered>[2]) =>
      registry.mountDiscovered(providerId, registry.resolveProviderService(providerId, {}), discovered).added.map(body => body.name)
    expect(asked('hindsight', [bank('bank-a', 'Alice'), bank('team', 'Team')])).toEqual([])
    expect(asked('honcho', [workspace('w1'), workspace('w2')])).toEqual(['w2'])
    // The agent `dsh` is read by the hand-made space as well; another agent is not.
    expect(asked('mem0', [entity('user', 'alice'), entity('agent', 'dsh'), entity('agent', 'helper')])).toEqual(['helper'])
    expect(registry.list().map(body => body.name)).toEqual(['Alice', 'Team, made here', 'W1 for Alice', 'Alice in Mem0', 'w2', 'helper'])
  })

  it('remembers a space made by hand that a person disconnected, by the namespace it read', async () => {
    const { registry } = setup()
    const service = registry.resolveProviderService('hindsight', SETTINGS)
    registry.syncProviderService('hindsight', service, [bank('bank-a', 'Alice')])
    const team = await registry.create({ name: 'Team, made here', description: 'A bank named by hand.', providerId: 'hindsight', connection: { bankId: 'team', budget: 'high' } })
    await registry.remove(team.id)
    expect(disconnects(registry.disconnectsPath).providers).toEqual({ hindsight: [{ connection: { bankId: 'team', budget: 'high' } }] })

    expect(registry.mountDiscovered('hindsight', registry.resolveProviderService('hindsight', {}), [bank('bank-a'), bank('team', 'Team')])).toEqual({ added: [], disconnected: 1 })
    registry.syncProviderService('hindsight', service, [bank('bank-a', 'Alice'), bank('team', 'Team')])
    expect(names(registry)).toEqual([['Alice', true], ['Team', true]])
    expect(existsSync(registry.disconnectsPath)).toBe(false)
  })

  it('tells namespaces that share one connection apart by externalId alone', () => {
    const { registry } = setup()
    // A Provider that reports its namespaces with the same settings, told apart only by externalId.
    registry.syncProviderService('holographic', registry.resolveProviderService('holographic', {}), [store('/data/a.json')])
    const mounted = registry.mountDiscovered('holographic', registry.resolveProviderService('holographic', {}), [store('/data/a.json'), store('/data/b.json'), store('/data/c.json')])
    expect(mounted.added.map(body => body.name)).toEqual(['Holographic', 'Holographic'])
    expect(registry.list()).toHaveLength(3)
  })

  it('takes a store whose path moved with its data directory as the store already mounted', () => {
    const { registry } = setup()
    // Holographic names its one store by the absolute path it had when its settings were saved.
    registry.syncProviderService('holographic', registry.resolveProviderService('holographic', {}), [store('/old/data/state/holographic/store.json')])
    const mounted = registry.mountDiscovered('holographic', registry.resolveProviderService('holographic', {}), [store('/new/data/state/holographic/store.json')])
    expect(mounted.added).toEqual([])
    expect(registry.list().map(body => body.name)).toEqual(['Holographic'])
  })

  it('mounts nothing for a Provider switched off, or saved with other settings since it was asked', () => {
    const { registry } = setup()
    const asked = registry.resolveProviderService('hindsight', SETTINGS)
    registry.syncProviderService('hindsight', asked, [bank('bank-a')])
    registry.updateProviderService('hindsight', { ...SETTINGS, endpoint: 'http://127.0.0.1:18890' })
    expect(registry.mountDiscovered('hindsight', asked, [bank('bank-a'), bank('bank-b')]).added).toEqual([])
    registry.updateProviderService('hindsight', SETTINGS, [], false)
    expect(registry.mountDiscovered('hindsight', registry.resolveProviderService('hindsight', {}), [bank('bank-b')]).added).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('leaves out a namespace it cannot hold and still mounts the others', () => {
    const { registry } = setup()
    registry.syncProviderService('hindsight', registry.resolveProviderService('hindsight', SETTINGS), [bank('bank-a')])
    const mounted = registry.mountDiscovered('hindsight', registry.resolveProviderService('hindsight', {}), [
      { ...bank('bank-b'), externalId: '   ' },
      bank('bank-c', 'Research'),
      { ...bank('bank-c', 'Research, reported twice'), connection: { bankId: 'bank-c-copy', budget: 'mid' } },
    ])
    expect(mounted.added.map(body => body.name)).toEqual(['Research'])
  })

  it('keeps disconnects when a build that predates them rewrites the registry, and reads only sound ones', async () => {
    const { registry, runner } = setup()
    registry.syncProviderService('hindsight', registry.resolveProviderService('hindsight', SETTINGS), [bank('bank-a'), bank('bank-b')])
    await registry.remove(registry.list().find(body => body.name === 'bank-b')!.id)
    // An earlier build switches a space off: it rewrites the registry with the fields it knows.
    const file = JSON.parse(readFileSync(registry.providerRegistryPath, 'utf8')) as { version: number; services: unknown; enabled: unknown; bodies: Array<Record<string, unknown>> }
    writeFileSync(registry.providerRegistryPath, `${JSON.stringify({ version: file.version, services: file.services, enabled: file.enabled, bodies: file.bodies.map(body => ({ ...body, active: false })) }, null, 2)}\n`)
    const reread = createRegistry(runner, true)
    expect(reread.mountDiscovered('hindsight', reread.resolveProviderService('hindsight', {}), [bank('bank-a'), bank('bank-b')])).toEqual({ added: [], disconnected: 1 })

    writeFileSync(registry.disconnectsPath, JSON.stringify({ version: 1, providers: {
      hindsight: [{ externalId: 'bank-c' }, 7, {}, { externalId: '' }, { connection: { bankId: 'bank-d' } }, { externalId: 'x'.repeat(2001) }],
      'Not A Provider': [{ externalId: 'bank-e' }],
    } }))
    const sound = createRegistry(runner, true)
    expect(sound.mountDiscovered('hindsight', sound.resolveProviderService('hindsight', {}), [bank('bank-c'), bank('bank-d'), bank('bank-e')]))
      .toMatchObject({ added: [expect.objectContaining({ name: 'bank-e' })], disconnected: 2 })
  })
})

describe('Asking every enabled Provider again (#373)', () => {
  it('asks each one side by side and says why one could not answer, keeping its spaces', async () => {
    const { service, registry } = setup()
    const hindsight = upstream('hindsight', [bank('bank-a', 'Alice')])
    const honcho = upstream('honcho', [])
    install(service, hindsight)
    install(service, honcho)
    await service.updateProviderService('hindsight', SETTINGS)
    registry.syncProviderService('honcho', registry.resolveProviderService('honcho', { endpoint: 'http://127.0.0.1:18891', apiKey: 'synthetic-key' }), [])
    hindsight.discover.mockImplementationOnce(async () => [bank('bank-a', 'Alice'), bank('bank-b', 'Team')])
    honcho.discover.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:18891'))

    const outcome = await service.rediscoverProviders('manual')
    // In the order the Providers are listed, whichever answered first.
    expect(outcome).toMatchObject({ trigger: 'manual', results: [
      { providerId: 'honcho', found: 0, added: [], error: 'connect ECONNREFUSED 127.0.0.1:18891' },
      { providerId: 'hindsight', label: 'Hindsight', found: 2, added: [{ name: 'Team' }], disconnected: 0 },
    ] })
    expect(outcome.results[0]).not.toHaveProperty('timedOut')
    expect(names(registry)).toEqual([['Alice', true], ['Team', false]])
    expect(service.spaceDirectory().rediscovery).toEqual({ running: false, last: outcome })
  })

  it('gives up on a Provider that does not answer in time without holding the others back', async () => {
    const { service } = setup()
    const hindsight = upstream('hindsight', [bank('bank-a')])
    install(service, hindsight)
    await service.updateProviderService('hindsight', SETTINGS)
    hindsight.discover.mockImplementationOnce(() => new Promise(() => {}))
    const outcome = await service.rediscoverProviders('startup', undefined, 50)
    expect(outcome.results).toEqual([expect.objectContaining({ providerId: 'hindsight', timedOut: true, error: 'did not answer within 50 ms' })])
  })

  it('joins a pass already running, and asks again when whoever started it stops it', async () => {
    const { service, registry } = setup()
    const namespaces = [bank('bank-a')]
    const hindsight = upstream('hindsight', namespaces)
    install(service, hindsight)
    await service.updateProviderService('hindsight', SETTINGS)
    let answer!: (value: Array<ReturnType<typeof bank>>) => void
    hindsight.discover.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const controller = new AbortController()
    const first = service.rediscoverProviders('startup', controller.signal)
    const second = service.rediscoverProviders('manual')
    await vi.waitFor(() => expect(hindsight.discover).toHaveBeenCalledTimes(2))
    expect(service.spaceDirectory().rediscovery).toMatchObject({ running: true })

    namespaces.push(bank('bank-b'))
    controller.abort(new Error('the runtime went away'))
    await expect(first).rejects.toThrow('the runtime went away')
    // The page that joined still gets its answer, from a pass of its own.
    await expect(second).resolves.toMatchObject({ trigger: 'manual', results: [{ providerId: 'hindsight', added: [{ name: 'bank-b' }] }] })
    // The pass that was stopped writes nothing, even when its Provider answers afterwards.
    answer([bank('bank-a'), bank('bank-x')])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(registry.list().map(body => body.name)).toEqual(['bank-a', 'bank-b'])
    expect(service.spaceDirectory().rediscovery).toMatchObject({ running: false, last: { trigger: 'manual' } })
  })

  it('coalesces multiple joiners onto one replacement pass when the starter aborts', async () => {
    const { service } = setup()
    const hindsight = upstream('hindsight', [bank('bank-a')])
    install(service, hindsight)
    await service.updateProviderService('hindsight', SETTINGS)
    hindsight.discover.mockClear()
    let finishFirst!: (value: Array<ReturnType<typeof bank>>) => void
    hindsight.discover
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockImplementationOnce(async () => [bank('bank-a'), bank('bank-b')])
    const starter = new AbortController()
    const first = service.rediscoverProviders('startup', starter.signal)
    const second = service.rediscoverProviders('manual')
    const third = service.rediscoverProviders('manual')
    await vi.waitFor(() => expect(hindsight.discover).toHaveBeenCalledTimes(1))

    starter.abort(new Error('starter cancelled'))
    await expect(first).rejects.toThrow('starter cancelled')
    const [secondOutcome, thirdOutcome] = await Promise.all([second, third])
    expect(hindsight.discover).toHaveBeenCalledTimes(2)
    expect(secondOutcome).toEqual(thirdOutcome)
    finishFirst([bank('bank-a')])
    await service.dispose()
  })

  it('lets a request that joined a pass stop waiting for it, and leaves the pass running', async () => {
    const { service } = setup()
    const hindsight = upstream('hindsight', [bank('bank-a')])
    install(service, hindsight)
    await service.updateProviderService('hindsight', SETTINGS)
    let answer!: (value: Array<ReturnType<typeof bank>>) => void
    hindsight.discover.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const first = service.rediscoverProviders('startup')
    const leaving = new AbortController()
    const second = service.rediscoverProviders('manual', leaving.signal)
    leaving.abort(new Error('the page closed'))
    await expect(second).rejects.toThrow('the page closed')
    expect(service.spaceDirectory().rediscovery).toMatchObject({ running: true })
    answer([bank('bank-a'), bank('bank-b')])
    await expect(first).resolves.toMatchObject({ results: [{ added: [{ name: 'bank-b' }] }] })
  })

  it('refuses on a read-only deployment and asks no Provider', async () => {
    const { service, registry } = setup(false)
    registry.syncProviderService('hindsight', registry.resolveProviderService('hindsight', SETTINGS), [bank('bank-a')])
    const hindsight = upstream('hindsight', [bank('bank-a'), bank('bank-b')])
    install(service, hindsight)
    await expect(service.rediscoverProviders('manual')).rejects.toThrow('read-only')
    expect(hindsight.discover).not.toHaveBeenCalled()
  })

  it('offers it as a confirmed management mutation of the Source', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-rediscovery-source-'))
    directories.push(directory)
    const scope = { storage: 'custom' as const }
    const namespaces = [{ externalId: 'notes', name: 'Notes', description: 'Fixture namespace', connection: {} }]
    const module = defineMemorySpaceProvider<undefined>({ id: 'rediscovered', apply(ctx, host) {
      host.install(ctx, {
        manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'rediscovered',
          packageName: 'dsh-mnemon-provider-rediscovered-test', version: '1.0.0', label: 'Rediscovered fixture', summary: 'Simulated Provider; real Source.',
          origin: 'third-party', locality: 'remote', workspaceBinding: 'provider-global', fields: [], secrets: [], scoreSemantics: 'normalized-relevance',
          capabilities: descriptor.capabilities,
        },
        create: () => ({ id: 'rediscovered', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
          discover: async () => namespaces.map(namespace => ({ ...namespace })),
          status: async () => ({ healthy: true }), list: async () => [], search: async () => ({ results: [] }),
          graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }), remember: async () => ({ action: 'stored' }),
        }),
      })
    } })
    const runner = new MemoryCompositionRunner()
    await runner.mount(strategy, { instanceId: 'strategy' })
    await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
      await installMemorySpaces(ctx, [{ instanceId: 'account', module, config: undefined }], { config: { dataDir: directory } })
    } }, { instanceId: 'work' })
    try {
      const source = (await runner.managementCatalog(scope)).sources[0]!
      const mutate = async (operation: string, input: unknown) => {
        const revision = (await runner.managementCatalog(scope)).sources[0]!.revision
        return runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: true, expectedRevision: revision, operation, input: input as never })
      }
      const directoryNames = async () => {
        const read = await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'read', confirmed: false, operation: 'body-directory', input: null })
        return (read.value as unknown as { items: Array<{ name: string; active: boolean }> }).items.map(item => [item.name, item.active])
      }
      await mutate('provider-service-update', { providerId: 'account', settings: {}, enabled: true })
      expect(await directoryNames()).toEqual([['Notes', true]])
      // Created on the Provider side after the settings were saved.
      namespaces.push({ externalId: 'research', name: 'Research', description: 'Fixture namespace', connection: {} })
      const outcome = await mutate('provider-rediscover', { trigger: 'manual' })
      expect(outcome.value).toMatchObject({ trigger: 'manual', results: [{ providerId: 'account', found: 2, added: [{ name: 'Research' }] }] })
      expect(await directoryNames()).toEqual([['Notes', true], ['Research', false]])
      await expect(runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: false, expectedRevision: (await runner.managementCatalog(scope)).sources[0]!.revision, operation: 'provider-rediscover', input: null }))
        .rejects.toThrow(/confirmation/u)
    } finally {
      await runner.dispose()
    }
  })
})
