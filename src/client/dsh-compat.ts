/**
 * Compile-time boundary against the public DSH browser contracts.
 *
 * Keep version-sensitive declaration merging in one place so a future DSH
 * upgrade fails here instead of being papered over by local copies of slots.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { MnemonKey } from './locales.ts'
import type {
  JsonValue,
  MemorySourceManagementInstance,
  MemorySourceManagementResult,
} from '../shared/contracts.ts'

/**
 * Instance- and scope-bound browser capability. It deliberately exposes only
 * the authenticated Source management protocol, never the raw DSH transport.
 */
export interface MnemonSourceManagementClient {
  readonly sourceInstanceKey: string
  readonly revision: string
  read(operation: string, input?: JsonValue): Promise<MemorySourceManagementResult>
  mutate(
    operation: string,
    input: JsonValue,
    options: { expectedRevision?: string; confirmed: true },
  ): Promise<MemorySourceManagementResult>
}

export interface MnemonSourcePageOwnerProps {
  /** Type-level presentation identity; never a Client or Host Fiber uid. */
  sourceTypeId: string
  /** Selected Host instance in the current authenticated scope. */
  sourceInstanceKey?: string
  sourceInstances: readonly MemorySourceManagementInstance[]
  /** Present only while the selected Host instance remains visible. */
  management?: MnemonSourceManagementClient
  sessionId?: string
  workspaceId?: string
  locale: string
  /** Migration seat used by the three built-in pages in the root artifact. */
  children?: ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    mnemon: MnemonKey
  }

  interface SlotMap {
    /** Optional Source-specific pages owned by the canonical Mnemon workspace. */
    'mnemon.source.page': {
      kind: 'list'
      scope: 'session'
      owner: MnemonSourcePageOwnerProps
    }
  }
}

export interface MnemonSessionSummary {
  cwd?: string
  origin?: string
  projectionValues?: Readonly<Record<string, unknown>>
  [key: string]: unknown
}

export interface MnemonSessionListState {
  current?: string
  byId: Record<string, MnemonSessionSummary>
  [key: string]: unknown
}

export interface MnemonWorkspaceSummary {
  workspaceId: unknown
  title: string
  path: string
}

export interface MnemonWorkspaceListState {
  items: MnemonWorkspaceSummary[]
  [key: string]: unknown
}

interface SnapshotStore<State> {
  getSnapshot(): State
  subscribe(listener: () => void): () => void
}

/** Context shared by the released client runtime and the 0.1.2 controller split. */
export type MnemonClientContext = Context & {
  connection: ConnectionHandle
  locale: LocaleRuntime
  sessions: { list: SnapshotStore<MnemonSessionListState> }
  workspaces: { list: SnapshotStore<MnemonWorkspaceListState> }
}
