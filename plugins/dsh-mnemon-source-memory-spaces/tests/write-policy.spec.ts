import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { installMemorySpaces } from '../src/index.ts'
import { MemorySpaceRegistry } from '../src/memory-spaces.ts'
import { createRunner } from '../src/runner.ts'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import { MemoryProviderCatalog } from '../src/providers/catalog.ts'
import type { ProcessRunner } from '../src/providers/process.ts'
import { modelSpaceCatalog } from '../src/view-model.ts'
import type { MemorySpace, MemorySpaceCatalog } from '../src/contracts.ts'
import { createRegistry, createService, installedCliStub } from './providers.ts'
import { strategy } from './fixture.ts'
import { bankDescriptor, bankProvider, type Row } from './bank-provider.ts'

// Issue #434: a read-only namespace is recalled as before and takes no write from DSH,
// whichever path the write takes; every other space works as it did.

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

/** The Source with the bank Provider on, a legacy bank holding memories and a fresh one for DSH. */
async function mountBanks() {
  const directory = temporary('mnemon-write-policy-')
  const banks: Record<string, Row[]> = {
    legacy: [{ id: 'old-1', content: 'Legacy decision: deploys wait for a green build.', score: 0.9 }, { id: 'old-2', content: 'Legacy fact: the bank predates DSH.', score: 0.8 }],
    fresh: [],
  }
  const { module, writes } = bankProvider(banks)
  const runner = new MemoryCompositionRunner()
  const scope = { storage: 'custom' as const }
  await runner.mount(strategy, { instanceId: 'strategy' })
  await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
    await installMemorySpaces(ctx, [{ instanceId: 'bank', module, config: undefined }], { config: { dataDir: directory } })
  } }, { instanceId: 'spaces' })
  const client = await runner.managementClient('source:spaces', scope)
  await client.mutate('provider-service-update', { providerId: 'bank', settings: {}, enabled: true }, { confirmed: true })
  const directoryNow = async () => (await client.read('body-directory')).value as unknown as MemorySpaceCatalog
  const spaces = (await directoryNow()).items
  const legacy = spaces.find(space => space.name === 'legacy')!.id
  const fresh = spaces.find(space => space.name === 'fresh')!.id
  const policy = (memoryBodyId: string, value: 'writable' | 'read-only') => client.mutate('body-write-policy', { memoryBodyId, policy: value }, { confirmed: true })
  return { directory, runner, scope, client, writes, banks, legacy, fresh, policy, directoryNow, dispose: () => runner.dispose() }
}

describe('Memory Space write policy (#434)', () => {
  it('recalls a read-only space and refuses every write to it before its Provider is called', async () => {
    const f = await mountBanks()
    try {
      expect((await f.directoryNow()).items.every(space => space.writePolicy === undefined)).toBe(true)
      expect((await f.policy(f.legacy, 'read-only')).value).toMatchObject({ id: f.legacy, writePolicy: 'read-only' })
      const items = (await f.directoryNow()).items
      expect(items.find(space => space.id === f.legacy)).toMatchObject({ active: true, writePolicy: 'read-only' })
      expect(items.find(space => space.id === f.fresh)).not.toHaveProperty('writePolicy')

      const turn = await f.runner.beginTurn({ scope: f.scope })
      const offer = (id: string) => turn.view.actionOffers.find(action => action.sourceActionId === id)!.id
      const route = (id: string) => turn.view.routes.find(item => item.sourceRouteId === id)!.id
      // Reads are as before: Recall returns the legacy bank's memories.
      const recalled = await turn.executeRoute(route('recall'), { query: 'legacy decision' })
      expect(recalled.items.map(item => item.id)).toEqual(expect.arrayContaining(['old-1', 'old-2']))
      // Each write path names the legacy space, and none reaches the Provider.
      const refused = `Memory Space legacy (${f.legacy}) is read only: it is recalled and takes no writes, so nothing was written. Choose a writable space.`
      await expect(turn.executeAction(offer('remember'), { content: 'Goes nowhere.', memoryBodyId: f.legacy }, () => true)).rejects.toThrow(refused)
      await expect(turn.executeAction(offer('forget'), { id: 'old-1' }, () => true)).rejects.toThrow(refused)
      await expect(turn.executeAction(offer('link'), { sourceId: 'old-1', targetId: 'old-2' }, () => true)).rejects.toThrow(refused)
      await expect(f.client.mutate('remember', { content: 'Goes nowhere.', memoryBodyId: f.legacy }, { confirmed: true })).rejects.toThrow(refused)
      await expect(f.client.mutate('remember-many', { requests: [{ content: 'Goes nowhere.', memoryBodyId: f.legacy }] }, { confirmed: true })).rejects.toThrow(refused)
      await expect(f.client.mutate('forget', { id: 'old-1', memoryBodyId: f.legacy }, { confirmed: true })).rejects.toThrow(refused)
      await expect(f.client.mutate('link', { sourceId: 'old-1', targetId: 'old-2', memoryBodyId: f.legacy }, { confirmed: true })).rejects.toThrow(refused)
      expect(f.writes).toEqual([])
      // With one writable space, a write that names none goes there.
      await expect(turn.executeAction(offer('remember'), { content: 'New DSH memory.' }, () => true)).resolves.toMatchObject({ completion: 'committed', details: { memoryBodyId: f.fresh } })
      await f.client.read('body-directory')
      await f.client.mutate('remember', { content: 'Saved from the page.' }, { confirmed: true })
      expect(f.writes).toEqual(['remember:fresh', 'remember:fresh'])
      turn.release()
      // The legacy bank is unchanged, and Recall reads both banks.
      expect(f.banks.legacy!.map(row => row.id)).toEqual(['old-1', 'old-2'])
      const next = await f.runner.beginTurn({ scope: f.scope })
      const both = await next.executeRoute(next.view.routes.find(item => item.sourceRouteId === 'recall')!.id, { query: 'memory' })
      expect(new Set(both.items.map(item => (item.provenance as { memoryBodyId?: string } | undefined)?.memoryBodyId))).toEqual(new Set([f.legacy, f.fresh]))
      next.release()
    } finally { await f.dispose() }
  })

  it('keeps the namespace read only when it is switched off, named again, mounted by hand or reconnected', async () => {
    const f = await mountBanks()
    try {
      await f.policy(f.legacy, 'read-only')
      const refused = 'is read only: it is recalled and takes no writes, so nothing was written'
      // Switched off and named explicitly: still refused, before activation could switch it on.
      await f.client.mutate('body-update', { memoryBodyId: f.legacy, active: false }, { confirmed: true })
      await expect(f.client.mutate('remember', { content: 'x', memoryBodyId: f.legacy }, { confirmed: true })).rejects.toThrow(refused)
      expect((await f.directoryNow()).items.find(space => space.id === f.legacy)).toMatchObject({ active: false, writePolicy: 'read-only' })
      // Switched on again: activation grants no write.
      await f.client.mutate('body-update', { memoryBodyId: f.legacy, active: true }, { confirmed: true })
      await expect(f.client.mutate('remember', { content: 'x', memoryBodyId: f.legacy }, { confirmed: true })).rejects.toThrow(refused)
      // A second space made by hand for the same bank is the same namespace.
      const alias = (await f.client.mutate('body-create', { name: 'Legacy again', description: 'Same bank', providerId: 'bank', connection: { bankId: 'legacy' } }, { confirmed: true })).value as unknown as MemorySpace
      expect(alias.writePolicy).toBe('read-only')
      await expect(f.client.mutate('remember', { content: 'x', memoryBodyId: alias.id }, { confirmed: true })).rejects.toThrow(refused)
      // A space whose settings move to the legacy bank becomes read only with it.
      const moved = (await f.client.mutate('body-create', { name: 'Elsewhere', description: 'Another bank', providerId: 'bank', connection: { bankId: 'other' } }, { confirmed: true })).value as unknown as MemorySpace
      expect(moved).not.toHaveProperty('writePolicy')
      const repointed = (await f.client.mutate('body-update', { memoryBodyId: moved.id, connection: { bankId: 'legacy' } }, { confirmed: true })).value as unknown as MemorySpace
      expect(repointed.writePolicy).toBe('read-only')
      // Disconnected and mounted again: the namespace stays read only.
      await f.client.mutate('body-delete', { memoryBodyId: f.legacy }, { confirmed: true })
      await f.client.mutate('body-delete', { memoryBodyId: alias.id }, { confirmed: true })
      const remounted = (await f.client.mutate('body-create', { name: 'Legacy once more', description: 'Same bank', providerId: 'bank', connection: { bankId: 'legacy' } }, { confirmed: true })).value as unknown as MemorySpace
      expect(remounted.writePolicy).toBe('read-only')
      expect(f.writes).toEqual([])
      // Writable again, for the namespace: every space that names it takes writes.
      await f.policy(remounted.id, 'writable')
      expect((await f.directoryNow()).items.every(space => space.writePolicy === undefined)).toBe(true)
      await f.client.mutate('remember', { content: 'Allowed now.', memoryBodyId: repointed.id }, { confirmed: true })
      expect(f.writes).toEqual(['remember:legacy'])
      expect(existsSync(join(f.directory, 'state', 'memory-provider-write-policy.json'))).toBe(false)
    } finally { await f.dispose() }
  })

  it('offers no default, link or forget through read-only spaces, and never falls back to one', async () => {
    const f = await mountBanks()
    try {
      await f.policy(f.legacy, 'read-only')
      await f.policy(f.fresh, 'read-only')
      const turn = await f.runner.beginTurn({ scope: f.scope })
      const offers = turn.view.actionOffers.map(action => action.sourceActionId)
      // A new space can still be made and written; nothing can be linked or forgotten.
      expect(offers).toEqual(expect.arrayContaining(['remember', 'manage-spaces']))
      expect(offers).not.toContain('link')
      expect(offers).not.toContain('forget')
      const remember = turn.view.actionOffers.find(action => action.sourceActionId === 'remember')!.id
      await expect(turn.executeAction(remember, { content: 'x' }, () => true)).rejects.toThrow('remember requires a writable Memory Space: the ones in this View scope are read only')
      await expect(f.client.mutate('remember', { content: 'x' }, { confirmed: true })).rejects.toThrow(`no active memory space takes writes: legacy (${f.legacy}), fresh (${f.fresh}) are read only`)
      // The model sees what each space takes now.
      const inspected = await turn.executeRoute(turn.view.routes.find(item => item.sourceRouteId === 'inspect')!.id, { section: 'directory' })
      const catalog = JSON.parse(inspected.items[0]!.text) as ReturnType<typeof modelSpaceCatalog>
      expect(catalog.items.map(item => [item.writePolicy, item.provider.capabilities.remember, item.provider.capabilities.forget, item.provider.capabilities.link]))
        .toEqual([['read-only', false, false, false], ['read-only', false, false, false]])
      expect(f.writes).toEqual([])
      turn.release()
      // A write scope given to Host writers holds no read-only space.
      const scoped = await f.runner.beginTurn({ scope: f.scope })
      const grant = scoped.view.readGrants.find(item => item.sourceInstanceKey === 'source:spaces')!
      const directory = (await f.client.read('body-directory', { writeScope: { viewId: scoped.view.id, grant } } as never)).value as unknown as MemorySpaceCatalog
      expect(directory.writeScope?.memoryBodyIds).toEqual([])
      scoped.release()
    } finally { await f.dispose() }
  })

  it('checks the live policy when the write is dispatched, not the View that offered it', async () => {
    const f = await mountBanks()
    try {
      const turn = await f.runner.beginTurn({ scope: f.scope })
      const remember = turn.view.actionOffers.find(action => action.sourceActionId === 'remember')!.id
      // The View was composed while both banks were writable.
      await f.policy(f.fresh, 'read-only')
      await expect(turn.executeAction(remember, { content: 'x', memoryBodyId: f.fresh }, () => true)).rejects.toThrow('is read only')
      // Now one writable space is left, and a write naming none goes there.
      await f.policy(f.legacy, 'writable')
      await expect(turn.executeAction(remember, { content: 'Stays in legacy.' }, () => true)).resolves.toMatchObject({ details: { memoryBodyId: f.legacy } })
      expect(f.writes).toEqual(['remember:legacy'])
      turn.release()
    } finally { await f.dispose() }
  })
})

/** A service over a Mnemon Native data directory whose CLI is faked; writes are the commands that change a Store. */
function nativeFixture(dataDir = temporary('mnemon-write-policy-native-')) {
  for (const store of ['work', 'legacy']) {
    mkdirSync(join(dataDir, 'data', store), { recursive: true })
    writeFileSync(join(dataDir, 'data', store, 'mnemon.db'), 'fixture database')
  }
  writeFileSync(join(dataDir, 'active'), 'work\n')
  const commands: string[][] = []
  const process = vi.fn<ProcessRunner>(async (_command, args) => {
    commands.push([...args])
    if (args.includes('--version')) return { stdout: 'mnemon version 0.1.2\n', stderr: '', exitCode: 0 }
    if (args.includes('store') && args.includes('list')) return { stdout: JSON.stringify({ stores: ['work', 'legacy'], active: 'work' }), stderr: '', exitCode: 0 }
    if (args.includes('recall')) return { stdout: JSON.stringify({ results: [{ id: 'm1', content: 'Legacy memory', score: 0.9 }] }), stderr: '', exitCode: 0 }
    if (args.includes('embed') && args.includes('--status')) return { stdout: JSON.stringify({ embedding_available: true, model: 'fixture', total_insights: 2, embedded: 1, coverage: '50%' }), stderr: '', exitCode: 0 }
    if (args.includes('remember')) return { stdout: JSON.stringify({ id: 'm2', action: 'added' }), stderr: '', exitCode: 0 }
    if (args.includes('import')) return { stdout: JSON.stringify({ imported: 1, updated: 0, skipped: 0, errors: 0 }), stderr: '', exitCode: 0 }
    return { stdout: '{}', stderr: '', exitCode: 0 }
  })
  const config = resolveMemorySpacesConfig({ cliPath: installedCliStub(), dataDir, store: 'work' })
  const runner = createRunner(config, process)
  const service = createService(runner, config, createRegistry(runner, true))
  const writeCommands = () => commands.filter(args => ['remember', 'forget', 'link', 'import'].some(verb => args.includes(verb))
    || (args.includes('embed') && args.includes('--all')) || (args.includes('store') && args.includes('remove')))
  return { service, dataDir, commands, writeCommands, runner, config }
}

describe('Memory Space write policy over Mnemon Native (#434)', () => {
  it('runs no command that changes a read-only Store, and reads it as before', async () => {
    const f = nativeFixture()
    f.service.updateSpace('legacy', { active: true })
    const before = f.service.memoryRevision()
    f.service.setWritePolicy('legacy', 'read-only')
    expect(f.service.memoryRevision()).not.toBe(before)
    const refused = 'is read only: it is recalled and takes no writes'
    await expect(f.service.remember({ content: 'x', memoryBodyId: 'legacy' })).rejects.toThrow(refused)
    await expect(f.service.rememberMany([{ content: 'x', memoryBodyId: 'legacy' }])).rejects.toThrow(refused)
    await expect(f.service.forget('m1', undefined, 'legacy')).rejects.toThrow(refused)
    await expect(f.service.link('m1', 'm2', 'semantic', 0.5, undefined, undefined, 'legacy')).rejects.toThrow(refused)
    await expect(f.service.mergeSpaces('legacy', ['work'])).rejects.toThrow(refused)
    await expect(f.service.embedMissing('legacy')).rejects.toThrow('so no vectors were filled in. Make it writable first to fill them in.')
    await expect(f.service.deleteSpace('legacy')).rejects.toThrow('so its Mnemon Store was not deleted. Make it writable first to delete it.')
    expect(f.writeCommands()).toEqual([])
    // Reads are as before.
    await expect(f.service.search({ query: 'legacy', memoryBodyIds: ['legacy'] })).resolves.toMatchObject({ results: [expect.objectContaining({ id: 'm1' })] })
    expect((await f.service.embeddingStatus()).spaces).toEqual(expect.arrayContaining([expect.objectContaining({ memoryBodyId: 'legacy', writePolicy: 'read-only' })]))
    // The one writable active space is the default destination.
    await f.service.remember({ content: 'New work memory.' })
    expect(f.writeCommands()).toEqual([expect.arrayContaining(['--store', 'work', 'remember'])])
  })

  it('stops a batch at a destination that turned read only while an earlier one was written', async () => {
    const f = nativeFixture()
    f.service.updateSpace('legacy', { active: true })
    const native = (f.service as unknown as { providers: Map<string, { rememberMany?: unknown }> }).providers.get('mnemon-native')!
    const written: string[] = []
    native.rememberMany = async (body: MemorySpace, requests: readonly unknown[]) => {
      written.push(body.id)
      // Another request changes the policy while the first destination is written.
      f.service.setWritePolicy('legacy', 'read-only')
      return requests.map((_request, index) => ({ action: 'added', id: `m${index}` }))
    }
    await expect(f.service.rememberMany([{ content: 'first', memoryBodyId: 'work' }, { content: 'second', memoryBodyId: 'legacy' }])).rejects.toThrow('legacy (legacy) is read only')
    expect(written).toEqual(['work'])
  })

  it('makes every space read only while the policy file cannot be read, and recalls as before', async () => {
    const f = nativeFixture()
    const path = join(f.dataDir, 'state', 'memory-provider-write-policy.json')
    mkdirSync(join(f.dataDir, 'state'), { recursive: true })
    writeFileSync(path, '{ not json')
    f.service.memorySpaces.reload()
    expect(f.service.spaceDirectory().items.map(space => space.writePolicy)).toEqual(['read-only', 'read-only'])
    await expect(f.service.remember({ content: 'x', memoryBodyId: 'work' })).rejects.toThrow(`Memory Space write policy ${path} is unreadable`)
    await expect(f.service.remember({ content: 'x', memoryBodyId: 'work' })).rejects.toThrow('fix or remove it. Until then')
    expect(() => f.service.setWritePolicy('work', 'writable')).toThrow('fix or remove it')
    await expect(f.service.search({ query: 'legacy', memoryBodyIds: ['work'] })).resolves.toMatchObject({ results: [expect.objectContaining({ id: 'm1' })] })
    writeFileSync(path, JSON.stringify({ version: 2, readOnly: {} }))
    f.service.memorySpaces.reload()
    await expect(f.service.remember({ content: 'x', memoryBodyId: 'work' })).rejects.toThrow('has an unsupported format; fix or remove it')
    expect(f.writeCommands()).toEqual([])
    rmSync(path)
    f.service.memorySpaces.reload()
    expect(f.service.spaceDirectory().items.every(space => space.writePolicy === undefined)).toBe(true)
  })

  it('keeps the choice across a restart, beside the Provider registry, and apart from another data directory', () => {
    const f = nativeFixture()
    f.service.setWritePolicy('legacy', 'read-only')
    const path = join(f.dataDir, 'state', 'memory-provider-write-policy.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, readOnly: { 'mnemon-native': [{ spaceId: 'legacy' }] } })
    const restarted = createService(f.runner, f.config, createRegistry(f.runner, true))
    expect(restarted.memorySpaces.get('legacy').writePolicy).toBe('read-only')
    // The registry the space settings live in carries no policy, for readers that rewrite it.
    expect(readFileSync(join(f.dataDir, 'data', '.dsh-memory-bodies.json'), 'utf8')).not.toContain('writePolicy')
    const other = nativeFixture()
    expect(other.service.memorySpaces.get('legacy')).not.toHaveProperty('writePolicy')
  })

  it('changes nothing for spaces without a policy: no file, no field, the same revision encoding', () => {
    const f = nativeFixture()
    const directory = f.service.spaceDirectory()
    expect(directory.items.some(space => 'writePolicy' in space)).toBe(false)
    expect(modelSpaceCatalog(directory).items.some(space => 'writePolicy' in space)).toBe(false)
    const revision = f.service.memoryRevision()
    f.service.setWritePolicy('legacy', 'writable')
    expect(f.service.memoryRevision()).toBe(revision)
    expect(existsSync(join(f.dataDir, 'state', 'memory-provider-write-policy.json'))).toBe(false)
    f.service.setWritePolicy('legacy', 'read-only')
    f.service.setWritePolicy('legacy', 'writable')
    expect(f.service.memoryRevision()).toBe(revision)
    expect(existsSync(join(f.dataDir, 'state', 'memory-provider-write-policy.json'))).toBe(false)
  })
})

describe('Memory Space write policy registry (#434)', () => {
  it('names a namespace by its settings with defaults, a wildcard read included', async () => {
    const dataDir = temporary('mnemon-write-policy-registry-')
    const runner = createRunner(resolveMemorySpacesConfig({ dataDir, cliPath: '/missing/mnemon' }))
    const registry = new MemorySpaceRegistry(runner, true, undefined, new MemoryProviderCatalog([bankDescriptor]))
    registry.syncProviderService('bank', {}, [
      { externalId: 'dsh', name: 'Default bank', description: 'Has the default bank id', connection: {} },
      { externalId: 'team', name: 'Team bank', description: 'Another bank', connection: { bankId: 'team' } },
    ])
    const [defaults, team] = ['Default bank', 'Team bank'].map(name => registry.list().find(space => space.name === name)!)
    registry.setWritePolicy(defaults!.id, 'read-only')
    expect(registry.get(defaults!.id).writePolicy).toBe('read-only')
    expect(registry.get(team!.id)).not.toHaveProperty('writePolicy')
    // A space created for the default bank by naming it, or reading every bank, is read only too.
    const named = await registry.create({ name: 'Default by name', description: 'Names the default bank', providerId: 'bank', connection: { bankId: 'dsh' } })
    const every = await registry.create({ name: 'Every bank', description: 'Reads every bank', providerId: 'bank', connection: { bankId: '*' } })
    expect(registry.list().filter(space => space.writePolicy === 'read-only').map(space => space.id).sort()).toEqual([defaults!.id, named.id, every.id].sort())
    expect(() => registry.setWritePolicy(defaults!.id, 'unknown' as never)).toThrow('unsupported write policy')
    expect(() => registry.setWritePolicy('missing', 'read-only')).toThrow('unknown memory space: missing')
  })
})
