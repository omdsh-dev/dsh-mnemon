import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineMemorySource, installMemory } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import type { DocumentMutationResult } from 'dsh-mnemon-source-documents/contracts'
import type { HostAgent, HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import { agentScope } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator } from '../src/host/subagent.ts'
import { registerTools } from '../src/host/tools.ts'
import { modelMemoryWake, unofferedViewId } from '../src/host/view-presentation.ts'
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
