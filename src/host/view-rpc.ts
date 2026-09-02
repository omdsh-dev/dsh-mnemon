import type { HostConnectionHandle, HostRpcAuthority, HostRpcHandler } from './dsh.ts'
import type { MnemonLifecycle } from './lifecycle.ts'
import type { LiveMnemonRuntime } from './runtime.ts'
import type { MemoryRuntime } from '../core/runtime.ts'
import type { MemoryOperationScope } from '../core/contracts/index.ts'
import type { MemoryStrategyManagement } from './strategy-management.ts'
import { MNEMON_VIEW_CHANNEL, MNEMON_VIEW_WRITE_CHANNEL, type MemoryViewConfigurationRequest, type MemoryViewDashboard } from './view-protocol.ts'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('View request must be an object')
  return value as Record<string, unknown>
}
function optionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 1000) throw new Error('Invalid View scope identifier')
  return value.trim() || undefined
}

export function createViewHandler(runtime: LiveMnemonRuntime, engine: MemoryRuntime, management: MemoryStrategyManagement, access: 'read' | 'write', lifecycle?: MnemonLifecycle): HostRpcHandler {
  return async (endpoint, input, signal) => {
    try {
      if (access === 'read' ? endpoint !== 'dashboard' && endpoint !== 'preview' : endpoint !== 'apply') throw new Error('View operation is not available on this channel')
      const payload = object(input)
      const sessionId = optionalId(payload.sessionId)
      const selectedWorkspaceId = optionalId(payload.workspaceId)
      const route = runtime.route({ ...(sessionId === undefined ? {} : { sessionId }), ...(selectedWorkspaceId === undefined ? {} : { workspaceId: selectedWorkspaceId }) })
      const workspaceId = route.selectedWorkspace?.path ?? lifecycle?.workspaceRoot(sessionId)
      const sessionWorkspace = lifecycle?.workspaceRoot(sessionId)
      const aligned = route.aligned && (route.selectedWorkspace === undefined || sessionId === undefined
        || sessionWorkspace !== undefined && resolve(route.selectedWorkspace.path) === resolve(sessionWorkspace))
      const config = management.resolveConfig(runtime.config)
      const scope: MemoryOperationScope = { storage: config.storageScope,
        ...(workspaceId === undefined ? {} : { workspaceId }), ...(sessionId === undefined ? {} : { sessionId, agentId: sessionId }) }
      if (endpoint === 'dashboard') {
        const catalog = await management.catalog()
        const current = sessionId === undefined || !aligned ? undefined : lifecycle?.memoryView(sessionId, workspaceId)
        const activity = current?.turn === undefined || sessionId === undefined
          ? undefined
          : lifecycle?.turnActivities(sessionId).activities.find(candidate => candidate.turn === current.turn)
        const snapshot = engine.contributionSnapshot()
        const value: MemoryViewDashboard = { ...catalog, strategyTypeId: config.memoryTopology.strategyId,
          ...(current === undefined ? { currentUnavailable: sessionId === undefined ? 'no-session' as const : !aligned ? 'unaligned' as const : 'not-generated' as const } : { current }),
          ...(activity === undefined ? {} : { activity }),
          sources: snapshot.sources.map(source => ({ sourceInstanceKey: source.instanceKey, sourceTypeId: source.definition.manifest.typeId,
            role: source.definition.manifest.role, label: source.definition.manifest.management?.label ?? source.definition.manifest.typeId })),
        }
        return { ok: true, value }
      }
      if (endpoint !== 'preview' && endpoint !== 'apply') throw new Error('Unknown View operation')
      const raw = object(payload.configuration)
      if (typeof raw.expectedRevision !== 'string' || typeof raw.strategyTypeId !== 'string') throw new Error('View configuration requires a revision and Strategy id')
      object(raw.entries)
      const request = raw as unknown as MemoryViewConfigurationRequest
      if (endpoint === 'preview') return { ok: true, value: await management.preview(config, scope, request, signal) }
      if (payload.confirmed !== true) throw new Error('Saving View configuration requires confirmation')
      await management.apply(config, scope, request, signal)
      return { ok: true, value: { saved: true } }
    } catch (error) {
      return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } }
    }
  }
}

export function registerViewRpc(connection: HostConnectionHandle, runtime: LiveMnemonRuntime, engine: MemoryRuntime, management: MemoryStrategyManagement, lifecycle: MnemonLifecycle, authority: HostRpcAuthority): void {
  connection.rpc.handle(MNEMON_VIEW_CHANNEL, createViewHandler(runtime, engine, management, 'read', lifecycle), { authority: 'trusted-host' })
  connection.rpc.handle(MNEMON_VIEW_WRITE_CHANNEL, createViewHandler(runtime, engine, management, 'write', lifecycle), { authority })
}
import { resolve } from 'node:path'
