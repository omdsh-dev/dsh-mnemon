import type { MemoryContextProfile, MemoryPluginLocalizedText } from './index.ts'

export const MEMORY_CONTEXT_POLICY_FORMAT = 'mnemon-context-policy/v1' as const

/** A restriction can only narrow current Host-authorized sources and budgets. */
export interface MemoryContextSelection {
  sourceKeys?: string[]
  writableSourceKeys?: string[]
  maxProjectionCharacters?: number
}

/** An extension evaluates its own domain rule before returning this bounded proposal. */
export interface MemoryContextDecision {
  id: string
  sourceInstanceKey: string
  ready: boolean
  reason: MemoryPluginLocalizedText
  requires?: { routeIds?: string[]; actionIds?: string[] }
  context?: MemoryContextProfile
  instruction?: string
}

export interface MemoryContextPolicy {
  format: typeof MEMORY_CONTEXT_POLICY_FORMAT
  selection?: MemoryContextSelection
  decisions: MemoryContextDecision[]
}

/** A replayable account of the decisions that did and did not enter this View. */
export interface MemoryContextDecisionTrace {
  id: string
  contributionInstanceKey: string
  sourceInstanceKey: string
  state: 'applied' | 'deferred' | 'excluded' | 'budget' | 'unavailable'
  reason: MemoryPluginLocalizedText
  routeIds: string[]
  actionIds: string[]
}
