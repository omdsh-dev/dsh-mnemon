import type { ConnectionHandle as DshClientConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { MemoryJsonPrimitive, MemoryJsonValue } from '../../core/contracts/index.ts'
import { MNEMON_VIEW_CHANNEL, MNEMON_VIEW_WRITE_CHANNEL } from '../view-protocol.ts'

export const MNEMON_READ_CHANNEL = '/dsh-mnemon-read'
export const MNEMON_ACTIVATION_CHANNEL = '/dsh-mnemon-activation'
export const MNEMON_WRITE_CHANNEL = '/dsh-mnemon-write'
export const MNEMON_PACK_CHANNEL = '/dsh-mnemon-pack'
export const MNEMON_SYNC_CHANNEL = '/dsh-mnemon-sync'
/**
 * The credential environment variable the sync channel reads before its stored
 * token. The name travels to the browser so the settings form can tell the user
 * which variable wins; the value never does.
 */
export const MNEMON_SYNC_TOKEN_ENV = 'MNEMON_SYNC_GIT_TOKEN'
/**
 * What a storage root publishes before anyone configures it: the branch, the
 * directory inside it, and the fallback when no author or Git identity is set. They
 * are declared with the wire constants because the settings form shows the same
 * defaults the Host would apply to an empty field.
 */
export const MNEMON_SYNC_DEFAULT_BRANCH = 'mnemon-sync'
export const MNEMON_SYNC_DEFAULT_SUBDIR = 'mnemon/'
export const MNEMON_SYNC_DEFAULT_AUTHOR_NAME = 'dsh-mnemon sync'
export const MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL = 'mnemon@localhost'
export const MNEMON_SETTINGS_CHANNEL = '/dsh-mnemon-settings'
/**
 * Reconciliation is the only channel that changes memory after a human read it:
 * it stages proposals into a review ledger, takes opinions, and applies an
 * accepted entry. It is deliberately separate from the write channel.
 */
export const MNEMON_REVIEW_CHANNEL = '/dsh-mnemon-review'
/** DSH API Gateway endpoints used by paired remote Web clients. */
export const MNEMON_REMOTE_CHANNEL = '/api'
export const MNEMON_REMOTE_NAMESPACE = 'dshMnemon'
export const MNEMON_REMOTE_READ_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/read`
export const MNEMON_REMOTE_ACTIVATION_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/activation`
export const MNEMON_REMOTE_WRITE_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/write`
export const MNEMON_REMOTE_PACK_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/pack`
export const MNEMON_REMOTE_SYNC_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/sync`
export const MNEMON_REMOTE_SETTINGS_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/settings`
export const MNEMON_REMOTE_VIEW_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/view`
export const MNEMON_REMOTE_VIEW_WRITE_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/viewWrite`
export const MNEMON_REMOTE_REVIEW_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/review`
export const MNEMON_SETTINGS_NAMESPACE = 'mnemon'
export const MNEMON_UI_SETTINGS_NAMESPACE = 'mnemon-ui'
/** 技能管理's settings: one live group of the dsh-mnemon entry, drawn on that component's page. */
export const MNEMON_SKILLS_SETTINGS_NAMESPACE = 'mnemon-skills'

/**
 * Every endpoint the Host serves on each channel, by the names both sides use: the client's calls
 * are typed against this list, and tests/rpc-endpoints.spec.ts checks that each Host handler serves
 * exactly these names.
 */
export const MNEMON_RPC_ENDPOINTS = {
  [MNEMON_READ_CHANNEL]: [
    'status', 'status-summary', 'memory-system', 'versions', 'task-agent-models', 'runtime-memory', 'documents', 'document', 'document-search',
    'graph', 'bodies', 'body-directory', 'body-reconnect', 'provider-services', 'embedding-status', 'list', 'entities', 'search', 'agent-search', 'related',
    'turn-activities', 'turn-activity', 'skill-activity', 'assistant-message', 'source-management-catalog', 'source-management-read', 'source-assistance',
  ],
  [MNEMON_ACTIVATION_CHANNEL]: ['body', 'source-assistance'],
  [MNEMON_WRITE_CHANNEL]: [
    'runtime-memory', 'document', 'supervise', 'remember', 'link', 'forget', 'body-create', 'body-update', 'body-delete', 'body-merge',
    'body-metadata-maintain', 'provider-service-update', 'embedding-fill', 'source-management-mutate', 'source-assistance', 'version-update',
  ],
  [MNEMON_PACK_CHANNEL]: ['target', 'export', 'inspect', 'import'],
  [MNEMON_SYNC_CHANNEL]: [
    'status', 'configure', 'push', 'preview', 'backups', 'diff', 'pull',
    'github-status', 'github-start', 'github-poll', 'github-cancel', 'github-signout', 'github-repositories', 'github-create',
  ],
  [MNEMON_REVIEW_CHANNEL]: ['view', 'opinion', 'decide', 'reopen', 'reconcile', 'apply'],
  [MNEMON_SETTINGS_CHANNEL]: ['get', 'mutate'],
  [MNEMON_VIEW_CHANNEL]: ['dashboard', 'preview', 'inspect-plugin'],
  [MNEMON_VIEW_WRITE_CHANNEL]: ['apply', 'install-plugin'],
} as const satisfies Readonly<Record<string, readonly string[]>>
/** A channel the Host serves. */
export type MnemonRpcChannel = keyof typeof MNEMON_RPC_ENDPOINTS
/** An endpoint the Host serves on a channel, or on any of several. */
export type MnemonRpcEndpoint<Channel extends MnemonRpcChannel = MnemonRpcChannel> = (typeof MNEMON_RPC_ENDPOINTS)[Channel][number]

export type JsonPrimitive = MemoryJsonPrimitive
export type JsonValue = MemoryJsonValue

export type RpcError =
  | { code: 'bad-request'; message: string; details: { issues: JsonValue[] } }
  | { code: 'settings-rejected'; message: string; details: { ns: string } }
  /** `reason` names a failure the page can state in its own language, such as a sync remote refusing credentials. */
  | { code: 'internal'; message: string; details: Record<string, never> | { reason: string } }

export type RpcResult<T = JsonValue> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError }

/** Public DSH browser RPC face plus the transport boundary needed to gate local-only writes. */
export type ClientConnectionHandle = Pick<DshClientConnectionHandle, 'rpc' | 'isLoopback'>

export interface ClientSettingsSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value?: T
  base?: unknown
  user?: unknown
  revision?: number
  writable: boolean
  mode: 'host' | 'memory'
}

export interface ClientSettingsScope<T> {
  getSnapshot(): ClientSettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(ops: SettingsOperation[]): Promise<void>
}

export type SettingsOperation = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }
