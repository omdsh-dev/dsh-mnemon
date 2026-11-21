import type { MemoryJsonValue, MemorySourceManagementInstance, MemorySourceManagementResult, TaskAgentModelCatalog } from 'dsh-mnemon/contracts'

export interface MnemonSourceManagementClient {
  readonly sourceInstanceKey: string
  readonly revision: string
  readonly assistance?: {
    readonly operations: readonly string[]
    execute(operation: string, input: MemoryJsonValue, options: { expectedRevision: string; confirmed: boolean }): Promise<MemorySourceManagementResult>
  }
  read(operation: string, input?: MemoryJsonValue, options?: { coalesce?: boolean }): Promise<MemorySourceManagementResult>
  mutate(operation: string, input: MemoryJsonValue, options: { expectedRevision?: string; confirmed: true }): Promise<MemorySourceManagementResult>
  readonly models?: () => Promise<TaskAgentModelCatalog>
}

export type MemorySourcePageInstance = Omit<MemorySourceManagementInstance, 'capabilities'> & { capabilities: readonly string[] }

export interface MemorySourcePageProps {
  sourceTypeId: string
  sourceInstanceKey?: string
  sourceInstances: readonly MemorySourcePageInstance[]
  management?: MnemonSourceManagementClient
  writable?: boolean
  active?: boolean
  sessionId?: string
  workspaceId?: string
  locale: string
  navigationInput?: MemoryJsonValue
  onRefresh?(): void
  refreshKey?: number
  onResetScroll?(): void
  onRevealElement?(element: HTMLElement, topInset?: number): void
  onReturnToConversation?(): void
  preferences?: { value: MemoryJsonValue; writable: boolean; replace(value: MemoryJsonValue): Promise<void> }
  onOpenSettings?: (section?: string) => void
  standalone?: boolean
}
