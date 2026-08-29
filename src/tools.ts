import type { HostContextShape, ToolDefinition, ToolExecution } from './contracts.ts'
import type { HostAgent } from './contracts.ts'
import type { DocumentManager, DocumentMutation, DocumentSearchResult } from './documents.ts'
import type { RuntimeMemoryController, RuntimeMemoryImportance, RuntimeMemoryTarget } from './runtime-memory.ts'
import { assertMemoryLayerParticipation } from './memory-system/access.ts'
import type { MemoryCapability } from './memory-system/contracts.ts'
import type { MemoryKernel } from './memory-system/kernel.ts'
import type { MnemonAgentRuntimeSource } from './live-runtime.ts'
import type { ComposableMemoryTurnManager } from './composable/turns.ts'
import type { MemoryJsonValue } from '../packages/contracts/src/index.ts'
import { isSubagent, MnemonSubagentCoordinator } from './subagent.ts'
import {
  CATEGORIES,
  EDGE_TYPES,
  SOURCES,
  type Category,
  type EdgeType,
  type MnemonService,
  type MemoryBodyCatalog,
  type Source,
  type StatusView,
} from './service.ts'

const text = (value: unknown): Array<{ type: 'text'; text: string }> => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}]

function definition(value: ToolDefinition): ToolDefinition {
  return value
}

// DSH tool outputs use its supported JSON Schema subset. `type: "json"` is
// valid in the parameter DSL, but it is not a JSON Schema type.
const JSON_OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const
const MODEL_MEMORY_BODY_LIMIT = 16
const MODEL_DOCUMENT_RESULT_LIMIT = 4
const MODEL_DOCUMENT_TOTAL_CONTENT_LIMIT = 6_000
const MODEL_DOCUMENT_CONTENT_LIMIT = 2_600

function boundedToolText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

/** Strip control-plane paths, provider settings, and statistics from model output. */
function modelBodyCatalog(catalog: MemoryBodyCatalog) {
  const items = catalog.items.slice(0, MODEL_MEMORY_BODY_LIMIT)
  return {
    items: items.map(body => ({
      id: body.id,
      name: boundedToolText(body.name, 120),
      description: boundedToolText(body.description, 500),
      active: body.active,
      providerEnabled: body.providerEnabled !== false,
      status: body.providerEnabled === false
        ? 'provider-disabled'
        : body.statusLoading === true ? 'not-probed' : body.healthy ? 'healthy' : 'unhealthy',
      ...(body.error === undefined ? {} : { error: boundedToolText(body.error, 500) }),
      provider: {
        id: body.provider.id,
        label: boundedToolText(body.provider.label, 120),
        capabilities: structuredClone(body.provider.capabilities),
      },
    })),
    total: catalog.total,
    activeCount: catalog.activeCount,
    omittedCount: Math.max(0, catalog.items.length - items.length),
  }
}

function documentEvidence(content: string, query: string, maximum: number): string {
  if (content.length <= maximum) return content
  const normalized = content.toLocaleLowerCase()
  const terms = [query.trim(), ...(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    .map(term => term.toLocaleLowerCase())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const matched = terms.map(term => normalized.indexOf(term)).find(index => index >= 0) ?? 0
  const projectedStart = Math.max(0, Math.min(content.length - maximum, matched - 400))
  const prefix = projectedStart === 0 ? '' : '[earlier content omitted]\n'
  const suffix = projectedStart + maximum >= content.length ? '' : '\n[later content omitted]'
  const bodyLength = Math.max(0, maximum - prefix.length - suffix.length)
  const start = suffix === '' ? content.length - bodyLength : projectedStart
  const body = content.slice(start, start + bodyLength)
  return `${prefix}${body}${suffix}`
}

/** Keep enough query-local document evidence without serializing managed records. */
function modelDocumentSearch(result: DocumentSearchResult) {
  let remaining = MODEL_DOCUMENT_TOTAL_CONTENT_LIMIT
  const results = []
  for (const document of result.results.slice(0, MODEL_DOCUMENT_RESULT_LIMIT)) {
    if (remaining <= 0) break
    const content = documentEvidence(document.content, result.query, Math.min(MODEL_DOCUMENT_CONTENT_LIMIT, remaining))
    remaining -= content.length
    results.push({
      id: document.id,
      title: boundedToolText(document.title, 200),
      description: boundedToolText(document.description, 500),
      status: document.status,
      relativePath: boundedToolText(document.relativePath, 500),
      sourcePaths: document.sourcePaths.slice(0, 8).map(path => boundedToolText(path, 500)),
      score: document.score,
      content,
    })
  }
  return {
    query: result.query,
    includeArchived: result.includeArchived,
    total: result.total,
    results,
    hint: 'Document evidence is bounded. Use it, then one focused mnemon_recall only if exact durable history is still missing; do not repeat Document search this turn.',
  }
}

/** Keep health diagnostics useful without exposing complete control-plane state. */
function modelStatus(status: StatusView) {
  const active = status.memoryBodies.filter(body => body.active && body.providerEnabled !== false)
  const unhealthy = active.filter(body => !body.healthy)
  const relevantProviders = status.providerServices?.filter(provider => (
    provider.enabled || provider.configured || provider.memoryBodyCount > 0 || provider.status === 'unhealthy'
  )) ?? []
  const providers = relevantProviders.slice(0, 16)
  return {
    healthy: status.healthy && unhealthy.length === 0,
    ...(status.error === undefined ? {} : { error: boundedToolText(status.error, 1_000) }),
    ...(status.version === undefined ? {} : { version: boundedToolText(status.version, 120) }),
    ...(status.dshMnemonVersion === undefined ? {} : { dshMnemonVersion: boundedToolText(status.dshMnemonVersion, 120) }),
    commandFound: status.commandFound,
    writeEnabled: status.writeEnabled,
    memorySpaces: {
      total: status.memoryBodies.length,
      active: active.length,
      healthy: active.length - unhealthy.length,
      unhealthy: unhealthy.length,
      providerDisabled: status.memoryBodies.filter(body => body.providerEnabled === false).length,
    },
    providers: providers.map(provider => ({
      providerId: provider.providerId,
      label: boundedToolText(provider.label, 120),
      enabled: provider.enabled,
      configured: provider.configured,
      status: provider.status,
      memoryBodyCount: provider.memoryBodyCount,
      activeMemoryBodyCount: provider.activeMemoryBodyCount,
      ...(provider.error === undefined ? {} : { error: boundedToolText(provider.error, 500) }),
    })),
    omittedProviderCount: Math.max(0, relevantProviders.length - providers.length),
    ...(status.stats === undefined ? {} : {
      aggregate: {
        totalInsights: status.stats.totalInsights,
        deletedInsights: status.stats.deletedInsights,
        edgeCount: status.stats.edgeCount,
        oplogCount: status.stats.oplogCount,
        dbSizeBytes: status.stats.dbSizeBytes,
      },
    }),
  }
}

/** Register a deliberately small model-facing surface over Mnemon's protocol. */
function requireAgent(exec: ToolExecution) {
  if (exec.agent === undefined) throw new Error('Mnemon semantic operations require a live DSH agent')
  return exec.agent
}

type AgentRuntimeSource = MnemonAgentRuntimeSource

interface ToolRuntime {
  service: MnemonService
  runtimeMemory: RuntimeMemoryController
  documents: DocumentManager
  memoryKernel?: MemoryKernel
  composableTurns?: ComposableMemoryTurnManager
}

function isAgentRuntimeSource(value: MnemonService | AgentRuntimeSource): value is AgentRuntimeSource {
  return 'forAgent' in value && typeof value.forAgent === 'function'
}

/** Model tools use the executing Agent's pinned runtime and deterministic service. */
export function registerTools(ctx: HostContextShape, serviceOrSource: MnemonService | AgentRuntimeSource, coordinator: MnemonSubagentCoordinator, runtimeMemory?: RuntimeMemoryController, documents?: DocumentManager): void {
  const runtimeFor = (exec: ToolExecution): ToolRuntime => {
    if (isAgentRuntimeSource(serviceOrSource)) return serviceOrSource.forAgent(requireAgent(exec))
    if (runtimeMemory === undefined || documents === undefined) throw new Error('Mnemon runtime control plane is unavailable')
    return { service: serviceOrSource, runtimeMemory, documents }
  }
  const requireLayer = (exec: ToolExecution, layerId: string, capability: MemoryCapability): ToolRuntime => {
    const runtime = runtimeFor(exec)
    if (runtime.memoryKernel !== undefined) {
      runtime.memoryKernel.assertParticipation(layerId, capability, 'automatic')
      return runtime
    }
    // Direct service injection is retained for the public/testing compatibility
    // seam. Older callers have no topology and therefore keep legacy behavior.
    const topology = runtime.service.config.memoryTopology
    if (topology === undefined) return runtime
    const configured = topology.layers[layerId]
    if (configured === undefined) throw new Error(`memory layer is not configured in the active topology: ${layerId}`)
    assertMemoryLayerParticipation({ id: layerId, ...configured }, capability, 'automatic')
    return runtime
  }
  const config = serviceOrSource.config
  const composableTurn = (exec: ToolExecution) => {
    const agent = requireAgent(exec)
    const manager = runtimeFor(exec).composableTurns
    if (manager === undefined) throw new Error('Composable Memory View is unavailable in this runtime')
    const parentId = isSubagent(agent) ? agent.session.header?.parentSession?.trim() : undefined
    const ownerId = parentId === undefined || parentId === '' ? agent.id : parentId
    const turn = manager.activeTurn(ownerId)
    if (turn === undefined) throw new Error('Composable Memory View is not pinned to the current root turn')
    return { manager, turn }
  }

  ctx.tools.register(definition({
    name: 'mnemon_view_route',
    description: 'Execute one exact Route offered in the current MNEMON VIEW ROUTES envelope. Use only ids present in that envelope; the Host binds the request to its hidden ReadGrant, enforces call/result/character budgets, and returns Evidence.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Exact View Route id.' },
        input: { type: 'object', additionalProperties: true, description: 'Route-specific JSON input described by the offered Route.' },
      },
      required: ['routeId', 'input'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    execute: (args: { routeId: string; input: MemoryJsonValue }, exec: ToolExecution) => {
      const { manager, turn } = composableTurn(exec)
      return manager.executeRoute(turn.turnId, args.routeId, args.input, exec.signal)
    },
    presentCall: (args: { routeId: string }) => ({ card: 'generic', title: 'Query composable memory', kind: 'search', rawInput: args.routeId }),
    presentResult: () => ({ card: 'generic', title: 'Composable memory evidence ready' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_view_action',
    description: 'Execute one exact Action offered in the current MNEMON VIEW ROUTES envelope. The Host rechecks write policy and authority at call time and returns a mutation Receipt; an offer is never itself authorization.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Exact View ActionOffer id.' },
        input: { type: 'object', additionalProperties: true, description: 'Action-specific JSON input described by the offered Action.' },
      },
      required: ['offerId', 'input'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    execute: (args: { offerId: string; input: MemoryJsonValue }, exec: ToolExecution) => {
      if (!config.writeEnabled) throw new Error('dsh-mnemon is configured read-only (writeEnabled: false)')
      const { manager, turn } = composableTurn(exec)
      return manager.executeAction(turn.turnId, args.offerId, args.input, offer => offer.authority === undefined, exec.signal)
    },
    presentCall: (args: { offerId: string }) => ({ card: 'generic', title: 'Apply composable memory action', kind: 'edit', rawInput: args.offerId }),
    presentResult: () => ({ card: 'generic', title: 'Composable memory receipt ready' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_memory_bodies',
    description: 'Inspect a bounded Memory Space catalog with ids, routing, capabilities, activation, and health; paths, settings, and statistics are omitted. Use only for explicit space inspection or management, or before a capability-dependent write. Never call it to route Recall: omit memoryBodyIds and mnemon_recall searches every pinned active space.',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    async execute(_args: unknown, exec: ToolExecution) {
      const runtime = runtimeFor(exec)
      const catalog = isSubagent(exec.agent)
        ? runtime.service.bodyDirectory()
        : await runtime.service.bodies(exec.signal)
      return modelBodyCatalog(catalog)
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect Mnemon Memory Spaces', kind: 'search' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Memory Spaces ready' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_recall',
    description: 'Recall bounded durable evidence from this turn\'s pinned MemorySource only when the current question needs history. The Host allows one initial query plus one LLM-chosen different-query refinement, shares one evidence envelope, validates Memory Spaces, ignores brittle semantic filters, and replays duplicate queries. Omit memoryBodyIds to search every pinned active space.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Focused natural-language memory query.' },
        mode: { type: 'string', enum: ['smart', 'keyword', 'basic'], description: 'smart=graph-enhanced default, keyword=token ranking, basic=SQL LIKE fallback.' },
        limit: { type: 'integer', description: 'Maximum number of results. The model path caps output at 6.' },
        memoryBodyIds: { type: 'array', items: { type: 'string' }, description: 'Optional known active Memory Space ids to narrow recall. Omit this field to search every pinned active space; do not list the catalog only to populate it. The Host rejects ids outside the pinned Source.' },
      },
      required: ['query'],
    },
    output: {
      schema: JSON_OBJECT_OUTPUT,
      render: (_args: unknown, value: unknown) => text(value),
    },
    async execute(args: { query: string; mode?: 'smart' | 'keyword' | 'basic'; limit?: number; memoryBodyIds?: string[] }, exec: ToolExecution) {
      requireLayer(exec, 'memory-spaces', 'recall')
      const agent = requireAgent(exec)
      return coordinator.recall(agent, args, exec.signal, { requirePinnedView: true })
    },
    presentCall: (args: { query: string }) => ({ card: 'generic', title: 'Recall Mnemon memory', kind: 'search', rawInput: args.query }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon recall complete' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_related',
    description: 'Traverse one insight admitted by this turn\'s mnemon_recall. At most one traversal is allowed per turn; use it only when the owning Memory Space reports capabilities.related=true and graph neighbors materially help. OpenViking does not currently support this operation.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Insight id returned by mnemon_recall.' },
        depth: { type: 'integer', description: 'Traversal depth. The service accepts 1 through 5.' },
        edge: { type: 'string', enum: [...EDGE_TYPES] },
        memoryBodyId: { type: 'string', description: 'Active Memory Space that returned this insight id.' },
      },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    async execute(args: { id: string; depth?: number; edge?: EdgeType; memoryBodyId?: string }, exec: ToolExecution) {
      requireLayer(exec, 'memory-spaces', 'related')
      const agent = requireAgent(exec)
      return coordinator.related(agent, args.id, args.memoryBodyId, exec.signal, {
        ...(args.depth === undefined ? {} : { depth: args.depth }),
        ...(args.edge === undefined ? {} : { edge: args.edge }),
        requirePinnedView: true,
      })
    },
    presentCall: (args: { id: string }) => ({ card: 'generic', title: 'Traverse Mnemon graph', kind: 'search', rawInput: args.id }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon graph traversal complete' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_status',
    description: 'Check a bounded health summary for memory-provider integrations and Memory Spaces. Use only when a memory operation fails or the user asks about memory health; full paths, settings, directories, and per-Space statistics stay in the control plane.',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    async execute(_args: unknown, exec: ToolExecution) {
      return modelStatus(await runtimeFor(exec).service.status(exec.signal))
    },
    presentCall: () => ({ card: 'generic', title: 'Check Mnemon status', kind: 'other' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon status checked' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_document_search',
    description: 'Run one focused search over project-scoped managed Documents before durable Recall. The Host admits only one Documents query per executing Agent turn; parallel calls share that slot, while child turns have independent budgets. Results contain bounded query-local evidence, not complete records. Cold archives are excluded unless a known archive reference requires them.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Focused natural-language or keyword query. Empty lists recent documents.' },
        includeArchived: { type: 'boolean', description: 'Include cold archived originals only for explicit deep-reference inspection.' },
        limit: { type: 'integer', description: 'Maximum results, 1 through 4 for model calls.' },
      },
      required: ['query'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    async execute(args: { query: string; includeArchived?: boolean; limit?: number }, exec: ToolExecution) {
      const agent = requireAgent(exec)
      const controller = requireLayer(exec, 'documents', 'search').documents.forAgent(agent)
      if (!coordinator.claimDocumentSearch(agent)) {
        return {
          query: args.query.trim(),
          includeArchived: args.includeArchived === true,
          notRun: true,
          results: [],
          hint: 'This Agent turn already used its Documents search slot, so no second disk query ran. Use the admitted evidence, make one focused mnemon_recall only if exact durable history is still missing, or answer with appropriate uncertainty.',
        }
      }
      const result = await controller.search(args.query, { ...(args.includeArchived === undefined ? {} : { includeArchived: args.includeArchived }), limit: Math.min(4, args.limit ?? 4) })
      const suggestions = result.results.length === 0 && args.query.trim() !== ''
        ? controller.snapshot().documents
          .filter(document => args.includeArchived === true || document.status === 'active')
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
          .slice(0, Math.min(3, args.limit ?? 3))
          .map(document => ({
            id: document.id,
            title: document.title,
            description: document.description,
            status: document.status,
            excerpt: document.excerpt,
          }))
        : []
      return {
        ...modelDocumentSearch(result),
        ...(suggestions.length === 0 ? {} : {
          suggestions,
          suggestionHint: 'No exact match. Use one focused mnemon_recall rather than repeating Document search.',
        }),
      }
    },
    presentCall: (args: { query: string }) => ({ card: 'generic', title: 'Search Mnemon Documents', kind: 'search', rawInput: args.query }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Documents ready' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_document_manage',
    description: 'Create or update one managed project Document through the Mnemon Documents control plane. Use for substantial reusable project knowledge, not user-profile preferences, routine progress, raw transcripts, secrets, or small hot-memory facts. Source paths are references inside the workspace and are never edited. Archive is allowed only from a root request and first writes a durable Mnemon cold-reference through an isolated subagent.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'archive'] },
        id: { type: 'string', description: 'Required for update and archive.' },
        title: { type: 'string', description: 'Meaningful project-document title. Required for create.' },
        description: { type: 'string', description: 'Concise routing description.' },
        content: { type: 'string', description: 'Managed Markdown body. Required for create.' },
        sourcePaths: { type: 'array', items: { type: 'string' }, description: 'Read-only source paths relative to the workspace.' },
      },
      required: ['action'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    execute: (args: { action: 'create' | 'update' | 'archive'; id?: string; title?: string; description?: string; content?: string; sourcePaths?: string[] }, exec: ToolExecution) => {
      if (!config.writeEnabled) throw new Error('dsh-mnemon is configured read-only (writeEnabled: false)')
      const agent = requireAgent(exec)
      if (args.action === 'archive') {
        requireLayer(exec, 'documents', 'archive')
        requireLayer(exec, 'memory-spaces', 'write')
        if (isSubagent(agent)) throw new Error('idle document workers cannot cold-archive directly')
        if (args.id === undefined) throw new Error('document id is required for archive')
        return coordinator.archiveDocument(agent, args.id, exec.signal)
      }
      const controller = requireLayer(exec, 'documents', 'write').documents.forAgent(agent)
      const request: DocumentMutation = args.action === 'create'
        ? { action: 'create', title: args.title ?? '', content: args.content ?? '', ...(args.description === undefined ? {} : { description: args.description }), ...(args.sourcePaths === undefined ? {} : { sourcePaths: args.sourcePaths }), sessionIds: [agent.id] }
        : { action: 'update', id: args.id ?? '', ...(args.title === undefined ? {} : { title: args.title }), ...(args.description === undefined ? {} : { description: args.description }), ...(args.content === undefined ? {} : { content: args.content }), ...(args.sourcePaths === undefined ? {} : { sourcePaths: args.sourcePaths }), sessionIds: [agent.id] }
      return isSubagent(agent) ? controller.mutate(request) : coordinator.document(agent, request, exec.signal)
    },
    presentCall: (args: { action: string; title?: string }) => ({ card: 'generic', title: `${args.action} Mnemon Document`, kind: 'edit', ...(args.title === undefined ? {} : { rawInput: args.title }) }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Document processed' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_runtime_memory',
    description: 'Maintain compact hot memory injected into future turns. Write only new reusable facts supplied or corrected by the user, or information the user explicitly asks to save. Never copy, promote, or summarize evidence returned by Documents, Recall, or Related unless the user explicitly asks to save that exact evidence; answering a read question must stay read-only. add creates one independent fact; replace corrects or consolidates one uniquely matched entry; remove is only for an explicitly withdrawn, obsolete, or wrong entry. target=user is only for who the user is; target=memory is for project/environment/decisions/lessons. Skip questions, guesses, assistant-authored claims, temporary progress, completed-work logs, raw dumps, secrets, rediscoverable facts, and skill-covered guidance. This tool exclusively writes runtime MEMORY.md and USER.md; capacity archival and compaction are automatic. Optional branches (git branch names, target=memory only) project an entry only in sessions on those branches: use them for branch-specific decisions and experiments, tag new branch-scoped entries with the git branch reported in the snapshot header, omit for cross-branch facts; on replace an empty list clears the scope, and an omitted list keeps the current scope.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'add a new entry, replace one uniquely matched entry, or remove one uniquely matched entry.' },
        target: { type: 'string', enum: ['memory', 'user'], description: 'user for user identity/preferences; memory for project, environment, decisions, and lessons.' },
        content: { type: 'string', description: 'Compact entry content. Required for add and replace.' },
        old_text: { type: 'string', description: 'Unique substring of the existing entry. Required for replace and remove.' },
        importance: { type: 'string', enum: ['critical', 'normal', 'low'], description: 'critical for explicit must/always/never rules; low for transient facts; normal by default.' },
        branches: { type: 'array', items: { type: 'string' }, description: 'Optional git branch names restricting where a target=memory entry is injected. Omit for cross-branch facts; on replace an empty list clears the scope and an omitted list keeps it. Never accepted for target=user.' },
      },
      required: ['action', 'target'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    execute: (args: { action: 'add' | 'replace' | 'remove'; target: RuntimeMemoryTarget; content?: string; old_text?: string; importance?: RuntimeMemoryImportance; branches?: string[] }, exec: ToolExecution) => {
      if (!config.writeEnabled) throw new Error('dsh-mnemon is configured read-only (writeEnabled: false)')
      const runtime = requireLayer(exec, 'runtime', 'write')
      const request = {
        action: args.action,
        target: args.target,
        ...(args.content === undefined ? {} : { content: args.content }),
        ...(args.old_text === undefined ? {} : { oldText: args.old_text }),
        ...(args.importance === undefined ? {} : { importance: args.importance }),
        ...(args.branches === undefined ? {} : { branches: args.branches }),
      }
      return isSubagent(exec.agent) ? runtime.runtimeMemory.mutate(request) : coordinator.runtime(requireAgent(exec), request, exec.signal)
    },
    presentCall: (args: { action: string; target: string }) => ({ card: 'generic', title: `${args.action} runtime ${args.target} memory`, kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Runtime memory updated' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_remember',
    description: 'Archive one durable insight in a selected provider-backed Memory Space. Ordinary new hot memory belongs in mnemon_runtime_memory; use direct archival only for explicit long-term persistence or runtime capacity migration. Choose the narrowest existing space, search it first, verify capabilities.remember=true, and wait for the provider receipt. OpenViking writes are asynchronous semantic extraction and may truthfully return skipped. Do not dump transcripts, temporary progress, routine observations, or repository-obvious facts.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'One concise, self-contained durable insight.' },
        category: { type: 'string', enum: [...CATEGORIES] },
        importance: { type: 'integer', description: 'Durable value from 1 through 5.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'At most 20 concise tags.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'At most 50 named entities.' },
        source: { type: 'string', enum: [...SOURCES], description: 'Defaults to agent for model-authored writeback.' },
        memoryBodyId: { type: 'string', description: 'Target Memory Space id. Required unless exactly one space is active.' },
      },
      required: ['content'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    async execute(args: { content: string; category?: Category; importance?: number; tags?: string[]; entities?: string[]; source?: Source; memoryBodyId?: string }, exec: ToolExecution) {
      const runtime = requireLayer(exec, 'memory-spaces', 'write')
      const request = { ...args, source: args.source ?? 'agent' }
      return isSubagent(exec.agent)
        ? runtime.service.remember(request, exec.signal)
        : coordinator.remember(requireAgent(exec), request, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Write Mnemon memory', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon memory processed' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_link',
    description: 'Create a typed, bidirectional relation between two known insights in one Memory Space. Use only when its provider reports capabilities.link=true (currently Mnemon Native), the relation improves future recall, and both ids were verified through recall or graph traversal.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
        type: { type: 'string', enum: [...EDGE_TYPES] },
        weight: { type: 'number', description: 'Relationship confidence from 0 through 1.' },
        reason: { type: 'string' },
        memoryBodyId: { type: 'string', description: 'Body containing both insight ids.' },
      },
      required: ['sourceId', 'targetId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    async execute(args: { sourceId: string; targetId: string; type?: EdgeType; weight?: number; reason?: string; memoryBodyId?: string }, exec: ToolExecution) {
      const runtime = requireLayer(exec, 'memory-spaces', 'link')
      return isSubagent(exec.agent)
        ? runtime.service.link(args.sourceId, args.targetId, args.type, args.weight, args.reason, exec.signal, args.memoryBodyId)
        : coordinator.write(requireAgent(exec), 'link', args, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Link Mnemon insights', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon insights linked' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_forget',
    description: 'Forget one insight by exact id only when its provider reports capabilities.forget=true (currently Mnemon Native soft-delete). This is a destructive semantic operation; use only when the user explicitly asks or the insight is verified obsolete or incorrect.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, memoryBodyId: { type: 'string', description: 'Body containing the insight id.' } },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    execute: (args: { id: string; memoryBodyId?: string }, exec: ToolExecution) => {
      const runtime = requireLayer(exec, 'memory-spaces', 'forget')
      return isSubagent(exec.agent)
        ? runtime.service.forget(args.id, exec.signal, args.memoryBodyId)
        : coordinator.write(requireAgent(exec), 'forget', args, exec.signal)
    },
    presentCall: (args: { id: string }) => ({ card: 'generic', title: 'Forget Mnemon insight', kind: 'edit', rawInput: args.id }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon insight forgotten' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_memory_body_create',
    description: 'Create a new isolated Memory Space under the user-configured persistence strategy. First inspect mnemon_memory_bodies.persistenceStrategy. In manual mode the host fixes the Provider. In automatic mode select only an eligible configured Provider from that policy and supply a concise reason and confidence; the host validates every hard rule and injects saved connection settings. Never invent credentials or endpoints. Use only for a distinct recurring durable scope, then write the qualifying insight with mnemon_remember, which activates it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Topic-specific human-readable name that remains meaningful in the directory.' },
        description: { type: 'string', description: 'Precise routing boundary: what durable knowledge belongs here and when it should be recalled.' },
        providerId: { type: 'string', enum: ['mnemon-native', 'openviking', 'honcho', 'mem0', 'hindsight', 'holographic', 'retaindb', 'byterover', 'supermemory'], description: 'Automatic mode only: one eligible Provider id from persistenceStrategy.' },
        reason: { type: 'string', description: 'Automatic mode only: concise user-facing reason for this Provider choice.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Automatic mode only: calibrated confidence in the Provider choice.' },
      },
      required: ['name', 'description'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    execute: (args: { name: string; description: string; providerId?: string; reason?: string; confidence?: string }, exec: ToolExecution) => {
      const runtime = requireLayer(exec, 'memory-spaces', 'write')
      return isSubagent(exec.agent)
      ? runtime.service.createBodyForPersistence(args, args.providerId === undefined && args.reason === undefined && args.confidence === undefined ? undefined : {
          providerId: args.providerId ?? '',
          reason: args.reason ?? '',
          confidence: args.confidence ?? '',
        }, exec.signal, { runId: requireAgent(exec).id, provider: 'supervised-writeback' })
      : coordinator.write(requireAgent(exec), 'create-memory-body', args, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Create Memory Space', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Memory Space created' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_memory_body_update',
    description: 'Update a Memory Space name, routing description, or activation state. Activation controls reads only. Use conservatively; prefer the user-facing toggle for ordinary manual activation changes.',
    parameters: {
      type: 'object',
      properties: {
        memoryBodyId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        active: { type: 'boolean' },
      },
      required: ['memoryBodyId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    execute: (args: { memoryBodyId: string; name?: string; description?: string; active?: boolean }, exec: ToolExecution) => {
      const runtime = requireLayer(exec, 'memory-spaces', 'write')
      return isSubagent(exec.agent)
        ? runtime.service.updateBody(args.memoryBodyId, args)
        : coordinator.write(requireAgent(exec), 'update-memory-body', args, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Update Mnemon Memory Space', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Memory Space updated' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemon_memory_body_merge',
    description: 'Non-destructively merge complete Mnemon Native source Memory Spaces into one Mnemon Native target through import, preserving durable nodes and typed graph edges. External providers are not mergeable. Use only after confirming substantial scope overlap or when the user requests consolidation. Source databases are retained and merely deactivated by default.',
    parameters: {
      type: 'object',
      properties: {
        targetMemoryBodyId: { type: 'string' },
        sourceMemoryBodyIds: { type: 'array', items: { type: 'string' }, description: 'One through 20 source Memory Space ids.' },
        deactivateSources: { type: 'boolean', description: 'Defaults to true. Never deletes source databases.' },
      },
      required: ['targetMemoryBodyId', 'sourceMemoryBodyIds'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    execute: (args: { targetMemoryBodyId: string; sourceMemoryBodyIds: string[]; deactivateSources?: boolean }, exec: ToolExecution) => {
      const runtime = requireLayer(exec, 'memory-spaces', 'write')
      return isSubagent(exec.agent)
        ? runtime.service.mergeBodies(args.targetMemoryBodyId, args.sourceMemoryBodyIds, args.deactivateSources ?? true, exec.signal)
        : coordinator.write(requireAgent(exec), 'merge-memory-bodies', args, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Merge Mnemon Memory Spaces', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Memory Spaces merged' }),
  } as never))
}
