import type { MnemonSyncGitHubStatus, MnemonSyncStatus } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'

export interface RepositoryEditorProps {
  client: MnemonClient
  status: MnemonSyncStatus
  github: MnemonSyncGitHubStatus | null
  disabled: boolean
  cancellable: boolean
  initialMode?: 'github' | 'address' | undefined
  t: MnemonTranslate
  onGitHub: (status: MnemonSyncGitHubStatus | null) => void
  onReadGitHub: () => Promise<void>
  onRefresh: () => Promise<void>
  onCancel: () => void
  onConnected: () => Promise<void>
}
