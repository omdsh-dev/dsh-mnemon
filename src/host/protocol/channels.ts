import type { ConnectionHandle as DshClientConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { MemoryJsonPrimitive, MemoryJsonValue } from '../../core/contracts/index.ts'
import { MNEMON_VIEW_CHANNEL, MNEMON_VIEW_WRITE_CHANNEL } from '../view-protocol.ts'

export const MNEMON_READ_CHANNEL = '/dsh-mnemon-read'
export const MNEMON_ACTIVATION_CHANNEL = '/dsh-mnemon-activation'
export const MNEMON_WRITE_CHANNEL = '/dsh-mnemon-write'
export const MNEMON_PACK_CHANNEL = '/dsh-mnemon-pack'
export const MNEMON_SYNC_CHANNEL = '/dsh-mnemon-sync'
export const MNEMON_SYNC_TOKEN_ENV = 'MNEMON_SYNC_GIT_TOKEN'
export const MNEMON_SYNC_DEFAULT_BRANCH = 'mnemon-sync'
export const MNEMON_SYNC_DEFAULT_SUBDIR = 'mnemon/'
export const MNEMON_SYNC_DEFAULT_AUTHOR_NAME = 'dsh-mnemon sync'
export const MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL = 'mnemon@localhost'
export const MNEMON_SETTINGS_CHANNEL = '/dsh-mnemon-settings'
export const MNEMON_REVIEW_CHANNEL = '/dsh-mnemon-review'
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
export const MNEMON_SKILLS_SETTINGS_NAMESPACE = 'mnemon-skills'

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
export type MnemonRpcChannel = keyof typeof MNEMON_RPC_ENDPOINTS
export type MnemonRpcEndpoint<Channel extends MnemonRpcChannel = MnemonRpcChannel> = (typeof MNEMON_RPC_ENDPOINTS)[Channel][number]

export type JsonPrimitive = MemoryJsonPrimitive
export type JsonValue = MemoryJsonValue

export type RpcError =
  | { code: 'bad-request'; message: string; details: { issues: JsonValue[] } }
  | { code: 'settings-rejected'; message: string; details: { ns: string } }
  | { code: 'internal'; message: string; details: Record<string, never> | { reason: string } }

export type RpcResult<T = JsonValue> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError }

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
