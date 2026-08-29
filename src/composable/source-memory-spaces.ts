import { randomUUID } from 'node:crypto'
import type {
  MemoryCapability,
  MemoryEvidence,
  MemoryJsonValue,
  MemoryReadGrant,
  MemorySourceDefinition,
  MemorySourceFacts,
  MemorySourceManagementRequest,
  MemorySourceManagementResult,
} from '../../packages/contracts/src/index.ts'
import { COMPOSABLE_MEMORY_API_VERSION } from '../../packages/contracts/src/index.ts'
import { defineMemorySource } from '../../packages/kernel/src/index.ts'
import type { MnemonService } from '../service.ts'
import type { MemoryProviderAdapterRegistry } from '../providers/registry.ts'
import type { MemorySpaceProviderSnapshot } from '../memory-spaces/provider-sdk.ts'
import type {
  Category,
  CreateMemoryBodyRequest,
  EdgeType,
  Intent,
  MemoryPlacementDecision,
  MemoryProviderConnection,
  MemoryProviderId,
  Source,
  UpdateMemoryBodyRequest,
} from '../shared/contracts.ts'
import { BUILTIN_MEMORY_BINDINGS } from './bindings.ts'
import { integer, receipt, record, stringArray, text, truncate } from './shared.ts'

const CATEGORIES = new Set<Category>(['preference', 'decision', 'fact', 'insight', 'context', 'general'])
const SOURCES = new Set<Source>(['user', 'agent', 'external'])
const INTENTS = new Set<Intent>(['WHY', 'WHEN', 'ENTITY', 'GENERAL'])
const EDGES = new Set<EdgeType>(['temporal', 'semantic', 'causal', 'entity'])

function grantIds(grant: MemoryReadGrant): string[] {
  return stringArray(record(grant.value, 'Memory Spaces ReadGrant').memoryBodyIds, 'memoryBodyIds', 10_000) ?? []
}

function grantFor(view: { readGrants: MemoryReadGrant[] }, sourceInstanceKey: string): MemoryReadGrant {
  const grant = view.readGrants.find(candidate => candidate.sourceInstanceKey === sourceInstanceKey)
  if (grant === undefined) throw new Error('Memory Spaces action has no View ReadGrant')
  return grant
}

function scalarRecord(value: MemoryJsonValue | undefined, label: string): MemoryProviderConnection | undefined {
  if (value === undefined) return undefined
  const input = record(value, label)
  const result: MemoryProviderConnection = {}
  for (const [key, item] of Object.entries(input)) {
    if (!/^[a-z][a-zA-Z0-9_-]{0,127}$/u.test(key)) throw new Error(`${label} contains an invalid field: ${key}`)
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`${label}.${key} must be a string, number, or boolean`)
    }
    result[key] = item
  }
  return result
}

function providerConnections(value: MemoryJsonValue | undefined): Record<MemoryProviderId, MemoryProviderConnection> | undefined {
  if (value === undefined) return undefined
  const input = record(value, 'providerConnections')
  return Object.fromEntries(Object.entries(input).map(([providerId, connection]) => [
    text(providerId, 'providerId', 128)!,
    scalarRecord(connection, `providerConnections.${providerId}`)!,
  ]))
}

function createBodyRequest(value: MemoryJsonValue): CreateMemoryBodyRequest {
  const input = record(value, 'Memory Space body-create request')
  const providerId = text(input.providerId, 'providerId', 128, false) as MemoryProviderId | undefined
  const connection = scalarRecord(input.connection, 'connection')
  const connections = providerConnections(input.providerConnections)
  const placementValue = input.placement === undefined ? undefined : record(input.placement, 'placement')
  const rulesValue = placementValue?.rules === undefined ? undefined : record(placementValue.rules, 'placement.rules')
  const allowedProviderIds = rulesValue === undefined ? undefined : stringArray(rulesValue.allowedProviderIds, 'placement.rules.allowedProviderIds', 100)
  const requiredCapabilities = rulesValue === undefined ? undefined : stringArray(rulesValue.requiredCapabilities, 'placement.rules.requiredCapabilities', 20)
  const placement: CreateMemoryBodyRequest['placement'] = placementValue === undefined ? undefined : {
    mode: text(placementValue.mode, 'placement.mode', 20)! as 'automatic',
    ...(text(placementValue.prompt, 'placement.prompt', 4_000, false) === undefined ? {} : { prompt: text(placementValue.prompt, 'placement.prompt', 4_000, false)! }),
    ...(rulesValue === undefined ? {} : {
      rules: {
        ...(allowedProviderIds === undefined ? {} : { allowedProviderIds }),
        ...(text(rulesValue.dataBoundary, 'placement.rules.dataBoundary', 30, false) === undefined ? {} : { dataBoundary: text(rulesValue.dataBoundary, 'placement.rules.dataBoundary', 30, false)! as 'allow-remote' | 'local-only' }),
        ...(requiredCapabilities === undefined ? {} : { requiredCapabilities: requiredCapabilities as NonNullable<NonNullable<NonNullable<CreateMemoryBodyRequest['placement']>['rules']>['requiredCapabilities']> }),
        ...(text(rulesValue.preference, 'placement.rules.preference', 30, false) === undefined ? {} : { preference: text(rulesValue.preference, 'placement.rules.preference', 30, false)! as 'balanced' | 'local-first' | 'shared-first' }),
      },
    }),
  }
  return {
    name: text(input.name, 'name', 100)!,
    description: text(input.description, 'description', 1_000)!,
    ...(typeof input.active !== 'boolean' ? {} : { active: input.active }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(connection === undefined ? {} : { connection }),
    ...(connections === undefined ? {} : { providerConnections: connections }),
    ...(placement === undefined ? {} : { placement }),
  }
}

function updateBodyRequest(value: MemoryJsonValue): { memoryBodyId: string; request: UpdateMemoryBodyRequest } {
  const input = record(value, 'Memory Space body-update request')
  const connection = scalarRecord(input.connection, 'connection')
  return {
    memoryBodyId: text(input.memoryBodyId, 'memoryBodyId', 300)!,
    request: {
      ...(text(input.name, 'name', 100, false) === undefined ? {} : { name: text(input.name, 'name', 100, false)! }),
      ...(text(input.description, 'description', 1_000, false) === undefined ? {} : { description: text(input.description, 'description', 1_000, false)! }),
      ...(typeof input.active !== 'boolean' ? {} : { active: input.active }),
      ...(connection === undefined ? {} : { connection }),
      ...(stringArray(input.clearSecrets, 'clearSecrets', 100) === undefined ? {} : { clearSecrets: stringArray(input.clearSecrets, 'clearSecrets', 100)! }),
    },
  }
}

function placementDecision(value: MemoryJsonValue | undefined): MemoryPlacementDecision | undefined {
  if (value === undefined) return undefined
  const input = record(value, 'Memory Space placement decision')
  return {
    mode: text(input.mode, 'placement decision mode', 20)! as 'automatic',
    providerId: text(input.providerId, 'placement decision providerId', 128)!,
    decidedBy: text(input.decidedBy, 'placement decision decidedBy', 20)! as 'rules' | 'llm',
    reason: text(input.reason, 'placement decision reason', 1_000)!,
    confidence: text(input.confidence, 'placement decision confidence', 20)! as 'high' | 'medium' | 'low',
    candidateProviderIds: stringArray(input.candidateProviderIds, 'placement decision candidateProviderIds', 100)!,
    appliedRules: stringArray(input.appliedRules, 'placement decision appliedRules', 100)!,
    decidedAt: text(input.decidedAt, 'placement decision decidedAt', 100)!,
    ...(text(input.runId, 'placement decision runId', 500, false) === undefined ? {} : { runId: text(input.runId, 'placement decision runId', 500, false)! }),
    ...(text(input.subagentProvider, 'placement decision subagentProvider', 500, false) === undefined ? {} : { subagentProvider: text(input.subagentProvider, 'placement decision subagentProvider', 500, false)! }),
  }
}

function managementResult(service: MnemonService, value: unknown): MemorySourceManagementResult {
  return { revision: service.memoryRevision(), value: value as MemoryJsonValue }
}

async function manageMemorySpaces(service: MnemonService, request: MemorySourceManagementRequest): Promise<MemorySourceManagementResult> {
  const input = request.input === null ? {} : record(request.input, `Memory Spaces management ${request.operation}`)
  if (request.mode === 'read') {
    switch (request.operation) {
      case 'status-summary': return managementResult(service, service.statusSummary())
      case 'status': return managementResult(service, await service.status(request.signal))
      case 'body-directory': return managementResult(service, service.bodyDirectory())
      case 'bodies': return managementResult(service, await service.bodies(request.signal))
      // Management output is always sanitized. Configured secret names may be
      // shown, but credential values never cross the Host/Client boundary.
      case 'provider-services': return managementResult(service, service.memoryBodies.providerServices())
      case 'graph': return managementResult(service, await service.graph(request.signal, stringArray(input.memoryBodyIds, 'memoryBodyIds', 10_000)))
      case 'list': return managementResult(service, await service.list({
        ...(text(input.query, 'query', 2_000, false) === undefined ? {} : { query: text(input.query, 'query', 2_000, false)! }),
        ...(text(input.category, 'category', 30, false) === undefined ? {} : { category: text(input.category, 'category', 30, false)! as Category }),
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, 100, 1, 10_000) }),
        ...(stringArray(input.memoryBodyIds, 'memoryBodyIds', 10_000) === undefined ? {} : { memoryBodyIds: stringArray(input.memoryBodyIds, 'memoryBodyIds', 10_000)! }),
      }, request.signal))
      case 'entities': return managementResult(service, await service.entities(
        text(input.entity, 'entity', 500, false),
        input.limit === undefined ? undefined : integer(input.limit, 100, 1, 10_000),
        request.signal,
      ))
      case 'search': return managementResult(service, await service.search({
        query: text(input.query, 'query', 2_000)!,
        ...(text(input.mode, 'mode', 20, false) === undefined ? {} : { mode: text(input.mode, 'mode', 20, false)! as 'smart' | 'keyword' | 'basic' }),
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, 10, 1, 1_000) }),
        ...(text(input.category, 'category', 30, false) === undefined ? {} : { category: text(input.category, 'category', 30, false)! as Category }),
        ...(text(input.source, 'source', 30, false) === undefined ? {} : { source: text(input.source, 'source', 30, false)! as Source }),
        ...(text(input.intent, 'intent', 30, false) === undefined ? {} : { intent: text(input.intent, 'intent', 30, false)! as Intent }),
        ...(stringArray(input.memoryBodyIds, 'memoryBodyIds', 10_000) === undefined ? {} : { memoryBodyIds: stringArray(input.memoryBodyIds, 'memoryBodyIds', 10_000)! }),
      }, request.signal))
      case 'related': return managementResult(service, await service.related(
        text(input.id, 'id', 2_000)!,
        integer(input.depth, 2, 1, 5),
        text(input.edge, 'edge', 30, false) as EdgeType | undefined,
        request.signal,
        text(input.memoryBodyId, 'memoryBodyId', 300, false),
      ))
      case 'body-reconnect': return managementResult(service, await service.reconnectBody(text(input.memoryBodyId, 'memoryBodyId', 300)!, request.signal))
      case 'prepare-body-placement': return managementResult(service, service.prepareBodyPlacement(createBodyRequest(request.input)))
      default: throw new Error(`unsupported Memory Spaces management read operation: ${request.operation}`)
    }
  }

  if (!request.confirmed) throw new Error('Memory Spaces management mutation requires explicit confirmation')
  switch (request.operation) {
    case 'provider-service-update': {
      const providerId = text(input.providerId, 'providerId', 128)!
      await service.updateProviderService(
        providerId,
        scalarRecord(input.settings, 'settings') ?? {},
        stringArray(input.clearSecrets, 'clearSecrets', 100) ?? [],
        input.enabled === undefined ? true : input.enabled === true,
        request.signal,
      )
      return managementResult(service, service.memoryBodies.providerServices().items.find(item => item.providerId === providerId)!)
    }
    case 'remember': return managementResult(service, await service.remember({
      content: text(input.content, 'content', 100_000)!,
      ...(text(input.category, 'category', 30, false) === undefined ? {} : { category: text(input.category, 'category', 30, false)! as Category }),
      ...(typeof input.importance !== 'number' ? {} : { importance: input.importance }),
      ...(stringArray(input.tags, 'tags', 100) === undefined ? {} : { tags: stringArray(input.tags, 'tags', 100)! }),
      ...(stringArray(input.entities, 'entities', 100) === undefined ? {} : { entities: stringArray(input.entities, 'entities', 100)! }),
      ...(text(input.source, 'source', 30, false) === undefined ? {} : { source: text(input.source, 'source', 30, false)! as Source }),
      ...(text(input.memoryBodyId, 'memoryBodyId', 300, false) === undefined ? {} : { memoryBodyId: text(input.memoryBodyId, 'memoryBodyId', 300, false)! }),
    }, request.signal))
    case 'link': return managementResult(service, await service.link(
      text(input.sourceId, 'sourceId', 2_000)!,
      text(input.targetId, 'targetId', 2_000)!,
      (text(input.type, 'type', 30, false) ?? 'semantic') as EdgeType,
      typeof input.weight === 'number' ? input.weight : 0.5,
      text(input.reason, 'reason', 1_000, false),
      request.signal,
      text(input.memoryBodyId, 'memoryBodyId', 300, false),
    ))
    case 'forget': return managementResult(service, await service.forget(
      text(input.id, 'id', 2_000)!,
      request.signal,
      text(input.memoryBodyId, 'memoryBodyId', 300, false),
    ))
    case 'body-create': {
      const bodyInput = input.request ?? request.input
      const body = await service.createBody(createBodyRequest(bodyInput), request.signal, placementDecision(input.placementDecision))
      return managementResult(service, body)
    }
    case 'body-update': {
      const parsed = updateBodyRequest(request.input)
      return managementResult(service, service.updateBody(parsed.memoryBodyId, parsed.request))
    }
    case 'body-delete': return managementResult(service, await service.deleteBody(text(input.memoryBodyId, 'memoryBodyId', 300)!, request.signal))
    default: throw new Error(`unsupported Memory Spaces management mutation operation: ${request.operation}`)
  }
}

export function createMemorySpacesSource(providerInput?: MemoryProviderAdapterRegistry | MemorySpaceProviderSnapshot): MemorySourceDefinition {
  return defineMemorySource({
  manifest: {
    apiVersion: COMPOSABLE_MEMORY_API_VERSION,
    kind: 'source',
    typeId: 'memory-spaces',
    packageName: 'dsh-mnemon-source-memory-spaces',
    role: 'durable-evidence',
    capabilities: ['status', 'project', 'recall', 'related', 'write', 'link', 'forget'],
    consistency: 'namespace-pinned-live-read',
    routes: [
      {
        id: 'recall', description: 'Recall evidence only from Memory Spaces pinned into this View.', capability: 'recall',
        inputSchema: {
          type: 'object', required: ['query'], additionalProperties: false,
          properties: {
            query: { type: 'string' }, mode: { type: 'string', enum: ['smart', 'keyword', 'basic'] }, limit: { type: 'integer' },
            category: { type: 'string' }, source: { type: 'string' }, intent: { type: 'string' },
          },
        },
        maxCalls: 4, maxResults: 20, maxCharacters: 16_000,
      },
      {
        id: 'related', description: 'Traverse related memories only from evidence already admitted by this View.', capability: 'related',
        inputSchema: {
          type: 'object', required: ['id'], additionalProperties: false,
          properties: { id: { type: 'string' }, depth: { type: 'integer' }, edge: { type: 'string' } },
        },
        maxCalls: 4, maxResults: 20, maxCharacters: 16_000,
      },
    ],
    actions: [
      {
        id: 'remember', description: 'Persist an exact memory in a Memory Space authorized for this View.', capability: 'write',
        inputSchema: {
          type: 'object', required: ['content'], additionalProperties: false,
          properties: {
            content: { type: 'string' }, category: { type: 'string' }, importance: { type: 'number' }, tags: { type: 'array' },
            entities: { type: 'array' }, source: { type: 'string' }, memoryBodyId: { type: 'string' },
          },
        },
      },
      {
        id: 'link', description: 'Link two evidence items admitted by this View and owned by the same Memory Space.', capability: 'link',
        inputSchema: {
          type: 'object', required: ['sourceId', 'targetId'], additionalProperties: false,
          properties: { sourceId: { type: 'string' }, targetId: { type: 'string' }, type: { type: 'string' }, weight: { type: 'number' }, reason: { type: 'string' } },
        },
      },
      {
        id: 'forget', description: 'Forget one evidence item admitted by this View.', capability: 'forget',
        inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } },
      },
    ],
    management: {
      label: 'Memory Spaces',
      description: 'Durable evidence across local and remote Provider-backed namespaces.',
    },
  },
  create(context) {
    const hostService = context.binding<MnemonService>(BUILTIN_MEMORY_BINDINGS.memorySpaces)
    if (hostService === undefined) throw new Error('Memory Spaces Source requires its private Host binding')
    const providerSnapshot = providerInput !== undefined && 'adapterRegistry' in providerInput ? providerInput : undefined
    const providerRegistry = providerSnapshot?.adapterRegistry() ?? providerInput as MemoryProviderAdapterRegistry | undefined
    const service = providerRegistry === undefined
      ? hostService
      : hostService.withProviderAdapterRegistry(providerRegistry, providerSnapshot?.descriptors())
    const ownsService = providerRegistry !== undefined
    let prepared: { all: ReturnType<typeof service.memoryBodies.list>; active: ReturnType<typeof service.memoryBodies.active>; revision: string } | undefined
    const sourceState = () => {
      const value = { all: service.memoryBodies.list(), active: service.memoryBodies.active().sort((left, right) => left.id.localeCompare(right.id)), revision: service.memoryRevision() }
      prepared = value
      return value
    }
    const admittedByView = new Map<string, Map<string, string>>()
    const admit = (viewId: string, entries: Array<{ id: string; memoryBodyId?: string }>): void => {
      const current = admittedByView.get(viewId) ?? new Map<string, string>()
      for (const entry of entries) if (entry.memoryBodyId !== undefined) current.set(entry.id, entry.memoryBodyId)
      admittedByView.delete(viewId)
      admittedByView.set(viewId, current)
      while (admittedByView.size > 128) admittedByView.delete(admittedByView.keys().next().value!)
    }
    const evidence = (
      request: { view: { id: string }; route: { id: string } },
      items: Array<{ id: string; content: string; score?: number; normalizedScore?: number; createdAt?: string; memoryBodyId?: string; memoryBodyName?: string; memoryProviderId?: string; externalUri?: string }>,
      unavailable?: string,
    ): MemoryEvidence => ({
      id: `evidence:${randomUUID()}`,
      viewId: request.view.id,
      routeId: request.route.id,
      sourceInstanceKey: context.sourceInstanceKey,
      observedAt: new Date().toISOString(),
      items: items.map(item => ({
        id: item.id,
        text: item.content,
        ...(item.normalizedScore ?? item.score) === undefined ? {} : { score: item.normalizedScore ?? item.score },
        ...(item.createdAt === undefined ? {} : { revision: item.createdAt }),
        provenance: {
          ...(item.memoryBodyId === undefined ? {} : { memoryBodyId: item.memoryBodyId }),
          ...(item.memoryBodyName === undefined ? {} : { memoryBodyName: item.memoryBodyName }),
          ...(item.memoryProviderId === undefined ? {} : { providerId: item.memoryProviderId }),
          ...(item.externalUri === undefined ? {} : { externalUri: item.externalUri }),
        },
      })),
      truncated: false,
      ...(unavailable === undefined ? {} : { unavailable }),
    })
    return {
      facts(): MemorySourceFacts {
        try {
          const { active, revision } = sourceState()
          const routeIds: string[] = [
            ...(active.some(body => body.provider.capabilities.search) ? ['recall'] : []),
            ...(active.some(body => body.provider.capabilities.related) ? ['related'] : []),
          ]
          const actionIds: string[] = [
            ...(active.some(body => body.provider.capabilities.remember) ? ['remember'] : []),
            ...(active.some(body => body.provider.capabilities.link) ? ['link'] : []),
            ...(active.some(body => body.provider.capabilities.forget) ? ['forget'] : []),
          ]
          const capabilities: MemoryCapability[] = ['status', 'project']
          if (routeIds.includes('recall')) capabilities.push('recall')
          if (routeIds.includes('related')) capabilities.push('related')
          if (actionIds.includes('remember')) capabilities.push('write')
          if (actionIds.includes('link')) capabilities.push('link')
          if (actionIds.includes('forget')) capabilities.push('forget')
          return {
            sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'memory-spaces', role: 'durable-evidence',
            availability: active.length === 0 ? 'degraded' : 'ready', revision, capabilities: [...capabilities], routeIds, actionIds,
            hints: { activeCount: active.length, providerCount: new Set(active.map(body => body.provider.id)).size },
          }
        } catch (error) {
          return {
            sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'memory-spaces', role: 'durable-evidence', availability: 'unavailable',
            revision: 'unavailable:memory-spaces', capabilities: ['status'], routeIds: [], actionIds: [],
            hints: { reason: error instanceof Error ? error.message : String(error) },
          }
        }
      },
      project(request) {
        const { all, active, revision } = prepared ?? sourceState()
        prepared = undefined
        return {
          fragments: request.includeProjection ? [{
            id: `${context.sourceInstanceKey}/projection`, sourceInstanceKey: context.sourceInstanceKey, mode: request.mode,
            text: truncate(`${active.length} active of ${all.length} configured Memory Space${all.length === 1 ? '' : 's'} available through scoped recall.`, request.maxCharacters),
            revision,
            provenance: { sourceTypeId: 'memory-spaces' },
          }] : [],
          readGrant: {
            id: `${context.sourceInstanceKey}/grant/${revision}`,
            sourceInstanceKey: context.sourceInstanceKey,
            schema: 'dsh-mnemon.memory-spaces/v1',
            value: { memoryBodyIds: active.map(body => body.id) },
            revision,
            consistency: 'namespace-pinned-live-read',
          },
        }
      },
      async query(request) {
        const allowedBodies = grantIds(request.grant)
        const input = record(request.input, `Memory Spaces ${request.route.sourceRouteId}`)
        if (request.route.sourceRouteId === 'recall') {
          const category = text(input.category, 'category', 30, false) as Category | undefined
          const source = text(input.source, 'source', 30, false) as Source | undefined
          const intent = text(input.intent, 'intent', 30, false) as Intent | undefined
          if (category !== undefined && !CATEGORIES.has(category)) throw new Error(`unsupported category: ${category}`)
          if (source !== undefined && !SOURCES.has(source)) throw new Error(`unsupported source: ${source}`)
          if (intent !== undefined && !INTENTS.has(intent)) throw new Error(`unsupported intent: ${intent}`)
          const mode = text(input.mode, 'mode', 20, false) as 'smart' | 'keyword' | 'basic' | undefined
          const result = await service.search({
            query: text(input.query, 'query', 2_000)!,
            ...(mode === undefined ? {} : { mode }),
            limit: integer(input.limit, 10, 1, 20),
            memoryBodyIds: allowedBodies,
            ...(category === undefined ? {} : { category }), ...(source === undefined ? {} : { source }), ...(intent === undefined ? {} : { intent }),
          }, request.signal)
          admit(request.view.id, result.results)
          return evidence(request, result.results, result.results.length === 0 ? result.hint : undefined)
        }
        if (request.route.sourceRouteId === 'related') {
          const id = text(input.id, 'id', 2_000)!
          const owner = admittedByView.get(request.view.id)?.get(id)
          if (owner === undefined) throw new Error('related-memory traversal requires evidence already admitted by this View')
          if (!allowedBodies.includes(owner)) throw new Error('related-memory owner is outside this View ReadGrant')
          const edge = text(input.edge, 'edge', 30, false) as EdgeType | undefined
          if (edge !== undefined && !EDGES.has(edge)) throw new Error(`unsupported edge: ${edge}`)
          const results = await service.related(id, integer(input.depth, 2, 1, 5), edge, request.signal, owner)
          admit(request.view.id, results)
          return evidence(request, results)
        }
        throw new Error(`unsupported Memory Spaces Route: ${request.route.sourceRouteId}`)
      },
      async mutate(request) {
        const input = record(request.input, `Memory Spaces ${request.offer.sourceActionId}`)
        const allowedBodies = grantIds(grantFor(request.view, context.sourceInstanceKey))
        const admitted = admittedByView.get(request.view.id) ?? new Map<string, string>()
        let result: MemoryJsonValue
        let bodyId: string | undefined
        if (request.offer.sourceActionId === 'remember') {
          bodyId = text(input.memoryBodyId, 'memoryBodyId', 300, false)
          if (bodyId !== undefined && !allowedBodies.includes(bodyId)) throw new Error('remember destination is outside this View ReadGrant')
          const category = text(input.category, 'category', 30, false) as Category | undefined
          const source = text(input.source, 'source', 30, false) as Source | undefined
          if (category !== undefined && !CATEGORIES.has(category)) throw new Error(`unsupported category: ${category}`)
          if (source !== undefined && !SOURCES.has(source)) throw new Error(`unsupported source: ${source}`)
          result = await service.remember({
            content: text(input.content, 'content', 100_000)!,
            ...(category === undefined ? {} : { category }), ...(source === undefined ? {} : { source }),
            ...(typeof input.importance !== 'number' ? {} : { importance: input.importance }),
            ...(input.tags === undefined ? {} : { tags: stringArray(input.tags, 'tags') ?? [] }),
            ...(input.entities === undefined ? {} : { entities: stringArray(input.entities, 'entities') ?? [] }),
            ...(bodyId === undefined ? {} : { memoryBodyId: bodyId }),
          }, request.signal) as MemoryJsonValue
        } else if (request.offer.sourceActionId === 'link') {
          const sourceId = text(input.sourceId, 'sourceId', 2_000)!
          const targetId = text(input.targetId, 'targetId', 2_000)!
          const sourceBody = admitted.get(sourceId)
          const targetBody = admitted.get(targetId)
          if (sourceBody === undefined || targetBody === undefined || sourceBody !== targetBody || !allowedBodies.includes(sourceBody)) {
            throw new Error('link requires two evidence items admitted by this View from the same Memory Space')
          }
          bodyId = sourceBody
          const edge = text(input.type, 'type', 30, false) as EdgeType | undefined
          if (edge !== undefined && !EDGES.has(edge)) throw new Error(`unsupported edge: ${edge}`)
          const weight = typeof input.weight === 'number' ? input.weight : 0.5
          result = await service.link(sourceId, targetId, edge, weight, text(input.reason, 'reason', 1_000, false), request.signal, bodyId) as MemoryJsonValue
        } else if (request.offer.sourceActionId === 'forget') {
          const id = text(input.id, 'id', 2_000)!
          bodyId = admitted.get(id)
          if (bodyId === undefined || !allowedBodies.includes(bodyId)) throw new Error('forget requires evidence already admitted by this View')
          result = await service.forget(id, request.signal, bodyId) as MemoryJsonValue
        } else {
          throw new Error(`unsupported Memory Spaces action: ${request.offer.sourceActionId}`)
        }
        return receipt(request.view.id, request.offer.id, context.sourceInstanceKey, service.memoryRevision(), {
          memoryBodyId: bodyId ?? null,
          result,
        })
      },
      manage(request) {
        return manageMemorySpaces(service, request)
      },
      async dispose() {
        admittedByView.clear()
        if (ownsService) await service.dispose()
      },
    }
  },
  })
}

/** Compatibility definition samples the v0.3 registry through the legacy Host service. */
export const MEMORY_SPACES_SOURCE = createMemorySpacesSource()
