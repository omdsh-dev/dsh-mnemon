import type { MemoryJsonValue, MemorySourceManagementInstance, MemorySourceManagementResult, TaskAgentModelCatalog } from 'dsh-mnemon/contracts'

/** Instance- and scope-bound capability; never the Host's raw transport. */
export interface MnemonSourceManagementClient {
  readonly sourceInstanceKey: string
  readonly revision: string
  /** Optional workflows advertised and authorized by the Host for this exact instance. */
  readonly assistance?: {
    readonly operations: readonly string[]
    execute(operation: string, input: MemoryJsonValue, options: { expectedRevision: string; confirmed: boolean }): Promise<MemorySourceManagementResult>
  }
  /** Automatic inspections may share an identical pending read; explicit actions remain fresh by default. */
  read(operation: string, input?: MemoryJsonValue, options?: { coalesce?: boolean }): Promise<MemorySourceManagementResult>
  mutate(operation: string, input: MemoryJsonValue, options: { expectedRevision?: string; confirmed: true }): Promise<MemorySourceManagementResult>
  /**
   * The routes and model directory a page may offer as a per-run choice. Absent
   * on a Host that offers none, and the page then hides its pickers.
   */
  readonly models?: () => Promise<TaskAgentModelCatalog>
}

/** Browser metadata is display-only; the Host validates capability identifiers. */
export type MemorySourcePageInstance = Omit<MemorySourceManagementInstance, 'capabilities'> & { capabilities: readonly string[] }

export interface MemorySourcePageProps {
  /** Type-level presentation identity; never a Client or Host Fiber uid. */
  sourceTypeId: string
  /** Selected Host instance in the current authenticated scope. */
  sourceInstanceKey?: string
  sourceInstances: readonly MemorySourcePageInstance[]
  /** Present only while the selected Host instance remains visible. */
  management?: MnemonSourceManagementClient
  /** Presentation hint only; the Host still authenticates every mutation. */
  writable?: boolean
  /** False while a retained panel is hidden; pause polling and focus refreshes. Defaults to true. */
  active?: boolean
  sessionId?: string
  workspaceId?: string
  locale: string
  /** Opaque navigation data owned by this Source page. */
  navigationInput?: MemoryJsonValue
  onRefresh?(): void
  /** Changes each time the user refreshes the workspace; reload this page's data when it does. */
  refreshKey?: number
  /** Reset only this workbench's page scroll when Source-owned navigation changes. */
  onResetScroll?(): void
  /**
   * Reveal a descendant in this canvas only, below the locked page header, or
   * `topInset` below the top when the Source pins and measures its own header.
   */
  onRevealElement?(element: HTMLElement, topInset?: number): void
  /**
   * Leave the Memory System for the conversation it was opened from, as the
   * header's back button does. Absent where the page is already beside the
   * conversation, such as the conversation tab.
   */
  onReturnToConversation?(): void
  /** Optional, Source-bound product preferences; no raw settings service or secrets. */
  preferences?: { value: MemoryJsonValue; writable: boolean; replace(value: MemoryJsonValue): Promise<void> }
  /**
   * Open this Source component's own settings, on its page under Plugins.
   * Present while that page offers navigation.
   */
  onOpenSettings?(): void
  /**
   * The page is the whole view, as in a sidebar entry of its own: the view's
   * header already carries its title.
   */
  standalone?: boolean
}
