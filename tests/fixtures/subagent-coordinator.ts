import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { HostAgent, HostSubagentStartRequest, HostSubagentsService, ToolDefinition } from '../../src/host/dsh.ts'
import type { RememberRequest, MemorySpaceCatalog, SearchRequest, Insight } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { DocumentMutationResult } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemoryMaintenancePlan, RuntimeMemoryMutation, RuntimeMemoryMutationResult } from 'dsh-mnemon-source-runtime/contracts'
import type { MemoryEvidence, MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { MemoryTestManagementClient } from 'dsh-mnemon/testing'
import type { MnemonAgentRuntimeSource, MnemonRuntimeGraph } from '../../src/host/runtime.ts'
import { MemoryExecutions } from '../../src/host/memory-executions.ts'
import type { SourceSession } from '../../src/host/source-session.ts'
import type { ComposableMemoryTurn } from '../../src/core/turns.ts'
import { MnemonSubagentCoordinator } from '../../src/host/subagent.ts'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from 'dsh-mnemon-strategy-default-three-tier'
import { resolveConfig } from '../../src/host/config.ts'
import { sourceFixture } from './sources.ts'
import { sessionLog } from './session-log.ts'

/** A DSH 0.2.0 provider, which takes the child's persona and tool filter in the start request. */
export const capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

/** DSH 0.2.1's providers: none takes a persona or tool filter. */
export const DSH_021_CAPABILITIES = { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }

export type HostActivationSpec = Parameters<NonNullable<HostSubagentsService['startActivation']>>[0]

export const temporaryDirectories: string[] = []
export const releases: Array<() => Promise<void>> = []

export async function cleanupSubagentFixtures(): Promise<void> {
  for (const release of releases.splice(0)) await release()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
}

export function parent(origin?: 'subagent'): HostAgent {
  return {
    id: origin === undefined ? 'root' : 'child',
    status: 'idle',
    session: { header: { ...(origin === undefined ? {} : { origin }) }, ...sessionLog() },
  } as unknown as HostAgent
}

export interface SpaceData {
  config: ReturnType<typeof resolveConfig>
  bodyDirectory(): MemorySpaceCatalog
  bodies(): Promise<MemorySpaceCatalog>
  search(request: SearchRequest, signal?: AbortSignal): Promise<{ query: string; mode: string; results: Insight[] }>
  metadataSample(id: string, signal?: AbortSignal): Promise<unknown>
  related(id: string, depth?: number, edge?: string, signal?: AbortSignal, memoryBodyId?: string): Promise<Insight[]>
  status(): Promise<unknown>
  remember(request: RememberRequest, signal?: AbortSignal): Promise<unknown>
  rememberMany(requests: readonly RememberRequest[], signal?: AbortSignal): Promise<unknown[]>
  link(): Promise<unknown>
  forget(id?: string, signal?: AbortSignal, memoryBodyId?: string): Promise<unknown>
  createBody(): Promise<unknown>
  updateBody(): unknown
  mergeBodies(): Promise<unknown>
}

export interface RuntimeOperations {
  mutate(request: RuntimeMemoryMutation): Promise<RuntimeMemoryMutationResult>
  planMaintenance(request: RuntimeMemoryMutation): Promise<RuntimeMemoryMaintenancePlan>
  compactAndMutate(revision: string, request: RuntimeMemoryMutation, compacted: unknown, maxBytes?: number, lineage?: unknown, archive?: 'local'): Promise<RuntimeMemoryMutationResult>
}

export function service(): SpaceData {
  const project = {
    id: 'project',
    name: '项目记忆空间',
    description: '项目决策',
    active: true,
    providerEnabled: true,
    dbPath: '/tmp/project.db',
    createdAt: 'now',
    updatedAt: 'now',
    healthy: true,
    provider: {
      id: 'mnemon-native',
      label: 'Mnemon Native',
      capabilities: { search: true, remember: true, forget: true, writeMode: 'exact' },
    },
  }
  const catalog = {
    items: [project],
    providers: [],
    total: 1,
    activeCount: 1,
    directory: '/tmp',
    generatedAt: 'now',
  }
  return {
    config: { writeEnabled: true },
    bodyDirectory: vi.fn(() => catalog),
    bodies: vi.fn(async () => catalog),
    search: vi.fn(async request => ({ query: request.query, mode: 'smart', results: [{ id: 'm1', content: 'SQLite', memoryBodyId: 'project', memoryBodyName: '项目记忆空间' }] })),
    metadataSample: vi.fn(async (memoryBodyId: string) => ({
      memoryBodyId,
      name: memoryBodyId === 'release' ? 'Release' : 'Product',
      description: memoryBodyId === 'release' ? 'Release gates and rollback notes.' : 'Product scope and decisions.',
      providerId: 'mnemon-native',
      providerLabel: 'mnemon',
      method: 'native-basic',
      evidence: [{ content: memoryBodyId === 'release' ? 'Use staged rollout and a rollback gate.' : 'The product keeps durable architecture decisions.', category: 'decision', entities: ['DSH'] }],
    })),
    related: vi.fn(async () => []),
    status: vi.fn(async () => ({ healthy: true })),
    remember: vi.fn(async request => ({
      action: 'added',
      id: `stored-${createHash('sha256').update(request.content).digest('hex').slice(0, 8)}`,
      memoryBodyId: request.memoryBodyId,
      memoryBodyName: '项目记忆空间',
    })),
    rememberMany: vi.fn(async (requests: readonly RememberRequest[]) => requests.map(request => ({
      action: 'added',
      id: `stored-${createHash('sha256').update(request.content).digest('hex').slice(0, 8)}`,
      memoryBodyId: request.memoryBodyId,
      memoryBodyName: '项目记忆空间',
    }))),
    link: vi.fn(async () => ({ action: 'linked' })),
    forget: vi.fn(async () => ({ action: 'forgotten' })),
    createBody: vi.fn(async () => ({ id: 'new-body' })),
    updateBody: vi.fn(() => ({ id: 'project' })),
    mergeBodies: vi.fn(async () => ({ imported: 1 })),
  } as unknown as SpaceData
}

export function addSecondWritableBody(memoryService: SpaceData): void {
  const catalog = memoryService.bodyDirectory()
  const source = catalog.items[0]!
  vi.mocked(memoryService.bodyDirectory).mockReturnValue({
    ...catalog,
    items: [source, {
      ...source,
      id: 'release',
      name: '发布记忆空间',
      description: '发布门禁、回滚和金丝雀策略',
      dbPath: '/tmp/release.db',
    }],
    total: 2,
    activeCount: 2,
  })
}

export function subagents(structured: unknown, stopReason = 'completed', providers = ['spawn'], localAgent?: HostAgent, diagnostic?: string) {
  const dispose = vi.fn(async () => {})
  const start = vi.fn(async (_provider?: string, _request?: HostSubagentStartRequest) => ({
    id: 'child-run-1',
    result: Promise.resolve({ output: [], structured, stopReason, ...(diagnostic === undefined ? {} : { diagnostic }) }),
    dispose,
    ...(localAgent === undefined ? {} : { localAgent }),
  }))
  const value = {
    list: vi.fn(() => providers),
    getProvider: vi.fn((name: string) => providers.includes(name) ? { capabilities, inheritsParentContext: name === 'fork' } : undefined),
    start,
  } as unknown as HostSubagentsService
  return { value, start, dispose }
}

/**
 * DSH 0.2.1 starts every child as a managed activation (#356), and a child joins its parent's
 * composition; its spawn and fork providers prepare local activations. As there, the result settles
 * only after the child has left the Agent registry (`release`), at least one turn after
 * startActivation resolves.
 */
export function activations(structured: unknown, stopReason = 'completed', providers = ['spawn'], publish?: (spec: HostActivationSpec) => void, release?: () => void) {
  const dispose = vi.fn(async () => {})
  const startActivation = vi.fn(async (spec: HostActivationSpec) => {
    publish?.(spec)
    const result = new Promise<{ output: []; structured: unknown; stopReason: string }>(settle => setTimeout(() => {
      release?.()
      settle({ output: [], structured, stopReason })
    }, 0))
    return { childId: 'child-run-1', messageId: 'message-1', result, dispose }
  })
  const value = {
    list: vi.fn(() => providers),
    getProvider: vi.fn((name: string) => providers.includes(name)
      ? { capabilities: DSH_021_CAPABILITIES, inheritsParentContext: name === 'fork', prepareContinuable: () => {} }
      : undefined),
    startActivation,
  } as unknown as HostSubagentsService
  return { value, startActivation, dispose }
}

/** A child as DSH 0.2.1 publishes it, recording what is registered in its own scope. */
export function composableChild(id: string) {
  const sections: Array<{ name: string; order: number; text: string }> = []
  const restrictions: Array<{ allow?: string[]; deny?: string[] }> = []
  const guard = vi.fn(() => () => {})
  const child = { ...parent('subagent'), id, ctx: {
    systemPrompt: { section: (section: { name: string; order: number; text: string }) => { sections.push(section) }, getSectionOrder: () => 0 },
    tools: { guard, restrict: (filter: { allow?: string[]; deny?: string[] }) => { restrictions.push(filter) } },
  } } as unknown as HostAgent
  return { child, sections, restrictions, guard }
}

export function resultArguments(request: { persona?: string }, result: unknown) {
  const requestId = request.persona?.match(/requestId `([^`]+)`/u)?.[1]
  if (requestId === undefined) throw new Error('Missing delegated result capability')
  return { requestId, result }
}

export function delegatedResultSchema(request: { persona?: string }): { properties: Record<string, { enum?: unknown[] }> } {
  const schema = request.persona?.split('matching this JSON schema:\n')[1]?.split('\n')[0]
  if (schema === undefined) throw new Error('Missing delegated result schema')
  return JSON.parse(schema)
}

export function toolRegistry() {
  const definitions: ToolDefinition[] = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const register = vi.fn((definition: ToolDefinition) => {
    definitions.push(definition)
    const dispose = vi.fn()
    disposers.push(dispose)
    return dispose
  })
  const on = vi.fn((name: string, listener: (...args: unknown[]) => unknown) => {
    const registered = listeners.get(name) ?? new Set()
    registered.add(listener)
    listeners.set(name, registered)
    const dispose = vi.fn(() => { registered.delete(listener) })
    disposers.push(dispose)
    return dispose
  })
  const emit = (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  const owners = new Map<string, HostAgent>()
  const live = new Map<string, HostAgent>()
  const agents = { get: (id: string) => live.get(id), isOwnedBy: (id: string, owner: HostAgent) => owners.get(id) === owner }
  const publish = (child: HostAgent, owner: HostAgent) => { owners.set(child.id, owner); live.set(child.id, child); emit('agent/created', { agent: child }) }
  const unpublish = (id: string) => { owners.delete(id); live.delete(id) }
  const reviewChild = (id: string, owner: HostAgent) => {
    const child = { ...parent('subagent'), id, ctx: { tools: { guard: () => () => {} } } } as unknown as HostAgent
    publish(child, owner)
    return child
  }
  // DSH publishes a review child while the start call is still pending, as these wrappers do.
  const withReviewPublication = (host: HostSubagentsService): HostSubagentsService => ({ ...host,
    ...(host.start === undefined ? {} : { async start(provider: string, request: HostSubagentStartRequest) {
      const run = await host.start!(provider, request)
      if (request.label !== 'Mnemon idle checkpoint review') return run
      return { ...run, localAgent: reviewChild(run.id, request.parent) }
    } }),
    ...(host.startActivation === undefined ? {} : { async startActivation(spec: HostActivationSpec) {
      const activation = await host.startActivation!(spec)
      if (spec.label === 'Mnemon idle checkpoint review') reviewChild(activation.childId, spec.request.parent)
      return activation
    } }),
  })
  return { value: { tools: { register }, on, agents }, register, on, emit, publish, unpublish, reviewChild, definitions, disposers, withReviewPublication }
}

export function capacityError(target: string, used: number, projected: number, limit: number) {
  return Object.assign(new Error('Runtime capacity exceeded'), { code: 'runtime-capacity', target, used, projected, limit })
}

export function pinnedTurn(turnId: string, viewId: string, memoryBodyIds: string[] = ['project']): ComposableMemoryTurn {
  return { turnId, view: { id: viewId, actionOffers: [
    { sourceInstanceKey: 'source:mnemon-source-runtime', sourceActionId: 'mutate' },
    { sourceInstanceKey: 'source:mnemon-source-documents', sourceActionId: 'create' },
  ], readGrants: [{
    id: 'space-grant', sourceInstanceKey: 'source:mnemon-source-memory-spaces', schema: 'dsh-mnemon.memory-spaces/v1', value: { memoryBodyIds },
  }] } } as unknown as ComposableMemoryTurn
}

export function managedSession(client: MemoryTestManagementClient) {
  return {
    forGeneration() { return this },
    read: vi.fn(async <T,>(operation: string, input: unknown = null): Promise<T> => (await client.read(operation, input as MemoryJsonValue)).value as T),
    mutate: vi.fn(async <T,>(operation: string, input: unknown): Promise<T> => (await client.mutate(operation, input as MemoryJsonValue, { confirmed: true })).value as T),
    mutateResult: vi.fn(async (operation: string, input: unknown) => client.mutate(operation, input as MemoryJsonValue, { confirmed: true })),
  } as unknown as SourceSession
}

/** JSON Source test ports. Domain responses are explicit test data only. */
export function runtimeSource(
  runtime?: RuntimeOperations | MnemonAgentRuntimeSource | SourceSession,
  spaces: SpaceData = service(),
  documents?: SourceSession,
  turnPort?: { activeTurn: (agentId: string) => ComposableMemoryTurn | undefined },
): MnemonAgentRuntimeSource & { forAgent: ReturnType<typeof vi.fn<(agent: HostAgent) => MnemonRuntimeGraph>> } {
  if (runtime && 'forAgent' in runtime) return runtime as ReturnType<typeof runtimeSource>
  const config = resolveConfig(spaces.config)
  let workflow: ComposableMemoryTurn | undefined
  const turns = turnPort ?? {
    activeTurn: vi.fn(() => workflow),
    turn: vi.fn(() => workflow),
    beginTurn: vi.fn(async (id: string) => { workflow = pinnedTurn(id, id); return workflow }),
    endTurn: vi.fn(() => { workflow = undefined }),
  }
  const policies = new WeakMap<ComposableMemoryTurn, ReturnType<NonNullable<typeof DEFAULT_THREE_TIER_VIEW_STRATEGY.createTurn>>>()
  const policyFor = (turn: ComposableMemoryTurn) => {
    let policy = policies.get(turn)
    if (!policy) { policy = DEFAULT_THREE_TIER_VIEW_STRATEGY.createTurn!(turn.view); policies.set(turn, policy) }
    return policy
  }
  const spaceSession = {
    forGeneration() { return this },
    forInstance() { return this },
    identity: async () => ({ sourceInstanceKey: 'source:mnemon-source-memory-spaces' }),
    forTurn: (turn: ComposableMemoryTurn) => ({ ...spaceSession, route: (operation: string, input: MemoryJsonValue, signal: AbortSignal) => {
      const route = { id: 'space/' + operation, sourceInstanceKey: 'source:mnemon-source-memory-spaces', sourceRouteId: operation, readGrantId: 'space-grant', maxCalls: 4 }
      return policyFor(turn).query({ route: route as never, input, signal }, async input => {
        const value = await spaceSession.route(operation, input as Record<string, unknown>, signal)
        return { id: 'read-' + Math.random(), viewId: turn.view.id, routeId: route.id, sourceInstanceKey: route.sourceInstanceKey,
          observedAt: new Date().toISOString(), truncated: false, ...value } as MemoryEvidence
      })
    } }),
    async read(operation: string, input: Record<string, unknown> | null = null, signal?: AbortSignal) {
      const value = input ?? {}
      if (operation === 'body-directory') return spaces.bodyDirectory()
      if (operation === 'search') return spaces.search(value as unknown as SearchRequest, signal)
      if (operation === 'related') return spaces.related(String(value.id), Number(value.depth), value.edge as string | undefined, signal, value.memoryBodyId as string | undefined)
      if (operation === 'metadata-sample') return spaces.metadataSample(String(value.memoryBodyId), signal)
      if (operation === 'finalize-placement') return value.selection === undefined ? null : { ...(value.selection as object), decidedBy: 'llm', runId: value.runId, provider: value.provider }
      throw new Error('Unexpected Source read: ' + operation)
    },
    async mutate(operation: string, input: Record<string, unknown>, signal?: AbortSignal) {
      if (operation === 'forget') return spaces.forget(String(input.id), signal, String(input.memoryBodyId))
      if (operation === 'remember-many') return spaces.rememberMany(input.requests as RememberRequest[], signal)
      if (operation === 'remember') return spaces.remember(input as unknown as RememberRequest, signal)
      throw new Error('Unexpected Source mutation: ' + operation)
    },
    async route(operation: string, input: Record<string, unknown>, signal?: AbortSignal) {
      const results = operation === 'recall'
        ? (await spaces.search(input as unknown as SearchRequest, signal)).results
        : await spaces.related(String(input.id), Number(input.depth), input.edge as string | undefined, signal, input.memoryBodyId as string | undefined)
      return { items: results.map(({ id, content, ...metadata }) => ({ id, text: content, provenance: metadata })) }
    },
  }
  const operations = runtime as RuntimeOperations | undefined
  const runtimeSession = runtime && 'read' in runtime ? runtime : {
    forGeneration() { return this },
    read: (operation: string, input: RuntimeMemoryMutation) => {
      if (operation === 'maintenance-plan') return operations!.planMaintenance(input)
      throw new Error('Unexpected Runtime read: ' + operation)
    },
    mutate: (operation: string, input: RuntimeMemoryMutation & { revision: string; mutation: RuntimeMemoryMutation; compacted: unknown; maxBytes?: number; lineage?: unknown; archive?: 'local' }) =>
      operation === 'mutate' ? operations!.mutate(input) : input.archive === undefined
        ? operations!.compactAndMutate(input.revision, input.mutation, input.compacted, input.maxBytes, input.lineage)
        : operations!.compactAndMutate(input.revision, input.mutation, input.compacted, input.maxBytes, input.lineage, input.archive),
    action: async (_operation: string, input: RuntimeMemoryMutation) => ({ details: await operations!.mutate(input) }),
  }
  if (!('mutateResult' in runtimeSession)) Object.assign(runtimeSession, {
    mutateResult: async (...args: Parameters<SourceSession['mutate']>) => ({ revision: 'committed-revision', value: await (runtimeSession as unknown as SourceSession).mutate(...args) }),
  })
  const documentSession = documents ?? { forTurn: (turn: ComposableMemoryTurn) => ({ route: (operation: string, input: MemoryJsonValue, signal: AbortSignal) => {
    if (!turn.view.readGrants.some(grant => grant.id === 'doc-grant')) turn.view.readGrants.push({ id: 'doc-grant', sourceInstanceKey: 'docs', schema: 'dsh-mnemon.documents/v1' } as never)
    return policyFor(turn).query({ route: { id: 'docs/search', sourceInstanceKey: 'docs', sourceRouteId: operation, readGrantId: 'doc-grant' } as never, input, signal }, async () => ({ id: 'docs', viewId: turn.view.id, routeId: 'docs/search', sourceInstanceKey: 'docs', observedAt: 'now', items: [], truncated: false }))
  } }) }
  // The serving generation composes with the configured Strategy.
  const generation = { strategy: { definition: { manifest: { typeId: config.memoryTopology.strategyId } } },
    sourceInstances: () => [
      { sourceInstanceKey: 'source:mnemon-source-memory-spaces', sourceTypeId: 'memory-spaces' },
      { sourceInstanceKey: 'source:mnemon-source-runtime', sourceTypeId: 'runtime' },
      { sourceInstanceKey: 'source:mnemon-source-documents', sourceTypeId: 'documents' },
    ] }
  const graph = { config, memoryComposition: { generation: () => generation, acquire: () => ({ generation, release: () => {} }) }, composableTurns: turns, source: (type: string) => type === 'runtime' ? runtimeSession : type === 'documents' ? documentSession : spaceSession } as unknown as MnemonRuntimeGraph
  const source = { config, forAgent: vi.fn((_agent: HostAgent) => graph), bindAgentRuntime: vi.fn(() => () => {}) }
  return { ...source, executions: new MemoryExecutions(source) }
}

export function createCoordinator(host: HostSubagentsService, runtime?: RuntimeOperations | MnemonAgentRuntimeSource | SourceSession) {
  const registry = toolRegistry()
  return new MnemonSubagentCoordinator(registry.withReviewPublication(host), runtimeSource(runtime), registry.value)
}

export function maintenancePlan(
  target: 'memory' | 'user' = 'memory',
  entries = [
    { content: 'Project uses pnpm.', importance: 'normal' as const },
    { content: 'Release checks require a canary.', importance: 'critical' as const },
  ],
): RuntimeMemoryMaintenancePlan {
  return {
    revision: `${target}-reviewed-revision`,
    action: 'add',
    target,
    entries: entries.map(entry => ({
      ...entry,
      target,
      created_at: '2026-08-23T00:00:00.000Z',
      updated_at: '2026-08-23T00:00:00.000Z',
    })),
    pending: { content: target === 'memory' ? 'New durable fact.' : 'User prefers direct answers.', importance: 'normal' },
    used: target === 'memory' ? 10_200 : 4_090,
    projected: target === 'memory' ? 10_300 : 4_180,
    limit: target === 'memory' ? 10_240 : 4_096,
    requiresMaintenance: true,
    localArchive: true,
  }
}

export function runtimeArchiveFixture() {
  const plan = maintenancePlan()
  const runtime = {
    mutate: vi.fn().mockRejectedValue(capacityError('memory', plan.used, plan.projected, plan.limit)),
    planMaintenance: vi.fn(async () => plan),
    compactAndMutate: vi.fn(async () => ({ success: true, target: 'memory', added: plan.pending!.content, usage: { used: 30, limit: plan.limit } })),
  } as unknown as RuntimeOperations
  const spaces = service()
  const host = subagents({ action: 'planned', summary: 'Route both sources.', routes: [{ sourceIndexes: [1, 2], memoryBodyId: 'project' }] })
  const coordinator = new MnemonSubagentCoordinator(host.value, runtimeSource(runtime, spaces), toolRegistry().value)
  return { plan, runtime, spaces, host, archive: (signal = new AbortController().signal) => coordinator.runtime(parent(), { action: 'add', target: 'memory', content: plan.pending!.content }, signal) }
}

export function observedSubagents(
  resultTools: ReturnType<typeof toolRegistry>,
  publish: (child: HostAgent) => void,
  stopReason = 'completed',
  structured?: object,
) {
  const dispose = vi.fn(async () => {})
  const child = parent('subagent')
  child.id = 'child-run-1'
  const start = vi.fn(async () => {
    publish(child)
    return { id: child.id, result: Promise.resolve({ output: [], stopReason, ...(structured === undefined ? {} : { structured }) }), dispose, localAgent: child }
  })
  const value = {
    list: vi.fn(() => ['spawn']),
    getProvider: vi.fn(() => ({ capabilities })),
    start,
  } as unknown as HostSubagentsService
  return { value, start, dispose, child }
}

export function emitSuccessfulToolResult(
  resultTools: ReturnType<typeof toolRegistry>,
  child: HostAgent,
  name: string,
  argumentsValue: unknown,
  value: unknown,
  parentToken?: symbol,
) {
  const execution = {
    name,
    arguments: argumentsValue,
    token: Symbol(name),
    ...(parentToken === undefined ? {} : { parent: parentToken }),
    agent: child,
    signal: new AbortController().signal,
  }
  resultTools.emit('tools/result', execution, { isError: false, value })
  return execution
}

export async function documentArchiveFixture(proposal: unknown = { action: 'planned', summary: 'Preserve the release gates.', memoryBodyId: 'project' }) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-mnemon-document-archive-'))
  temporaryDirectories.push(workspace)
  const documents = await sourceFixture({ dataDir: join(workspace, '.mnemon'), workspace })
  releases.push(documents.dispose)
  const controller = managedSession(documents.documents)
  const created = await controller.mutate<DocumentMutationResult>('mutate', { action: 'create', title: 'Release design', content: 'Canary before production. Keep the exact original.' })
  const spaces = service()
  vi.mocked(spaces.search).mockResolvedValue({ query: '', mode: 'keyword', results: [] })
  const host = subagents(proposal)
  const agent = { ...parent(), session: { header: { cwd: workspace }, ...sessionLog() } } as HostAgent
  const runtime = runtimeSource(undefined, spaces, controller)
  const coordinator = new MnemonSubagentCoordinator(host.value, runtime, toolRegistry().value)
  return { controller, document: created.document, spaces, host, agent, runtime, coordinator,
    archive: (signal = new AbortController().signal) => coordinator.archiveDocument(agent, created.document.id, signal) }
}
