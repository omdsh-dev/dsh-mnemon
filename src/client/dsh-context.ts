import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { MnemonKey } from './locales.ts'
import type { MemorySourcePageProps } from './source-contracts.ts'
import type { MemoryComponentSettingsProps, MemoryComponentStatusProps } from './component-ui.tsx'
export type { MnemonSourceManagementClient } from './source-contracts.ts'
export type MnemonSourcePageOwnerProps = MemorySourcePageProps

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    mnemon: MnemonKey
  }

  interface SlotMap {
    'mnemon.source.page': {
      kind: 'list'
      scope: 'root'
      owner: MnemonSourcePageOwnerProps
    }
    'mnemon.component.settings': {
      kind: 'keyed'
      scope: 'root'
      owner: MemoryComponentSettingsProps
    }
    'mnemon.component.status': {
      kind: 'keyed'
      scope: 'root'
      owner: MemoryComponentStatusProps
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
  byId: Record<string, MnemonSessionSummary>
  [key: string]: unknown
}

interface MnemonWorkspaceSummary {
  workspaceId: unknown
  title: string
  path: string
}

interface MnemonWorkspaceListState {
  items: MnemonWorkspaceSummary[]
  [key: string]: unknown
}

export type MnemonClientContext = Context & {
  connection: ConnectionHandle
  locale: LocaleRuntime
  sessions: { list: ObservableSnapshot<MnemonSessionListState> }
  workspaces: { list: ObservableSnapshot<MnemonWorkspaceListState> }
}
