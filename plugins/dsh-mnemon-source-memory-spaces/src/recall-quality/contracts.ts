/** Memory Spaces-owned recall quality policy. */
import type { Insight, MemoryProviderId, ResolvedRecallQualityConfig } from '../contracts.ts'
import type { ProviderScoreSemantics } from '../providers/adapter.ts'

export type RecallQualityDecisionReason =
  | 'high-score'
  | 'medium-score'
  | 'low-score'
  | 'non-positive-score'
  | 'invalid-score'
  | 'unscaled-score'
  /** Embedding similarity kept in its Provider's order beside other Providers, under the default thresholds (#454). */
  | 'uncalibrated-score'
  | 'unscored'

export interface RecallQualityCandidate {
  insight: Insight
  memoryBodyId: string
  providerId: MemoryProviderId
  providerRank: number
  bodyOrder: number
  scoreSemantics?: ProviderScoreSemantics
}

export interface RecallQualityDecision {
  action: 'keep' | 'drop'
  /** `ranked`: kept by the Provider's order, not banded by score; see `maxRankedResults`. */
  tier: 'high' | 'medium' | 'low' | 'unknown' | 'ranked'
  reason: RecallQualityDecisionReason
  normalizedScore?: number
}

export interface EvaluatedRecallQualityCandidate {
  candidate: RecallQualityCandidate
  decision: RecallQualityDecision
}

export interface RecallQualityPolicyContext {
  requestedLimit: number
  config: ResolvedRecallQualityConfig
  /** More than one Provider answers the search, so candidates are ordered by rank rather than by score. */
  mixedProviders?: boolean
}

/** Pure, bounded policy applied before recall rows are serialized to an Agent. */
export interface RecallQualityPolicy {
  readonly id: string
  candidateLimit(context: RecallQualityPolicyContext): number
  evaluate(candidate: RecallQualityCandidate, context: RecallQualityPolicyContext): RecallQualityDecision
  select(candidates: readonly EvaluatedRecallQualityCandidate[], context: RecallQualityPolicyContext): EvaluatedRecallQualityCandidate[]
}
