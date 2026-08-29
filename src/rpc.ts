import type { HostConnectionHandle, HostRpcAuthority, HostRpcHandler, RpcResult } from './contracts.ts'
import type { MnemonLifecycle } from './lifecycle.ts'
import type { RuntimeMemoryController, RuntimeMemoryImportance, RuntimeMemoryTarget } from './runtime-memory.ts'
import type { Category, EdgeType, Intent, MnemonService, SearchRequest, Source } from './service.ts'
import type { StorageScopeInspector } from './storage-scope.ts'
import type { MnemonPackManager } from './pack.ts'
import type { LiveMnemonRuntime, MnemonRuntimeGraph } from './live-runtime.ts'
import { VersionUpdateManager, type VersionComponentId } from './version-updates.ts'
import { MNEMON_ACTIVATION_CHANNEL, MNEMON_PACK_CHANNEL, MNEMON_READ_CHANNEL, MNEMON_WRITE_CHANNEL } from './channels.ts'
import { isMemoryProviderId } from './providers/catalog.ts'
import { assertMemoryLayerParticipation } from './memory-system/access.ts'
import type { MemoryCapability } from './memory-system/contracts.ts'
import type { MemoryJsonValue, MemoryOperationScope } from '../packages/contracts/src/index.ts'
import type {
  CreateMemoryBodyRequest,
  MemoryPlacementCapability,
  MemoryProviderConnection,
  MemoryProviderId,
  UpdateMemoryBodyRequest,
} from './shared/contracts.ts'
export { MNEMON_ACTIVATION_CHANNEL, MNEMON_PACK_CHANNEL, MNEMON_READ_CHANNEL, MNEMON_WRITE_CHANNEL } from './channels.ts'

type RuntimeInput = MnemonService | LiveMnemonRuntime

function isRoutedRuntime(value: RuntimeInput): value is LiveMnemonRuntime {
  return 'route' in value && typeof value.route === 'function'
}

function isRoutedPackInput(value: MnemonPackManager | LiveMnemonRuntime): value is LiveMnemonRuntime {
  return 'route' in value && typeof value.route === 'function'
}

function requestedScope(payload: Record<string, unknown>): { workspaceId?: string; sessionId?: string } {
  const workspaceId = payload.workspaceId === undefined ? undefined : String(payload.workspaceId).trim()
  const sessionId = payload.sessionId === undefined ? undefined : String(payload.sessionId).trim()
  return {
    ...(workspaceId === undefined || workspaceId === '' ? {} : { workspaceId }),
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
  }
}

function runtimeFor(
  input: RuntimeInput,
  payload: Record<string, unknown>,
  runtimeMemory?: RuntimeMemoryController,
  storage?: StorageScopeInspector,
): {
  graph: Pick<MnemonRuntimeGraph, 'service' | 'runtimeMemory' | 'documents' | 'storage' | 'packs'> & Partial<Pick<MnemonRuntimeGraph, 'memoryKernel' | 'memoryComposition'>>
  route?: ReturnType<LiveMnemonRuntime['route']>
  explicitWorkspace: boolean
} {
  if (isRoutedRuntime(input)) {
    const scope = requestedScope(payload)
    const route = input.route(scope)
    return { graph: route.graph, route, explicitWorkspace: scope.workspaceId !== undefined && route.graph.config.storageScope === 'workspace' }
  }
  return {
    graph: {
      service: input,
      runtimeMemory: runtimeMemory as RuntimeMemoryController,
      documents: undefined as never,
      storage: storage as StorageScopeInspector,
      packs: undefined as never,
    },
    explicitWorkspace: false,
  }
}

function managementScope(resolved: ReturnType<typeof runtimeFor>, payload: Record<string, unknown>): MemoryOperationScope {
  const requested = requestedScope(payload)
  const workspaceId = resolved.route?.selectedWorkspace?.path ?? requested.workspaceId
  return {
    storage: resolved.graph.service.config.storageScope,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(requested.sessionId === undefined ? {} : { sessionId: requested.sessionId }),
  }
}

function requireLayer(
  graph: Pick<MnemonRuntimeGraph, 'service'> & Partial<Pick<MnemonRuntimeGraph, 'memoryKernel'>>,
  layerId: string,
  capability: MemoryCapability,
): void {
  if (graph.memoryKernel !== undefined) {
    graph.memoryKernel.assertParticipation(layerId, capability, 'manual')
    return
  }
  // Keep the direct-service compatibility seam usable for callers from before
  // the topology contract existed.
  const topology = graph.service.config.memoryTopology
  if (topology === undefined) return
  const configured = topology.layers[layerId]
  if (configured === undefined) throw new Error(`memory layer is not configured in the active topology: ${layerId}`)
  assertMemoryLayerParticipation({ id: layerId, ...configured }, capability, 'manual')
}

function requireAligned(route: ReturnType<LiveMnemonRuntime['route']> | undefined): void {
  if (route?.aligned === false) throw new Error('the selected memory workspace differs from the current session; align the workbench before running an Agent-backed operation')
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload must be an object')
  return value as Record<string, unknown>
}

function providerConnection(value: unknown): MemoryProviderConnection | undefined {
  if (value === undefined) return undefined
  const input = object(value)
  const connection: MemoryProviderConnection = {}
  for (const [key, setting] of Object.entries(input)) {
    if (typeof setting !== 'string' && typeof setting !== 'number' && typeof setting !== 'boolean') {
      throw new Error(`provider connection setting ${key} must be a string, number, or boolean`)
    }
    connection[key] = setting
  }
  return connection
}

function providerConnections(value: unknown): CreateMemoryBodyRequest['providerConnections'] | undefined {
  if (value === undefined) return undefined
  const input = object(value)
  return Object.fromEntries(Object.entries(input).map(([providerId, settings]) => {
    if (!isMemoryProviderId(providerId)) throw new Error(`unsupported memory provider: ${providerId}`)
    const parsed = providerConnection(settings)
    if (parsed === undefined) throw new Error(`provider connection is missing for ${providerId}`)
    return [providerId, parsed]
  })) as CreateMemoryBodyRequest['providerConnections']
}

function success(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown): RpcResult<unknown> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

export function createReadHandler(input: RuntimeInput, lifecycle?: MnemonLifecycle, runtimeMemory?: RuntimeMemoryController, storage?: StorageScopeInspector, versions?: VersionUpdateManager): HostRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      const payload = object(rawPayload)
      if (endpoint === 'versions') {
        if (versions === undefined) throw new Error('version checks are unavailable')
        return success(await versions.check())
      }
      if (endpoint === 'task-agent-models') {
        if (lifecycle === undefined) throw new Error('Mnemon task Agent model directory is unavailable without lifecycle integration')
        return success(await lifecycle.taskAgentModels(payload.includeCatalog !== false))
      }
      const resolved = runtimeFor(input, payload, runtimeMemory, storage)
      const { service } = resolved.graph
      const selectedWorkspace = resolved.route?.selectedWorkspace
      const documentController = resolved.explicitWorkspace && selectedWorkspace !== undefined
        ? resolved.graph.documents.forWorkspace(selectedWorkspace.path)
        : undefined
      switch (endpoint) {
        case 'source-management-catalog':
          {
            if (resolved.graph.memoryComposition === undefined) throw new Error('Composable Source management is unavailable')
            const lease = resolved.graph.memoryComposition.acquire()
            try {
              return success(await lease.generation.managementCatalog(managementScope(resolved, payload)))
            } finally {
              lease.release()
            }
          }
        case 'source-management-read':
          {
            if (resolved.graph.memoryComposition === undefined) throw new Error('Composable Source management is unavailable')
            const lease = resolved.graph.memoryComposition.acquire()
            try {
              return success(await lease.generation.executeManagement({
                scope: managementScope(resolved, payload),
                sourceInstanceKey: String(payload.sourceInstanceKey ?? ''),
                mode: 'read',
                operation: String(payload.operation ?? ''),
                input: (payload.input ?? null) as MemoryJsonValue,
                confirmed: false,
                ...(signal === undefined ? {} : { signal }),
              }))
            } finally {
              lease.release()
            }
          }
        case 'embedding-status':
          return success(await service.embeddingStatus())
        case 'memory-system':
          if (resolved.graph.memoryKernel === undefined) throw new Error('memory system descriptor is unavailable')
          return success(resolved.graph.memoryKernel.descriptor())
        case 'runtime-memory':
          requireLayer(resolved.graph, 'runtime', 'read')
          if (resolved.graph.runtimeMemory === undefined) throw new Error('runtime memory is unavailable')
          return success(resolved.graph.runtimeMemory.snapshot())
        case 'status':
          {
            const sessionId = payload.sessionId === undefined ? '' : String(payload.sessionId).trim()
            let documents
            if (documentController !== undefined) {
              try { documents = documentController.snapshot() } catch {}
            } else if (lifecycle !== undefined && sessionId !== '') {
              try { documents = lifecycle.documents(sessionId) } catch {}
            }
          return success({
            ...await service.status(),
            ...(versions === undefined ? {} : { dshMnemonVersion: versions.currentDshMnemonVersion }),
            ...(lifecycle === undefined ? {} : {
              lifecycle: service.config.storageScope === 'workspace'
                ? lifecycle.snapshot(payload.sessionId === undefined ? undefined : String(payload.sessionId), selectedWorkspace?.path)
                : lifecycle.snapshot(payload.sessionId === undefined ? undefined : String(payload.sessionId)),
            }),
            ...(documents === undefined ? {} : { documents }),
            ...(resolved.graph.memoryKernel === undefined ? {} : { memorySystem: resolved.graph.memoryKernel.descriptor() }),
            ...(resolved.graph.storage === undefined ? {} : { storage: resolved.graph.storage.catalog(selectedWorkspace?.path ?? lifecycle?.workspaceRoot(sessionId)) }),
            ...(resolved.route === undefined ? {} : {
              workspaceContext: {
                mode: service.config.storageScope,
                selectedRoot: resolved.route.selectedRoot,
                effectiveRoot: resolved.route.effectiveRoot,
                aligned: resolved.route.aligned,
                ...(resolved.route.selectedWorkspace === undefined ? {} : { selectedWorkspace: resolved.route.selectedWorkspace }),
                ...(resolved.route.effectiveWorkspace === undefined ? {} : { effectiveWorkspace: resolved.route.effectiveWorkspace }),
              },
            }),
          })
          }
        case 'status-summary':
          {
            const sessionId = payload.sessionId === undefined ? '' : String(payload.sessionId).trim()
            let documents
            if (documentController !== undefined) {
              try { documents = documentController.snapshot() } catch {}
            } else if (lifecycle !== undefined && sessionId !== '') {
              try { documents = lifecycle.documents(sessionId) } catch {}
            }
            return success({
              ...service.statusSummary(),
              ...(versions === undefined ? {} : { dshMnemonVersion: versions.currentDshMnemonVersion }),
              ...(lifecycle === undefined ? {} : {
                lifecycle: service.config.storageScope === 'workspace'
                  ? lifecycle.snapshot(payload.sessionId === undefined ? undefined : String(payload.sessionId), selectedWorkspace?.path)
                  : lifecycle.snapshot(payload.sessionId === undefined ? undefined : String(payload.sessionId)),
              }),
              ...(documents === undefined ? {} : { documents }),
              ...(resolved.graph.memoryKernel === undefined ? {} : { memorySystem: resolved.graph.memoryKernel.descriptor() }),
              ...(resolved.graph.storage === undefined ? {} : { storage: resolved.graph.storage.catalog(selectedWorkspace?.path ?? lifecycle?.workspaceRoot(sessionId)) }),
              ...(resolved.route === undefined ? {} : {
                workspaceContext: {
                  mode: service.config.storageScope,
                  selectedRoot: resolved.route.selectedRoot,
                  effectiveRoot: resolved.route.effectiveRoot,
                  aligned: resolved.route.aligned,
                  ...(resolved.route.selectedWorkspace === undefined ? {} : { selectedWorkspace: resolved.route.selectedWorkspace }),
                  ...(resolved.route.effectiveWorkspace === undefined ? {} : { effectiveWorkspace: resolved.route.effectiveWorkspace }),
                },
              }),
            })
          }
        case 'documents':
          requireLayer(resolved.graph, 'documents', 'browse')
          if (documentController !== undefined) return success(documentController.snapshot())
          if (lifecycle === undefined) throw new Error('Mnemon Documents require lifecycle integration')
          return success(lifecycle.documents(String(payload.sessionId ?? '')))
        case 'document':
          requireLayer(resolved.graph, 'documents', 'read')
          if (documentController !== undefined) return success(documentController.get(String(payload.id ?? '')))
          if (lifecycle === undefined) throw new Error('Mnemon Documents require lifecycle integration')
          return success(lifecycle.document(String(payload.sessionId ?? ''), String(payload.id ?? '')))
        case 'document-search':
          requireLayer(resolved.graph, 'documents', 'search')
          if (documentController !== undefined) return success(await documentController.search(
            String(payload.query ?? ''),
            { includeArchived: payload.includeArchived === true, ...(payload.limit === undefined ? {} : { limit: Number(payload.limit) }) },
          ))
          if (lifecycle === undefined) throw new Error('Mnemon Documents require lifecycle integration')
          return success(await lifecycle.searchDocuments(
            String(payload.sessionId ?? ''),
            String(payload.query ?? ''),
            payload.includeArchived === true,
            payload.limit === undefined ? undefined : Number(payload.limit),
          ))
        case 'graph':
          requireLayer(resolved.graph, 'memory-spaces', 'graph')
          return success(await service.graph(undefined, Array.isArray(payload.memoryBodyIds) ? payload.memoryBodyIds.map(String) : undefined))
        case 'bodies':
          return success(await service.bodies())
        case 'body-directory':
          return success(service.bodyDirectory())
        case 'body-reconnect':
          return success(await service.reconnectBody(String(payload.memoryBodyId ?? '')))
        case 'provider-services':
          return success(service.memoryBodies.providerServices())
        case 'list':
          requireLayer(resolved.graph, 'memory-spaces', 'browse')
          return success(await service.list({
            ...(payload.query === undefined ? {} : { query: String(payload.query) }),
            ...(payload.category === undefined ? {} : { category: payload.category as Category }),
            ...(payload.limit === undefined ? {} : { limit: Number(payload.limit) }),
            ...(Array.isArray(payload.memoryBodyIds) ? { memoryBodyIds: payload.memoryBodyIds.map(String) } : {}),
          }))
        case 'entities':
          {
            requireLayer(resolved.graph, 'memory-spaces', 'search')
            const entity = payload.entity === undefined ? '' : String(payload.entity).trim()
            const limit = payload.limit === undefined ? undefined : Number(payload.limit)
            return success(await service.entities(entity || undefined, limit))
          }
        case 'search':
          {
            requireLayer(resolved.graph, 'memory-spaces', 'recall')
            const request = {
            query: String(payload.query ?? ''),
            ...(payload.mode === undefined ? {} : { mode: payload.mode as NonNullable<SearchRequest['mode']> }),
            ...(payload.limit === undefined ? {} : { limit: Number(payload.limit) }),
            ...(payload.category === undefined ? {} : { category: payload.category as Category }),
            ...(payload.source === undefined ? {} : { source: payload.source as Source }),
            ...(payload.intent === undefined ? {} : { intent: payload.intent as Intent }),
            ...(Array.isArray(payload.memoryBodyIds) ? { memoryBodyIds: payload.memoryBodyIds.map(String) } : {}),
            }
            return success(await service.search(request))
          }
        case 'agent-search':
          {
            requireLayer(resolved.graph, 'memory-spaces', 'recall')
            if (lifecycle === undefined) throw new Error('Mnemon Agent query is unavailable without lifecycle integration')
            const request = {
              query: String(payload.query ?? ''),
              ...(payload.mode === undefined ? {} : { mode: payload.mode as NonNullable<SearchRequest['mode']> }),
              ...(payload.limit === undefined ? {} : { limit: Number(payload.limit) }),
              ...(payload.category === undefined ? {} : { category: payload.category as Category }),
              ...(payload.source === undefined ? {} : { source: payload.source as Source }),
              ...(payload.intent === undefined ? {} : { intent: payload.intent as Intent }),
              ...(Array.isArray(payload.memoryBodyIds) ? { memoryBodyIds: payload.memoryBodyIds.map(String) } : {}),
            }
            const recalled = await service.search(request)
            const answer = await lifecycle.answerTask(
              String(payload.sessionId ?? ''),
              request.query,
              recalled.results,
              service.config.storageScope === 'workspace' ? selectedWorkspace?.path : undefined,
            )
            return success({ ...recalled, ...answer })
          }
        case 'related':
          requireLayer(resolved.graph, 'memory-spaces', 'related')
          return success(await service.related(String(payload.id ?? ''), payload.depth === undefined ? 2 : Number(payload.depth), payload.edge as EdgeType | undefined, undefined, payload.memoryBodyId === undefined ? undefined : String(payload.memoryBodyId)))
        case 'turn-activities':
          if (lifecycle === undefined) throw new Error('Mnemon turn activity requires lifecycle integration')
          return success(lifecycle.turnActivities(String(payload.sessionId ?? '')))
        case 'turn-activity':
          if (lifecycle === undefined) throw new Error('Mnemon turn activity requires lifecycle integration')
          {
            const snapshot = lifecycle.turnActivities(String(payload.sessionId ?? ''))
            return success(snapshot.activities.find(activity => activity.turn === Number(payload.turn)) ?? null)
          }
        case 'assistant-message':
          if (lifecycle === undefined) throw new Error('Mnemon assistant message requires lifecycle integration')
          return success(lifecycle.assistantMessage(String(payload.sessionId ?? ''), String(payload.messageId ?? '')))
        default:
          return badRequest(`unknown read endpoint: ${endpoint}`)
      }
    } catch (error) {
      return failure(error)
    }
  }
}

const ACTIVATION_PAYLOAD_FIELDS = new Set(['memoryBodyId', 'active', 'sessionId', 'workspaceId'])

/** Keep activation on a narrow, independently validated control endpoint. */
export function createActivationHandler(input: RuntimeInput): HostRpcHandler {
  return async (endpoint, rawPayload) => {
    try {
      if (endpoint !== 'body') return badRequest(`unknown activation endpoint: ${endpoint}`)
      const payload = object(rawPayload)
      const unexpected = Object.keys(payload).filter(field => !ACTIVATION_PAYLOAD_FIELDS.has(field))
      if (unexpected.length > 0) return badRequest(`unsupported activation fields: ${unexpected.join(', ')}`)
      if (typeof payload.memoryBodyId !== 'string' || payload.memoryBodyId.trim() === '') return badRequest('memoryBodyId must be a non-empty string')
      if (typeof payload.active !== 'boolean') return badRequest('active must be a boolean')
      if (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') return badRequest('sessionId must be a string')
      if (payload.workspaceId !== undefined && typeof payload.workspaceId !== 'string') return badRequest('workspaceId must be a string')

      const { graph } = runtimeFor(input, payload)
      if (!graph.service.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only (writeEnabled: false)')
      return success(graph.service.updateBody(payload.memoryBodyId.trim(), { active: payload.active }))
    } catch (error) {
      return failure(error)
    }
  }
}

export function createWriteHandler(input: RuntimeInput, lifecycle?: MnemonLifecycle, runtimeMemory?: RuntimeMemoryController, versions?: VersionUpdateManager): HostRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      const payload = object(rawPayload)
      if (endpoint === 'version-update') {
        if (versions === undefined) throw new Error('version updates are unavailable')
        const component = String(payload.component ?? '')
        if (component !== 'mnemon' && component !== 'dsh-mnemon') return badRequest(`unknown version component: ${component}`)
        return success(await versions.update(component as VersionComponentId))
      }
      const resolved = runtimeFor(input, payload, runtimeMemory)
      const { service } = resolved.graph
      // Stored Provider secrets remain on the management channel rather than
      // the ordinary redacted catalog, independently of semantic write mode.
      if (endpoint === 'provider-services') return success(service.memoryBodies.providerServices({ includeSecrets: true }))
      if (!service.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only (writeEnabled: false)')
      const selectedWorkspace = resolved.route?.selectedWorkspace
      const documentController = resolved.explicitWorkspace && selectedWorkspace !== undefined
        ? resolved.graph.documents.forWorkspace(selectedWorkspace.path)
        : undefined
      const inspectionDiverged = resolved.explicitWorkspace && resolved.route?.aligned === false
      const alignedSession = resolved.explicitWorkspace && resolved.route?.aligned === true && resolved.route.effectiveWorkspace !== undefined
      switch (endpoint) {
        case 'source-management-mutate':
          {
            if (resolved.graph.memoryComposition === undefined) throw new Error('Composable Source management is unavailable')
            const lease = resolved.graph.memoryComposition.acquire()
            try {
              return success(await lease.generation.executeManagement({
                scope: managementScope(resolved, payload),
                sourceInstanceKey: String(payload.sourceInstanceKey ?? ''),
                mode: 'mutate',
                operation: String(payload.operation ?? ''),
                input: (payload.input ?? null) as MemoryJsonValue,
                expectedRevision: String(payload.expectedRevision ?? ''),
                confirmed: payload.confirmed === true,
                ...(signal === undefined ? {} : { signal }),
              }))
            } finally {
              lease.release()
            }
          }
        case 'provider-service-update':
          {
            const providerId = String(payload.providerId ?? '')
            if (!isMemoryProviderId(providerId) || providerId === 'mnemon-native') throw new Error(`unsupported provider service: ${providerId}`)
            const settings = providerConnection(payload.settings)
            if (settings === undefined) throw new Error('provider service settings are required')
            const clearSecrets = payload.clearSecrets === undefined
              ? []
              : Array.isArray(payload.clearSecrets)
                ? payload.clearSecrets.map(String)
                : (() => { throw new Error('clearSecrets must be an array') })()
            const enabled = payload.enabled === undefined ? true : payload.enabled === true
            const updated = await service.updateProviderService(providerId, settings, clearSecrets, enabled)
            return success(service.memoryBodies.providerServices({ includeSecrets: true }).items.find(item => item.providerId === providerId) ?? updated)
          }
        case 'runtime-memory':
          requireLayer(resolved.graph, 'runtime', 'write')
          if (resolved.graph.runtimeMemory === undefined) throw new Error('runtime memory is unavailable')
          {
            const branches = payload.branches === undefined
              ? undefined
              : Array.isArray(payload.branches) && payload.branches.every(branch => typeof branch === 'string')
                ? payload.branches
                : (() => { throw new Error('branches must be an array of strings') })()
            const request = {
              action: String(payload.action ?? '') as 'add' | 'replace' | 'remove',
              target: String(payload.target ?? '') as RuntimeMemoryTarget,
              ...(payload.content === undefined ? {} : { content: String(payload.content) }),
              ...(payload.old_text === undefined ? {} : { oldText: String(payload.old_text) }),
              ...(payload.importance === undefined ? {} : { importance: String(payload.importance) as RuntimeMemoryImportance }),
              ...(branches === undefined ? {} : { branches }),
            }
            const sessionId = String(payload.sessionId ?? '').trim()
            return success(inspectionDiverged || lifecycle === undefined || sessionId === '' || (resolved.explicitWorkspace && !alignedSession)
              ? await resolved.graph.runtimeMemory.mutate(request)
              : await lifecycle.runtime(sessionId, request))
          }
        case 'supervise':
          requireLayer(resolved.graph, 'memory-spaces', 'write')
          if (lifecycle === undefined) throw new Error('Mnemon lifecycle integration is unavailable')
          {
            const sessionId = String(payload.sessionId ?? '')
            const idempotencyKey = payload.idempotencyKey === undefined ? undefined : String(payload.idempotencyKey)
            const workspaceRoot = resolved.route?.selectedWorkspace?.path ?? lifecycle.workspaceRoot(sessionId)
            return success(await lifecycle.superviseTask(sessionId, String(payload.content ?? ''), idempotencyKey, workspaceRoot))
          }
        case 'document':
          {
            const action = String(payload.action ?? '')
            requireLayer(resolved.graph, 'documents', action === 'archive' ? 'archive' : 'write')
            if (action === 'archive') requireLayer(resolved.graph, 'memory-spaces', 'write')
            const sessionId = String(payload.sessionId ?? '')
            if (documentController !== undefined && action !== 'archive' && (!alignedSession || lifecycle === undefined)) {
              const sessionIds = resolved.route?.aligned === true && sessionId.trim() !== '' ? [sessionId] : []
              if (action === 'create') return success(await documentController.mutate({
                action: 'create',
                title: String(payload.title ?? ''),
                content: String(payload.content ?? ''),
                ...(payload.description === undefined ? {} : { description: String(payload.description) }),
                ...(Array.isArray(payload.sourcePaths) ? { sourcePaths: payload.sourcePaths.map(String) } : {}),
                sessionIds,
              }))
              if (action === 'update') return success(await documentController.mutate({
                action: 'update',
                id: String(payload.id ?? ''),
                ...(payload.title === undefined ? {} : { title: String(payload.title) }),
                ...(payload.description === undefined ? {} : { description: String(payload.description) }),
                ...(payload.content === undefined ? {} : { content: String(payload.content) }),
                ...(Array.isArray(payload.sourcePaths) ? { sourcePaths: payload.sourcePaths.map(String) } : {}),
                sessionIds,
              }))
            }
            if (lifecycle === undefined) throw new Error('Mnemon Documents require lifecycle integration')
            if (action === 'archive') return success(await lifecycle.archiveDocument(sessionId, String(payload.id ?? ''), selectedWorkspace?.path))
            if (resolved.explicitWorkspace) requireAligned(resolved.route)
            if (action === 'create') return success(await lifecycle.mutateDocument(sessionId, {
              action: 'create',
              title: String(payload.title ?? ''),
              content: String(payload.content ?? ''),
              ...(payload.description === undefined ? {} : { description: String(payload.description) }),
              ...(Array.isArray(payload.sourcePaths) ? { sourcePaths: payload.sourcePaths.map(String) } : {}),
              sessionIds: [sessionId],
            }))
            if (action === 'update') return success(await lifecycle.mutateDocument(sessionId, {
              action: 'update',
              id: String(payload.id ?? ''),
              ...(payload.title === undefined ? {} : { title: String(payload.title) }),
              ...(payload.description === undefined ? {} : { description: String(payload.description) }),
              ...(payload.content === undefined ? {} : { content: String(payload.content) }),
              ...(Array.isArray(payload.sourcePaths) ? { sourcePaths: payload.sourcePaths.map(String) } : {}),
              sessionIds: [sessionId],
            }))
            return badRequest(`unknown document action: ${action}`)
          }
        case 'remember':
          {
            requireLayer(resolved.graph, 'memory-spaces', 'write')
            const request = {
            content: String(payload.content ?? ''),
            ...(payload.category === undefined ? {} : { category: payload.category as Category }),
            ...(payload.importance === undefined ? {} : { importance: Number(payload.importance) }),
            ...(Array.isArray(payload.tags) ? { tags: payload.tags.map(String) } : {}),
            ...(Array.isArray(payload.entities) ? { entities: payload.entities.map(String) } : {}),
            ...(payload.memoryBodyId === undefined ? {} : { memoryBodyId: String(payload.memoryBodyId) }),
            source: 'user',
            } as const
            return success(inspectionDiverged || lifecycle === undefined || (resolved.explicitWorkspace && !alignedSession)
              ? await service.remember(request)
              : await lifecycle.remember(String(payload.sessionId ?? ''), request))
          }
        case 'link':
          requireLayer(resolved.graph, 'memory-spaces', 'link')
          return success(inspectionDiverged || lifecycle === undefined || (resolved.explicitWorkspace && !alignedSession)
            ? await service.link(String(payload.sourceId ?? ''), String(payload.targetId ?? ''), payload.type as EdgeType | undefined, payload.weight === undefined ? 0.5 : Number(payload.weight), payload.reason === undefined ? undefined : String(payload.reason), undefined, payload.memoryBodyId === undefined ? undefined : String(payload.memoryBodyId))
            : await lifecycle.mutate(String(payload.sessionId ?? ''), 'link', payload))
        case 'forget':
          requireLayer(resolved.graph, 'memory-spaces', 'forget')
          return success(inspectionDiverged || lifecycle === undefined || (resolved.explicitWorkspace && !alignedSession)
            ? await service.forget(String(payload.id ?? ''), undefined, payload.memoryBodyId === undefined ? undefined : String(payload.memoryBodyId))
            : await lifecycle.mutate(String(payload.sessionId ?? ''), 'forget', { id: String(payload.id ?? ''), ...(payload.memoryBodyId === undefined ? {} : { memoryBodyId: String(payload.memoryBodyId) }) }))
        case 'body-create':
          {
            const connection = providerConnection(payload.connection)
            const connections = providerConnections(payload.providerConnections)
            const openViking = payload.openViking === undefined ? undefined : object(payload.openViking)
            const placement = payload.placement === undefined ? undefined : object(payload.placement)
            const placementRules = placement?.rules === undefined ? undefined : object(placement.rules)
            if (placement !== undefined && placement.mode !== 'automatic') throw new Error(`unsupported provider placement mode: ${String(placement.mode)}`)
            const request: CreateMemoryBodyRequest = {
              name: String(payload.name ?? ''),
              description: String(payload.description ?? ''),
              ...(payload.active === undefined ? {} : { active: Boolean(payload.active) }),
              ...(payload.providerId === undefined ? {} : { providerId: String(payload.providerId) as MemoryProviderId }),
              ...(connection === undefined ? {} : { connection }),
              ...(connections === undefined ? {} : { providerConnections: connections }),
              ...(openViking === undefined ? {} : {
                openViking: {
                  endpoint: String(openViking.endpoint ?? ''),
                  targetUri: String(openViking.targetUri ?? ''),
                  ...(openViking.apiKey === undefined ? {} : { apiKey: String(openViking.apiKey) }),
                  ...(openViking.account === undefined ? {} : { account: String(openViking.account) }),
                  ...(openViking.user === undefined ? {} : { user: String(openViking.user) }),
                  ...(openViking.actorPeerId === undefined ? {} : { actorPeerId: String(openViking.actorPeerId) }),
                },
              }),
              ...(placement === undefined ? {} : {
                placement: {
                  mode: 'automatic',
                  ...(placement.prompt === undefined ? {} : { prompt: String(placement.prompt) }),
                  ...(placementRules === undefined ? {} : {
                    rules: {
                      ...(Array.isArray(placementRules.allowedProviderIds) ? { allowedProviderIds: placementRules.allowedProviderIds.map(String) as MemoryProviderId[] } : {}),
                      ...(placementRules.dataBoundary === undefined ? {} : { dataBoundary: String(placementRules.dataBoundary) as 'allow-remote' | 'local-only' }),
                      ...(Array.isArray(placementRules.requiredCapabilities) ? { requiredCapabilities: placementRules.requiredCapabilities.map(String) as MemoryPlacementCapability[] } : {}),
                      ...(placementRules.preference === undefined ? {} : { preference: String(placementRules.preference) as 'balanced' | 'local-first' | 'shared-first' }),
                    },
                  }),
                },
              }),
            }
            if (request.placement === undefined) return success(await service.createBody(request))
            if (lifecycle === undefined) throw new Error('automatic provider placement requires Mnemon lifecycle integration')
            requireAligned(resolved.route)
            const prepared = service.prepareBodyPlacement(request)
            const decision = await lifecycle.placeProvider(String(payload.sessionId ?? ''), {
              name: request.name,
              description: request.description,
            }, prepared)
            return success(await service.createBody(request, undefined, decision))
          }
        case 'body-update':
          {
            const connection = providerConnection(payload.connection)
            const openViking = payload.openViking === undefined ? undefined : object(payload.openViking)
            const request: UpdateMemoryBodyRequest = {
              ...(payload.name === undefined ? {} : { name: String(payload.name) }),
              ...(payload.description === undefined ? {} : { description: String(payload.description) }),
              ...(payload.active === undefined ? {} : { active: Boolean(payload.active) }),
              ...(connection === undefined ? {} : { connection }),
              ...(payload.clearSecrets === undefined
                ? {}
                : Array.isArray(payload.clearSecrets)
                  ? { clearSecrets: payload.clearSecrets.map(String) }
                  : (() => { throw new Error('clearSecrets must be an array') })()),
              ...(openViking === undefined ? {} : {
                openViking: {
                  ...(openViking.endpoint === undefined ? {} : { endpoint: String(openViking.endpoint) }),
                  ...(openViking.targetUri === undefined ? {} : { targetUri: String(openViking.targetUri) }),
                  ...(openViking.apiKey === undefined ? {} : { apiKey: String(openViking.apiKey) }),
                  ...(openViking.account === undefined ? {} : { account: String(openViking.account) }),
                  ...(openViking.user === undefined ? {} : { user: String(openViking.user) }),
                  ...(openViking.actorPeerId === undefined ? {} : { actorPeerId: String(openViking.actorPeerId) }),
                  ...(openViking.clearApiKey === undefined ? {} : { clearApiKey: Boolean(openViking.clearApiKey) }),
                },
              }),
            }
            return success(service.updateBody(String(payload.memoryBodyId ?? ''), request))
          }
        case 'body-metadata-maintain':
          {
            requireLayer(resolved.graph, 'memory-spaces', 'maintain')
            if (lifecycle === undefined) throw new Error('AI metadata maintenance requires Mnemon lifecycle integration')
            if (!Array.isArray(payload.memoryBodyIds)) throw new Error('memoryBodyIds must be an array')
            const memoryBodyIds = [...new Set(payload.memoryBodyIds.map(String).map(id => id.trim()).filter(Boolean))]
            if (memoryBodyIds.length === 0 || memoryBodyIds.length > 20) throw new Error('metadata maintenance requires 1 through 20 Memory Spaces')
            const directory = service.bodyDirectory()
            for (const id of memoryBodyIds) {
              const body = directory.items.find(item => item.id === id)
              if (body === undefined) throw new Error(`unknown memory body: ${id}`)
              if (!body.active || body.providerEnabled === false) throw new Error(`metadata maintenance requires an active Memory Space: ${id}`)
            }
            const maintained = await lifecycle.maintainMetadata(String(payload.sessionId ?? ''), memoryBodyIds, selectedWorkspace?.path)
            if (maintained.updates.length > 0) service.updateBodyMetadata(maintained.updates)
            return success(maintained)
          }
        // Compatibility route for clients released before card reconnect
        // moved from the management channel to the read channel.
        case 'body-reconnect':
          return success(await service.reconnectBody(String(payload.memoryBodyId ?? '')))
        case 'body-delete':
          return success(await service.deleteBody(String(payload.memoryBodyId ?? '')))
        default:
          return badRequest(`unknown write endpoint: ${endpoint}`)
      }
    } catch (error) {
      return failure(error)
    }
  }
}

/** Backup payloads contain private memory and stay behind DSH browser authentication. */
export function createPackHandler(input: MnemonPackManager | LiveMnemonRuntime, writeEnabled: boolean | (() => boolean) = true): HostRpcHandler {
  return async (endpoint, rawPayload) => {
    try {
      const payload = object(rawPayload)
      const manager = isRoutedPackInput(input)
        ? input.route(requestedScope(payload)).graph.packs
        : input
      if (endpoint === 'target') return success(manager.target())
      if (endpoint === 'export') return success(await manager.exportPack('full'))
      if (endpoint === 'inspect') return success(manager.inspectPack(String(payload.base64 ?? ''), payload.fileName === undefined ? undefined : String(payload.fileName)))
      if (endpoint === 'import') {
        const writable = typeof writeEnabled === 'function' ? writeEnabled() : writeEnabled
        if (!writable) throw new Error('Mnemon Pack import is disabled while memory writes are read-only')
        return success(await manager.importPack(String(payload.base64 ?? ''), { mode: 'merge' }))
      }
      return badRequest(`unknown Pack endpoint: ${endpoint}`)
    } catch (error) {
      return failure(error)
    }
  }
}

/**
 * Register one call shape across DSH rc.2 and 0.1.2-alpha.1. The former
 * enforces channel authority; the latter ignores the trailing options object
 * after applying its uniform browser-session authentication boundary.
 */
export function registerRpc(connection: HostConnectionHandle, input: RuntimeInput, lifecycle?: MnemonLifecycle, runtimeMemory?: RuntimeMemoryController, storage?: StorageScopeInspector, packs?: MnemonPackManager, versions?: VersionUpdateManager, managementAuthority: HostRpcAuthority = 'loopback'): void {
  const versionManager = versions ?? new VersionUpdateManager({ mnemonCliPath: () => findVersionCli(input) })
  connection.rpc.handle(MNEMON_READ_CHANNEL, createReadHandler(input, lifecycle, runtimeMemory, storage, versionManager), { authority: 'trusted-host' })
  connection.rpc.handle(MNEMON_ACTIVATION_CHANNEL, createActivationHandler(input), { authority: 'trusted-host' })
  connection.rpc.handle(MNEMON_WRITE_CHANNEL, createWriteHandler(input, lifecycle, runtimeMemory, versionManager), { authority: managementAuthority })
  const packManager = isRoutedRuntime(input) ? input : packs
  const config = input.config
  if (packManager !== undefined) connection.rpc.handle(MNEMON_PACK_CHANNEL, createPackHandler(packManager, () => config.writeEnabled), { authority: managementAuthority })
}

function findVersionCli(input: RuntimeInput): string | undefined {
  return input.config.cliPath
}
