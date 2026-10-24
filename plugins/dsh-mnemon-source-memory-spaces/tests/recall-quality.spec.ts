import { describe, expect, it } from 'vitest'
import { resolveMemorySpacesConfig } from "../src/config.ts"
import { NORMALIZED_RELEVANCE_SCORE } from '../src/providers/adapter.ts'
import {
  BALANCED_RECALL_QUALITY_POLICY,
  EXHAUSTIVE_RECALL_QUALITY_POLICY,
  RecallQualityPolicyRegistry,
  STRICT_RECALL_QUALITY_POLICY,
  applyRecallQualityPolicy,
  prepareRecallQualityPolicy,
  type RecallQualityCandidate,
  type RecallQualityPolicy,
  type RecallQualityPolicyContext,
} from '../src/recall-quality/index.ts'

function context(policy = 'strict-v1', requestedLimit = 10): RecallQualityPolicyContext {
  return { requestedLimit, config: resolveMemorySpacesConfig({ recallQuality: { policy } }).recallQuality }
}

function candidate(id: string, score?: number, normalized = true): RecallQualityCandidate {
  return {
    insight: { id, content: id, ...(score === undefined ? {} : { score }) },
    memoryBodyId: 'project',
    providerId: 'mnemon-native',
    providerRank: 1,
    bodyOrder: 0,
    ...(normalized ? { scoreSemantics: NORMALIZED_RELEVANCE_SCORE } : {}),
  }
}

describe('recall quality policies', () => {
  it.each([STRICT_RECALL_QUALITY_POLICY, BALANCED_RECALL_QUALITY_POLICY, EXHAUSTIVE_RECALL_QUALITY_POLICY])('preserves native ranks without interpreting their score scale in $id (#454)', policy => {
    const policyContext = context(policy.id, 6)
    const rows = [1.038, 0.71, undefined, -2, 0, 99].map((score, index) => ({
      ...candidate(`rank-${index}`, score), scoreSemantics: { kind: 'provider-native' as const },
    }))
    const result = applyRecallQualityPolicy(prepareRecallQualityPolicy(policy, policyContext), rows, policyContext)
    expect(result.selected.map(row => row.candidate.insight.id)).toEqual(rows.map(row => row.insight.id))
    expect(result.selected.every(row => row.decision.tier === 'ranked' && row.decision.normalizedScore === undefined)).toBe(true)
  })

  it('keeps the fused order across ranked and calibrated results while retaining limits (#454)', () => {
    const policyContext = context('strict-v1', 5)
    policyContext.config.maxMediumResults = 1
    policyContext.config.maxUnknownResults = 1
    const rows = [
      { ...candidate('native-answer', 1.038), scoreSemantics: { kind: 'provider-native' as const } },
      candidate('calibrated-high', 0.9), candidate('medium', 0.5), candidate('medium-over-budget', 0.4),
      { ...candidate('native-unscored'), scoreSemantics: { kind: 'provider-native' as const } },
      candidate('unknown'), candidate('unknown-over-budget'), candidate('low', 0.1),
      { ...candidate('invalid', Number.NaN), scoreSemantics: { kind: 'provider-native' as const } },
    ]
    const result = applyRecallQualityPolicy(prepareRecallQualityPolicy(STRICT_RECALL_QUALITY_POLICY, policyContext), rows, policyContext)
    expect(result.selected.map(row => row.candidate.insight.id)).toEqual(['native-answer', 'calibrated-high', 'medium', 'native-unscored', 'unknown'])
    expect(result.evaluated.at(-1)?.decision).toMatchObject({ action: 'drop', reason: 'invalid-score' })
  })

  it('strict-v1 enforces score boundaries while retaining unscored and unknown-scale ranks', () => {
    const policyContext = context()
    const prepared = prepareRecallQualityPolicy(STRICT_RECALL_QUALITY_POLICY, policyContext)
    const result = applyRecallQualityPolicy(prepared, [
      candidate('high', 0.6),
      candidate('medium-upper', 0.599),
      candidate('medium-lower', 0.25),
      candidate('low', 0.249),
      candidate('zero', 0),
      candidate('unscored'),
      candidate('unscaled', 99),
      candidate('provider-unknown', 0.1, false),
    ], policyContext)

    expect(result.selected.map(entry => entry.candidate.insight.id)).toEqual([
      'high', 'medium-upper', 'medium-lower', 'unscored', 'unscaled',
    ])
    expect(result.evaluated.map(entry => [entry.candidate.insight.id, entry.decision])).toEqual(expect.arrayContaining([
      ['high', expect.objectContaining({ action: 'keep', tier: 'high', normalizedScore: 0.6 })],
      ['medium-lower', expect.objectContaining({ action: 'keep', tier: 'medium', normalizedScore: 0.25 })],
      ['low', expect.objectContaining({ action: 'drop', reason: 'low-score' })],
      ['zero', expect.objectContaining({ action: 'drop', reason: 'non-positive-score' })],
      ['unscaled', expect.objectContaining({ action: 'keep', tier: 'unknown', reason: 'out-of-range-score' })],
      ['provider-unknown', expect.objectContaining({ action: 'keep', tier: 'unknown', reason: 'unscaled-score' })],
    ]))
    expect(prepared.candidateLimit).toBe(30)
  })

  it('strict-v1 budgets medium and unknown rows instead of filling the requested limit', () => {
    const policyContext = context('strict-v1', 10)
    const result = applyRecallQualityPolicy(
      prepareRecallQualityPolicy(STRICT_RECALL_QUALITY_POLICY, policyContext),
      [
        candidate('high-1', 0.9), candidate('high-2', 0.7),
        candidate('medium-1', 0.59), candidate('medium-2', 0.5), candidate('medium-3', 0.4),
        candidate('medium-4', 0.3), candidate('medium-5', 0.29), candidate('medium-6', 0.28),
        candidate('unknown-1'), candidate('unknown-2'), candidate('unknown-3'),
      ],
      policyContext,
    )

    expect(result.selected.map(entry => entry.candidate.insight.id)).toEqual([
      'high-1', 'high-2', 'medium-1', 'medium-2', 'medium-3', 'medium-4', 'unknown-1', 'unknown-2',
    ])
  })

  it('balanced-v1 places low-score rows after primary evidence while exhaustive-v1 preserves zero scores', () => {
    const balancedContext = context('balanced-v1', 2)
    const balanced = applyRecallQualityPolicy(
      prepareRecallQualityPolicy(BALANCED_RECALL_QUALITY_POLICY, balancedContext),
      [candidate('low', 0.1), candidate('high', 0.8), candidate('medium', 0.4)],
      balancedContext,
    )
    expect(balanced.selected.map(entry => entry.candidate.insight.id)).toEqual(['high', 'medium'])

    const exhaustiveContext = context('exhaustive-v1', 2)
    const exhaustive = applyRecallQualityPolicy(
      prepareRecallQualityPolicy(EXHAUSTIVE_RECALL_QUALITY_POLICY, exhaustiveContext),
      [candidate('zero', 0), candidate('low', 0.1)],
      exhaustiveContext,
    )
    expect(exhaustive.selected.map(entry => entry.candidate.insight.id)).toEqual(['zero', 'low'])
  })

  it('registers replaceable policies and rejects duplicate ids', () => {
    const registry = new RecallQualityPolicyRegistry([])
    const custom: RecallQualityPolicy = { ...STRICT_RECALL_QUALITY_POLICY, id: 'custom-v1' }
    const dispose = registry.register(custom)
    expect(registry.resolve('custom-v1')).toBe(custom)
    expect(() => registry.register(custom)).toThrow('already registered')
    dispose()
    expect(() => registry.resolve('custom-v1')).toThrow('unknown recall quality policy')
  })

  it('falls back to strict-v1 when a custom policy returns an unsafe limit or selection', () => {
    const policyContext = context('broken-v1', 2)
    const badLimit: RecallQualityPolicy = { ...STRICT_RECALL_QUALITY_POLICY, id: 'broken-v1', candidateLimit: () => 0 }
    const prepared = prepareRecallQualityPolicy(badLimit, policyContext)
    expect(prepared).toMatchObject({ policy: STRICT_RECALL_QUALITY_POLICY, candidateLimit: 6, fallbackFrom: 'broken-v1' })

    const unsafeSelection: RecallQualityPolicy = {
      ...STRICT_RECALL_QUALITY_POLICY,
      id: 'unsafe-v1',
      select: candidates => [candidates.find(entry => entry.decision.action === 'drop')!],
    }
    const unsafeContext = context('unsafe-v1', 2)
    const result = applyRecallQualityPolicy(
      prepareRecallQualityPolicy(unsafeSelection, unsafeContext),
      [candidate('high', 0.8), candidate('low', 0.1)],
      unsafeContext,
    )
    expect(result).toMatchObject({ policyId: 'strict-v1', fallbackFrom: 'unsafe-v1' })
    expect(result.selected.map(entry => entry.candidate.insight.id)).toEqual(['high'])
  })
})
