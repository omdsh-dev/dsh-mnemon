import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import * as lightContext from 'dsh-mnemon-strategy-light-context'
import * as autoCapture from 'dsh-mnemon-strategy-auto-capture'
import * as runtimePlugin from 'dsh-mnemon-source-runtime'
import { installMemorySpaces } from 'dsh-mnemon-source-memory-spaces'
import holographic from 'dsh-mnemon-provider-holographic'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from 'dsh-mnemon-strategy-default-three-tier'
import { defineMemoryStrategy, installMemory } from '../src/sdk/index.ts'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import type { HostAgent, HostContextShape, HostSubagentsService, HostWorkspace, ToolDefinition } from '../src/host/dsh.ts'
import type { MnemonLifecycle } from '../src/host/lifecycle.ts'
import type { Config } from '../src/host/config.ts'
import { agentScope, createRuntimeGraph } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator, type RuntimeMaintenanceTaskRunner } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { createWriteHandler } from '../src/host/rpc.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { sessionLog } from './fixtures/session-log.ts'

const runtimeKey = 'source:mnemon-source-runtime'
const spacesKey = 'source:mnemon-source-memory-spaces'
const saved = 'Saved durable fact. '.repeat(15).trim()
const pending = 'Pending durable fact. '.repeat(15).trim()
const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })

async function fixture(taskRunner?: RuntimeMaintenanceTaskRunner, config: Config = {}) {
  const f = await compositionFixture({ runtimeMemory: { memoryLimitBytes: 512, userLimitBytes: 512 }, ...config })
  fixtures.push(f)
  await f.memorySpace()
  await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
  const start = vi.fn()
  const coordinator = new MnemonSubagentCoordinator({ start } as unknown as HostSubagentsService, f.live, undefined, undefined, undefined, taskRunner)
  const tools = new Map<string, ToolDefinition>()
  registerTools({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
  const lifecycle = { manageSource: coordinator.manageSource.bind(coordinator), workspaceRoot: () => f.workspace,
    snapshot: () => ({ taskAgentAvailable: false }) } as unknown as MnemonLifecycle
  const write = createWriteHandler(f.live, lifecycle)
  const root = { id: 'capacity-root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
  const child = { id: 'capacity-child', session: { header: { cwd: f.workspace, origin: 'subagent', parentSession: root.id }, ...sessionLog() } } as unknown as HostAgent
  const begin = async () => {
    const graph = f.live.snapshot()
    const turn = await graph.composableTurns.beginTurn(root.id + ':1', agentScope(root, graph.config))
    graph.composableTurns.pinTurn(child.id + ':1', agentScope(child, graph.config), turn.view.id)
    return turn
  }
  const execute = (name: string, input: object, agent = root, signal = new AbortController().signal) =>
    tools.get(name)!.execute(input as never, { agent, signal })
  const management = async (sourceInstanceKey = runtimeKey, input: object = { action: 'add', target: 'memory', content: pending }) => ({
    workspaceId: 'workspace', sourceInstanceKey, operation: 'mutate', input, confirmed: true,
    expectedRevision: await f.live.snapshot().memoryComposition.current()!.managementRevision(sourceInstanceKey, { storage: f.config.storageScope, workspaceId: f.workspace }),
  })
  return { ...f, fixtureRoot: f.root, coordinator, start, write, root, child, begin, execute, management }
}

describe('default Runtime capacity workflow across Host entry points', () => {
  it.each(['named', 'generic', 'fallback'].flatMap(entry => [false, true].map(overflow => ({ entry, overflow }))))('preserves importance for $entry writes, overflow=$overflow (#469)', async ({ entry, overflow }) => {
    const f = await fixture()
    const runtime = f.graph.source('runtime')
    await runtime.mutate('mutate', { action: 'replace', target: 'memory', oldText: saved, content: saved, importance: 'critical' })
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Filler '.repeat(20).trim(), importance: 'low' })
    const turn = entry === 'fallback' ? undefined : await f.begin()
    const content = 'Corrected durable rule. '.repeat(overflow ? 19 : 3).trim()
    const mutation = { action: 'replace' as const, target: 'memory' as const, oldText: saved, content, importance: 'normal' as const }
    if (entry === 'fallback') await f.coordinator.runtime(f.root, mutation, new AbortController().signal)
    else if (entry === 'named') await f.execute('mnemon_runtime_memory', { ...mutation, old_text: saved }, f.child)
    else {
      const offer = turn!.view.actionOffers.find(value => value.sourceInstanceKey === runtimeKey && value.sourceActionId === 'mutate')!
      // A model-provided flag cannot bypass the Source's automatic-write policy.
      await expect(f.execute('mnemon_view_action', { offerId: offer.id, input: { ...mutation, preserveImportance: false } }, f.child)).rejects.toThrow('unsupported property')
      await f.execute('mnemon_view_action', { offerId: offer.id, input: mutation }, f.child)
    }
    const entries = (await runtime.read<RuntimeMemorySnapshot>('snapshot')).entries
    expect(entries.find(row => row.content === content)?.importance).toBe('critical')
    expect(entries).toHaveLength(overflow ? 1 : 2)
    // Explicit management still lets the user lower an entry's importance.
    await runtime.mutate('mutate', { ...mutation, oldText: content, content: 'User-edited rule', importance: 'low' })
    expect((await runtime.read<RuntimeMemorySnapshot>('snapshot')).entries.find(row => row.content === 'User-edited rule')?.importance).toBe('low')
  })

  it.each(['root', 'child', 'enhanced-root', 'enhanced-child'] as const)('archives into a known namespace activated after the %s View was pinned (issue 250)', async caller => {
    const f = await fixture()
    if (caller.startsWith('enhanced-')) {
      await f.mount(scoped, { instanceId: 'scoped' })
      await f.mount(lightContext, { instanceId: 'light-context' })
      await f.mount(autoCapture, { instanceId: 'auto-capture' })
    }
    const spaces = f.graph.source('memory-spaces')
    const body = await f.memorySpace()
    await spaces.mutate('body-update', { memoryBodyId: body.id, active: false })
    const turn = await f.begin()
    expect(turn.view.readGrants.find(grant => grant.sourceInstanceKey === spacesKey)!.value)
      .toMatchObject({ memoryBodyIds: [], knownMemoryBodyIds: [body.id] })
    const offerId = turn.view.actionOffers.find(offer => offer.sourceInstanceKey === spacesKey && offer.sourceActionId === 'manage-spaces')!.id
    const agent = caller.endsWith('root') ? f.root : f.child
    await f.execute('mnemon_view_action', { offerId, input: { operation: 'update', memoryBodyId: body.id, active: true } }, agent)
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }, agent))
      .resolves.toMatchObject({ added: pending, maintenance: { memoryBodyIds: [body.id] } })
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([pending])
    expect(await spaces.read('search', { query: 'Saved durable fact' })).toMatchObject({ results: [expect.objectContaining({ content: saved })] })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('archives into a namespace created and activated by its own View (issue 250)', async () => {
    const f = await fixture(undefined, { persistenceStrategy: { mode: 'manual', providerId: 'holographic' } })
    const spaces = f.graph.source('memory-spaces')
    const original = await f.memorySpace()
    await spaces.mutate('body-update', { memoryBodyId: original.id, active: false })
    const turn = await f.begin()
    const offerId = turn.view.actionOffers.find(offer => offer.sourceInstanceKey === spacesKey && offer.sourceActionId === 'manage-spaces')!.id
    const created = await f.execute('mnemon_view_action', { offerId, input: {
      operation: 'create', request: { name: 'Own View archive', description: 'Synthetic same-View archive destination.' },
    } }) as { details: { memoryBodyId: string } }
    await f.execute('mnemon_view_action', { offerId, input: { operation: 'update', memoryBodyId: created.details.memoryBodyId, active: true } })
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }))
      .resolves.toMatchObject({ added: pending, maintenance: { memoryBodyIds: [created.details.memoryBodyId] } })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('retains an overflowing write for retry when only a foreign-created namespace is active (issue 250)', async () => {
    const f = await fixture()
    const spaces = f.graph.source('memory-spaces')
    const original = await f.memorySpace()
    await spaces.mutate('body-update', { memoryBodyId: original.id, active: false })
    await f.begin()
    await spaces.mutate('body-create', { name: 'Foreign View archive', description: 'Synthetic foreign namespace.', providerId: 'holographic', active: true })
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }))
      .rejects.toThrow('current View write scope')
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
    expect(await spaces.read('search', { query: 'Saved durable fact' })).toMatchObject({ results: [] })
    f.graph.composableTurns.endTurn(f.root.id + ':1')
    f.graph.composableTurns.endTurn(f.child.id + ':1')
    await f.begin()
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending })).resolves.toMatchObject({ added: pending })
  })

  it.each([true, false])('keeps conservative compatibility with a Source that omits writeScope: active at pin=%s', async active => {
    const f = await fixture()
    const spaces = f.graph.source('memory-spaces')
    const body = await f.memorySpace()
    if (!active) await spaces.mutate('body-update', { memoryBodyId: body.id, active: false })
    await f.begin()
    if (!active) await spaces.mutate('body-update', { memoryBodyId: body.id, active: true })
    const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
    const manage = source.manage!.bind(source)
    vi.spyOn(source as { manage: NonNullable<typeof source.manage> }, 'manage').mockImplementation(request => manage(
      request.operation === 'body-directory' ? { ...request, input: null } : request,
    ))
    const result = f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending })
    if (active) await expect(result).resolves.toMatchObject({ added: pending })
    else {
      await expect(result).rejects.toThrow('current View write scope is empty')
      expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
    }
  })

  it.each(['empty', 'revoked', 'null', 'foreign-view', 'foreign-source', 'malformed-ids'] as const)('rejects %s Source write authority before archive side effects', async fault => {
    const f = await fixture()
    await f.begin()
    const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
    const manage = source.manage!.bind(source)
    let reads = 0
    const mutations: string[] = []
    vi.spyOn(source as { manage: NonNullable<typeof source.manage> }, 'manage').mockImplementation(async request => {
      if (request.mode === 'mutate') mutations.push(request.operation)
      const result = await manage(request)
      if (request.operation === 'body-directory') {
        reads++
        const value = result.value as unknown as { writeScope: Record<string, unknown> | null }
        if (fault === 'empty' || fault === 'revoked' && reads > 1) value.writeScope!.memoryBodyIds = []
        if (fault === 'null') value.writeScope = null
        if (fault === 'foreign-view') value.writeScope!.viewId = 'foreign-view'
        if (fault === 'foreign-source') value.writeScope!.sourceInstanceKey = 'source:foreign'
        if (fault === 'malformed-ids') value.writeScope!.memoryBodyIds = [42]
      }
      return result
    })
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }))
      .rejects.toThrow(fault === 'empty' ? 'current View write scope is empty' : fault === 'revoked' ? 'no longer eligible' : 'invalid Memory Spaces write scope')
    expect(mutations).toEqual([])
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
  })

  it('keeps explicitly attenuated namespace grants empty despite an active catalog', async () => {
    const f = await fixture()
    const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
    const project = source.project!.bind(source)
    vi.spyOn(source as { project: NonNullable<typeof source.project> }, 'project').mockImplementation(async request => {
      const result = await project(request)
      return { ...result, readGrant: { ...result.readGrant!, value: { memoryBodyIds: [], knownMemoryBodyIds: [] } } }
    })
    await f.begin()
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }))
      .rejects.toThrow('current View write scope is empty')
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
  })

  it.each(['cancel', 'ended-turn', 'unload'] as const)('keeps the initiating View lease when %s occurs during write-scope resolution', async change => {
    const f = await fixture()
    await f.begin()
    const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
    const manage = source.manage!.bind(source)
    let started!: () => void
    let release!: () => void
    const begun = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    let first = true
    vi.spyOn(source as { manage: NonNullable<typeof source.manage> }, 'manage').mockImplementation(async request => {
      const result = await manage(request)
      if (request.operation === 'body-directory' && first) { first = false; started(); await held }
      return result
    })
    const controller = new AbortController()
    const operation = f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }, f.root, controller.signal)
    await begun
    if (change === 'cancel') controller.abort()
    else if (change === 'ended-turn') f.graph.composableTurns.endTurn(f.root.id + ':1')
    else await f.releases[2]!()
    release()
    if (change === 'unload') await expect(operation).resolves.toMatchObject({ added: pending })
    else {
      await expect(operation).rejects.toThrow(change === 'cancel' ? /abort/i : 'ended turn')
      expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
    }
  })

  it('gets write authority from the exact selected Memory Spaces instance', async () => {
    const f = await fixture()
    const otherKey = 'source:other-spaces'
    await f.mount({ inject: ['mnemonMemory'], apply: ctx => installMemorySpaces(ctx, [
      { instanceId: holographic.id, module: holographic, config: undefined },
    ], { config: { dataDir: join(f.fixtureRoot, 'other-spaces') } }) }, { instanceId: 'other-spaces' })
    await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: [runtimeKey, otherKey] } })
    const other = f.graph.source('memory-spaces').forInstance(otherKey)
    await other.mutate('provider-service-update', { providerId: 'holographic', enabled: true, settings: { dataPath: join(f.fixtureRoot, 'other-facts.json') } })
    await f.begin()
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }))
      .resolves.toMatchObject({ added: pending })
    expect(await other.read('search', { query: 'Saved durable fact' })).toMatchObject({ results: [expect.objectContaining({ content: saved })] })
    expect(await f.graph.source('memory-spaces').read('search', { query: 'Saved durable fact' })).toMatchObject({ results: [] })
  })

  it.skipIf(!process.env.MNEMON_NATIVE_TEST_CLI)('archives exact checkpoints to two same-View Native namespaces through real Host tools', async () => {
    const routes: Array<{ sourceIndexes: number[]; memoryBodyId: string }> = []
    const f = await fixture(async () => ({ provider: 'fixture', runId: 'native-write-scope', result: {
      output: [], stopReason: 'completed', structured: { action: 'planned', summary: 'Split synthetic checkpoints.', routes },
    } }), { cliPath: process.env.MNEMON_NATIVE_TEST_CLI! })
    const spaces = f.graph.source('memory-spaces')
    await spaces.mutate('provider-service-update', { providerId: 'holographic', enabled: false, settings: {} })
    const runtime = f.graph.source('runtime')
    await runtime.mutate('mutate', { action: 'remove', target: 'memory', oldText: saved })
    const checkpoints = ['Issue250 architecture checkpoint. '.repeat(6).trim(), 'Issue250 release checkpoint. '.repeat(6).trim()]
    for (const content of checkpoints) await runtime.mutate('mutate', { action: 'add', target: 'memory', content })
    const turn = await f.begin()
    expect(turn.view.readGrants.find(grant => grant.sourceInstanceKey === spacesKey)!.value).toMatchObject({ memoryBodyIds: [], knownMemoryBodyIds: [] })
    const offerId = turn.view.actionOffers.find(offer => offer.sourceInstanceKey === spacesKey && offer.sourceActionId === 'manage-spaces')!.id
    for (const index of [0, 1]) {
      const created = await f.execute('mnemon_view_action', { offerId, input: { operation: 'create', request: {
        name: `Native checkpoint ${index}`, description: 'Disposable issue 250 integration destination.',
      } } }) as { details: { memoryBodyId: string } }
      const memoryBodyId = created.details.memoryBodyId
      await f.execute('mnemon_view_action', { offerId, input: { operation: 'update', memoryBodyId, active: true } })
      routes.push({ sourceIndexes: [index + 1], memoryBodyId })
    }
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }))
      .resolves.toMatchObject({ added: pending, maintenance: { memoryBodyIds: routes.map(route => route.memoryBodyId) } })
    expect((await runtime.read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([pending])
    for (const [index, route] of routes.entries()) {
      expect(await spaces.read('list', { memoryBodyIds: [route.memoryBodyId], limit: 10 }))
        .toMatchObject({ items: [expect.objectContaining({ content: checkpoints[index], memoryBodyId: route.memoryBodyId })] })
    }
  }, 30_000)

  it.each(['root-tool', 'child-tool', 'root-action', 'child-action', 'web-runtime', 'web-management', 'web-assistance'] as const)(
    'archives before committing an overflowing %s write without a model', async entry => {
      const f = await fixture()
      const input = { action: 'add', target: 'memory', content: pending }
      let revision: string
      if (entry.startsWith('web-')) {
        const result = entry === 'web-runtime' ? await f.write('runtime-memory', { workspaceId: 'workspace', ...input })
          : await f.write(entry === 'web-management' ? 'source-management-mutate' : 'source-assistance', await f.management())
        expect(result).toMatchObject({ ok: true })
        revision = (result as { ok: true; value: { revision: string } }).value.revision
      } else {
        const turn = await f.begin()
        const agent = entry.startsWith('child-') ? f.child : f.root
        const result = entry.endsWith('-tool') ? await f.execute('mnemon_runtime_memory', input, agent)
          : await f.execute('mnemon_view_action', { offerId: turn.view.actionOffers.find(offer => offer.sourceInstanceKey === runtimeKey)!.id, input }, agent)
        expect(result).toMatchObject(entry.endsWith('-tool')
          ? { added: pending, maintenance: { kind: 'mnemon-archive' }, memoryReceipt: { completion: 'committed' } }
          : { completion: 'committed', details: { added: pending, maintenance: { kind: 'mnemon-archive' } } })
        revision = (result as { revision: string }).revision
      }
      const snapshot = await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')
      expect(snapshot.entries.map(entry => entry.content)).toEqual([pending])
      expect(revision).toBe(snapshot.revision)
      const archived = await f.graph.source('memory-spaces').read<{ results: Array<{ content: string }> }>('search', { query: 'Saved durable fact' })
      expect(archived.results.some(entry => entry.content === saved)).toBe(true)
      expect(f.start).not.toHaveBeenCalled()
    },
  )

  it.each(['tool', 'action', 'web'] as const)('respects a read-only archive destination through %s', async entry => {
    const f = await fixture()
    await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: [runtimeKey, spacesKey], writableSourceKeys: [runtimeKey] } })
    const turn = await f.begin()
    const before = await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')
    const input = { action: 'add', target: 'memory', content: pending }
    if (entry === 'web') expect(await f.write('source-management-mutate', await f.management())).toMatchObject({ ok: false, error: { message: expect.stringContaining('not offered') } })
    else await expect(f.execute(entry === 'tool' ? 'mnemon_runtime_memory' : 'mnemon_view_action', entry === 'tool' ? input : {
      offerId: turn.view.actionOffers.find(offer => offer.sourceInstanceKey === runtimeKey)!.id, input,
    }, f.child)).rejects.toThrow('not offered')
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ revision: before.revision, entries: before.entries, targets: before.targets })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('rejects stale browser revisions before archival and retains every hot entry', async () => {
    const f = await fixture()
    const request = await f.management()
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'A concurrent addition.' })
    const before = await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')
    expect(await f.write('source-management-mutate', request)).toMatchObject({ ok: false, error: { message: expect.stringContaining('revision conflict') } })
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ revision: before.revision, entries: before.entries, targets: before.targets })
    expect(f.coordinator.snapshot().migrations).toBe(0)
  })

  it('does not begin an archive after cancellation', async () => {
    const f = await fixture()
    await f.begin()
    const controller = new AbortController()
    controller.abort()
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }, f.child, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
  })

  it('requires model tools to retain their own View instead of using operator management authority', async () => {
    const f = await fixture()
    expect(() => f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }, f.child)).toThrow('View is not pinned')
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
  })

  it('serializes concurrent child writes without losing either hot or archived facts', async () => {
    const f = await fixture()
    await f.begin()
    const additions = Array.from({ length: 4 }, (_, index) => `Concurrent fact ${index}. ` + 'Detail '.repeat(40))
    await Promise.all(additions.map(content => f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content }, f.child)))
    const hot = await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')
    const cold = await f.graph.source('memory-spaces').read<{ results: Array<{ content: string }> }>('search', { query: 'Concurrent fact', limit: 20 })
    const retained = new Set([...hot.entries, ...cold.results].map(entry => entry.content))
    expect(additions.every(content => retained.has(content.trim()))).toBe(true)
    expect(hot.targets.memory.used).toBeLessThanOrEqual(512)
  })

  it('does not let a queued child write borrow a later turn', async () => {
    const f = await fixture()
    const turn = await f.begin()
    let started!: () => void
    let release!: () => void
    const begun = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
    const manage = source.manage!.bind(source)
    vi.spyOn(source as { manage: NonNullable<typeof source.manage> }, 'manage').mockImplementation(async request => {
      if (request.mode === 'mutate' && request.operation === 'remember-many') { started(); await held }
      return manage(request)
    })
    const first = f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending })
    await begun
    const second = f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: 'Queued child fact.' }, f.child)
    const rejected = expect(second).rejects.toThrow('ended turn')
    f.graph.composableTurns.endTurn(f.child.id + ':1')
    f.graph.composableTurns.pinTurn(f.child.id + ':2', agentScope(f.child, f.config), turn.view.id)
    release()
    await first
    await rejected
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([pending])
  })

  it('preserves Runtime when the archive Provider fails', async () => {
    const f = await fixture()
    const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
    const manage = source.manage!.bind(source)
    vi.spyOn(source as { manage: NonNullable<typeof source.manage> }, 'manage').mockImplementation(request => {
      if (request.mode === 'mutate' && request.operation === 'remember-many') throw new Error('Provider unavailable')
      return manage(request)
    })
    expect(await f.write('source-management-mutate', await f.management())).toMatchObject({ ok: false, error: { message: 'Provider unavailable' } })
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
  })

  it('compacts USER through an independent model task without a selected session', async () => {
    const merged = 'User prefers concise Chinese technical answers.'
    const taskRunner = vi.fn<RuntimeMaintenanceTaskRunner>(async () => ({ provider: 'spawn', runId: 'independent-profile', result: {
      output: [], stopReason: 'completed', structured: { action: 'compacted', summary: 'Merged overlapping preferences.',
        compactedEntries: [{ content: merged, importance: 'normal', sourceIndexes: [1, 2] }] },
    } }))
    const f = await fixture(taskRunner)
    const runtime = f.graph.source('runtime')
    await runtime.mutate('mutate', { action: 'add', target: 'user', content: 'User prefers concise answers. '.repeat(7) })
    await runtime.mutate('mutate', { action: 'add', target: 'user', content: 'User prefers Chinese technical answers. '.repeat(5) })
    const next = 'User wants explicit verification details. '.repeat(4).trim()
    expect(await f.write('runtime-memory', { workspaceId: 'workspace', action: 'add', target: 'user', content: next })).toMatchObject({
      ok: true, value: { added: next, maintenance: { kind: 'local-compaction', memoryBodyIds: [] } },
    })
    expect(taskRunner).toHaveBeenCalledWith({ storage: 'custom', workspaceId: f.workspace }, expect.any(AbortSignal), expect.any(Function))
    expect((await runtime.read<RuntimeMemorySnapshot>('snapshot')).entries.filter(entry => entry.target === 'user').map(entry => entry.content)).toEqual([merged, next])
    expect(f.start).not.toHaveBeenCalled()
  })

  it('does not widen archival to a namespace added after the model View was pinned', async () => {
    const f = await fixture()
    await f.begin()
    const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
    const manage = source.manage!.bind(source)
    vi.spyOn(source as { manage: NonNullable<typeof source.manage> }, 'manage').mockImplementation(async request => {
      const result = await manage(request)
      if (request.mode === 'read' && request.operation === 'body-directory') {
        const value = result.value as unknown as { items: Array<Record<string, unknown>> }
        value.items.push({ ...value.items[0], id: 'outside-pinned-namespace', active: true, mnemonDefault: true })
      }
      return result
    })
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }, f.child)).resolves.toMatchObject({ added: pending })
    expect(f.start).not.toHaveBeenCalled()
  })

  it.each(['tool', 'action', 'web'] as const)('keeps exact Runtime instance identity during %s maintenance', async entry => {
    const f = await fixture()
    await f.mount(runtimePlugin, { instanceId: 'other-runtime', config: { dataDir: join(f.fixtureRoot, 'other-runtime'), memoryLimitBytes: 512 } })
    const otherKey = 'source:other-runtime'
    await f.mount(scoped, { instanceId: 'scoped', config: { sourceKeys: [otherKey, spacesKey] } })
    const other = f.graph.source('runtime').forInstance(otherKey)
    await other.mutate('mutate', { action: 'add', target: 'memory', content: saved })
    if (entry === 'web') expect(await f.write('source-management-mutate', await f.management(otherKey))).toMatchObject({ ok: true })
    else {
      const turn = await f.begin()
      const offerId = turn.view.actionOffers.find(offer => offer.sourceInstanceKey === otherKey)!.id
      const input = { action: 'add', target: 'memory', content: pending }
      await expect(entry === 'tool' ? f.execute('mnemon_runtime_memory', input, f.child) : f.execute('mnemon_view_action', { offerId, input }, f.child))
        .resolves.toMatchObject(entry === 'tool' ? { memoryReceipt: { completion: 'committed' } } : { completion: 'committed' })
    }
    expect((await other.read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([pending])
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
  })

  it('leaves Source-local capacity semantics intact when an independent Strategy is selected', async () => {
    const f = await fixture()
    const definition = defineMemoryStrategy({
      // It composes as the Layered strategy does, but declares none of its workflows.
      manifest: { ...DEFAULT_THREE_TIER_VIEW_STRATEGY.manifest, typeId: 'external', packageName: 'external-strategy', workflows: [] },
      compose: (...args) => ({ ...DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(...args), strategyTypeId: 'external' }),
    })
    await f.mount({ inject: ['mnemonMemory'], apply: ctx => installMemory(ctx, { strategies: [definition] }) }, { instanceId: 'external' })
    f.live.swap(createRuntimeGraph({ ...f.config, memoryTopology: { ...f.config.memoryTopology, strategyId: 'external' } }, f.workspace, f.extensions))
    await f.begin()
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }, f.child)).rejects.toMatchObject({ code: 'runtime-capacity' })
    expect(await f.write('source-management-mutate', await f.management())).toMatchObject({ ok: false })
    expect(f.coordinator.snapshot().migrations).toBe(0)
    expect(f.start).not.toHaveBeenCalled()
  })

  it('archives for an independent Strategy that declares Runtime capacity maintenance', async () => {
    const f = await fixture()
    const body = await f.memorySpace()
    const definition = defineMemoryStrategy({
      manifest: { ...DEFAULT_THREE_TIER_VIEW_STRATEGY.manifest, typeId: 'external', packageName: 'external-strategy', workflows: ['runtime-capacity'] },
      compose: (...args) => ({ ...DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(...args), strategyTypeId: 'external' }),
    })
    await f.mount({ inject: ['mnemonMemory'], apply: ctx => installMemory(ctx, { strategies: [definition] }) }, { instanceId: 'external' })
    f.live.swap(createRuntimeGraph({ ...f.config, memoryTopology: { ...f.config.memoryTopology, strategyId: 'external' } }, f.workspace, f.extensions))
    const turn = await f.begin()
    expect(turn.view.strategyTypeId).toBe('external')
    await expect(f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending }, f.child))
      .resolves.toMatchObject({ added: pending, maintenance: { memoryBodyIds: [body.id] } })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('archives in the inspected workspace even when the selected conversation belongs elsewhere', async () => {
    const workspaces = new Map<string, HostWorkspace>()
    let parent: HostAgent | undefined
    const f = await compositionFixture({ storageScope: 'workspace', runtimeUserScope: 'storage', runtimeMemory: { memoryLimitBytes: 512 } }, {
      workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) },
      agents: { get: (id: string) => id === parent?.id ? parent : undefined, roots: () => parent === undefined ? [] : [parent] } as never,
    })
    fixtures.push(f)
    const otherWorkspace = join(f.root, 'second-workspace')
    mkdirSync(otherWorkspace)
    workspaces.set('first', { id: 'first', title: 'First', path: f.workspace })
    workspaces.set('second', { id: 'second', title: 'Second', path: otherWorkspace })
    parent = { id: 'unrelated-conversation', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
    const route = f.live.route({ workspaceId: 'second', sessionId: parent.id })
    expect(route.aligned).toBe(false)
    await route.graph.source('memory-spaces').mutate('provider-service-update', {
      providerId: 'holographic', enabled: true, settings: { dataPath: join(otherWorkspace, 'facts.json') },
    })
    await route.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved + ' Second workspace.' })
    const coordinator = new MnemonSubagentCoordinator({} as never, f.live)
    const write = createWriteHandler(f.live, { manageSource: coordinator.manageSource.bind(coordinator), workspaceRoot: () => f.workspace } as unknown as MnemonLifecycle)
    expect(await write('runtime-memory', { workspaceId: 'second', sessionId: parent.id, action: 'add', target: 'memory', content: pending })).toMatchObject({ ok: true })
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([saved])
    expect((await route.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([pending])
    const archived = await route.graph.source('memory-spaces').read<{ results: Array<{ content: string }> }>('search', { query: 'Second workspace' })
    expect(archived.results.some(entry => entry.content === saved + ' Second workspace.')).toBe(true)
  })
})

it('keeps pinned Runtime in every new View across repeated Provider archives', async () => {
  const f = await fixture()
  const runtime = f.graph.source('runtime')
  const rule = 'Ask before deleting data.'
  await runtime.mutate('mutate', { action: 'add', target: 'memory', content: rule, importance: 'low' })
  await runtime.mutate('pin', { target: 'memory', content: rule, pinned: true })
  const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
  const writes = vi.spyOn(source as { manage: NonNullable<typeof source.manage> }, 'manage')
  for (let index = 0; index < 3; index++) {
    const content = `Round ${index}: ` + 'New ordinary detail. '.repeat(14).trim()
    expect(await f.write('runtime-memory', { workspaceId: 'workspace', action: 'add', target: 'memory', content })).toMatchObject({ ok: true })
    expect((await runtime.read<RuntimeMemorySnapshot>('snapshot')).entries.find(entry => entry.content === rule)).toMatchObject({ pinned: true, importance: 'low' })
    const turn = await f.graph.composableTurns.beginTurn(`pin-check:${index}`, agentScope(f.root, f.graph.config))
    expect(turn.view.projection.map(fragment => fragment.text).join('\n')).toContain(rule)
  }
  const archives = writes.mock.calls.filter(([request]) => request.mode === 'mutate' && request.operation === 'remember-many')
  expect(archives).toHaveLength(3)
  expect(JSON.stringify(archives)).not.toContain(rule)
})

it('fails a pinned-capacity conflict before any Provider archive or model work', async () => {
  const task = vi.fn<RuntimeMaintenanceTaskRunner>()
  const f = await fixture(task)
  await f.graph.source('runtime').mutate('pin', { target: 'memory', content: saved, pinned: true })
  const source = f.graph.memoryComposition.current()!.sourceRuntime(spacesKey)!
  const writes = vi.spyOn(source as { manage: NonNullable<typeof source.manage> }, 'manage')
  expect(await f.write('runtime-memory', { workspaceId: 'workspace', action: 'add', target: 'memory', content: pending })).toMatchObject({ ok: false, error: { message: expect.stringContaining('Unpin entries or increase') } })
  expect(writes.mock.calls.filter(([request]) => request.mode === 'mutate')).toHaveLength(0)
  expect(task).not.toHaveBeenCalled()
  expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries).toMatchObject([{ content: saved, pinned: true }])
})

it('copies pinned USER entries verbatim around model compaction of unpinned preferences', async () => {
  const task = vi.fn<RuntimeMaintenanceTaskRunner>(async () => ({ provider: 'spawn', runId: 'pin-profile', result: {
    output: [], stopReason: 'completed', structured: { action: 'compacted', summary: 'Consolidated ordinary preferences.', compactedEntries: [{ content: 'Be concise.', importance: 'normal', sourceIndexes: [1] }] },
  } }))
  const f = await fixture(task)
  const runtime = f.graph.source('runtime')
  const rule = 'Keep this exact profile instruction. '.repeat(2).trim()
  await runtime.mutate('mutate', { action: 'add', target: 'user', content: rule, importance: 'critical' })
  await runtime.mutate('pin', { target: 'user', content: rule, pinned: true })
  const before = (await runtime.read<RuntimeMemorySnapshot>('snapshot')).entries.find(entry => entry.content === rule)
  await runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Ordinary preference. '.repeat(17).trim() })
  const next = 'New user preference. '.repeat(10).trim()
  expect(await f.write('runtime-memory', { workspaceId: 'workspace', action: 'add', target: 'user', content: next })).toMatchObject({ ok: true })
  const entries = (await runtime.read<RuntimeMemorySnapshot>('snapshot')).entries.filter(entry => entry.target === 'user')
  expect(entries[0]).toEqual(before)
  expect(entries.map(entry => entry.content)).toEqual([rule, 'Be concise.', next])
})
