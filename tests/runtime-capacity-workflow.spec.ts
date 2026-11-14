import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import * as lightContext from 'dsh-mnemon-strategy-light-context'
import * as autoCapture from 'dsh-mnemon-strategy-auto-capture'
import * as runtimePlugin from 'dsh-mnemon-source-runtime'
import { installMemorySpaces } from 'dsh-mnemon-source-memory-spaces'
import holographic from 'dsh-mnemon-provider-holographic'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from 'dsh-mnemon-strategy-default-three-tier'
import { defineMemoryStrategy, installMemory } from '../src/sdk/index.ts'
import type { DocumentView } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import type { HostAgent, HostContextShape, HostSubagentsService, HostWorkspace, ToolDefinition } from '../src/host/dsh.ts'
import type { MnemonLifecycle } from '../src/host/lifecycle.ts'
import type { Config } from '../src/host/config.ts'
import { agentScope, createRuntimeGraph } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator, type RuntimeMaintenanceTaskRunner } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { createWriteHandler } from '../src/host/rpc.ts'
import { compositionFixture } from './fixtures/composition.ts'
import type { Insight } from 'dsh-mnemon-source-memory-spaces/contracts'
import { SourceSession } from '../src/host/source-session.ts'
import { sourceFixture } from './fixtures/sources.ts'
import { sessionLog } from './fixtures/session-log.ts'
import {
  addSecondWritableBody, capabilities, capacityError, cleanupSubagentFixtures, createCoordinator,
  delegatedResultSchema, maintenancePlan, managedSession, parent, releases, runtimeArchiveFixture,
  runtimeSource, service, subagents, temporaryDirectories, toolRegistry, type RuntimeOperations,
} from './fixtures/subagent-coordinator.ts'

describe('runtime capacity workflow', () => {
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
  return { ...f, fixtureRoot: f.root, coordinator, lifecycle, start, write, root, child, begin, execute, management }
}

describe('default Runtime capacity workflow across Host entry points', () => {
  it.each(['named', 'generic', 'fallback', 'management'].flatMap(entry => ['serialized', 'json-error', 'foreign-realm'].map(shape => ({ entry, shape }))))('maintains capacity across a $shape Source failure through $entry (#641)', async ({ entry, shape }) => {
    const f = await fixture()
    const generation = f.live.snapshot().memoryComposition.current()!
    const serializeFailure = async <T,>(operation: Promise<T>): Promise<T> => {
      try { return await operation }
      catch (error) {
        if (!(error instanceof Error)) throw error
        if (shape === 'json-error') throw JSON.parse(JSON.stringify(error))
        const fields = { ...error, name: error.name, message: error.message }
        throw shape === 'serialized' ? Object.freeze(fields) : runInNewContext('Object.assign(new Error(fields.message), fields)', { fields })
      }
    }
    const action = generation.executeAction.bind(generation)
    const manage = generation.executeManagement.bind(generation)
    vi.spyOn(generation, 'executeAction').mockImplementation((...args) => serializeFailure(action(...args)))
    vi.spyOn(generation, 'executeManagement').mockImplementation((...args) => serializeFailure(manage(...args)))
    const turn = entry === 'fallback' ? undefined : await f.begin()
    const input = { action: 'add' as const, target: 'memory' as const, content: pending }
    if (entry === 'named') await expect(f.execute('mnemon_runtime_memory', input)).resolves.toMatchObject({ added: pending })
    else if (entry === 'generic') {
      const offer = turn!.view.actionOffers.find(value => value.sourceInstanceKey === runtimeKey && value.sourceActionId === 'mutate')!
      await expect(f.execute('mnemon_view_action', { offerId: offer.id, input })).resolves.toMatchObject({ completion: 'committed' })
    } else if (entry === 'fallback') {
      await expect(f.coordinator.runtime(f.root, input, new AbortController().signal)).resolves.toMatchObject({ added: pending })
    } else await expect(f.write('source-management-mutate', await f.management())).resolves.toMatchObject({ ok: true })
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(value => value.content)).toEqual([pending])
    expect(await f.graph.source('memory-spaces').read('search', { query: 'Saved durable fact' }))
      .toMatchObject({ results: [expect.objectContaining({ content: saved })] })
    expect(f.start).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'serialized message', error: { message: 'Archive destination is unavailable; retry after reconnecting.', privateTranscript: 'PRIVATE-SYNTHETIC-CONTENT' }, message: 'Archive destination is unavailable; retry after reconnecting.' },
    { label: 'opaque Error', error: new Error('[object Object]'), message: 'Operation failed without a readable error message.' },
    { label: 'unknown object', error: { privateTranscript: 'PRIVATE-SYNTHETIC-CONTENT' }, message: 'Operation failed without a readable error message.' },
  ])('returns a readable $label to the save UI without dumping other fields (#641)', async ({ error, message }) => {
    const f = await fixture()
    const request = await f.management()
    vi.spyOn(f.lifecycle, 'manageSource').mockRejectedValueOnce(error)
    const result = await f.write('source-management-mutate', request)
    expect(result).toMatchObject({ ok: false, error: { message } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC-CONTENT')
    expect((await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')).entries.map(value => value.content)).toEqual([saved])
  })

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
    expect(await f.write('source-management-mutate', await f.management())).toMatchObject({ ok: false, error: {
      message: expect.stringMatching(/Would exceed memory runtime memory capacity:.*limit 512.*Automatic capacity maintenance failed: Provider unavailable/u),
    } })
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
})

describe('memory layer combinations at their capacity limits (issue 336)', () => {
  const runtimeKey = 'source:mnemon-source-runtime'
  const spacesKey = 'source:mnemon-source-memory-spaces'
  const saved = 'Saved durable fact. '.repeat(15).trim()
  const pending = 'Pending durable fact. '.repeat(15).trim()
  const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })

  type SpacesState = 'ready' | 'inactive-space' | 'no-provider' | 'layer-off' | 'component-off'

  async function fixture(state: SpacesState, config: Config = {}, documentsLimitBytes?: number) {
    const topology = state === 'layer-off' ? { memoryTopology: { layers: { 'memory-spaces': { enabled: false } } } } : {}
    const f = await compositionFixture({ runtimeMemory: { memoryLimitBytes: 512, userLimitBytes: 512 }, ...topology, ...config } as Config,
      documentsLimitBytes === undefined ? {} : { documentsLimitBytes })
    fixtures.push(f)
    if (state === 'ready' || state === 'inactive-space') {
      const body = await f.memorySpace()
      if (state === 'inactive-space') await f.graph.source('memory-spaces').mutate('body-update', { memoryBodyId: body.id, active: false })
    }
    if (state === 'component-off') await f.releases[2]!()
    const start = vi.fn()
    const coordinator = new MnemonSubagentCoordinator({ start } as unknown as HostSubagentsService, f.live)
    const tools = new Map<string, ToolDefinition>()
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const lifecycle = { manageSource: coordinator.manageSource.bind(coordinator), workspaceRoot: () => f.workspace,
      snapshot: () => ({ taskAgentAvailable: false }) } as unknown as MnemonLifecycle
    const write = createWriteHandler(f.live, lifecycle)
    const root = { id: 'layers-root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    const begin = async () => {
      const graph = f.live.snapshot()
      return graph.composableTurns.beginTurn(root.id + ':1', agentScope(root, graph.config))
    }
    const execute = (name: string, input: object) => Promise.resolve().then(() => tools.get(name)!.execute(input as never, { agent: root, signal: new AbortController().signal }))
    const runtimeSnapshot = () => f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')
    const archiveText = async () => readFileSync(join((await runtimeSnapshot()).directory, 'archived', 'MEMORY.md'), 'utf8')
    return { ...f, start, coordinator, root, write, begin, execute, runtimeSnapshot, archiveText }
  }

  it.each(['ready', 'inactive-space', 'no-provider', 'layer-off', 'component-off'] as const)('keeps MEMORY.md writable when Memory Spaces is %s, through the Agent tool and the web page', async state => {
    for (const entry of ['tool', 'web'] as const) {
      const f = await fixture(state)
      await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
      const turn = await f.begin()
      let result: unknown
      if (entry === 'tool') result = await f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending })
      else {
        const response = await f.write('source-management-mutate', {
          workspaceId: 'workspace', sourceInstanceKey: runtimeKey, operation: 'mutate', input: { action: 'add', target: 'memory', content: pending }, confirmed: true,
          expectedRevision: await f.live.snapshot().memoryComposition.current()!.managementRevision(runtimeKey, { storage: f.config.storageScope, workspaceId: f.workspace }),
        }) as { ok: boolean; value?: unknown; error?: unknown }
        expect(response).toMatchObject({ ok: true })
        result = (response.value as { value: unknown }).value
      }
      expect((await f.runtimeSnapshot()).entries.map(item => item.content)).toEqual([pending])
      if (state === 'ready') {
        expect(result).toMatchObject({ maintenance: { kind: 'mnemon-archive' } })
        expect(await f.graph.source('memory-spaces').read('search', { query: 'Saved durable fact' })).toMatchObject({ results: [expect.objectContaining({ content: saved })] })
      } else {
        expect(result).toMatchObject({ maintenance: { kind: 'local-archive', memoryBodyIds: [] } })
        expect(await f.archiveText()).toContain(saved)
      }
      expect(f.start).not.toHaveBeenCalled()
      f.graph.composableTurns.endTurn(turn.turnId)
    }
  })

  it.each(['ready', 'inactive-space', 'no-provider', 'layer-off', 'component-off'] as const)('keeps MEMORY.md writable outside a turn when Memory Spaces is %s', async state => {
    const f = await fixture(state)
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
    const result = await f.coordinator.runtime(f.root, { action: 'add', target: 'memory', content: pending }, new AbortController().signal)
    expect((await f.runtimeSnapshot()).entries.map(item => item.content)).toEqual([pending])
    if (state === 'ready') expect(result).toMatchObject({ maintenance: { kind: 'mnemon-archive' } })
    else {
      expect(result).toMatchObject({ maintenance: { kind: 'local-archive', memoryBodyIds: [] } })
      expect(await f.archiveText()).toContain(saved)
    }
    expect(f.start).not.toHaveBeenCalled()
  })

  it.each(['ready', 'inactive-space', 'no-provider', 'layer-off', 'component-off'] as const)('names only what the View offers when Memory Spaces is %s', async state => {
    const f = await fixture(state)
    const turn = await f.begin()
    const offers = turn.view.actionOffers.filter(offer => offer.sourceInstanceKey === spacesKey).map(offer => offer.sourceActionId)
    const system = turn.view.guidance?.system ?? ''
    if (state === 'ready') {
      expect(system).toContain('call mnemon_recall')
      expect(offers).toEqual(expect.arrayContaining(['remember', 'manage-spaces']))
    } else {
      expect(system).not.toContain('mnemon_recall')
      expect(system).toContain('to a local archive file')
    }
    const routing = turn.view.guidance?.routing
    if (state === 'ready') expect(routing).toContain('Call mnemon_recall')
    else if (state === 'inactive-space' || state === 'no-provider') {
      expect(routing).toContain('Search Mnemon Documents for substantial project records')
      expect(routing).not.toContain('mnemon_recall')
    } else expect(routing).toBeUndefined()
    if (state === 'no-provider') expect(offers).toEqual([])
    f.graph.composableTurns.endTurn(turn.turnId)
  })

  it.each(['inactive-space', 'no-provider', 'layer-off', 'component-off'] as const)('archives a Project Document locally, without model work, when Memory Spaces is %s', async state => {
    const f = await fixture(state)
    await f.begin()
    const documents = f.graph.source('documents')
    const created = await documents.mutate<{ document: DocumentView }>('mutate', { action: 'create', title: 'Release checklist', content: 'Run the full verify, then tag the release.' })
    await expect(f.execute('mnemon_document_manage', { action: 'archive', id: created.document.id }))
      .resolves.toMatchObject({ action: 'archived', maintenance: { provider: 'host', memoryBodyIds: [], archivedDocumentIds: [created.document.id] } })
    const archived = await documents.read<DocumentView>('document', { id: created.document.id })
    expect(archived).toMatchObject({ status: 'archived', content: expect.stringContaining('Run the full verify') })
    expect(f.start).not.toHaveBeenCalled()
  })

  it.each(['inactive-space', 'no-provider', 'layer-off', 'component-off'] as const)('makes room in full Project Documents by archiving locally when Memory Spaces is %s', async state => {
    const f = await fixture(state, {}, 1_200)
    await f.begin()
    const documents = f.graph.source('documents')
    const first = await f.execute('mnemon_document_manage', { action: 'create', title: 'First record', content: 'First. '.repeat(100) }) as { document: DocumentView }
    await expect(f.execute('mnemon_document_manage', { action: 'create', title: 'Second record', content: 'Second. '.repeat(90) }))
      .resolves.toMatchObject({ action: 'created', maintenance: { memoryBodyIds: [], archivedDocumentIds: [first.document.id] } })
    expect(await documents.read<DocumentView>('document', { id: first.document.id })).toMatchObject({ status: 'archived', content: expect.stringContaining('First.') })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('keeps every enabled layer writable at its limit in all eight topology combinations', async () => {
    const ids = ['runtime', 'documents', 'memory-spaces'] as const
    for (let mask = 0; mask < 8; mask++) {
      const enabled = (id: typeof ids[number]) => (mask & (1 << ids.indexOf(id))) !== 0
      const f = await fixture(enabled('memory-spaces') ? 'ready' : 'layer-off', { memoryTopology: { layers: Object.fromEntries(ids.map(id => [id, { enabled: enabled(id) }])) } } as Config, 1_200)
      if (enabled('runtime')) await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: saved })
      const turn = await f.begin()
      const runtimeWrite = f.execute('mnemon_runtime_memory', { action: 'add', target: 'memory', content: pending })
      if (enabled('runtime')) {
        await expect(runtimeWrite).resolves.toMatchObject({ added: pending, maintenance: { kind: enabled('memory-spaces') ? 'mnemon-archive' : 'local-archive' } })
      } else await expect(runtimeWrite).rejects.toThrow('Memory Source runtime does not allow')
      const first = f.execute('mnemon_document_manage', { action: 'create', title: 'First record', content: 'First. '.repeat(100) })
      if (enabled('documents')) {
        await first
        if (!enabled('memory-spaces')) {
          await expect(f.execute('mnemon_document_manage', { action: 'create', title: 'Second record', content: 'Second. '.repeat(90) }))
            .resolves.toMatchObject({ action: 'created', maintenance: { memoryBodyIds: [] } })
        }
      } else await expect(first).rejects.toThrow('Memory Source documents does not allow')
      f.graph.composableTurns.endTurn(turn.turnId)
    }
  })
})

describe('Runtime USER tool empty-branch compatibility (issue 281)', () => {
  const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })

  async function fixture(enhanced = false, child = false) {
    const f = await compositionFixture({}, enhanced ? { entryPrefix: 'custom' } : {})
    fixtures.push(f)
    if (enhanced) {
      await f.mount(scoped, { instanceId: 'scoped' })
      await f.mount(lightContext, { instanceId: 'light-context' })
      await f.mount(autoCapture, { instanceId: 'auto-capture' })
    }
    const root = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    const agent = child
      ? { id: 'child', session: { header: { cwd: f.workspace, origin: 'subagent', parentSession: root.id }, ...sessionLog() } } as unknown as HostAgent
      : root
    const tools = new Map<string, ToolDefinition>()
    const coordinator = new MnemonSubagentCoordinator({} as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const turn = await f.graph.composableTurns.beginTurn('root:1', agentScope(root, f.config))
    if (child) f.graph.composableTurns.pinTurn('child:1', agentScope(agent, f.config), turn.view.id)
    const execute = (input: object, name = 'mnemon_runtime_memory') => tools.get(name)!.execute(input as never, { agent, signal: new AbortController().signal })
    const runtime = f.graph.source('runtime')
    const snapshot = () => runtime.read<RuntimeMemorySnapshot>('snapshot')
    return { ...f, execute, runtime, snapshot, turn }
  }

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('adds, replaces and removes USER entries with an empty array (enhanced=%s, child=%s)', async (enhanced, child) => {
    const f = await fixture(enhanced, child)
    const unchanged = 'The synthetic project uses SQLite.'
    await f.runtime.mutate('mutate', { action: 'add', target: 'memory', content: unchanged })
    const base = await f.snapshot()
    await expect(f.execute({ action: 'add', target: 'user', content: 'I prefer concise replies.', branches: [] }))
      .resolves.toMatchObject({ added: 'I prefer concise replies.' })
    await expect(f.execute({ action: 'replace', target: 'user', old_text: 'I prefer concise replies.', content: 'I prefer detailed replies.', importance: 'critical', branches: [] }))
      .resolves.toMatchObject({ replaced: { from: 'I prefer concise replies.', to: 'I prefer detailed replies.' } })
    const changed = await f.snapshot()
    expect(changed.entries.filter(entry => entry.target === 'user')).toEqual([
      expect.objectContaining({ content: 'I prefer detailed replies.', importance: 'critical' }),
    ])
    expect(changed.entries.find(entry => entry.target === 'user')).not.toHaveProperty('branches')
    expect(changed.entries.filter(entry => entry.target === 'memory')).toEqual(base.entries)
    await expect(f.execute({ action: 'remove', target: 'user', old_text: 'I prefer detailed replies.', branches: [] }))
      .resolves.toMatchObject({ removed: 'I prefer detailed replies.' })
    expect((await f.snapshot()).entries).toEqual(base.entries)
  })

  it('keeps omitted USER branches and MEMORY branch preservation, replacement and clearing', async () => {
    const f = await fixture()
    await f.execute({ action: 'add', target: 'user', content: 'I prefer concise replies.' })
    await f.execute({ action: 'add', target: 'memory', content: 'Scoped decision v1.', branches: ['feature/281'] })
    await f.execute({ action: 'replace', target: 'memory', old_text: 'Scoped decision v1.', content: 'Scoped decision v2.' })
    expect((await f.snapshot()).entries.find(entry => entry.target === 'memory')).toMatchObject({ branches: ['feature/281'] })
    await f.execute({ action: 'replace', target: 'memory', old_text: 'Scoped decision v2.', content: 'Scoped decision v3.', branches: ['main'] })
    expect((await f.snapshot()).entries.find(entry => entry.target === 'memory')).toMatchObject({ branches: ['main'] })
    await f.execute({ action: 'replace', target: 'memory', old_text: 'Scoped decision v3.', content: 'Cross-branch decision.', branches: [] })
    expect((await f.snapshot()).entries.find(entry => entry.target === 'memory')).not.toHaveProperty('branches')
  })

  it.each([['feature/281'], [''], ['   '], [null], null, '', { length: 0 }].map(branches => ({ branches })))('rejects invalid USER branches $branches without changing storage', async ({ branches }) => {
    const f = await fixture()
    await f.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Original preference.' })
    const before = await f.snapshot()
    await expect(f.execute({ action: 'replace', target: 'user', old_text: 'Original preference.', content: 'Must not be saved.', branches }))
      .rejects.toThrow(/branches/)
    expect(await f.snapshot()).toMatchObject({ entries: before.entries, revision: before.revision })
  })

  it('keeps Source and generic View action contracts strict for USER branch fields', async () => {
    const f = await fixture(true)
    const input = { action: 'add', target: 'user', content: 'Must not be saved.', branches: [] }
    const before = await f.snapshot()
    await expect(f.runtime.mutate('mutate', input)).rejects.toThrow('branches applies to target=memory only')
    const offer = f.turn.view.actionOffers.find(offer => offer.sourceActionId === 'mutate')!
    await expect(f.execute({ offerId: offer.id, input }, 'mnemon_view_action')).rejects.toThrow('branches applies to target=memory only')
    expect(await f.snapshot()).toMatchObject({ entries: before.entries, revision: before.revision })
  })
})

describe('Mnemon runtime capacity and compaction coordinator', () => {
  afterEach(cleanupSubagentFixtures)
  it('uses bounded routing excerpts, then batch-archives exact sources and commits atomically', async () => {
    const plan = maintenancePlan()
    plan.entries[1]!.content = `发布历史 ${'金丝雀门禁'.repeat(500)}`
    plan.pending = { content: `未提交变更 ${'待'.repeat(2_000)}`, importance: 'normal' }
    const structured = {
      summary: 'Route both committed entries to project memory.',
      action: 'planned',
      routes: [{ sourceIndexes: [1, 2], memoryBodyId: 'project' }],
    }
    const resultTools = toolRegistry()
    const host = subagents(structured)
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({
        success: true,
        message: 'Entry added.',
        target: 'memory',
        entryCount: 2,
        usage: { used: 120, limit: 10_240 },
        added: plan.pending!.content,
      })),
    } as unknown as RuntimeOperations
    const memoryService = service()
    addSecondWritableBody(memoryService)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, resultTools.value)
    const request = { action: 'add', target: 'memory', content: plan.pending!.content } as const

    await expect(coordinator.runtime(parent(), request, new AbortController().signal)).resolves.toMatchObject({
      added: plan.pending.content,
      maintenance: { kind: 'mnemon-archive', provider: 'spawn', memoryBodyIds: ['project'] },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: ['mnemon_subagent_result'] },
      agentOptions: { maxTokens: 8_192 },
    }))
    const migrationCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string; toolFilter: { allow: string[] } }])[1]
    const migrationPrompt = migrationCall.prompt[0]!.text
    expect(migrationPrompt).toContain('Route this bounded MEMORY.md archive batch now')
    expect(migrationPrompt).toContain('Project uses pnpm.')
    expect(migrationPrompt).toContain('发布历史')
    expect(migrationPrompt).toContain('[... host-truncated routing excerpt ...]')
    expect(migrationPrompt).not.toContain(plan.pending.content)
    expect(migrationPrompt).not.toContain(plan.entries[1]!.content)
    expect(migrationPrompt).toContain('id=project')
    expect(migrationPrompt).toContain('id=release')
    expect(migrationPrompt).toContain('<runtime-memory-routing-excerpts>')
    expect(Buffer.byteLength(migrationPrompt, 'utf8')).toBeLessThan(8 * 1024)
    expect(migrationCall.persona).toContain('proposal has no data-plane authority')
    expect(migrationCall.persona).toContain('bulk-imports exact source entries')
    expect(migrationCall.persona).toContain('Excerpts may be host-truncated')
    expect(migrationCall.persona).toContain('USER.md preferences are outside this task and must never enter')
    expect(migrationCall.persona).toContain('Do not call task tools')
    expect(migrationCall.persona).not.toContain('<runtime-memory-routing-excerpts>')
    expect(migrationPrompt).not.toMatch(/catalog_json|runtime_entries_json|pending_mutation_json|current_usage_json|created_at|markdownPath|dbPath/)
    const resultSchema = delegatedResultSchema(migrationCall)
    expect(JSON.stringify(resultSchema)).not.toContain('compactedEntries')
    expect(memoryService.rememberMany).toHaveBeenCalledOnce()
    expect(memoryService.rememberMany).toHaveBeenCalledWith([
      { content: plan.entries[0]!.content, category: 'context', importance: 3, source: 'agent', memoryBodyId: 'project' },
      { content: plan.entries[1]!.content, category: 'context', importance: 5, source: 'agent', memoryBodyId: 'project' },
    ], expect.any(AbortSignal))
    expect(memoryService.remember).not.toHaveBeenCalled()
    expect(memoryService.createBody).not.toHaveBeenCalled()
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(
      plan.revision,
      request,
      plan.entries.map(({ content, importance }) => ({ content, importance })),
      expect.any(Number),
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({ reference: `runtime:${plan.revision}:memory:1` }),
          destination: expect.objectContaining({ layerId: 'memory-spaces', reference: expect.stringContaining('memory-space:project/item:stored-') }),
        }),
      ]),
    )
    expect(runtime.mutate).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ migrations: 1, lastOperation: 'migration' })
  })

  it('completes the dense Chinese capacity reproduction without starting a model worker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-integration-'))
    temporaryDirectories.push(directory)
    const sources = await sourceFixture({ dataDir: directory, workspace: directory })
    releases.push(sources.dispose)
    const runtime = managedSession(sources.runtime)
    const anchor = `项目锚点 ${'a'.repeat(220)}`
    const archived = `历史约束 ${'中'.repeat(2_550)}`
    const pending = `新增约束 ${'文'.repeat(2_550)}`
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content: anchor })
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content: archived })
    const host = subagents(undefined)
    const memoryService = service()
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: pending }, new AbortController().signal)).resolves.toMatchObject({
      added: pending,
      maintenance: { kind: 'mnemon-archive', provider: 'host', memoryBodyIds: ['project'] },
    })
    expect(host.start).not.toHaveBeenCalled()
    expect(memoryService.rememberMany).toHaveBeenCalledOnce()
    expect(vi.mocked(memoryService.rememberMany).mock.calls[0]![0].map(request => request.content)).toEqual([anchor, archived])
    expect(memoryService.remember).not.toHaveBeenCalled()
    expect((await runtime.read<RuntimeMemorySnapshot>('snapshot')).entries.map(entry => entry.content)).toEqual([pending])
    expect(coordinator.snapshot()).toMatchObject({ migrations: 1, lastOperation: 'migration', lastRunId: expect.stringMatching(/^host-/) })
  })

  it('archives locally, without model work, when no Memory Space can receive an archive (issue 336)', async () => {
    const plan = maintenancePlan()
    const host = subagents(undefined)
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'memory', entryCount: 2, usage: { used: 64, limit: plan.limit },
        added: plan.pending!.content, archived: { entries: 1, path: '/data/runtime/archived/MEMORY.md' } })),
    } as unknown as RuntimeOperations
    const memoryService = service()
    vi.mocked(memoryService.bodyDirectory).mockReturnValue({
      ...memoryService.bodyDirectory(),
      items: [],
      total: 0,
      activeCount: 0,
    })
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({ added: plan.pending!.content, maintenance: { kind: 'local-archive', provider: 'host', memoryBodyIds: [],
        summary: expect.stringContaining('Moved 1 MEMORY.md entry to the local archive /data/runtime/archived/MEMORY.md, since Memory Space body-directory is empty') } })
    // The exact committed entries go to the Runtime Source, which archives what compaction leaves out.
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(plan.revision, expect.objectContaining({ action: 'add' }),
      plan.entries.map(({ content, importance }) => ({ content, importance })), expect.any(Number), undefined, 'local')
    expect(host.start).not.toHaveBeenCalled()
    expect(memoryService.rememberMany).not.toHaveBeenCalled()
    expect(memoryService.remember).not.toHaveBeenCalled()
  })

  it('refuses rather than archive locally through a Runtime Source that cannot (issue 336)', async () => {
    // A Runtime Source from before the local archive plans without saying it can keep what compaction leaves out.
    const { localArchive: _localArchive, ...plan } = maintenancePlan()
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeOperations
    const memoryService = service()
    vi.mocked(memoryService.bodyDirectory).mockReturnValue({ ...memoryService.bodyDirectory(), items: [], total: 0, activeCount: 0 })
    const coordinator = new MnemonSubagentCoordinator(subagents(undefined).value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)
    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('this Runtime Source cannot archive locally; pending write was not committed and existing runtime entries are unchanged')
    expect(runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('refuses rather than archive locally while another Memory Spaces Source could take the archive (issue 336)', async () => {
    const plan = maintenancePlan()
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeOperations
    // The default Memory Spaces Source has no space; another one has a space that could take the archive.
    const empty = service()
    vi.mocked(empty.bodyDirectory).mockReturnValue({ ...empty.bodyDirectory(), items: [], total: 0, activeCount: 0 })
    const source = runtimeSource(runtime, empty)
    const graph = source.forAgent(parent())
    const own = graph.source('memory-spaces', {} as never)
    const other = runtimeSource(runtime, service()).forAgent(parent()).source('memory-spaces', {} as never)
    const extraKey = 'source:extra:mnemon-source-memory-spaces'
    const generation = { strategy: { definition: { manifest: { typeId: graph.config.memoryTopology.strategyId } } }, sourceInstances: () => [
      { sourceInstanceKey: 'source:mnemon-source-memory-spaces', sourceTypeId: 'memory-spaces' },
      { sourceInstanceKey: extraKey, sourceTypeId: 'memory-spaces' },
    ] }
    const original = graph.source.bind(graph)
    const spaces = { ...own, forGeneration() { return this }, forInstance: (key: string) => key === extraKey ? other : spaces }
    Object.assign(graph, {
      memoryComposition: { generation: () => generation, acquire: () => ({ generation, release: () => {} }) },
      source: (type: string, scope?: never) => type === 'memory-spaces' ? spaces : original(type, scope),
    })
    vi.mocked(source.forAgent).mockReturnValue(graph)
    await expect(new MnemonSubagentCoordinator(subagents(undefined).value, source as never, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('runtime memory archival requires an existing active writable Memory Space')
    expect(runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it.each(['async-extracting', 'no-forget'])('never archives into an unsafe destination; archives locally instead (issues 240, 336): %s', async capability => {
    const plan = maintenancePlan()
    const runtime = {
      mutate: vi.fn().mockRejectedValue(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'memory', entryCount: 2, usage: { used: 64, limit: plan.limit },
        added: plan.pending!.content, archived: { entries: 1, path: '/data/runtime/archived/MEMORY.md' } })),
    } as unknown as RuntimeOperations
    const spaces = service()
    const body = spaces.bodyDirectory().items[0]!
    if (capability === 'async-extracting') body.provider.capabilities.writeMode = 'async-extracting'
    else body.provider.capabilities.forget = false
    vi.mocked(spaces.rememberMany).mockImplementation(async requests => requests.map(() => ({ action: 'queued', operationId: 'accepted-before-error' })))
    const host = subagents(undefined)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, spaces), toolRegistry().value)
    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({ maintenance: { kind: 'local-archive', summary: expect.stringContaining('authorized destinations lack exact writes or safe forget') } })
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(plan.revision, expect.anything(), expect.anything(), expect.any(Number), undefined, 'local')
    expect(spaces.rememberMany).not.toHaveBeenCalled()
    expect(spaces.forget).not.toHaveBeenCalled()
    expect(host.start).not.toHaveBeenCalled()
  })

  it('uses only the safe destination in a mixed exact and async Provider catalog', async () => {
    const f = runtimeArchiveFixture()
    addSecondWritableBody(f.spaces)
    f.spaces.bodyDirectory().items[1]!.provider = { ...f.spaces.bodyDirectory().items[1]!.provider,
      id: 'hindsight', capabilities: { ...f.spaces.bodyDirectory().items[1]!.provider.capabilities, writeMode: 'async-extracting' } }
    await expect(f.archive()).resolves.toMatchObject({ maintenance: { memoryBodyIds: ['project'], provider: 'host' } })
    expect(vi.mocked(f.spaces.rememberMany).mock.calls.flatMap(([requests]) => requests.map(item => item.memoryBodyId))).toEqual(['project', 'project'])
    expect(f.host.start).not.toHaveBeenCalled()
  })

  it('rechecks every destination before starting the first archive write', async () => {
    const f = runtimeArchiveFixture()
    const catalog = f.spaces.bodyDirectory()
    vi.mocked(f.spaces.bodyDirectory).mockReturnValueOnce(catalog).mockReturnValue({ ...catalog, items: [] })
    await expect(f.archive()).rejects.toThrow('no longer eligible; no archive writes were attempted')
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
  })

  it('reports an actual archive failure and the earlier missing-result fallback together (#641)', async () => {
    const f = runtimeArchiveFixture()
    addSecondWritableBody(f.spaces)
    f.host.start.mockResolvedValueOnce({ id: 'router-without-result', result: Promise.resolve({ output: [], stopReason: 'completed', structured: undefined }), dispose: vi.fn(async () => {}) })
    vi.mocked(f.spaces.rememberMany).mockRejectedValueOnce({ message: 'Archive backend is busy; retry later.', code: 'busy', privateTranscript: 'PRIVATE-SYNTHETIC-CONTENT' })
    const error = await f.archive().then(() => undefined, error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Runtime capacity exceeded')
    expect(error?.message).toContain('Archive backend is busy; retry later.')
    expect(error?.message).toContain('memory subagent completed without recording its result')
    expect(error?.message).not.toMatch(/\[object Object\]|PRIVATE-SYNTHETIC-CONTENT/u)
    expect(f.runtime.compactAndMutate).not.toHaveBeenCalled()
    expect(f.spaces.forget).not.toHaveBeenCalled()
  })

  it('keeps missing routing results recoverable and visible in a successful receipt (#641)', async () => {
    const f = runtimeArchiveFixture()
    addSecondWritableBody(f.spaces)
    f.host.start.mockResolvedValueOnce({ id: 'router-without-result', result: Promise.resolve({ output: [], stopReason: 'completed', structured: undefined }), dispose: vi.fn(async () => {}) })
    await expect(f.archive()).resolves.toMatchObject({ success: true, maintenance: {
      memoryBodyIds: ['project'], summary: expect.stringContaining('routing failed: memory subagent completed without recording its result'),
    } })
    expect(vi.mocked(f.spaces.rememberMany).mock.calls.flatMap(([requests]) => requests.map(value => value.content))).toEqual(f.plan.entries.map(value => value.content))
    expect(f.runtime.compactAndMutate).toHaveBeenCalledOnce()
  })

  it('normalizes a structured refusal without attempting capacity maintenance (#641)', async () => {
    const f = runtimeArchiveFixture()
    vi.mocked(f.runtime.mutate).mockRejectedValueOnce({ code: 'read-only', message: 'Memory is read-only.' })
    const error = await f.archive().then(() => undefined, error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('Memory is read-only.')
    expect(f.runtime.planMaintenance).not.toHaveBeenCalled()
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
  })

  it('reconstructs capacity context when JSON serialization removes Error.message (#641)', async () => {
    const f = runtimeArchiveFixture()
    vi.mocked(f.runtime.mutate).mockRejectedValueOnce(JSON.parse(JSON.stringify(capacityError('memory', f.plan.used, f.plan.projected, f.plan.limit))))
    vi.mocked(f.spaces.rememberMany).mockRejectedValueOnce({ message: 'Archive is unavailable.' })
    await expect(f.archive()).rejects.toThrow(`Runtime memory capacity exceeded: ${f.plan.projected} bytes (current ${f.plan.used}, limit ${f.plan.limit})`)
    expect(f.runtime.planMaintenance).toHaveBeenCalled()
    expect(f.runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('preserves structured cancellation without writing or dumping the reason object (#641)', async () => {
    const f = runtimeArchiveFixture()
    const abort = new AbortController()
    abort.abort({ message: 'User cancelled capacity maintenance.', privateContext: 'PRIVATE-SYNTHETIC-CONTENT' })
    const error = await f.archive(abort.signal).then(() => undefined, error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'AbortError', message: 'User cancelled capacity maintenance.' })
    expect(f.runtime.mutate).not.toHaveBeenCalled()
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
  })

  it('redacts structured routing diagnostics when a later archive write fails (#641)', async () => {
    const f = runtimeArchiveFixture()
    addSecondWritableBody(f.spaces)
    f.host.start.mockRejectedValueOnce({ message: 'Router rejected sk-synthetic-secret-12345', transcript: 'PRIVATE-SYNTHETIC-CONTENT' })
    vi.mocked(f.spaces.rememberMany).mockRejectedValueOnce(new Error('Archive unavailable'))
    const error = await f.archive().then(() => undefined, error => error as Error)
    expect(error?.message).toContain('Archive unavailable')
    expect(error?.message).toContain('Router rejected [redacted]')
    expect(error?.message).not.toMatch(/sk-synthetic|PRIVATE-SYNTHETIC-CONTENT|\[object Object\]/u)
    expect(f.runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('rechecks the fallback destination when an invalid routing response follows deactivation', async () => {
    const f = runtimeArchiveFixture()
    addSecondWritableBody(f.spaces)
    f.host.start.mockImplementationOnce(async () => {
      f.spaces.bodyDirectory().items[0]!.active = false
      return { id: 'invalid-after-deactivation', result: Promise.resolve({ output: [], stopReason: 'completed', structured: {
        action: 'planned', summary: 'Invalid routing after destination deactivation.', routes: [],
      } }), dispose: vi.fn(async () => {}) }
    })
    await expect(f.archive()).rejects.toThrow('no longer eligible; no archive writes were attempted')
    expect(f.host.start).toHaveBeenCalledOnce()
    expect(f.spaces.rememberMany).not.toHaveBeenCalled()
    expect(f.runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('cleans every proven-new receipt when a later archive receipt is invalid', async () => {
    const f = runtimeArchiveFixture()
    vi.mocked(f.spaces.rememberMany).mockResolvedValueOnce([
      { action: 'added', id: 'new-index', memoryBodyId: 'project' },
      { action: 'queued', operationId: 'unknown-index', memoryBodyId: 'project' },
    ])
    await expect(f.archive()).rejects.toThrow('did not commit synchronously')
    expect(f.spaces.forget).toHaveBeenCalledExactlyOnceWith('new-index', expect.any(AbortSignal), 'project')
    expect(f.runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('compensates an earlier destination when a later Provider write throws', async () => {
    const f = runtimeArchiveFixture()
    addSecondWritableBody(f.spaces)
    f.host.start.mockResolvedValueOnce({ id: 'two-spaces', result: Promise.resolve({ output: [], stopReason: 'completed', structured: {
      action: 'planned', summary: 'Split archive.', routes: [{ sourceIndexes: [1], memoryBodyId: 'project' }, { sourceIndexes: [2], memoryBodyId: 'release' }],
    } }), dispose: vi.fn(async () => {}) })
    vi.mocked(f.spaces.rememberMany).mockResolvedValueOnce([{ action: 'added', id: 'first-destination', memoryBodyId: 'project' }]).mockRejectedValueOnce(new Error('later Provider unavailable'))
    await expect(f.archive()).rejects.toThrow('later Provider unavailable')
    expect(f.spaces.forget).toHaveBeenCalledExactlyOnceWith('first-destination', expect.any(AbortSignal), 'project')
    expect(f.runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('cleans new entries after local commit failure but preserves skipped pre-existing entries', async () => {
    const f = runtimeArchiveFixture()
    vi.mocked(f.spaces.rememberMany).mockResolvedValueOnce([
      { action: 'skipped', id: 'pre-existing', memoryBodyId: 'project' },
      { action: 'added', id: 'new-index', memoryBodyId: 'project' },
    ])
    vi.mocked(f.spaces.search).mockResolvedValueOnce({ query: '', mode: 'smart', results: [{ id: 'pre-existing', content: f.plan.entries[0]!.content, memoryBodyId: 'project' } as Insight] })
    vi.mocked(f.runtime.compactAndMutate).mockRejectedValueOnce(new Error('local commit failed'))
    await expect(f.archive()).rejects.toThrow('local commit failed')
    expect(f.spaces.forget).toHaveBeenCalledExactlyOnceWith('new-index', expect.any(AbortSignal), 'project')
  })

  it('cleans received entries with an independent signal when the caller cancels', async () => {
    const f = runtimeArchiveFixture()
    const abort = new AbortController()
    vi.mocked(f.spaces.rememberMany).mockImplementationOnce(async requests => {
      abort.abort(new Error('caller canceled'))
      return requests.map((_request, index) => ({ action: 'added', id: `new-${index}`, memoryBodyId: 'project' }))
    })
    await expect(f.archive(abort.signal)).rejects.toThrow('caller canceled')
    expect(f.spaces.forget).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.spaces.forget).mock.calls.every(([, signal]) => signal?.aborted === false)).toBe(true)
  })

  it('reports failed cleanup and still attempts the remaining created entries', async () => {
    const f = runtimeArchiveFixture()
    vi.mocked(f.runtime.compactAndMutate).mockRejectedValueOnce(new Error('local commit failed'))
    vi.mocked(f.spaces.forget).mockRejectedValueOnce(new Error('cleanup unavailable'))
    await expect(f.archive()).rejects.toThrow(/cleanup failed.*project.*stored-/)
    expect(f.spaces.forget).toHaveBeenCalledTimes(2)
  })

  it.each(['changed', 'unavailable'])('preserves archive entries when the local commit outcome is uncertain: %s', async state => {
    const f = runtimeArchiveFixture()
    vi.mocked(f.runtime.compactAndMutate).mockRejectedValueOnce(new Error('transport failed after commit'))
    vi.mocked(f.runtime.planMaintenance).mockResolvedValueOnce(f.plan).mockResolvedValueOnce(f.plan)
    if (state === 'changed') vi.mocked(f.runtime.planMaintenance).mockResolvedValueOnce({ ...f.plan, revision: 'committed-revision' })
    else vi.mocked(f.runtime.planMaintenance).mockRejectedValueOnce(new Error('runtime unavailable'))
    await expect(f.archive()).rejects.toThrow('uncertain local commit; preserve Memory Space entries')
    expect(f.spaces.forget).not.toHaveBeenCalled()
  })

  it('compensates real composed Runtime and Holographic Sources after local commit failure', async () => {
    const f = await compositionFixture({ runtimeMemory: { memoryLimitBytes: 300 } })
    releases.push(f.dispose)
    const body = await f.memorySpace()
    const spaces = f.graph.source('memory-spaces')
    await spaces.mutate('body-update', { memoryBodyId: body.id, request: { active: true } })
    const runtime = f.graph.source('runtime')
    const content = 'Archive source: ' + 'Keep the source intact. '.repeat(8)
    await runtime.mutate('mutate', { action: 'add', target: 'memory', content })
    const before = await runtime.read<RuntimeMemorySnapshot>('snapshot')
    const coordinator = new MnemonSubagentCoordinator(subagents(undefined).value, f.live, toolRegistry().value)
    const agent = { ...parent(), session: { header: { cwd: f.workspace }, ...sessionLog() } } as HostAgent
    const original = SourceSession.prototype.mutateResult
    const failCommit = vi.spyOn(SourceSession.prototype, 'mutateResult').mockImplementation(function (this: SourceSession, operation, input, signal) {
      if (this.typeId === 'runtime' && operation === 'compact-and-mutate') return Promise.reject(new Error('injected local commit failure'))
      return original.call(this, operation, input, signal)
    })
    try {
      await expect(coordinator.runtime(agent, { action: 'add', target: 'memory', content: 'Pending entry: ' + 'Preserve exact facts. '.repeat(5) }, new AbortController().signal)).rejects.toThrow('injected local commit failure')
    } finally { failCommit.mockRestore() }
    expect((await runtime.read<RuntimeMemorySnapshot>('snapshot')).revision).toBe(before.revision)
    const recalled = await spaces.read<{ results: Insight[] }>('search', { query: 'Archive source', memoryBodyIds: [body.id] })
    expect(recalled.results).toEqual([])
  })

  it('enforces automatic Memory Space write participation before capacity archival, archiving locally instead (issue 336)', async () => {
    const plan = maintenancePlan()
    const host = subagents(undefined)
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'memory', entryCount: 2, usage: { used: 64, limit: plan.limit },
        added: plan.pending!.content, archived: { entries: 1, path: '/data/runtime/archived/MEMORY.md' } })),
    } as unknown as RuntimeOperations
    const memoryService = service()
    const source = runtimeSource(runtime, memoryService)
    const graph = source.forAgent(parent())
    graph.config.memoryTopology.layers['memory-spaces']!.participation.write = 'manual'
    vi.mocked(source.forAgent).mockReturnValue(graph)

    // Memory Spaces take no automatic writes, so working memory makes room locally.
    await expect(new MnemonSubagentCoordinator(host.value, source as never, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({ added: plan.pending!.content, maintenance: { kind: 'local-archive', memoryBodyIds: [] } })
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(plan.revision, expect.anything(), expect.anything(), expect.any(Number), undefined, 'local')
    expect(host.start).not.toHaveBeenCalled()
    expect(memoryService.rememberMany).not.toHaveBeenCalled()
    expect(memoryService.remember).not.toHaveBeenCalled()
  })

  it.each([
    { action: 'planned', summary: 'Incomplete route.', routes: [{ sourceIndexes: [1], memoryBodyId: 'release' }] },
    { action: 'planned', summary: 'No routes.', routes: [] },
    { action: 'planned', summary: 'Unknown target.', routes: [{ sourceIndexes: [1, 2], memoryBodyId: 'invented' }] },
    { action: 'planned', summary: 'Empty target.', routes: [{ sourceIndexes: [1, 2], memoryBodyId: ' ' }] },
    { action: 'planned', summary: 'No indexes.', routes: [{ sourceIndexes: [], memoryBodyId: 'release' }] },
    { action: 'planned', summary: 'Duplicate indexes.', routes: [{ sourceIndexes: [1, 1, 2], memoryBodyId: 'release' }] },
    { action: 'planned', summary: 'Cross-route duplicate.', routes: [{ sourceIndexes: [1], memoryBodyId: 'release' }, { sourceIndexes: [1, 2], memoryBodyId: 'project' }] },
    { action: 'planned', summary: 'Out of range.', routes: [{ sourceIndexes: [1, 3], memoryBodyId: 'release' }] },
    { action: 'failed', summary: 'Router cannot choose.', routes: [] },
    { action: 'planned', summary: 'Noninteger.', routes: [{ sourceIndexes: [1, 2.5], memoryBodyId: 'release' }] },
  ])('falls back for invalid runtime routing output (issue 235): $summary', async proposal => {
    const plan = maintenancePlan()
    const host = subagents(proposal)
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, target: 'memory', added: plan.pending!.content, usage: { used: 20, limit: plan.limit } })),
    } as unknown as RuntimeOperations
    const memoryService = service()
    addSecondWritableBody(memoryService)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({ added: plan.pending!.content, maintenance: { memoryBodyIds: ['project'], summary: expect.stringContaining('routed to project deterministically') } })
    expect(vi.mocked(memoryService.rememberMany).mock.calls.flatMap(([requests]) => requests.map(item => item.memoryBodyId))).toEqual(['project', 'project'])
    expect(memoryService.remember).not.toHaveBeenCalled()
    expect(runtime.compactAndMutate).toHaveBeenCalledOnce()
  })

  it('preserves earlier valid routes when a later chunk restarts its source indexes', async () => {
    const plan = maintenancePlan('memory', [
      { content: 'First source ' + 'a'.repeat(500), importance: 'normal' },
      { content: 'Second source ' + 'b'.repeat(500), importance: 'normal' },
      { content: 'Third source ' + 'c'.repeat(500), importance: 'critical' },
    ])
    const host = subagents({ action: 'planned', summary: 'Local numbering.', routes: [{ sourceIndexes: [1], memoryBodyId: 'release' }] })
    host.start.mockResolvedValueOnce({ id: 'first-valid', result: Promise.resolve({ output: [], stopReason: 'completed', structured: {
      action: 'planned', summary: 'Valid first chunk.', routes: [{ sourceIndexes: [1, 2], memoryBodyId: 'release' }],
    } }), dispose: vi.fn(async () => {}) })
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, target: 'memory', added: plan.pending!.content, usage: { used: 20, limit: plan.limit } })),
    } as unknown as RuntimeOperations
    const spaces = service()
    addSecondWritableBody(spaces)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, spaces), toolRegistry().value)
    const result = await coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal)
    expect(result.maintenance?.summary).toContain('batch 2 routed to project deterministically')
    expect(vi.mocked(spaces.rememberMany).mock.calls.flatMap(([requests]) => requests.map(item => ({ content: item.content, memoryBodyId: item.memoryBodyId })))).toEqual(
      plan.entries.map((entry, index) => ({ content: entry.content, memoryBodyId: index < 2 ? 'release' : 'project' })),
    )
    expect(runtime.compactAndMutate).toHaveBeenCalledOnce()
    expect(host.start).toHaveBeenCalledTimes(2)
    const prompts = (host.start.mock.calls as unknown as Array<[string, { prompt: Array<{ text: string }> }]>).map(([, call]) => call.prompt[0]!.text)
    expect(prompts[1]).toContain('Allowed source indexes for this batch: 3. Keep these global indexes; never restart numbering.')
    for (const prompt of prompts) {
      const excerpt = prompt.split('<runtime-memory-routing-excerpts>\n')[1]!.split('\n</runtime-memory-routing-excerpts>')[0]!
      for (const entry of excerpt.split('\n§\n')) expect(entry.replace(/^\d+\. \[importance=\w+\] /, '').length).toBeLessThanOrEqual(384)
    }
  })

  it('deterministically routes to the default store when the routing model fails, then still commits the archive', async () => {
    const plan = maintenancePlan()
    const host = subagents(undefined, 'max-tokens')
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({
        success: true,
        message: 'Entry added.',
        target: 'memory',
        entryCount: 2,
        usage: { used: 120, limit: 10_240 },
        added: plan.pending!.content,
      })),
    } as unknown as RuntimeOperations
    const memoryService = service()
    addSecondWritableBody(memoryService)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({
        added: plan.pending!.content,
        // 模型路由失败后，归档仍以 host 兜底完成，不再整体中止。
        maintenance: { kind: 'mnemon-archive', memoryBodyIds: ['project'] },
      })
    expect(host.start).toHaveBeenCalledOnce()
    // 两条待归档条目全部确定性落到第一个 eligible body（project），Provider 仍收到完整原文。
    expect(memoryService.rememberMany).toHaveBeenCalledOnce()
    expect(vi.mocked(memoryService.rememberMany).mock.calls[0]![0].map(request => request.memoryBodyId)).toEqual(['project', 'project'])
    expect(memoryService.remember).not.toHaveBeenCalled()
    expect(runtime.compactAndMutate).toHaveBeenCalledOnce()
  })

  it('does not turn caller cancellation into deterministic archive fallback', async () => {
    const plan = maintenancePlan()
    const controller = new AbortController()
    const host = subagents(undefined, 'max-tokens')
    host.start.mockImplementationOnce(async () => {
      controller.abort()
      return {
        id: 'child-run-1',
        result: Promise.resolve({ output: [], structured: undefined, stopReason: 'max-tokens' }),
        dispose: vi.fn(async () => {}),
      }
    })
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeOperations
    const memoryService = service()
    addSecondWritableBody(memoryService)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(memoryService.rememberMany).not.toHaveBeenCalled()
    expect(runtime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('reports a later successful routing batch without double-counting migration', async () => {
    const plan = maintenancePlan('memory', [
      { content: `Project detail ${'a'.repeat(400)}`, importance: 'normal' },
      { content: `Project history ${'b'.repeat(400)}`, importance: 'normal' },
      { content: `Release gate ${'c'.repeat(400)}`, importance: 'critical' },
    ])
    const host = subagents({
      summary: 'Route the release gate to release memory.',
      action: 'planned',
      routes: [{ sourceIndexes: [3], memoryBodyId: 'release' }],
    })
    host.start.mockResolvedValueOnce({
      id: 'failed-run-1',
      result: Promise.resolve({ output: [], structured: undefined, stopReason: 'max-tokens' }),
      dispose: vi.fn(async () => {}),
    })
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({
        success: true,
        target: 'memory',
        added: plan.pending!.content,
        usage: { used: 20, limit: 10_240 },
      })),
    } as unknown as RuntimeOperations
    const memoryService = service()
    addSecondWritableBody(memoryService)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({
        maintenance: {
          kind: 'mnemon-archive',
          provider: 'spawn',
          runId: 'child-run-1',
          memoryBodyIds: ['project', 'release'],
        },
      })
    expect(host.start).toHaveBeenCalledTimes(2)
    expect(vi.mocked(memoryService.rememberMany).mock.calls.flatMap(([requests]) => requests.map(request => request.memoryBodyId)))
      .toEqual(['project', 'project', 'release'])
    expect(coordinator.snapshot()).toMatchObject({
      migrations: 1,
      failures: 1,
      lastRunId: 'child-run-1',
      lastOperation: 'migration',
    })
  })

  it('accepts a skipped archive write only after exact Host recall verification', async () => {
    const sourceEntry = { content: 'Use SQLite for local storage.', importance: 'normal' as const }
    const plan = maintenancePlan('memory', [sourceEntry])
    const host = subagents({
      summary: 'Route existing SQLite fact.',
      action: 'planned',
      routes: [{ sourceIndexes: [1], memoryBodyId: 'project' }],
    })
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, target: 'memory', added: plan.pending!.content, usage: { used: 20, limit: 10_240 } })),
    } as unknown as RuntimeOperations
    const memoryService = service()
    vi.mocked(memoryService.rememberMany).mockResolvedValueOnce([{ action: 'skipped', memoryBodyId: 'project' }])
    vi.mocked(memoryService.search).mockResolvedValueOnce({
      query: sourceEntry.content,
      mode: 'smart',
      results: [{ id: 'sqlite-1', content: sourceEntry.content, memoryBodyId: 'project', memoryBodyName: 'Project' }],
    } as never)
    const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({ maintenance: { kind: 'mnemon-archive', memoryBodyIds: ['project'] } })
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(plan.revision, expect.any(Object), [sourceEntry], expect.any(Number), [{
      source: {
        layerId: 'runtime',
        reference: `runtime:${plan.revision}:memory:1`,
        digest: createHash('sha256').update(JSON.stringify(sourceEntry)).digest('hex'),
      },
      destination: {
        layerId: 'memory-spaces',
        reference: 'memory-space:project/item:sqlite-1',
        digest: createHash('sha256').update(sourceEntry.content).digest('hex'),
      },
    }])
  })

  it('takes a skipped receipt that names the exact stored memory as its evidence, without a search', async () => {
    // Issue #339: earlier attempts left exact copies; a ranked search missed one of them every time.
    const entries = [
      { content: 'Use SQLite for local storage.', importance: 'normal' as const },
      { content: 'Release notes list blockers first.', importance: 'critical' as const },
      { content: 'Builds run on Node 24.', importance: 'normal' as const },
    ]
    const plan = maintenancePlan('memory', entries)
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, target: 'memory', added: plan.pending!.content, usage: { used: 20, limit: 10_240 } })),
    } as unknown as RuntimeOperations
    const memoryService = service()
    // As Mnemon Native answers: the two stored copies are named, the third is imported.
    vi.mocked(memoryService.rememberMany).mockResolvedValueOnce([
      { action: 'skipped', id: 'sqlite-1', content: entries[0]!.content, memoryBodyId: 'project' },
      { action: 'skipped', id: 'release-1', content: entries[1]!.content, memoryBodyId: 'project' },
      { action: 'added', id: 'node-1', content: entries[2]!.content, memoryBodyId: 'project' },
    ])
    vi.mocked(memoryService.search).mockResolvedValue({ query: '', mode: 'smart', results: [] } as never)
    const coordinator = new MnemonSubagentCoordinator(subagents(undefined).value, runtimeSource(runtime, memoryService) as never, toolRegistry().value)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .resolves.toMatchObject({ maintenance: { kind: 'mnemon-archive', memoryBodyIds: ['project'] } })
    expect(memoryService.search).not.toHaveBeenCalled()
    expect(memoryService.forget).not.toHaveBeenCalled()
    const lineage = vi.mocked(runtime.compactAndMutate).mock.calls[0]![4] as Array<{ destination: { reference: string; digest: string } }>
    expect(lineage.map(item => item.destination)).toEqual(['sqlite-1', 'release-1', 'node-1'].map((id, index) => ({
      layerId: 'memory-spaces',
      reference: `memory-space:project/item:${id}`,
      digest: createHash('sha256').update(entries[index]!.content).digest('hex'),
    })))
  })

  it('still searches when a skipped receipt does not carry the exact text, and says what the search found', async () => {
    const sourceEntry = { content: 'Use SQLite for local storage.', importance: 'normal' as const }
    const plan = maintenancePlan('memory', [sourceEntry, { content: 'Builds run on Node 24.', importance: 'normal' as const }])
    const runtime = () => ({
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    }) as unknown as RuntimeOperations
    const receipts = [
      // A semantic match is not an exact copy of the runtime entry.
      { action: 'skipped', id: 'sqlite-1', content: 'Use SQLite.', memoryBodyId: 'project' },
      { action: 'added', id: 'node-1', content: 'Builds run on Node 24.', memoryBodyId: 'project' },
    ]

    const missing = service()
    vi.mocked(missing.rememberMany).mockResolvedValueOnce(receipts)
    vi.mocked(missing.search).mockResolvedValueOnce({ query: '', mode: 'smart', results: [{ id: 'sqlite-1', content: 'Use SQLite.', memoryBodyId: 'project' }] } as never)
    const missingRuntime = runtime()
    await expect(new MnemonSubagentCoordinator(subagents(undefined).value, runtimeSource(missingRuntime, missing) as never, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('without exact durable recall evidence in Memory Space project: its search returned 1 results, none with that exact text')
    expect(missing.search).toHaveBeenCalledOnce()
    // The entry this attempt created is removed again; the runtime file is unchanged.
    expect(missing.forget).toHaveBeenCalledWith('node-1', expect.anything(), 'project')
    expect(missingRuntime.compactAndMutate).not.toHaveBeenCalled()

    const offline = service()
    vi.mocked(offline.rememberMany).mockResolvedValueOnce(receipts)
    vi.mocked(offline.search).mockResolvedValueOnce({ query: '', mode: 'smart', results: [], sources: [{ status: 'unavailable', hint: 'mnemon recall did not respond within 10000ms' }] } as never)
    await expect(new MnemonSubagentCoordinator(subagents(undefined).value, runtimeSource(runtime(), offline) as never, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('its search was unavailable (mnemon recall did not respond within 10000ms)')
  })

  it('checks revision again before Provider writes and rejects asynchronous acceptance', async () => {
    const plan = maintenancePlan('memory', [{ content: 'Use pnpm.', importance: 'normal' }])
    const structured = {
      summary: 'Route pnpm fact.',
      action: 'planned',
      routes: [{ sourceIndexes: [1], memoryBodyId: 'project' }],
    }
    const staleRuntime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, revision: 'concurrent-revision' }),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeOperations
    const staleService = service()
    await expect(new MnemonSubagentCoordinator(subagents(structured).value, runtimeSource(staleRuntime, staleService) as never, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('no archive writes were attempted')
    expect(staleService.rememberMany).not.toHaveBeenCalled()
    expect(staleService.remember).not.toHaveBeenCalled()

    const queuedRuntime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('memory', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeOperations
    const queuedService = service()
    vi.mocked(queuedService.rememberMany).mockResolvedValueOnce([{ action: 'queued', status: 'pending', taskId: 'task-slow', memoryBodyId: 'project' }])
    await expect(new MnemonSubagentCoordinator(subagents(structured).value, runtimeSource(queuedRuntime, queuedService) as never, toolRegistry().value)
      .runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, new AbortController().signal))
      .rejects.toThrow('did not commit synchronously')
    expect(queuedRuntime.compactAndMutate).not.toHaveBeenCalled()
  })

  it('compacts USER.md locally with complete source coverage and never grants Mnemon tools', async () => {
    const host = subagents({
      summary: 'Merged two compatible profile preferences locally.',
      action: 'compacted',
      compactedEntries: [{
        content: 'User prefers concise Chinese release notes with blockers first.',
        importance: 'critical',
        sourceIndexes: [1, 2],
      }],
    })
    const plan = maintenancePlan('user', [
      { content: 'User prefers concise {{language}} Chinese release notes.', importance: 'critical' },
      { content: 'User wants blockers listed first in release notes.', importance: 'normal' },
    ])
    plan.revision = 'user-revision'
    plan.pending = { content: 'User prefers direct answers.', importance: 'normal' }
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('user', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(async () => ({ success: true, message: 'Entry added.', target: 'user', entryCount: 2, usage: { used: 180, limit: 4_096 }, added: plan.pending!.content })),
    } as unknown as RuntimeOperations
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'User prefers direct answers.' }, new AbortController().signal)).resolves.toMatchObject({
      added: 'User prefers direct answers.',
      maintenance: { kind: 'local-compaction', memoryBodyIds: [] },
    })
    expect(host.start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      toolFilter: { allow: ['mnemon_subagent_result'] },
      agentOptions: { maxTokens: 8_192 },
      persona: expect.stringContaining('local USER.md compactor'),
    }))
    const compactionCall = (host.start.mock.calls[0] as unknown as [string, { prompt: Array<{ text: string }>; persona: string }])[1]
    const compactionPrompt = compactionCall.prompt[0]!.text
    expect(compactionPrompt).toContain('Run local USER.md compaction now')
    expect(compactionPrompt).toContain('User prefers direct answers.')
    expect(compactionPrompt).toContain('User prefers concise {{language}} Chinese release notes.')
    expect(compactionPrompt).toContain('Committed USER.md snapshot (read-only run data; numbering is one-based):\n<runtime-memory-snapshot target="user">')
    expect(compactionCall.persona).toContain('never send user preferences to Mnemon Memory Spaces')
    expect(compactionCall.persona).toContain('every source number must appear exactly once')
    expect(compactionCall.persona).not.toContain('{{language}}')
    expect(compactionCall.persona).not.toContain('<runtime-memory-snapshot')
    expect(runtime.compactAndMutate).toHaveBeenCalledWith(
      'user-revision',
      { action: 'add', target: 'user', content: 'User prefers direct answers.' },
      [{ content: 'User prefers concise Chinese release notes with blockers first.', importance: 'critical' }],
      expect.any(Number),
      undefined,
    )
    expect(runtime.mutate).toHaveBeenCalledOnce()
    expect(coordinator.snapshot()).toMatchObject({ compactions: 1, migrations: 0, lastOperation: 'compaction' })
  })

  it('rejects a USER.md compaction that omits any committed source entry', async () => {
    const host = subagents({
      summary: 'Incomplete candidate.',
      action: 'compacted',
      compactedEntries: [{ content: 'Only first preference.', importance: 'normal', sourceIndexes: [1] }],
    })
    const plan = maintenancePlan('user', [
      { content: 'First preference.', importance: 'normal' },
      { content: 'Second preference.', importance: 'normal' },
    ])
    plan.pending = { content: 'Pending preference.', importance: 'normal' }
    const runtime = {
      mutate: vi.fn().mockRejectedValueOnce(capacityError('user', plan.used, plan.projected, plan.limit)),
      planMaintenance: vi.fn(async () => plan),
      compactAndMutate: vi.fn(),
    } as unknown as RuntimeOperations
    const coordinator = createCoordinator(host.value, runtime)

    await expect(coordinator.runtime(parent(), { action: 'add', target: 'user', content: 'Pending preference.' }, new AbortController().signal)).rejects.toThrow('omitted committed entries')
    expect(runtime.compactAndMutate).not.toHaveBeenCalled()
  })
})
