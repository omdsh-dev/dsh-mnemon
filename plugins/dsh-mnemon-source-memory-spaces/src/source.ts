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
  MemoryViewRoute,
} from 'dsh-mnemon/contracts'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemorySource, memoryInputInteger as integer, createMemoryMutationReceipt as receipt, memoryInputRecord as record, memoryInputStringArray as stringArray, memoryInputText as text, truncateMemoryText as truncate } from 'dsh-mnemon/extension-sdk'
import { modelSpaceCatalog, modelStatus, modelJson } from './view-model.ts'
import { MemorySpacesService, mutationResultCompletion } from './service.ts'
import { createRunner } from './runner.ts'
import { MemoryProviderCatalog } from './providers/catalog.ts'
import { finalizeLlmPlacement, rulesOnlyPlacement } from './provider-placement.ts'
import { resolveMemorySpacesConfig, type MemorySpacesConfig } from './config.ts'
import { MemorySpaceProviderSnapshot } from './providers/host.ts'
import { CATEGORIES, EDGE_TYPES, INTENTS, isNativeProvider, MEMORY_SPACE_DESCRIPTION_MAX_LENGTH, MEMORY_SPACE_NAME_MAX_LENGTH, SOURCES } from './contracts.ts'
import type {
  Category,
  CreateMemorySpaceRequest,
  EdgeType,
  Intent,
  Insight,
  MemoryPlacementDecision,
  MemoryProviderConnection,
  MemoryProviderId,
  PreparedMemoryPlacement,
  RememberRequest,
  MemorySpaceMetadataUpdate,
  Source,
  UpdateMemorySpaceRequest,
} from './contracts.ts'

const CATEGORY_SET = new Set<Category>(CATEGORIES)
const SOURCE_SET = new Set<Source>(SOURCES)
const INTENT_SET = new Set<Intent>(INTENTS)
const EDGE_SET = new Set<EdgeType>(EDGE_TYPES)

function grantIds(grant: MemoryReadGrant): string[] {
  return stringArray(record(grant.value, 'Memory Spaces ReadGrant').memoryBodyIds, 'memoryBodyIds', 10_000) ?? []
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

function createSpaceRequest(value: MemoryJsonValue): CreateMemorySpaceRequest {
  const input = record(value, 'Memory Space body-create request')
  const providerId = text(input.providerId, 'providerId', 128, false) as MemoryProviderId | undefined
  const connection = scalarRecord(input.connection, 'connection')
  const connections = providerConnections(input.providerConnections)
  const placementValue = input.placement === undefined ? undefined : record(input.placement, 'placement')
  const rulesValue = placementValue?.rules === undefined ? undefined : record(placementValue.rules, 'placement.rules')
  const allowedProviderIds = rulesValue === undefined ? undefined : stringArray(rulesValue.allowedProviderIds, 'placement.rules.allowedProviderIds', 100)
  const requiredCapabilities = rulesValue === undefined ? undefined : stringArray(rulesValue.requiredCapabilities, 'placement.rules.requiredCapabilities', 20)
  const placement: CreateMemorySpaceRequest['placement'] = placementValue === undefined ? undefined : {
    mode: text(placementValue.mode, 'placement.mode', 20)! as 'automatic',
    ...(text(placementValue.prompt, 'placement.prompt', 4_000, false) === undefined ? {} : { prompt: text(placementValue.prompt, 'placement.prompt', 4_000, false)! }),
    ...(rulesValue === undefined ? {} : {
      rules: {
        ...(allowedProviderIds === undefined ? {} : { allowedProviderIds }),
        ...(text(rulesValue.dataBoundary, 'placement.rules.dataBoundary', 30, false) === undefined ? {} : { dataBoundary: text(rulesValue.dataBoundary, 'placement.rules.dataBoundary', 30, false)! as 'allow-remote' | 'local-only' }),
        ...(requiredCapabilities === undefined ? {} : { requiredCapabilities: requiredCapabilities as NonNullable<NonNullable<NonNullable<CreateMemorySpaceRequest['placement']>['rules']>['requiredCapabilities']> }),
        ...(text(rulesValue.preference, 'placement.rules.preference', 30, false) === undefined ? {} : { preference: text(rulesValue.preference, 'placement.rules.preference', 30, false)! as 'balanced' | 'local-first' | 'shared-first' }),
      },
    }),
  }
  return {
    name: text(input.name, 'name', MEMORY_SPACE_NAME_MAX_LENGTH)!,
    description: text(input.description, 'description', MEMORY_SPACE_DESCRIPTION_MAX_LENGTH)!,
    ...(typeof input.active !== 'boolean' ? {} : { active: input.active }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(connection === undefined ? {} : { connection }),
    ...(connections === undefined ? {} : { providerConnections: connections }),
    ...(placement === undefined ? {} : { placement }),
  }
}

function updateSpaceRequest(value: MemoryJsonValue): { memoryBodyId: string; request: UpdateMemorySpaceRequest } {
  const input = record(value, 'Memory Space body-update request')
  const connection = scalarRecord(input.connection, 'connection')
  return {
    memoryBodyId: text(input.memoryBodyId, 'memoryBodyId', 300)!,
    request: {
      ...(text(input.name, 'name', MEMORY_SPACE_NAME_MAX_LENGTH, false) === undefined ? {} : { name: text(input.name, 'name', MEMORY_SPACE_NAME_MAX_LENGTH, false)! }),
      ...(text(input.description, 'description', MEMORY_SPACE_DESCRIPTION_MAX_LENGTH, false) === undefined ? {} : { description: text(input.description, 'description', MEMORY_SPACE_DESCRIPTION_MAX_LENGTH, false)! }),
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

/**
 * Why this turn's View cannot forget from a Memory Space it does not read (#390). The View is
 * pinned for the turn, so switching a space on reaches a forget from the next turn only, and
 * whether a space is on stays the user's choice.
 */
function outsideView(service: MemorySpacesService, memoryBodyId: string): string {
  const catalog = service.spaceDirectory()
  const body = catalog.items.find(candidate => candidate.id === memoryBodyId)
  if (body === undefined) return `Memory Space ${JSON.stringify(memoryBodyId)} does not exist`
  const space = `Memory Space ${JSON.stringify(memoryBodyId)} (${body.name})`
  if (!body.active) return `${space} is switched off, so this turn's View does not read it and cannot forget from it. Whether it is on is the user's choice, on the Memory Spaces page; once it is on, a forget there works from the next turn`
  if (body.providerEnabled === false) return `${space} uses ${body.provider.label}, which is turned off on the dsh-mnemon page under Plugins`
  const provider = catalog.providers.find(candidate => candidate.id === body.provider.id)
  if (provider?.serviceConfigured === false) return `${space} uses ${body.provider.label}, which is not available here${isNativeProvider(provider) ? ': the Mnemon CLI is not installed' : ''}`
  return `${space} was switched on after this turn began, so this turn's View does not read it yet; a forget there works from the next turn`
}

/** The switched-off spaces a forget cannot reach this turn, named only when there are some (#390). */
function switchedOffSpaces(service: MemorySpacesService): string {
  const off = service.spaceDirectory().items.filter(body => !body.active)
  if (off.length === 0) return ''
  const names = off.slice(0, 5).map(body => JSON.stringify(body.name)).join(', ')
  return `. Switched-off spaces (${names}${off.length > 5 ? ` and ${off.length - 5} more` : ''}) are outside this View; one the user switches on is read from the next turn`
}

function managementResult(service: MemorySpacesService, value: unknown): MemorySourceManagementResult {
  return { revision: service.memoryRevision(), value: value as MemoryJsonValue }
}

async function manageMemorySpaces(service: MemorySpacesService, request: MemorySourceManagementRequest): Promise<MemorySourceManagementResult> {
  const input = request.input === null ? {} : record(request.input, `Memory Spaces management ${request.operation}`)
  if (request.mode === 'read') {
    switch (request.operation) {
      case 'embedding-status': return managementResult(service, await service.embeddingStatus(request.signal))
      case 'status-summary': return managementResult(service, service.statusSummary())
      case 'status': return managementResult(service, await service.status(request.signal))
      case 'body-directory': return managementResult(service, service.spaceDirectory())
      case 'bodies': return managementResult(service, await service.spaces(request.signal))
      // Management output is always sanitized. Configured secret names may be
      // shown, but credential values never cross the Host/Client boundary.
      case 'provider-services': return managementResult(service, service.memorySpaces.providerServices())
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
      case 'entity-memories': return managementResult(service, await service.entityMemories(
        text(input.entity, 'entity', 500)!,
        input.offset === undefined ? undefined : integer(input.offset, 0, 0, 1_000_000),
        input.limit === undefined ? undefined : integer(input.limit, 50, 1, 200),
        request.signal,
      ))
      case 'entity-related': return managementResult(service, await service.entityRelated(
        text(input.entity, 'entity', 500)!,
        input.limit === undefined ? undefined : integer(input.limit, 20, 1, 50),
        request.signal,
        // A page view's id: its newer selection cancels the related read it is still waiting for.
        text(input.view, 'view', 200, false),
      ))
      case 'search': return managementResult(service, await service.search({
        query: text(input.query, 'query', 2_000)!,
        ...(text(input.mode, 'mode', 20, false) === undefined ? {} : { mode: text(input.mode, 'mode', 20, false)! as 'smart' | 'keyword' | 'basic' }),
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, 10, 1, 1_000) }),
        ...(text(input.category, 'category', 30, false) === undefined ? {} : { category: text(input.category, 'category', 30, false)! as Category }),
        ...(text(input.source, 'source', 30, false) === undefined ? {} : { source: text(input.source, 'source', 30, false)! as Source }),
        ...(text(input.intent, 'intent', 30, false) === undefined ? {} : { intent: text(input.intent, 'intent', 30, false)! as Intent }),
        ...(stringArray(input.memoryBodyIds, 'memoryBodyIds', 10_000) === undefined ? {} : { memoryBodyIds: stringArray(input.memoryBodyIds, 'memoryBodyIds', 10_000)! }),
        ...(input.inspect === true ? { inspect: true } : {}),
      }, request.signal))
      case 'related': return managementResult(service, await service.related(
        text(input.id, 'id', 2_000)!,
        integer(input.depth, 2, 1, 5),
        text(input.edge, 'edge', 30, false) as EdgeType | undefined,
        request.signal,
        text(input.memoryBodyId, 'memoryBodyId', 300, false),
      ))
      case 'body-reconnect': return managementResult(service, await service.reconnectSpace(text(input.memoryBodyId, 'memoryBodyId', 300)!, request.signal))
      case 'provider-view': return managementResult(service, await service.providerView(text(input.memoryBodyId, 'memoryBodyId', 300)!, {
        view: text(input.view, 'view', 128)!,
        ...(text(input.uri, 'uri', 2_000, false) === undefined ? {} : { uri: text(input.uri, 'uri', 2_000, false)! }),
      }, request.signal))
      case 'prepare-body-placement': return managementResult(service, service.prepareSpacePlacement(createSpaceRequest(request.input)))
      case 'finalize-placement': {
        const prepared = record(input.prepared!, 'prepared placement') as unknown as PreparedMemoryPlacement
        if (!Array.isArray(prepared.candidates) || prepared.candidates.length === 0) throw new Error('placement candidates are required')
        const selection = input.selection === undefined ? undefined : record(input.selection, 'placement selection')
        return managementResult(service, selection === undefined ? rulesOnlyPlacement(prepared) ?? null : finalizeLlmPlacement(prepared, {
          providerId: text(selection.providerId, 'providerId', 128)!,
          reason: text(selection.reason, 'reason', 4_000)!,
          confidence: text(selection.confidence, 'confidence', 40)!,
        }, { runId: text(input.runId, 'runId', 300)!, provider: text(input.provider, 'provider', 300)! }))
      }
      case 'metadata-sample': return managementResult(service, await service.metadataSample(text(input.memoryBodyId, 'memoryBodyId', 300)!, request.signal))
      default: throw new Error(`unsupported Memory Spaces management read operation: ${request.operation}`)
    }
  }

  if (!request.confirmed) throw new Error('Memory Spaces management mutation requires explicit confirmation')
  switch (request.operation) {
    case 'embedding-fill': return managementResult(service, await service.embedMissing(text(input.memoryBodyId, 'memoryBodyId', 300)!, request.signal))
    case 'provider-service-update': {
      const providerId = text(input.providerId, 'providerId', 128)!
      await service.updateProviderService(
        providerId,
        scalarRecord(input.settings, 'settings') ?? {},
        stringArray(input.clearSecrets, 'clearSecrets', 100) ?? [],
        input.enabled === undefined ? true : input.enabled === true,
        request.signal,
      )
      return managementResult(service, service.memorySpaces.providerServices().items.find(item => item.providerId === providerId)!)
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
      const body = await service.createSpace(createSpaceRequest(bodyInput), request.signal, placementDecision(input.placementDecision))
      return managementResult(service, body)
    }
    case 'body-update': {
      const parsed = updateSpaceRequest(request.input)
      return managementResult(service, service.updateSpace(parsed.memoryBodyId, parsed.request))
    }
    // A person's choices on the Memory Spaces page; no Agent tool reaches them (#434).
    case 'body-write-policy-reset': return managementResult(service, service.resetWritePolicy())
    case 'body-write-policy': {
      const policy = text(input.policy, 'policy', 20)
      if (policy !== 'writable' && policy !== 'read-only') throw new Error(`unsupported write policy: ${String(policy)}`)
      return managementResult(service, service.setWritePolicy(text(input.memoryBodyId, 'memoryBodyId', 300)!, policy))
    }
    case 'remember-many': {
      if (!Array.isArray(input.requests) || input.requests.length > 1_000) throw new Error('remember-many requires at most 1000 requests')
      return managementResult(service, await service.rememberMany(input.requests.map(value => record(value, 'remember request') as unknown as RememberRequest), request.signal))
    }
    case 'body-create-for-persistence': {
      const selection = input.selection === undefined ? undefined : record(input.selection, 'placement selection')
      return managementResult(service, await service.createSpaceForPersistence(createSpaceRequest(input.request ?? request.input), selection === undefined ? undefined : {
        providerId: text(selection.providerId, 'providerId', 128)!,
        reason: text(selection.reason, 'reason', 4_000)!,
        confidence: text(selection.confidence, 'confidence', 40)!,
      }, request.signal))
    }
    case 'body-metadata-update': {
      if (!Array.isArray(input.updates) || input.updates.length > 20) throw new Error('metadata update requires at most 20 entries')
      const updates = input.updates.map(value => {
        const update = record(value, 'metadata update')
        return { memoryBodyId: text(update.memoryBodyId, 'memoryBodyId', 300)!, title: text(update.title, 'title', 48)!, description: text(update.description, 'description', 200)! } satisfies MemorySpaceMetadataUpdate
      })
      return managementResult(service, service.updateSpaceMetadata(updates))
    }
    case 'body-merge': return managementResult(service, await service.mergeSpaces(
      text(input.targetMemoryBodyId, 'targetMemoryBodyId', 300)!,
      stringArray(input.sourceMemoryBodyIds, 'sourceMemoryBodyIds', 1_000) ?? [],
      input.deactivateSources !== false, request.signal,
    ))
    case 'reload': service.memorySpaces.reload(); return managementResult(service, { reloaded: true })
    // Namespaces a Provider gained since its settings were saved, mounted inactive (#373).
    case 'provider-rediscover': return managementResult(service, await service.rediscoverProviders(input.trigger === 'startup' ? 'startup' : 'manual', request.signal))
    case 'body-delete': return managementResult(service, await service.deleteSpace(text(input.memoryBodyId, 'memoryBodyId', 300)!, request.signal))
    default: throw new Error(`unsupported Memory Spaces management mutation operation: ${request.operation}`)
  }
}

export function createMemorySpacesSource(providerSnapshot: MemorySpaceProviderSnapshot, config: MemorySpacesConfig = {}): MemorySourceDefinition {
  const capturedConfig = structuredClone(config)
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
        id: 'inspect', description: 'Inspect bounded Memory Space health or routing metadata without exposing storage paths or credentials.', capability: 'status',
        inputSchema: { type: 'object', required: ['section'], additionalProperties: false, properties: { section: { type: 'string', enum: ['directory', 'health'] } } },
        maxCalls: 4, maxResults: 1, maxCharacters: 12_000,
      },
      {
        id: 'recall', description: 'Recall evidence only from Memory Spaces pinned into this View.', capability: 'recall',
        inputSchema: {
          type: 'object', required: ['query'], additionalProperties: false,
          properties: {
            query: { type: 'string' }, mode: { type: 'string', enum: ['smart', 'keyword', 'basic'] }, limit: { type: 'integer' },
            category: { type: 'string' }, source: { type: 'string' }, intent: { type: 'string' }, memoryBodyIds: { type: 'array' },
          },
        },
        maxCalls: 4, maxResults: 20, maxCharacters: 16_000,
      },
      {
        id: 'related', description: 'Traverse related memories only from evidence already admitted by this View.', capability: 'related',
        inputSchema: {
          type: 'object', required: ['id'], additionalProperties: false,
          properties: { id: { type: 'string' }, depth: { type: 'integer' }, edge: { type: 'string' }, memoryBodyId: { type: 'string' } },
        },
        maxCalls: 4, maxResults: 20, maxCharacters: 16_000,
      },
    ],
    actions: [
      {
        id: 'manage-spaces', description: 'Create a Memory Space under the configured persistence policy, or update/merge spaces in this View scope.', capability: 'write',
        inputSchema: {
          type: 'object', required: ['operation'], additionalProperties: false,
          properties: {
            operation: { type: 'string', enum: ['create', 'update', 'merge'] }, request: { type: 'object' }, selection: { type: 'object' },
            memoryBodyId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, active: { type: 'boolean' },
            targetMemoryBodyId: { type: 'string' }, sourceMemoryBodyIds: { type: 'array' }, deactivateSources: { type: 'boolean' },
          },
        },
      },
      {
        id: 'remember', description: 'Record memory using an authorized Space and its Provider; the receipt distinguishes accepted extraction from commitment.', capability: 'write',
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
          properties: { sourceId: { type: 'string' }, targetId: { type: 'string' }, memoryBodyId: { type: 'string' }, type: { type: 'string' }, weight: { type: 'number' }, reason: { type: 'string' } },
        },
      },
      {
        id: 'forget', description: 'Forget one returned evidence item using its Provider deletion mode (soft or hard); not a guarantee of universal erasure.', capability: 'forget',
        inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' }, memoryBodyId: { type: 'string' } } },
      },
    ],
    management: {
      label: 'Memory Spaces',
      description: 'Durable evidence across local and remote Provider-backed namespaces.',
    },
  },
  create(context) {
    const resolved = resolveMemorySpacesConfig({ ...context.configuration, ...capturedConfig }, context.sourceInstanceKey)
    const service = new MemorySpacesService(createRunner(resolved), resolved, undefined, undefined, providerSnapshot.adapterRegistry(), new MemoryProviderCatalog(providerSnapshot.descriptors()))
    const canRemember = providerSnapshot.entries.some(entry => entry.definition.manifest.capabilities.remember)
    const prepared = new WeakMap<object, ReturnType<typeof service.memoryState>>()
    const sourceState = (scope: object) => {
      const value = service.memoryState()
      prepared.set(scope, value)
      return value
    }
    const admittedByView = new Map<string, Map<string, string>>()
    const createdByView = new Map<string, Set<string>>()
    const writeBodies = (viewId: string, grant: MemoryReadGrant): string[] => {
      if (grant.sourceInstanceKey !== context.sourceInstanceKey || grant.schema !== 'dsh-mnemon.memory-spaces/v1') {
        throw new Error('Memory Spaces write scope grant does not belong to this Source')
      }
      const known = stringArray(record(grant.value, 'Memory Spaces scope').knownMemoryBodyIds, 'knownMemoryBodyIds', 10_000) ?? grantIds(grant)
      return [...new Set([...known, ...(createdByView.get(viewId) ?? [])])]
    }
    const admit = (viewId: string, entries: Array<{ id: string; memoryBodyId?: string }>): void => {
      const current = admittedByView.get(viewId) ?? new Map<string, string>()
      for (const entry of entries) if (entry.memoryBodyId !== undefined) current.set(entry.memoryBodyId + '/' + entry.id, entry.memoryBodyId)
      admittedByView.delete(viewId)
      admittedByView.set(viewId, current)
      while (admittedByView.size > 128) admittedByView.delete(admittedByView.keys().next().value!)
    }
    /**
     * The Memory Space an exact id belongs to, for an action or traversal that
     * names a memory by id. Evidence this View returned decides first, as
     * before. Otherwise the Providers that can look an id up are asked among
     * the spaces in `scope`, and a found memory is admitted to this View. An
     * Agent can so forget what it just wrote, and a delegated worker can act on
     * an id from its parent's turn (#337). A Provider that cannot look ids up
     * keeps to evidence: its own call may reach beyond the space named.
     */
    const ownerOf = async (viewId: string, id: string, requestedSpace: string | undefined, scope: readonly string[], signal?: AbortSignal): Promise<string | undefined> => {
      const entries = admittedByView.get(viewId)
      if (requestedSpace !== undefined) {
        if (entries?.has(requestedSpace + '/' + id) === true) return requestedSpace
      } else {
        const owners = [...(entries?.entries() ?? [])].filter(([reference]) => reference.endsWith('/' + id)).map(([, owner]) => owner)
        if (owners.length > 0) return owners.length === 1 ? owners[0] : undefined
      }
      const candidates = requestedSpace === undefined ? scope : scope.includes(requestedSpace) ? [requestedSpace] : []
      if (candidates.length === 0) return undefined
      const found = await service.locate(id, candidates, signal)
      const owners = [...new Set(found.flatMap(item => item.memoryBodyId === undefined ? [] : [item.memoryBodyId]))]
      if (owners.length !== 1) return undefined
      admit(viewId, [{ id, memoryBodyId: owners[0]! }])
      return owners[0]
    }
    const evidence = (
      request: { view: { id: string }; route: MemoryViewRoute },
      items: Insight[],
      unavailable?: string,
    ): MemoryEvidence => {
      const catalog = request.route.sourceRouteId === 'inspect'
      let remaining = request.route.maxCharacters ?? 16_000
      let truncated = false
      const visible = items.slice(0, request.route.maxResults ?? 20).flatMap(item => {
        if (remaining <= 0 || (catalog && item.content.length > remaining)) { truncated = true; return [] }
        const content = catalog ? item.content : truncate(item.content, remaining)
        remaining -= content.length
        const clipped = content !== item.content
        truncated ||= clipped
        return [{ item, content, clipped }]
      })
      truncated ||= visible.length < items.length
      // Follow-up authority is limited to the evidence actually returned under the View budget.
      if (!catalog) admit(request.view.id, visible.map(({ item }) => item))
      return {
      id: `evidence:${randomUUID()}`,
      viewId: request.view.id,
      routeId: request.route.id,
      sourceInstanceKey: context.sourceInstanceKey,
      observedAt: new Date().toISOString(),
      items: visible.map(({ item, content, clipped }) => ({
        id: item.id,
        text: content,
        ...(item.normalizedScore ?? item.score) === undefined ? {} : { score: item.normalizedScore ?? item.score },
        ...(item.createdAt === undefined ? {} : { revision: item.createdAt }),
        provenance: {
          ...(item.memoryBodyId === undefined ? {} : { memoryBodyId: item.memoryBodyId }),
          ...(item.memoryBodyName === undefined ? {} : { memoryBodyName: item.memoryBodyName }),
          ...(item.memoryProviderId === undefined ? {} : { memoryProviderId: item.memoryProviderId }),
          ...(item.memoryProviderLabel === undefined ? {} : { memoryProviderLabel: item.memoryProviderLabel }),
          ...(item.memoryCapabilities === undefined ? {} : { memoryCapabilities: { ...item.memoryCapabilities } }),
          ...(item.relevanceTier === undefined ? {} : { relevanceTier: item.relevanceTier }),
          ...(item.category === undefined ? {} : { category: item.category }),
          ...(item.importance === undefined ? {} : { importance: item.importance }),
          ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
          ...(item.tags === undefined ? {} : { tags: item.tags }),
          ...(item.entities === undefined ? {} : { entities: item.entities }),
          ...(item.source === undefined ? {} : { source: item.source }),
          ...(item.depth === undefined ? {} : { depth: item.depth }),
          ...(item.edgeType === undefined ? {} : { edgeType: item.edgeType }),
          ...(item.externalUri === undefined ? {} : { externalUri: item.externalUri }),
        },
      })),
      truncated,
      ...(unavailable === undefined ? {} : { unavailable }),
      ...(catalog && visible.length === 0 ? { unavailable: 'Inspection cannot fit the View budget as valid catalog JSON.' } : {}),
    }
    }
    return {
      facts(request): MemorySourceFacts {
        const { active, providerReady, revision } = sourceState(request.scope)
        const routeIds: string[] = ['inspect',
          ...(active.some(body => body.provider.capabilities.search) ? ['recall'] : []),
          ...(active.some(body => body.provider.capabilities.related) ? ['related'] : []),
        ]
        // With no Provider ready, nothing can be created or remembered: the View
        // offers no write that is bound to fail (#336).
        const actionIds: string[] = service.config.writeEnabled ? [
          ...(providerReady ? ['manage-spaces'] : []),
          ...(canRemember && providerReady ? ['remember'] : []),
          // A link or a forget goes to a space that holds the memory, so a read-only one offers neither (#434).
          ...(active.some(body => body.provider.capabilities.link && body.writePolicy !== 'read-only') ? ['link'] : []),
          ...(active.some(body => body.provider.capabilities.forget && body.writePolicy !== 'read-only') ? ['forget'] : []),
        ] : []
        const capabilities: MemoryCapability[] = ['status', 'project']
        if (routeIds.includes('recall')) capabilities.push('recall')
        if (routeIds.includes('related')) capabilities.push('related')
        if (actionIds.includes('manage-spaces') || actionIds.includes('remember')) capabilities.push('write')
        if (actionIds.includes('link')) capabilities.push('link')
        if (actionIds.includes('forget')) capabilities.push('forget')
        return {
          sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'memory-spaces', role: 'durable-evidence',
          availability: active.length === 0 ? 'degraded' : 'ready', revision, capabilities: [...capabilities], routeIds, actionIds,
          hints: {
            activeCount: active.length, providerCount: new Set(active.map(body => body.provider.id)).size,
            // Spaces that can take a MEMORY.md archive or a Document's index: exact writes and safe forget.
            archivableCount: active.filter(body => body.writePolicy !== 'read-only'
              && body.provider.capabilities.remember && body.provider.capabilities.forget && body.provider.capabilities.writeMode === 'exact').length,
          },
        }
      },
      project(request) {
        const { all, active, revision } = prepared.get(request.scope) ?? sourceState(request.scope)
        prepared.delete(request.scope)
        if (revision !== request.expectedRevision) throw new Error('Memory Spaces projection revision changed during composition')
        const cover = `${active.length} active of ${all.length} configured Memory Space${all.length === 1 ? '' : 's'} available through scoped recall.`
        return {
          fragments: request.includeProjection ? [{
            id: `${context.sourceInstanceKey}/projection`, sourceInstanceKey: context.sourceInstanceKey, mode: request.mode,
            text: truncate(cover, request.maxCharacters),
            revision,
            provenance: { sourceTypeId: 'memory-spaces' },
          }] : [],
          readGrant: {
            id: `${context.sourceInstanceKey}/grant/${revision}`,
            sourceInstanceKey: context.sourceInstanceKey,
            schema: 'dsh-mnemon.memory-spaces/v1',
            value: { memoryBodyIds: active.map(body => body.id), knownMemoryBodyIds: all.map(body => body.id) },
            revision,
            consistency: 'namespace-pinned-live-read',
          },
          presentation: {
            visibleItems: active.length,
            totalItems: all.length,
            items: active.slice(0, 24).map(body => ({
              id: body.id,
              title: truncate(body.name, 160),
              ...(body.description.trim() === '' ? {} : { excerpt: truncate(body.description, 600) }),
            })),
          },
        }
      },
      async query(request) {
        const allowedBodies = grantIds(request.grant)
        const input = record(request.input, `Memory Spaces ${request.route.sourceRouteId}`)
        if (request.route.sourceRouteId === 'inspect') {
          const known = stringArray(record(request.grant.value, 'Memory Spaces scope').knownMemoryBodyIds, 'knownMemoryBodyIds', 10_000) ?? allowedBodies
          let value: unknown
          if (input.section === 'directory') {
            const catalog = service.spaceDirectory()
            const owned = createdByView.get(request.view.id)
            value = modelSpaceCatalog({ ...catalog, items: catalog.items.filter(body => known.includes(body.id) || owned?.has(body.id)) })
          } else if (input.section === 'health') value = modelStatus(await service.status(request.signal))
          else throw new Error('unknown Memory Spaces inspection section')
          return evidence(request, [{ id: 'memory-spaces:' + String(input.section), content: modelJson(value, request.route.maxCharacters ?? 12_000) }])
        }
        if (request.route.sourceRouteId === 'recall') {
          const category = text(input.category, 'category', 30, false) as Category | undefined
          const source = text(input.source, 'source', 30, false) as Source | undefined
          const intent = text(input.intent, 'intent', 30, false) as Intent | undefined
          if (category !== undefined && !CATEGORY_SET.has(category)) throw new Error(`unsupported category: ${category}`)
          if (source !== undefined && !SOURCE_SET.has(source)) throw new Error(`unsupported source: ${source}`)
          if (intent !== undefined && !INTENT_SET.has(intent)) throw new Error(`unsupported intent: ${intent}`)
          const requestedSpaces = stringArray(input.memoryBodyIds, 'memoryBodyIds', 10_000) ?? allowedBodies
          if (requestedSpaces.some(id => !allowedBodies.includes(id))) throw new Error('Recall requested a Memory Space outside this View ReadGrant')
          const mode = text(input.mode, 'mode', 20, false) as 'smart' | 'keyword' | 'basic' | undefined
          const result = await service.search({
            query: text(input.query, 'query', 2_000)!,
            ...(mode === undefined ? {} : { mode }),
            limit: Math.min(request.route.maxResults ?? 20, integer(input.limit, 10, 1, 20)),
            memoryBodyIds: requestedSpaces,
            ...(category === undefined ? {} : { category }), ...(source === undefined ? {} : { source }), ...(intent === undefined ? {} : { intent }),
          }, request.signal)
          return evidence(request, result.results, result.results.length === 0 ? result.hint : undefined)
        }
        if (request.route.sourceRouteId === 'related') {
          const id = text(input.id, 'id', 2_000)!
          const requestedSpace = text(input.memoryBodyId, 'memoryBodyId', 300, false)
          const owner = await ownerOf(request.view.id, id, requestedSpace, allowedBodies, request.signal)
          if (owner === undefined) throw new Error('related-memory traversal requires evidence already admitted by this View, or an id found in a Memory Space it can read')
          if (!allowedBodies.includes(owner)) throw new Error('related-memory owner is outside this View ReadGrant')
          const edge = text(input.edge, 'edge', 30, false) as EdgeType | undefined
          if (edge !== undefined && !EDGE_SET.has(edge)) throw new Error(`unsupported edge: ${edge}`)
          const results = await service.related(id, integer(input.depth, 2, 1, 5), edge, request.signal, owner)
          return evidence(request, results)
        }
        throw new Error(`unsupported Memory Spaces Route: ${request.route.sourceRouteId}`)
      },
      async mutate(request) {
        const input = record(request.input, `Memory Spaces ${request.offer.sourceActionId}`)
        if (!service.config.writeEnabled) throw new Error('Memory Spaces is configured read-only')
        const grant = request.grant
        if (grant === undefined) throw new Error('Memory Spaces action has no View ReadGrant')
        const allowedBodies = grantIds(grant)
        const created = createdByView.get(request.view.id) ?? new Set<string>()
        const writableBodies = writeBodies(request.view.id, grant)
        const admittedOwner = (id: string): Promise<string | undefined> =>
          ownerOf(request.view.id, id, text(input.memoryBodyId, 'memoryBodyId', 300, false), allowedBodies, request.signal)
        let result: MemoryJsonValue
        let bodyId: string | undefined
        if (request.offer.sourceActionId === 'manage-spaces') {
          if (input.operation === 'create') {
            const selection = input.selection === undefined ? undefined : record(input.selection, 'placement selection')
            const body = await service.createSpaceForPersistence(createSpaceRequest(input.request!), selection === undefined ? undefined : {
              providerId: text(selection.providerId, 'providerId', 128)!, reason: text(selection.reason, 'reason', 4_000)!, confidence: text(selection.confidence, 'confidence', 40)!,
            }, request.signal)
            created.add(body.id)
            createdByView.set(request.view.id, created)
            while (createdByView.size > 128) createdByView.delete(createdByView.keys().next().value!)
            bodyId = body.id
            result = { action: 'created', memoryBodyId: body.id, name: body.name, description: body.description }
          } else if (input.operation === 'update') {
            bodyId = text(input.memoryBodyId, 'memoryBodyId', 300)!
            if (!writableBodies.includes(bodyId)) throw new Error('Memory Space update is outside this View scope')
            const body = service.updateSpace(bodyId, {
              ...(input.name === undefined ? {} : { name: text(input.name, 'name', MEMORY_SPACE_NAME_MAX_LENGTH)! }),
              ...(input.description === undefined ? {} : { description: text(input.description, 'description', MEMORY_SPACE_DESCRIPTION_MAX_LENGTH)! }),
              ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
            })
            result = { action: 'updated', memoryBodyId: body.id, name: body.name, description: body.description, active: body.active }
          } else if (input.operation === 'merge') {
            const target = text(input.targetMemoryBodyId, 'targetMemoryBodyId', 300)!
            const sources = stringArray(input.sourceMemoryBodyIds, 'sourceMemoryBodyIds', 20) ?? []
            if ([target, ...sources].some(id => !writableBodies.includes(id))) throw new Error('Memory Space merge is outside this View scope')
            bodyId = target
            result = await service.mergeSpaces(target, sources, input.deactivateSources !== false, request.signal) as unknown as MemoryJsonValue
          } else throw new Error('unsupported Memory Space management action')
        } else if (request.offer.sourceActionId === 'remember') {
          bodyId = text(input.memoryBodyId, 'memoryBodyId', 300, false)
          if (bodyId === undefined) {
            // A read-only space is never the default destination (#434).
            const candidates = [...new Set([...allowedBodies, ...created])]
            const defaults = candidates.filter(id => service.takesWrites(id))
            if (defaults.length !== 1) {
              throw new Error(defaults.length === 0 && candidates.length > 0
                ? 'remember requires a writable Memory Space: the ones in this View scope are read only; name a writable one'
                : 'remember requires an explicit Memory Space in this View scope')
            }
            bodyId = defaults[0]!
          }
          if (!writableBodies.includes(bodyId)) throw new Error('remember destination is outside this View scope')
          const category = text(input.category, 'category', 30, false) as Category | undefined
          const source = text(input.source, 'source', 30, false) as Source | undefined
          if (category !== undefined && !CATEGORY_SET.has(category)) throw new Error(`unsupported category: ${category}`)
          if (source !== undefined && !SOURCE_SET.has(source)) throw new Error(`unsupported source: ${source}`)
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
          const sourceSpace = await admittedOwner(sourceId)
          const targetSpace = await admittedOwner(targetId)
          if (sourceSpace === undefined || targetSpace === undefined || sourceSpace !== targetSpace || !allowedBodies.includes(sourceSpace)) {
            throw new Error('link requires two evidence items admitted by this View from the same Memory Space, or two ids found in one Memory Space it can read')
          }
          bodyId = sourceSpace
          const edge = text(input.type, 'type', 30, false) as EdgeType | undefined
          if (edge !== undefined && !EDGE_SET.has(edge)) throw new Error(`unsupported edge: ${edge}`)
          const weight = typeof input.weight === 'number' ? input.weight : 0.5
          result = await service.link(sourceId, targetId, edge, weight, text(input.reason, 'reason', 1_000, false), request.signal, bodyId) as MemoryJsonValue
        } else if (request.offer.sourceActionId === 'forget') {
          const id = text(input.id, 'id', 2_000)!
          // A space this View does not read says why, rather than looking like a missing memory (#390).
          const named = text(input.memoryBodyId, 'memoryBodyId', 300, false)
          if (named !== undefined && !allowedBodies.includes(named)) throw new Error(outsideView(service, named))
          bodyId = await admittedOwner(id)
          if (bodyId === undefined || !allowedBodies.includes(bodyId)) {
            throw new Error(`forget requires evidence already admitted by this View, or an id found in one Memory Space it can read; name the space (memoryBodyId) when several hold it${switchedOffSpaces(service)}`)
          }
          result = await service.forget(id, request.signal, bodyId) as MemoryJsonValue
        } else {
          throw new Error(`unsupported Memory Spaces action: ${request.offer.sourceActionId}`)
        }
        return receipt(request.view.id, request.offer.id, context.sourceInstanceKey, service.memoryRevision(), { memoryBodyId: bodyId ?? null, result }, mutationResultCompletion(result))
      },
      manage(request) {
        if (request.mode === 'read' && request.operation === 'body-directory' && request.input !== null) {
          const input = record(request.input, 'Memory Spaces body-directory')
          if (input.writeScope !== undefined) {
            if (!service.config.writeEnabled) throw new Error('Memory Spaces is configured read-only')
            const scope = record(input.writeScope, 'Memory Spaces write scope')
            const viewId = text(scope.viewId, 'write scope viewId', 300)!
            const grant = record(scope.grant ?? null, 'Memory Spaces write scope grant') as unknown as MemoryReadGrant
            return managementResult(service, { ...service.spaceDirectory(), writeScope: {
              viewId, sourceInstanceKey: context.sourceInstanceKey, memoryBodyIds: writeBodies(viewId, grant).filter(id => service.takesWrites(id)),
            } })
          }
        }
        return manageMemorySpaces(service, request)
      },
      async dispose() {
        admittedByView.clear()
        createdByView.clear()
        await service.dispose()
      },
    }
  },
  })
}
