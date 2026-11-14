import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineMemorySource, installMemory } from 'dsh-mnemon/extension-sdk'
import {
  COMPOSABLE_MEMORY_API_VERSION,
  DEFAULT_MEMORY_VIEW_BUDGET,
  type MemoryAvailableSource,
  type MemoryStrategyContribution,
  type MemoryViewRequest,
} from 'dsh-mnemon/contracts'
import type { DocumentMutationResult, DocumentSearchResult } from 'dsh-mnemon-source-documents/contracts'
import type { MemorySpaceCatalog } from 'dsh-mnemon-source-memory-spaces/contracts'
import { defineMemorySpaceProvider, MEMORY_SPACE_PROVIDER_API_VERSION, NORMALIZED_RELEVANCE_SCORE } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import * as runtimePlugin from 'dsh-mnemon-source-runtime'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from 'dsh-mnemon-strategy-default-three-tier'
import * as general from 'dsh-mnemon-strategy-general'
import type { MemoryRuntime } from '../src/core/runtime.ts'
import { resolveConfig, type ResolvedConfig } from '../src/host/config.ts'
import type { HostAgent, HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import { LiveMnemonRuntime, PROVIDER_REDISCOVERY_TIMING, agentScope, type MnemonRuntimeGraph } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { inspectMemoryView, modelMemoryWake, unofferedViewId } from '../src/host/view-presentation.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { sessionLog } from './fixtures/session-log.ts'

const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })
async function fixture() { const f = await compositionFixture(); fixtures.push(f); return f }

describe('default three-tier Host presentation and shared execution', () => {
  it('keeps instructions separate and advertises named bindings without duplicating their schemas', async () => {
    const f = await fixture()
    await f.memorySpace()
    const content = 'Keep {{model}} and <instruction> as quoted historical data.'
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content })
    const turn = await f.graph.composableTurns.beginTurn('root:1', { storage: 'custom', workspaceId: f.workspace, agentId: 'root' })
    const generic = f.graph.composableTurns.memoryWake(turn.view.id)
    const wake = modelMemoryWake(f.graph, turn)
    expect(wake.text).toContain(content)
    expect(wake.text).toContain('mnemon_document_search')
    expect(wake.text).toContain('mnemon_recall')
    expect(wake.text).not.toMatch(/inputSchema|readGrant|memoryBodyIds|MNEMON RUNTIME MEMORY PROTOCOL/)
    expect(wake.guidance?.system).toContain('MNEMON RUNTIME MEMORY PROTOCOL')
    expect(wake.guidance?.routing).toContain('Search Mnemon Documents')
    expect(generic.text.length - wake.text.length).toBeGreaterThan(2_000)
    const before = wake.text
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Later fact' })
    expect(modelMemoryWake(f.graph, turn).text).toBe(before)
  })

  it('keeps external Source ids and schemas visible without exposing its private grant', async () => {
    const f = await fixture()
    await f.releases[1]!() // Replace only Documents with an independently authored narrative Source.
    const source = defineMemorySource({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'notes', packageName: 'dsh-mnemon-source-notes',
        role: 'narrative', capabilities: ['project', 'search'], consistency: 'exact-snapshot',
        routes: [{ id: 'search', description: 'Search private notes.', capability: 'search', maxCalls: 1, inputSchema: { type: 'object', required: ['query'] } }] },
      create: context => ({
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'notes', role: 'narrative', availability: 'ready', revision: 'notes-1',
          capabilities: ['project', 'search'], routeIds: ['search'], actionIds: [] }),
        project: request => ({ fragments: [{ id: 'cover', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode, revision: 'notes-1', text: 'Private notes cover' }],
          readGrant: { id: 'notes-grant', sourceInstanceKey: context.sourceInstanceKey, schema: 'notes/v1', value: { secret: 'never-print-grant' }, revision: 'notes-1', consistency: 'exact-snapshot' } }),
        query: request => ({ id: 'notes-evidence', viewId: request.view.id, routeId: request.route.id, sourceInstanceKey: context.sourceInstanceKey,
          observedAt: new Date().toISOString(), items: [{ id: 'note', text: 'External evidence', provenance: {} }], truncated: false }),
      }),
    })
    await f.mount({ inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [source] }) } }, { instanceId: 'external-notes' })
    const turn = await f.graph.composableTurns.beginTurn('external:1', { storage: 'custom', workspaceId: f.workspace, agentId: 'external' })
    const wake = modelMemoryWake(f.graph, turn)
    expect(wake.text).toContain('source:external-notes/search')
    expect(wake.text).toContain('inputSchema')
    expect(wake.text).toContain('Private notes cover')
    expect(wake.text).not.toContain('never-print-grant')
    expect(wake.text).not.toContain('mnemon_document_search')
    expect(wake.guidance?.routing).toBeUndefined()
    const evidence = await f.graph.composableTurns.executeRoute(turn.turnId, 'source:external-notes/search', { query: 'private' })
    expect(evidence.items[0]?.text).toBe('External evidence')
  })

  it('refuses an id the View does not offer by naming only what its envelope shows (#390)', async () => {
    const f = await fixture()
    await f.releases[1]!() // Documents gives way to an independently authored Source, whose Route keeps its exact id.
    const source = defineMemorySource({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'notes', packageName: 'dsh-mnemon-source-notes',
        role: 'narrative', capabilities: ['project', 'search'], consistency: 'exact-snapshot',
        routes: [{ id: 'search', description: 'Search notes.', capability: 'search', maxCalls: 1, inputSchema: { type: 'object' } }] },
      create: context => ({
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'notes', role: 'narrative', availability: 'ready', revision: 'notes-1',
          capabilities: ['project', 'search'], routeIds: ['search'], actionIds: [] }),
        project: request => ({ fragments: [{ id: 'cover', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode, revision: 'notes-1', text: 'Notes cover' }],
          readGrant: { id: 'notes-grant', sourceInstanceKey: context.sourceInstanceKey, schema: 'notes/v1', value: {}, revision: 'notes-1', consistency: 'exact-snapshot' } }),
        query: request => ({ id: 'notes-evidence', viewId: request.view.id, routeId: request.route.id, sourceInstanceKey: context.sourceInstanceKey,
          observedAt: new Date().toISOString(), items: [], truncated: false }),
      }),
    })
    await f.mount({ inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [source] }) } }, { instanceId: 'external-notes' })
    await f.memorySpace()
    const agent = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    const registered = new Map<string, ToolDefinition>()
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.set(tool.name, tool); return () => { registered.delete(tool.name) } } } } as unknown as HostContextShape, f.live, new MnemonSubagentCoordinator({} as never, f.live), f.extensions)
    const turn = await f.graph.composableTurns.beginTurn('root:ids', agentScope(agent, f.config))
    const exec = { agent, signal: new AbortController().signal }
    const route = (args: object) => (registered.get('mnemon_view_route')!.execute as Function)(args, exec) as Promise<unknown>
    const action = (args: object) => (registered.get('mnemon_view_action')!.execute as Function)(args, exec) as Promise<unknown>
    const wake = modelMemoryWake(f.graph, turn).text
    const hidden = [...turn.view.routes.filter(candidate => !wake.includes(candidate.id)), ...turn.view.actionOffers.filter(candidate => !wake.includes(candidate.id))].map(candidate => candidate.id)
    expect(hidden.length).toBeGreaterThan(0)
    // A refusal comes back as the tool's error, thrown or rejected.
    const failure = async (call: () => Promise<unknown>) => { try { await call() } catch (error) { return (error as Error).message } return 'resolved' }
    const messages = [
      // An operation bound to a named tool is offered through that tool.
      await failure(() => route({ routeId: 'recall', input: {} })),
      await failure(() => action({ offerId: 'remember', input: {} })),
      // A short form of a Route the envelope lists names its exact id.
      await failure(() => route({ routeId: 'search', input: {} })),
      // Anything else lists what the envelope shows.
      await failure(() => route({ routeId: 'source:external-notes/nowhere', input: {} })),
      // Every Action is bound, so none is offered by id.
      await failure(() => action({ offerId: 'source:nowhere/act', input: {} })),
      await failure(() => route({ route: 'search', input: {} })),
    ]
    expect(messages).toEqual([
      'memory View Route is unavailable: recall; this View offers it as mnemon_recall, so call that tool',
      'memory ActionOffer is unavailable: remember; this View offers it as mnemon_remember, so call that tool',
      'memory View Route is unavailable: search; ids are exact as MNEMON VIEW ROUTES lists them: "source:external-notes/search"',
      'memory View Route is unavailable: source:external-notes/nowhere; MNEMON VIEW ROUTES offers "source:external-notes/search"',
      'memory ActionOffer is unavailable: source:nowhere/act; MNEMON VIEW ROUTES offers none by id this turn, only the named tools in MNEMON VIEW TOOLS',
      'memory View Route needs routeId, the exact id of one it offers',
    ])
    // No refusal names an id the envelope does not show.
    for (const message of messages) for (const id of hidden) expect(message).not.toContain(id)
  })

  it('lists the Routes a short id could mean first, when two Sources offer it (#390)', () => {
    // Another Strategy can offer two Sources whose Routes end alike; nothing is bound to a named tool here.
    const view = { runtimeGeneration: 'gone', actionOffers: [], routes: ['alpha/search', ...Array.from({ length: 12 }, (_value, index) => `alpha/topic-${index + 1}`), 'beta/search']
      .map(path => ({ id: `source:${path}`, sourceRouteId: path.split('/')[1]! })) }
    const graph = { memoryComposition: { generation: () => undefined } }
    expect(unofferedViewId(graph as never, { view } as never, 'route', 'search')).toBe(`memory View Route is unavailable: search; MNEMON VIEW ROUTES offers "source:alpha/search", "source:beta/search", ${
      Array.from({ length: 10 }, (_value, index) => JSON.stringify(`source:alpha/topic-${index + 1}`)).join(', ')} and 2 more`)
    expect(unofferedViewId(graph as never, { view } as never, 'route', 'source:alpha/search')).toBeUndefined()
    expect(unofferedViewId(graph as never, { view } as never, 'route', 7)).toBe('memory View Route needs routeId, the exact id of one it offers')
  })

  it('hands back a Document write through the generic Action as compact as the named tools do (#390)', async () => {
    const f = await fixture()
    await f.graph.source('documents').mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Existing record', content: '# Existing' })
    const agent = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    const registered = new Map<string, ToolDefinition>()
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.set(tool.name, tool); return () => { registered.delete(tool.name) } } } } as unknown as HostContextShape, f.live, new MnemonSubagentCoordinator({} as never, f.live), f.extensions)
    const turn = await f.graph.composableTurns.beginTurn('root:generic-document', agentScope(agent, f.config))
    const create = turn.view.actionOffers.find(offer => offer.sourceActionId === 'create' && offer.sourceInstanceKey.includes('documents'))!
    const receipt = await (registered.get('mnemon_view_action')!.execute as Function)(
      { offerId: create.id, input: { title: 'Rollout note', content: '# Rollout body' } }, { agent, signal: new AbortController().signal }) as { details: unknown }
    const written = JSON.stringify(receipt.details)
    expect(written).toContain('Rollout note')
    expect(written).toContain('"documents":{"active":2,"archived":0')
    expect(written).not.toContain('Existing record')
    expect(written).not.toContain('# Rollout body')
    expect(written).not.toContain(f.config.dataDir!)
  })

  it.each(['named-first', 'generic-first'])('shares one Documents policy across both real tool entries (%s)', async order => {
    const f = await fixture()
    await f.graph.source('documents').mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Protocol record', content: 'protocol-token '.repeat(1_000) })
    const agent = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    const registered = new Map<string, ToolDefinition>()
    const coordinator = new MnemonSubagentCoordinator({} as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.set(tool.name, tool); return () => { registered.delete(tool.name) } } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const turn = await f.graph.composableTurns.beginTurn('root:tools', agentScope(agent, f.config))
    const route = turn.view.routes.find(route => route.sourceRouteId === 'search')!
    const read = vi.spyOn(f.graph.memoryComposition.current()!.sourceRuntime(route.sourceInstanceKey)!, 'query')
    const execute = async (entry: 'named' | 'generic') => (registered.get(entry === 'named' ? 'mnemon_document_search' : 'mnemon_view_route')!.execute as Function)(
      entry === 'named' ? { query: 'protocol-token' } : { routeId: route.id, input: { query: 'protocol-token' } }, { agent, signal: new AbortController().signal })
    const first = await execute(order === 'named-first' ? 'named' : 'generic')
    expect(first.results).toHaveLength(1)
    expect(first.results[0].content.length).toBeLessThanOrEqual(2_600)
    expect(first).not.toHaveProperty('items')
    const firstEntry = order === 'named-first' ? 'named' : 'generic'
    const firstArgs = firstEntry === 'named' ? { query: 'protocol-token' } : { routeId: route.id, input: { query: 'protocol-token' } }
    const meta = registered.get(firstEntry === 'named' ? 'mnemon_document_search' : 'mnemon_view_route')!.output.presentationMeta!(firstArgs, first)
    expect(meta).toMatchObject({ schema: 'dsh-mnemon.activity/v1', kind: 'read', operationId: firstEntry === 'named' ? 'search' : 'view-route',
      items: [{ id: expect.any(String), title: 'Protocol record', excerpt: expect.stringContaining('protocol-token') }] })
    if (firstEntry === 'generic') expect(meta).toMatchObject({ reference: route.id })
    const second = await execute(order === 'named-first' ? 'generic' : 'named')
    expect(second).toMatchObject({ notRun: true, budgetExhausted: true, results: [] })
    expect(read).toHaveBeenCalledOnce()
  })

  it.each(['named-first', 'generic-first'])('shares Recall replay and refinement across real tool entries (%s)', async order => {
    const f = await fixture()
    const body = await f.memorySpace()
    await f.graph.source('memory-spaces').mutate('remember', { memoryBodyId: body.id, content: 'The protocol-token is a saved durable fact.', category: 'fact', source: 'external' })
    const agent = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    const registered = new Map<string, ToolDefinition>()
    const coordinator = new MnemonSubagentCoordinator({} as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.set(tool.name, tool); return () => { registered.delete(tool.name) } } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
    const turn = await f.graph.composableTurns.beginTurn('root:recall', agentScope(agent, f.config))
    const route = turn.view.routes.find(route => route.sourceRouteId === 'recall')!
    const read = vi.spyOn(f.graph.memoryComposition.current()!.sourceRuntime(route.sourceInstanceKey)!, 'query')
    const execute = async (entry: 'named' | 'generic', query: string) => (registered.get(entry === 'named' ? 'mnemon_recall' : 'mnemon_view_route')!.execute as Function)(
      entry === 'named' ? { query } : { routeId: route.id, input: { query } }, { agent, signal: new AbortController().signal })
    const first = await execute(order === 'named-first' ? 'named' : 'generic', 'protocol-token')
    expect(first.results).toHaveLength(1)
    expect(first.results[0]).toHaveProperty('createdAt')
    expect(first.results[0]).toHaveProperty('importance')
    expect(first.results[0]).not.toHaveProperty('score')
    const replay = await execute(order === 'named-first' ? 'generic' : 'named', 'PROTOCOL TOKEN!')
    expect(replay.results).toEqual(first.results)
    expect(read).toHaveBeenCalledOnce()
    await execute('generic', 'durable fact')
    expect(read).toHaveBeenCalledTimes(2)
    const exhausted = await execute('named', 'third query')
    expect(exhausted).toMatchObject({ query: 'third query', results: [], notRun: true, budgetExhausted: true })
    expect(exhausted.hint).toContain('budget is exhausted')
    expect(read).toHaveBeenCalledTimes(2)
    // Only reads that ran count: the third Recall did not, and neither does Related from an insight the turn never admitted.
    expect(coordinator.snapshot()).toMatchObject({ recalls: 1 })
    const unadmitted = await (registered.get('mnemon_related')!.execute as Function)({ id: 'never-admitted', memoryBodyId: body.id }, { agent, signal: new AbortController().signal })
    expect(unadmitted).toMatchObject({ results: [], notRun: true })
    expect(coordinator.snapshot()).toMatchObject({ recalls: 1 })
  })
})

describe('public Source plugin composition', () => {
  async function builtinFixture() {
    const current = await fixture()
    return { ...current, generation: current.graph.memoryComposition.current()! }
  }
  const request = (workspace: string) => ({
    scope: { storage: 'custom' as const, workspaceId: workspace, sessionId: 'session-1', agentId: 'agent-1' },
    scenario: 'test.root-turn', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET },
  })

  it('composes three independently owned Sources through the default Strategy', async () => {
    const { workspace, graph, generation, memorySpace } = await builtinFixture()
    await memorySpace()
    await graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Pinned runtime context', importance: 'critical' })
    await graph.source('documents').mutate('mutate', { action: 'create', title: 'Architecture', content: 'Composable View Memory.' })
    const view = await generation.compose(request(workspace))
    expect(view.strategyTypeId).toBe('default-three-tier')
    expect(view.projection.map(item => item.sourceInstanceKey)).toEqual([
      'source:mnemon-source-runtime', 'source:mnemon-source-documents', 'source:mnemon-source-memory-spaces',
    ])
    expect(view.projection[0]?.text).toContain('Pinned runtime context')
    expect(view.routes.map(route => route.sourceRouteId)).toEqual(expect.arrayContaining(['search', 'recall', 'inspect']))
    expect(view.readGrants.map(grant => grant.schema)).toEqual(['dsh-mnemon.documents/v1', 'dsh-mnemon.memory-spaces/v1'])
    expect(JSON.stringify(view)).not.toContain('apiKey')
  })

  it('pins the Documents namespace while management sees newly created documents', async () => {
    const { workspace, graph, generation } = await builtinFixture()
    const documents = graph.source('documents')
    const first = await documents.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'First', content: 'grant-token first' })
    const view = await generation.compose(request(workspace))
    const second = await documents.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Second', content: 'grant-token second' })
    const route = view.routes.find(item => item.sourceRouteId === 'search')!
    const evidence = await generation.executeRoute(view, route.id, { query: 'grant-token', limit: 20 })
    expect(evidence.items.map(item => item.id)).toContain(first.document.id)
    expect(evidence.items.map(item => item.id)).not.toContain(second.document.id)
    const managed = await documents.read<DocumentSearchResult>('search', { query: 'grant-token' })
    expect(managed.results.map(item => item.id)).toEqual(expect.arrayContaining([first.document.id, second.document.id]))
  })

  it('binds durable write Receipts to the View and reads through pinned Provider namespaces', async () => {
    const { workspace, generation, memorySpace } = await builtinFixture()
    const body = await memorySpace()
    const first = await generation.compose(request(workspace))
    const offer = first.actionOffers.find(item => item.sourceActionId === 'remember')!
    const receipt = await generation.executeAction(first, offer.id, { content: 'provider-marker durable evidence', memoryBodyId: body.id }, () => true)
    expect(receipt).toMatchObject({ viewId: first.id, offerId: offer.id, status: 'succeeded' })
    const next = await generation.compose(request(workspace))
    const route = next.routes.find(item => item.sourceRouteId === 'recall')!
    const evidence = await generation.executeRoute(next, route.id, { query: 'provider-marker', mode: 'keyword', limit: 10 })
    expect(evidence.items.some(item => item.text.includes('provider-marker'))).toBe(true)
    expect(evidence.items.every(item => (item.provenance as { memoryBodyId: string }).memoryBodyId === body.id)).toBe(true)
    await expect(generation.executeRoute(next, route.id, { query: 'provider-marker', memoryBodyIds: ['not-pinned'] })).rejects.toThrow('outside pinned Source')
  })

  it('rejects ambiguous Source roles without inventing precedence', async () => {
    const { workspace, graph, mount, root } = await builtinFixture()
    await mount(runtimePlugin, { instanceId: 'runtime-second', config: { dataDir: root + '/second' } })
    await expect(graph.memoryComposition.current()!.compose(request(workspace))).rejects.toThrow('ambiguous working-context Sources')
  })
})

describe('default three-tier diagnostics for a Source role it does not admit (#504)', () => {
  const request: MemoryViewRequest = { scope: { storage: 'custom' }, scenario: 'diagnostics', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }

  function facts(role: string, key = role, availability: MemoryAvailableSource['availability'] = 'ready'): MemoryAvailableSource {
    return { sourceInstanceKey: `source:${key}`, sourceTypeId: key, role, availability, revision: 'r1',
      capabilities: ['project'], routeIds: [], actionIds: [], routes: [], actions: [] }
  }

  const THREE_TIER = [facts('working-context', 'runtime'), facts('narrative', 'documents'), facts('durable-evidence', 'memory-spaces')]
  const CUSTOM_ROLE = facts('todo', 'todo')

  function contribution(value: MemoryStrategyContribution['value']): MemoryStrategyContribution {
    return { instanceKey: 'strategy-extension:selection', typeId: 'selection', slot: 'selection', value }
  }

  function customRoleSource() {
    return defineMemorySource({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'todo', packageName: 'dsh-mnemon-source-todo',
        role: 'todo', capabilities: ['project', 'read', 'search'], consistency: 'exact-snapshot',
        routes: [
          { id: 'open-items', description: 'List open items.', capability: 'read', maxCalls: 1, inputSchema: { type: 'object' } },
          { id: 'search', description: 'Search items.', capability: 'search', maxCalls: 1, inputSchema: { type: 'object', required: ['query'] } },
        ] },
      create: context => ({
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'todo', role: 'todo', availability: 'ready', revision: 'todo-1',
          capabilities: ['project', 'read', 'search'], routeIds: ['open-items', 'search'], actionIds: [] }),
        project: projection => ({ fragments: [{ id: 'cover', sourceInstanceKey: context.sourceInstanceKey, mode: projection.mode, revision: 'todo-1', text: 'Open todos cover' }],
          readGrant: { id: 'todo-grant', sourceInstanceKey: context.sourceInstanceKey, schema: 'todo/v1', value: {}, revision: 'todo-1', consistency: 'exact-snapshot' } }),
        query: query => ({ id: 'todo-evidence', viewId: query.view.id, routeId: query.route.id, sourceInstanceKey: context.sourceInstanceKey,
          observedAt: new Date().toISOString(), items: [], truncated: false }),
      }),
    })
  }

  function shape(view: { projection: Array<{ sourceInstanceKey: string; mode: string }>; routes: Array<{ sourceInstanceKey: string; sourceRouteId: string }> }) {
    return {
      projection: view.projection.map(fragment => `${fragment.sourceInstanceKey}:${fragment.mode}`).sort(),
      routes: view.routes.map(route => `${route.sourceInstanceKey}/${route.sourceRouteId}`).sort(),
    }
  }

  it('adds nothing to the default three-Source View', async () => {
    const f = await fixture()
    await f.memorySpace()
    const turn = await f.graph.composableTurns.beginTurn('diagnostics:default', { storage: 'custom', workspaceId: f.workspace, agentId: 'default' })
    expect(turn.view.diagnostics).toBeUndefined()
    expect(DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, THREE_TIER)).not.toHaveProperty('diagnostics')
  })

  it('explains an installed read-only Source with a custom role instead of dropping it silently', async () => {
    const baseline = await fixture()
    await baseline.memorySpace()
    const before = await baseline.graph.composableTurns.beginTurn('diagnostics:baseline', { storage: 'custom', workspaceId: baseline.workspace, agentId: 'baseline' })
    const f = await fixture()
    await f.memorySpace()
    await f.mount({ inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [customRoleSource()] }) } }, { instanceId: 'todo' })
    const turn = await f.graph.composableTurns.beginTurn('diagnostics:custom', { storage: 'custom', workspaceId: f.workspace, agentId: 'custom' })
    expect(turn.view.consistency.sourceRevisions).toHaveProperty('source:todo')
    expect(turn.view.diagnostics).toHaveLength(1)
    expect(turn.view.diagnostics![0]).toMatchObject({ code: 'unsupported-source-role' })
    expect(turn.view.diagnostics![0]!.message).toContain('source:todo')
    expect(turn.view.diagnostics![0]!.message).toContain('"todo"')
    expect(turn.view.diagnostics![0]!.message).toContain('general Strategy')
    expect(turn.view.diagnostics![0]!.message).not.toContain('explicit selection')
    expect(turn.view.projection.some(fragment => fragment.sourceInstanceKey === 'source:todo')).toBe(false)
    expect(turn.view.routes.some(route => route.sourceInstanceKey === 'source:todo')).toBe(false)
    expect(turn.view.actionOffers.some(offer => offer.sourceInstanceKey === 'source:todo')).toBe(false)
    expect(shape(turn.view)).toEqual(shape(before.view))
    const wake = modelMemoryWake(f.graph, turn).text
    expect(wake).toContain('MNEMON VIEW AVAILABILITY')
    expect(wake).toContain('unsupported-source-role')
    const generation = f.graph.memoryComposition.generation(turn.view.runtimeGeneration)!
    expect(inspectMemoryView(generation, turn.view, 'active').diagnostics).toEqual([turn.view.diagnostics![0]!.message])
  })

  it('leaves the three-tier composition itself unchanged when such a Source is installed', () => {
    const without = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, THREE_TIER)
    const withCustom = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [CUSTOM_ROLE, ...THREE_TIER])
    expect(withCustom.sources).toEqual(without.sources)
    expect(withCustom.guidance).toEqual(without.guidance)
    expect(withCustom.explanation).toBe(without.explanation)
    expect(withCustom.diagnostics).toHaveLength(1)
    const second = facts('notes', 'notes')
    const reversed = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [second, CUSTOM_ROLE, ...THREE_TIER].reverse())
    expect(reversed.diagnostics!.map(diagnostic => diagnostic.message.match(/source:\S+/u)![0])).toEqual(['source:notes', 'source:todo'])
  })

  it('stays quiet about a custom role whose Source is unavailable', () => {
    expect(DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [facts('todo', 'todo', 'unavailable'), ...THREE_TIER])).not.toHaveProperty('diagnostics')
  })

  it('still rejects a selection that names a custom role, naming the Source and the way out', () => {
    const selection = contribution({ sourceKeys: ['source:todo'] })
    expect(() => DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [CUSTOM_ROLE, ...THREE_TIER], [selection]))
      .toThrow('unsupported scoped three-tier Source role: todo (source:todo); default-three-tier admits working-context, narrative, durable-evidence only, so remove it from the selection or select the general Strategy')
    const allowed = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [CUSTOM_ROLE, ...THREE_TIER], [contribution({ sourceKeys: ['source:runtime'] })])
    expect(allowed.sources.map(item => item.sourceInstanceKey)).toEqual(['source:runtime'])
    expect(allowed.diagnostics).toHaveLength(1)
  })
})

describe('Provider namespaces startup rediscovery (#373)', () => {
  const TIMING = { ...PROVIDER_REDISCOVERY_TIMING }
  afterEach(() => { Object.assign(PROVIDER_REDISCOVERY_TIMING, TIMING) })

  function mockGraph(directoryPath: string, config: ResolvedConfig = resolveConfig({})) {
    const calls: Array<{ operation: string; input: unknown; signal: AbortSignal | undefined }> = []
    let answer: () => Promise<unknown> = async () => ({ trigger: 'startup', results: [] })
    const value = {
      config, directory: directoryPath,
      source: (typeId: string) => ({
        mutate: (operation: string, input: unknown, signal?: AbortSignal) => {
          calls.push({ operation: `${typeId}/${operation}`, input, signal })
          return answer()
        },
      }),
      retire: vi.fn(), dispose: vi.fn(),
    } as unknown as MnemonRuntimeGraph
    return { value, calls, answerWith: (next: () => Promise<unknown>) => { answer = next } }
  }

  const directory = () => join(tmpdir(), 'mnemon-rediscovery-' + randomUUID())
  const live = (initial: MnemonRuntimeGraph) => new LiveMnemonRuntime(initial, undefined, undefined, {} as MemoryRuntime)
  const spaces = (layer: Record<string, unknown>): ResolvedConfig => {
    const config = resolveConfig({})
    const layers = config.memoryTopology.layers
    const current = layers['memory-spaces']!
    return { ...config, memoryTopology: { ...config.memoryTopology, layers: { ...layers, 'memory-spaces': { ...current, ...layer, participation: { ...current.participation, ...(layer.participation as object | undefined) } } } } }
  }

  describe('Provider namespaces asked for again when the Host starts serving (#373)', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('asks once per data directory, a little after a runtime starts serving it', async () => {
      const shared = directory()
      const first = mockGraph(shared)
      const runtime = live(first.value)
      try {
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs - 1)
        expect(first.calls).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        expect(first.calls).toEqual([{ operation: 'memory-spaces/provider-rediscover', input: { trigger: 'startup' }, signal: expect.any(AbortSignal) }])

        const same = mockGraph(shared)
        runtime.swap(same.value)
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs)
        expect(same.calls).toEqual([])
        const other = mockGraph(directory())
        runtime.swap(other.value)
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs)
        expect(other.calls).toHaveLength(1)
      } finally { runtime.dispose() }
    })

    it('asks nothing for a read-only runtime, or a Memory Spaces layer that is off or not maintained automatically', async () => {
      const readOnly = mockGraph(directory(), resolveConfig({ writeEnabled: false }))
      const off = mockGraph(directory(), spaces({ enabled: false }))
      const manual = mockGraph(directory(), spaces({ participation: { maintenance: 'manual' } }))
      const noMaintenance = mockGraph(directory(), spaces({ participation: { maintenance: 'off' } }))
      const runtimes = [readOnly, off, manual, noMaintenance].map(item => live(item.value))
      try {
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs * 2)
        for (const item of [readOnly, off, manual, noMaintenance]) expect(item.calls).toEqual([])
      } finally { for (const runtime of runtimes) runtime.dispose() }
    })

    it('leaves a pass cut short by a replaced runtime to the runtime that replaced it', async () => {
      const shared = directory()
      const first = mockGraph(shared)
      first.answerWith(() => new Promise(() => {}))
      const runtime = live(first.value)
      try {
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs)
        expect(first.calls).toHaveLength(1)
        const next = mockGraph(shared)
        runtime.swap(next.value)
        expect(first.calls[0]!.signal?.aborted).toBe(true)
        expect(first.value.retire).toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs)
        expect(next.calls).toHaveLength(1)
      } finally { runtime.dispose() }
    })

    it('tries again a little later when the Source cannot be reached yet, then counts the directory as asked', async () => {
      const shared = directory()
      const first = mockGraph(shared)
      let tries = 0
      first.answerWith(async () => {
        tries += 1
        if (tries === 1) throw new Error('no memory composition generation is serving yet')
        return { trigger: 'startup', results: [] }
      })
      const runtime = live(first.value)
      try {
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs)
        expect(first.calls).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.retryDelayMs - 1)
        expect(first.calls).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(first.calls).toHaveLength(2)
        const next = mockGraph(shared)
        runtime.swap(next.value)
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs + PROVIDER_REDISCOVERY_TIMING.retryDelayMs * 3)
        expect(next.calls).toEqual([])
      } finally { runtime.dispose() }
    })

    it('stops after its tries and leaves the directory to a later runtime', async () => {
      const shared = directory()
      const first = mockGraph(shared)
      first.answerWith(async () => { throw new Error('memory Source management revision conflict: expected a, current b') })
      const runtime = live(first.value)
      try {
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs + PROVIDER_REDISCOVERY_TIMING.retryDelayMs * (PROVIDER_REDISCOVERY_TIMING.attempts + 2))
        expect(first.calls).toHaveLength(PROVIDER_REDISCOVERY_TIMING.attempts)
        const next = mockGraph(shared)
        runtime.swap(next.value)
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs)
        expect(next.calls).toHaveLength(1)
      } finally { runtime.dispose() }
    })

    it('stops waiting when the runtime goes away, and takes a Source that cannot do it at its word', async () => {
      const waiting = mockGraph(directory())
      const stopped = live(waiting.value)
      stopped.dispose()
      await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs * 2)
      expect(waiting.calls).toEqual([])

      const older = mockGraph(directory())
      older.answerWith(async () => { throw new Error('unsupported Memory Spaces management mutation operation: provider-rediscover') })
      const runtime = live(older.value)
      try {
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs + PROVIDER_REDISCOVERY_TIMING.retryDelayMs * 3)
        expect(older.calls).toHaveLength(1)
        runtime.swap(mockGraph(older.value.directory).value)
        await vi.advanceTimersByTimeAsync(PROVIDER_REDISCOVERY_TIMING.delayMs)
        expect(older.calls).toHaveLength(1)
      } finally { runtime.dispose() }
    })
  })

  describe('The start-up pass on a real composition (#373)', () => {
    const capabilities = { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: false, writeMode: 'exact', deletionMode: 'unsupported' } as const

    function upstream(namespaces: Array<{ externalId: string; name: string }>) {
      return defineMemorySpaceProvider<undefined>({ id: 'banks', apply(ctx, host) {
        host.install(ctx, {
          manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'banks',
            packageName: 'dsh-mnemon-provider-banks-host-test', version: '1.0.0', label: 'Banks', summary: 'Simulated Provider; real Host and Source.',
            origin: 'third-party', locality: 'remote', workspaceBinding: 'provider-global', fields: [], secrets: [], scoreSemantics: 'normalized-relevance',
            capabilities,
          },
          create: () => ({ id: 'banks', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
            discover: async () => namespaces.map(namespace => ({ ...namespace, description: 'An upstream bank.', connection: {} })),
            status: async () => ({ healthy: true }), list: async () => [], search: async () => ({ results: [] }),
            graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }), remember: async () => ({ action: 'stored' }),
          }),
        })
      } })
    }

    it('mounts a namespace created on the Provider side while the Host was stopped, inactive', async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'mnemon-rediscovery-host-'))
      const namespaces = [{ externalId: 'alice', name: 'Alice' }]
      const providers = () => [{ instanceId: 'banks', module: upstream(namespaces), config: undefined }]
      try {
        PROVIDER_REDISCOVERY_TIMING.delayMs = 60_000
        const before = await compositionFixture({ dataDir }, { providers: providers() })
        try {
          await before.graph.source('memory-spaces').mutate('provider-service-update', { providerId: 'banks', settings: {}, enabled: true })
        } finally { await before.dispose() }

        namespaces.push({ externalId: 'research', name: 'Research' })
        PROVIDER_REDISCOVERY_TIMING.delayMs = 50
        PROVIDER_REDISCOVERY_TIMING.retryDelayMs = 200
        const after = await compositionFixture({ dataDir }, { providers: providers() })
        try {
          const source = after.graph.source('memory-spaces')
          await vi.waitFor(async () => {
            const catalog = await source.read<MemorySpaceCatalog>('body-directory')
            expect(catalog.items.map(item => [item.name, item.active])).toEqual([['Alice', true], ['Research', false]])
            expect(catalog.rediscovery).toMatchObject({ running: false, last: { trigger: 'startup', results: [{ providerId: 'banks', found: 2, added: [{ name: 'Research' }] }] } })
          }, { timeout: 10_000, interval: 100 })
        } finally { await after.dispose() }
      } finally { rmSync(dataDir, { recursive: true, force: true }) }
    }, 30_000)
  })
})

describe('General strategy named reads at the Host JSON boundary', () => {
  it.each([{}, { score: 0 }, { revision: 'r1' }, { score: 0.5, revision: 'r2' }])(
    'preserves optional Evidence metadata without introducing undefined (%j)', async metadata => {
      const f = await compositionFixture({ memoryTopology: { strategyId: 'general' } })
      fixtures.push(f)
      await f.mount(general, { instanceId: 'mnemon-strategy-general' })
      await f.releases[3]!()
      const body = await f.memorySpace()
      await f.graph.source('memory-spaces').mutate('remember', {
        memoryBodyId: body.id, content: 'General recall transport sentinel.', category: 'fact', source: 'external', entities: ['shared-entity'],
      })
      await f.graph.source('memory-spaces').mutate('remember', {
        memoryBodyId: body.id, content: 'Rollback trace.', category: 'fact', source: 'external', entities: ['shared-entity'],
      })
      const agent = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
      const turn = await f.graph.composableTurns.beginTurn('general:reads', agentScope(agent, f.config))
      expect(turn.view.strategyTypeId).toBe('general')
      const route = turn.view.routes.find(item => item.sourceRouteId === 'recall')!
      const source = f.graph.memoryComposition.current()!.sourceRuntime(route.sourceInstanceKey)!
      const query = source.query!.bind(source)
      source.query = vi.fn(async (request: Parameters<typeof query>[0]) => {
        const evidence = await query(request)
        return { ...evidence, items: evidence.items.map(({ score: _score, revision: _revision, ...item }) => ({ ...item, ...metadata })) }
      })
      const registered = new Map<string, ToolDefinition>()
      const coordinator = new MnemonSubagentCoordinator({} as never, f.live)
      registerTools({ tools: { register: (tool: ToolDefinition) => { registered.set(tool.name, tool); return () => { registered.delete(tool.name) } } } } as unknown as HostContextShape, f.live, coordinator, f.extensions)
      const execute = (name: string, args: object) => (registered.get(name)!.execute as Function)(args, { agent, signal: new AbortController().signal })
      const recall = await execute('mnemon_recall', { query: 'General recall transport sentinel', mode: 'keyword' })
      expect(recall.results).toHaveLength(1)
      expect(JSON.parse(JSON.stringify(recall))).toStrictEqual(recall)
      expect(recall.results[0]).toMatchObject({ content: 'General recall transport sentinel.', ...metadata })
      for (const field of ['score', 'revision']) {
        if (!Object.hasOwn(metadata, field)) expect(recall.results[0]).not.toHaveProperty(field)
      }
      const related = await execute('mnemon_related', { id: recall.results[0].id, memoryBodyId: body.id })
      expect(related.results.length).toBeGreaterThan(0)
      expect(JSON.parse(JSON.stringify(related))).toStrictEqual(related)
    },
  )
})
