import type { HostConnectionHandle, HostRpcAuthority, HostRpcHandler, HostSettingsService, RpcResult } from './contracts.ts'
import { MNEMON_SETTINGS_CHANNEL, MNEMON_SETTINGS_NAMESPACE, MNEMON_UI_SETTINGS_NAMESPACE } from './shared/contracts.ts'

export { MNEMON_SETTINGS_CHANNEL, MNEMON_SETTINGS_NAMESPACE, MNEMON_UI_SETTINGS_NAMESPACE } from './shared/contracts.ts'

function success(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown, namespace: string): RpcResult<unknown> {
  return {
    ok: false,
    error: {
      code: 'settings-rejected',
      message: error instanceof Error ? error.message : String(error),
      details: { ns: namespace },
    },
  }
}

function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function descriptor(settings: HostSettingsService, namespace: string) {
  const view = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === namespace)
  if (view === undefined) throw new Error(`${namespace} settings namespace is unavailable`)
  return {
    status: 'ready' as const,
    value: view.value,
    base: view.base,
    user: view.user,
    revision: view.revision,
    writable: settings.writable,
    mode: 'host' as const,
    applies: view.applies,
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload must be an object')
  return value as Record<string, unknown>
}

const MUTABLE_FIELDS = [
  'storageScope', 'cliPath', 'dataDir', 'customPackId', 'customPacks', 'store', 'timeoutMs', 'defaultRecallLimit',
  'recallQuality',
  'routingGuidance', 'lifecycleEnabled', 'recallMode', 'writebackMode', 'idleReviewMs',
  'displayMode', 'tabEnabled', 'writeEnabled', 'persistenceStrategy', 'taskAgentModel',
]
// remoteAccess is intentionally absent: changing the transport authority
// requires a local configuration edit and a Host restart.

/** Nested paths of the live in-conversation interaction toggles. */
const INTERACTION_PATHS: string[][] = [
  ['conversationInteraction', 'turnBar'],
  ['conversationInteraction', 'saveAction'],
]

const UI_FIELDS = ['turnBar', 'saveAction']

function namespaceOf(payload: Record<string, unknown>): string {
  const namespace = payload.namespace === undefined ? MNEMON_SETTINGS_NAMESPACE : String(payload.namespace)
  if (namespace !== MNEMON_SETTINGS_NAMESPACE && namespace !== MNEMON_UI_SETTINGS_NAMESPACE) throw new Error(`unsupported Mnemon settings namespace: ${namespace}`)
  return namespace
}

/** Whether one mutation path targets a supported Mnemon settings field. */
function mutablePath(namespace: string, path: string[]): boolean {
  if (namespace === MNEMON_UI_SETTINGS_NAMESPACE) return path.length === 1 && UI_FIELDS.includes(path[0]!)
  if (path.length === 1) return MUTABLE_FIELDS.includes(path[0]!)
  // Accepted only for legacy clients; the current UI writes `mnemon-ui`.
  return INTERACTION_PATHS.some(allowed => allowed.length === path.length && allowed.every((segment, index) => segment === path[index]))
}

export function createSettingsHandler(settings: HostSettingsService): HostRpcHandler {
  return async (endpoint, rawPayload) => {
    let namespace = MNEMON_SETTINGS_NAMESPACE
    try {
      const payload = object(rawPayload)
      namespace = namespaceOf(payload)
      if (endpoint === 'get') return success(descriptor(settings, namespace))
      if (endpoint !== 'mutate') return badRequest(`unknown settings endpoint: ${endpoint}`)
      if (!settings.writable) throw new Error('DSH settings are read-only')
      if (!Array.isArray(payload.ops) || payload.ops.length === 0 || payload.ops.length > 16) throw new Error('ops must contain 1..16 settings edits')
      const ops = payload.ops.map((raw) => {
        const op = object(raw)
        const path = Array.isArray(op.path) && op.path.length > 0 ? op.path.map(segment => String(segment)) : []
        if (!mutablePath(namespace, path)) throw new Error(`unsupported ${namespace} settings field: ${path.join('.')}`)
        if (op.op === 'unset') return { op: 'unset' as const, path }
        if (op.op !== 'set') throw new Error(`unsupported settings operation: ${String(op.op)}`)
        return { op: 'set' as const, path, value: op.value }
      })
      const revision = payload.expectedRevision === undefined ? undefined : Number(payload.expectedRevision)
      await settings.mutate(namespace, ops, revision)
      return success(descriptor(settings, namespace))
    } catch (error) {
      return failure(error, namespace)
    }
  }
}

export function registerSettingsRpc(connection: HostConnectionHandle, settings: HostSettingsService, authority: HostRpcAuthority = 'loopback'): void {
  connection.rpc.handle(MNEMON_SETTINGS_CHANNEL, createSettingsHandler(settings), { authority })
}
