/** Memory Spaces-owned recall quality policy. */
import type {
  EvaluatedRecallQualityCandidate,
  RecallQualityCandidate,
  RecallQualityDecision,
  RecallQualityPolicy,
  RecallQualityPolicyContext,
} from './contracts.ts'
import { DEFAULT_RECALL_HIGH_SCORE_THRESHOLD, DEFAULT_RECALL_LOW_SCORE_THRESHOLD } from '../defaults.ts'

function expandedLimit(context: RecallQualityPolicyContext): number {
  return Math.min(50, Math.max(context.requestedLimit, Math.ceil(context.requestedLimit * context.config.candidateMultiplier)))
}

/** Thresholds a user left at their defaults were tuned for no Provider's embedding model. */
function defaultThresholds(context: RecallQualityPolicyContext): boolean {
  return context.config.lowScoreThreshold === DEFAULT_RECALL_LOW_SCORE_THRESHOLD
    && context.config.highScoreThreshold === DEFAULT_RECALL_HIGH_SCORE_THRESHOLD
}

function scoreDecision(
  candidate: RecallQualityCandidate,
  context: RecallQualityPolicyContext,
  lowScoreAction: RecallQualityDecision['action'],
  nonPositiveAction: RecallQualityDecision['action'],
  rankEmbeddingSimilarity = false,
): RecallQualityDecision {
  const score = candidate.insight.score
  const scale = candidate.scoreSemantics?.kind === 'normalized-relevance' ? candidate.scoreSemantics.scale : undefined
  // Raw embedding similarity spreads differently with every model, so beside another Provider's rows
  // the default bands cannot place it: such rows keep their Provider's order instead. A search of that
  // Provider alone, or thresholds a user set, band it as declared (#454).
  if (rankEmbeddingSimilarity && context.mixedProviders === true && scale === 'embedding-similarity' && defaultThresholds(context)
    && (score === undefined || (Number.isFinite(score) && score > 0))) {
    return { action: 'keep', tier: 'ranked', reason: score === undefined ? 'unscored' : 'uncalibrated-score' }
  }
  if (score === undefined) return { action: 'keep', tier: 'unknown', reason: 'unscored' }
  if (!Number.isFinite(score)) return { action: 'drop', tier: 'unknown', reason: 'invalid-score' }
  if (candidate.scoreSemantics?.kind !== 'normalized-relevance') {
    return { action: 'keep', tier: 'unknown', reason: 'unscaled-score' }
  }
  if (score <= 0) return { action: nonPositiveAction, tier: 'low', reason: 'non-positive-score', normalizedScore: 0 }
  // Boosts can carry a relevant result past 1; it is still the top of the relevance scale (#454).
  const relevance = scale === 'boosted' ? Math.min(score, 1) : score
  // A Provider violating its declared 0..1 range is safer as an unknown-scale
  // ranked result than as a fabricated high-confidence result.
  if (relevance > 1) return { action: 'keep', tier: 'unknown', reason: 'unscaled-score' }
  if (relevance < context.config.lowScoreThreshold) return { action: lowScoreAction, tier: 'low', reason: 'low-score', normalizedScore: relevance }
  if (relevance < context.config.highScoreThreshold) return { action: 'keep', tier: 'medium', reason: 'medium-score', normalizedScore: relevance }
  return { action: 'keep', tier: 'high', reason: 'high-score', normalizedScore: relevance }
}

function primarySelection(candidates: readonly EvaluatedRecallQualityCandidate[], context: RecallQualityPolicyContext): EvaluatedRecallQualityCandidate[] {
  return candidates.filter(candidate => candidate.decision.action === 'keep').slice(0, context.requestedLimit)
}

export const STRICT_RECALL_QUALITY_POLICY: RecallQualityPolicy = {
  id: 'strict-v1',
  candidateLimit: expandedLimit,
  evaluate: (candidate, context) => scoreDecision(candidate, context, 'drop', 'drop', true),
  select(candidates, context) {
    const kept = candidates.filter(candidate => candidate.decision.action === 'keep')
    return [
      ...kept.filter(candidate => candidate.decision.tier === 'high'),
      // Rows kept by their Provider's order follow calibrated high evidence, so they never displace it.
      ...kept.filter(candidate => candidate.decision.tier === 'ranked').slice(0, context.config.maxRankedResults),
      ...kept.filter(candidate => candidate.decision.tier === 'medium').slice(0, context.config.maxMediumResults),
      ...kept.filter(candidate => candidate.decision.tier === 'unknown').slice(0, context.config.maxUnknownResults),
    ].slice(0, context.requestedLimit)
  },
}

export const BALANCED_RECALL_QUALITY_POLICY: RecallQualityPolicy = {
  id: 'balanced-v1',
  candidateLimit: expandedLimit,
  evaluate: (candidate, context) => scoreDecision(candidate, context, 'keep', 'drop'),
  select(candidates, context) {
    const kept = candidates.filter(candidate => candidate.decision.action === 'keep')
    return [
      ...kept.filter(candidate => candidate.decision.tier !== 'low'),
      ...kept.filter(candidate => candidate.decision.tier === 'low'),
    ].slice(0, context.requestedLimit)
  },
}

export const EXHAUSTIVE_RECALL_QUALITY_POLICY: RecallQualityPolicy = {
  id: 'exhaustive-v1',
  candidateLimit: expandedLimit,
  evaluate: (candidate, context) => scoreDecision(candidate, context, 'keep', 'keep'),
  select: primarySelection,
}

export const BUILTIN_RECALL_QUALITY_POLICIES = [
  STRICT_RECALL_QUALITY_POLICY,
  BALANCED_RECALL_QUALITY_POLICY,
  EXHAUSTIVE_RECALL_QUALITY_POLICY,
] as const
