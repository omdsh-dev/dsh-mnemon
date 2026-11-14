import {
  MNEMON_ACTIVATION_CHANNEL,
  MNEMON_PACK_CHANNEL,
  MNEMON_READ_CHANNEL,
  MNEMON_REMOTE_ACTIVATION_ENDPOINT,
  MNEMON_REMOTE_CHANNEL,
  MNEMON_REMOTE_PACK_ENDPOINT,
  MNEMON_REMOTE_READ_ENDPOINT,
  MNEMON_REMOTE_REVIEW_ENDPOINT,
  MNEMON_REMOTE_SETTINGS_ENDPOINT,
  MNEMON_REMOTE_SYNC_ENDPOINT,
  MNEMON_REMOTE_VIEW_ENDPOINT,
  MNEMON_REMOTE_VIEW_WRITE_ENDPOINT,
  MNEMON_REMOTE_WRITE_ENDPOINT,
  MNEMON_REVIEW_CHANNEL,
  MNEMON_SETTINGS_CHANNEL,
  MNEMON_SYNC_CHANNEL,
  MNEMON_VIEW_CHANNEL,
  MNEMON_VIEW_WRITE_CHANNEL,
  MNEMON_WRITE_CHANNEL,
  type ClientConnectionHandle,
  type MnemonRpcChannel,
  type MnemonRpcEndpoint,
} from '../host/protocol.ts'

type ClientRpcResult = Awaited<ReturnType<ClientConnectionHandle['rpc']['call']>>

const REMOTE_ENDPOINT = new Map<string, string>([
  [MNEMON_READ_CHANNEL, MNEMON_REMOTE_READ_ENDPOINT],
  [MNEMON_ACTIVATION_CHANNEL, MNEMON_REMOTE_ACTIVATION_ENDPOINT],
  [MNEMON_WRITE_CHANNEL, MNEMON_REMOTE_WRITE_ENDPOINT],
  [MNEMON_PACK_CHANNEL, MNEMON_REMOTE_PACK_ENDPOINT],
  [MNEMON_SYNC_CHANNEL, MNEMON_REMOTE_SYNC_ENDPOINT],
  [MNEMON_REVIEW_CHANNEL, MNEMON_REMOTE_REVIEW_ENDPOINT],
  [MNEMON_SETTINGS_CHANNEL, MNEMON_REMOTE_SETTINGS_ENDPOINT],
  [MNEMON_VIEW_CHANNEL, MNEMON_REMOTE_VIEW_ENDPOINT],
  [MNEMON_VIEW_WRITE_CHANNEL, MNEMON_REMOTE_VIEW_WRITE_ENDPOINT],
])

function isClientRpcResult(value: unknown): value is ClientRpcResult {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'ok')) return false
  const candidate = value as { ok?: unknown; value?: unknown; error?: unknown }
  if (candidate.ok === true) return Object.hasOwn(candidate, 'value')
  if (candidate.ok !== false || typeof candidate.error !== 'object' || candidate.error === null) return false
  return typeof (candidate.error as { message?: unknown }).message === 'string'
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export interface RemoteAccessCapability {
  readonly isOwner?: boolean | (() => boolean)
  readonly owner?: boolean
  readonly principal?: string
  readonly state?: { readonly owner?: boolean; readonly snapshot?: { readonly kind?: string } }
  getSnapshot?(): { isOwner?: boolean; owner?: boolean; principal?: string } | undefined
  source?(kind: string, id: string, action: string): { allowed?: boolean; isOwner?: boolean; getSnapshot?(): boolean } | boolean | undefined
}

const connectionRemoteAccess = new WeakMap<ClientConnectionHandle, RemoteAccessCapability>()

/** Bind DSH 0.2.1+ `ctx.remoteAccess` capability state to a connection handle for local vs remote routing. */
export function bindConnectionRemoteAccess(
  connection: ClientConnectionHandle,
  capability: RemoteAccessCapability | undefined,
): () => void {
  if (capability === undefined) {
    connectionRemoteAccess.delete(connection)
    return () => {}
  }
  connectionRemoteAccess.set(connection, capability)
  return () => {
    if (connectionRemoteAccess.get(connection) === capability) {
      connectionRemoteAccess.delete(connection)
    }
  }
}

function resolveRemoteOwnerState(capability: RemoteAccessCapability | undefined): boolean | undefined {
  if (capability === undefined) return undefined
  const directOwner = typeof capability.isOwner === 'function' ? capability.isOwner() : (capability.isOwner ?? capability.owner)
  if (typeof directOwner === 'boolean') return directOwner
  if (typeof capability.principal === 'string') return capability.principal === 'owner'
  if (typeof capability.getSnapshot === 'function') {
    const snapshot = capability.getSnapshot()
    if (typeof snapshot?.isOwner === 'boolean') return snapshot.isOwner
    if (typeof snapshot?.owner === 'boolean') return snapshot.owner
    if (typeof snapshot?.principal === 'string') return snapshot.principal === 'owner'
  }
  const internalKind = capability.state?.snapshot?.kind
  if (internalKind === 'owner') return true
  if (internalKind === 'granted') return false
  if (internalKind !== 'closed' && typeof capability.source === 'function') {
    const probe = capability.source('\u0000global', '', '__dsh_owner_probe__')
    if (typeof probe === 'boolean') return probe
    if (probe !== null && typeof probe === 'object') {
      if (typeof probe.getSnapshot === 'function') return Boolean(probe.getSnapshot())
      if (typeof probe.isOwner === 'boolean') return probe.isOwner
      if (typeof probe.allowed === 'boolean') return probe.allowed
    }
  }
  return undefined
}

/**
 * A window the application serves itself, such as DSH Desktop's
 * `dsh-app://app/`, runs beside its Host rather than across a network.
 */
function isApplicationPage(page: Location | undefined): boolean {
  const protocol = page?.protocol
  return typeof protocol === 'string' && protocol !== '' && protocol !== 'http:' && protocol !== 'https:'
}

/**
 * Consult official DSH `0.2.1+` `remoteAccess` capability state when available,
 * falling back to legacy application-page / loopback transport inspection on `0.2.0-rc.2`.
 */
export function isRemoteConnection(connection: ClientConnectionHandle): boolean {
  const page = globalThis.location
  const capability = connectionRemoteAccess.get(connection)
    ?? (connection as { remoteAccess?: RemoteAccessCapability }).remoteAccess
  const ownerState = resolveRemoteOwnerState(capability)
  if (ownerState !== undefined) {
    if (!ownerState) return true
    if (isApplicationPage(page)) return false
    const hostname = page?.hostname
    return typeof hostname === 'string' && hostname !== '' && !isLoopbackHostname(hostname)
  }
  if (isApplicationPage(page)) {
    const transport = (globalThis as { __DSH_TRANSPORT__?: { ownsHost?: unknown } }).__DSH_TRANSPORT__
    return transport !== undefined && transport !== null && transport.ownsHost !== true
  }
  const hostname = page?.hostname
  const remotePage = typeof hostname === 'string' && hostname !== '' && !isLoopbackHostname(hostname)
  return remotePage || !connection.isLoopback
}

/** Route only paired remote pages through API Gateway; local clients retain legacy channels. */
export async function callMnemonRpc<Channel extends MnemonRpcChannel>(
  connection: ClientConnectionHandle,
  channel: Channel,
  endpoint: MnemonRpcEndpoint<Channel>,
  payload: unknown,
  signal?: AbortSignal,
): Promise<ClientRpcResult> {
  const remoteEndpoint = REMOTE_ENDPOINT.get(channel)
  if (!isRemoteConnection(connection) || remoteEndpoint === undefined) {
    return signal === undefined
      ? connection.rpc.call(channel, endpoint, payload)
      : connection.rpc.call(channel, endpoint, payload, signal)
  }
  const remotePayload = { args: { endpoint, payload } }
  const response = await (signal === undefined
    ? connection.rpc.call(MNEMON_REMOTE_CHANNEL, remoteEndpoint, remotePayload)
    : connection.rpc.call(MNEMON_REMOTE_CHANNEL, remoteEndpoint, remotePayload, signal))
  if (!response.ok) return response
  if (!isClientRpcResult(response.value)) throw new Error('DSH API Gateway returned an invalid Mnemon response')
  return response.value
}
