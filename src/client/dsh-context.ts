/**
 * Compile-time boundary against the public DSH browser contracts.
 *
 * Keep version-sensitive declaration merging in one place so a future DSH
 * upgrade fails here instead of being papered over by local copies of slots.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { MnemonKey } from './locales.ts'
import type { MemorySourcePageProps } from './source-contracts.ts'
export type { MnemonSourceManagementClient } from './source-contracts.ts'
export type MnemonSourcePageOwnerProps = MemorySourcePageProps

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    mnemon: MnemonKey
  }

  interface SlotMap {
    /** Optional Source-specific pages owned by the canonical Mnemon workspace. */
    'mnemon.source.page': {
      kind: 'list'
      scope: 'root'
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
