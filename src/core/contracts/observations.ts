import type { MemoryMutationCompletion, MemoryOperationScope, MemoryReceiptStatus } from './index.ts'

/** Optional Source-owned metadata; state vocabulary belongs to that Source. */
export interface MemoryOperationRecord { id: string; revision?: string; state?: string }

/** Operation metadata for optional feedback plugins. Never includes prompts, grants or record bodies. */
export interface MemoryOperationObservation {
  id: string
  occurredAt: string
  scope: MemoryOperationScope
  sourceInstanceKey: string
  sourceTypeId: string
  operation: string
  kind: 'read' | 'mutation' | 'management'
  actor: 'model' | 'operator'
  viewId?: string
  recordIds: string[]
  records?: MemoryOperationRecord[]
  revision?: string
  status?: MemoryReceiptStatus
  execution?: import('./operations.ts').MemoryExecutionResult
  completion?: MemoryMutationCompletion
}

export type MemoryOperationObserver = (observation: Readonly<MemoryOperationObservation>) => void | Promise<void>
