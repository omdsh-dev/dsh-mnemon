import type { MemoryJsonValue } from './index.ts'

/** Semantic properties, not new Runtime methods or a primitive registry. */
export type MemorySemanticAction = 'record' | 'wake' | 'read' | 'compress' | 'forget'
export type MemorySemanticTarget = 'records' | 'representations' | 'relations' | 'catalog' | 'visibility' | 'usage' | 'candidates'
export type MemoryRepresentation = 'raw' | 'excerpt' | 'summary' | 'inference' | 'structured' | 'catalog' | 'receipt'

export interface MemoryEffect {
  target: MemorySemanticTarget
  mode: 'write' | 'delete' | 'invalidate'
  /** Required for usage effects. Retrieval is not injection or useful feedback. */
  stage?: 'retrieved' | 'injected' | 'feedback'
}

export interface MemoryBudgetMetric {
  resource: 'output' | 'input' | 'cost'
  /** characters = JS UTF-16 code units; bytes = UTF-8. Tokens require a basis. */
  unit: 'characters' | 'bytes' | 'tokens' | 'items' | 'calls' | 'milliseconds'
  measurement: 'exact' | 'estimated'
  /** E.g. tokenizer/model identity. Estimates must never claim exact tokens. */
  basis?: string
}

/** Source-enforced metrics in addition to Core's character/item/call ceilings. */
export interface MemoryBudgetSupport extends MemoryBudgetMetric {
  default: number
  maximum: number
}

export interface MemoryBudgetRequest extends MemoryBudgetMetric {
  /** auto inherits a finite Source default / Host ceiling; min is a preference, not padding. */
  amount: 'auto' | { max: number; min?: number }
}

export interface MemoryResolvedBudget extends MemoryBudgetMetric {
  max: number
  preferredMin?: number
}

/** Source-reported work; Core measures returned text/items and dispatched calls itself. */
export interface MemoryBudgetUsage extends MemoryBudgetMetric {
  used: number
}

export interface MemoryOperationSemantics {
  /** An upper bound for all modes of this operation, NOT a sequence to execute. */
  actions: MemorySemanticAction[]
  targets: MemorySemanticTarget[]
  effects: MemoryEffect[]
  representations: MemoryRepresentation[]
  /** summarize/page are Source algorithms. Core never invents either one. */
  overflow: 'truncate' | 'omit' | 'summarize' | 'page' | 'unavailable'
  budgets?: MemoryBudgetSupport[]
  /** Read-only does not imply retry-safe (e.g. retrieval usage bookkeeping). */
  retry: 'safe' | 'unsafe' | 'idempotency-key'
}

export interface MemoryOperationSelection {
  representation?: MemoryRepresentation
  budgets?: MemoryBudgetRequest[]
}

export interface MemoryResultSemantics {
  representation: MemoryRepresentation
  /** Preserved when mechanical clipping produces an excerpt of a summary/inference. */
  sourceRepresentation?: MemoryRepresentation
  /** Completeness of the stated item/target, never an implicit claim about the entire Source. */
  coverage: 'complete' | 'partial' | 'unknown'
  omitted?: string
  state?: 'active' | 'candidate' | 'archived'
  /** Provenance/citations alone do not promise an executable expansion. */
  expansion?: { routeId: string; input: MemoryJsonValue } | { unavailable: string }
  /** Source-local score interpretation; never automatically comparable across Sources. */
  score?: { basis: string; meaning: string }
}

/** Completion of the requested durable effect, distinct from transport/handler success. */
export type MemoryMutationCompletion = 'accepted' | 'candidate' | 'committed' | 'partial' | 'failed' | 'unknown'
