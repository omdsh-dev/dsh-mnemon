import type { MemoryJsonValue, MemorySourceMode } from './index.ts'

/** Access mechanisms can coexist on one route; they describe behavior, not permission. */
export const MEMORY_ACCESS_KINDS = ['read', 'browse', 'search', 'related', 'observe'] as const
export type MemoryAccessKind = typeof MEMORY_ACCESS_KINDS[number]
export const MEMORY_RESULT_SHAPES = ['text', 'records', 'resources', 'events', 'execution'] as const
export type MemoryResultShape = typeof MEMORY_RESULT_SHAPES[number]
export interface MemoryAccessSemantics {
  kinds: MemoryAccessKind[]
  result: MemoryResultShape
}

/** Effect vocabulary shared by selection, receipts and human presentation. */
export const MEMORY_OPERATION_EFFECTS = ['append', 'update', 'propose', 'publish', 'remove', 'execute', 'deliver', 'coordinate', 'transfer', 'feedback'] as const
export type MemoryOperationEffect = typeof MEMORY_OPERATION_EFFECTS[number]
export interface MemoryOperationSemantics {
  effects: MemoryOperationEffect[]
  execution: 'immediate' | 'deferred'
  /** Core requires this Source's pinned read grant; resource-level checks remain Source-owned. */
  requiresReadGrant?: true
}

/** A Source's advisory context profile. The selected Strategy owns the final allocation. */
export interface MemoryContextProfile {
  mode: MemorySourceMode
  weight: number
}

/** Source-local identity; it never authorizes access to a path or a different Source. */
export interface MemoryResourceReference {
  id: string
  revision?: string
  path?: string
  mediaType?: string
}

/** A continuation uses another offered route with the same Source authority and budget. */
export interface MemoryReadContinuation {
  routeId: string
  input: MemoryJsonValue
}

export const MEMORY_EXECUTION_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'timed-out', 'unknown'] as const
export type MemoryExecutionState = typeof MEMORY_EXECUTION_STATES[number]
export interface MemoryExecutionResult {
  id: string
  state: MemoryExecutionState
  /** Present only when an actual process exit was observed. */
  exitCode?: number
}

/** Browser-safe operation inventory. Management and model operations keep separate authority. */
export interface MemorySourceOperationInventory {
  reads: Array<{ id: string; description: string; access?: MemoryAccessSemantics }>
  actions: Array<{ id: string; description: string; operation?: MemoryOperationSemantics; requiresApproval: boolean }>
}
