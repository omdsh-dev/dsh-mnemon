import { describe, expect, it } from 'vitest'
import { resolveMemorySpacesConfig } from "../src/config.ts"
import { NORMALIZED_RELEVANCE_SCORE, type ProviderScoreSemantics } from '../src/providers/adapter.ts'
import type { RecallQualityConfig } from '../src/contracts.ts'
import {
  BALANCED_RECALL_QUALITY_POLICY,
  EXHAUSTIVE_RECALL_QUALITY_POLICY,
  RecallQualityPolicyRegistry,
  STRICT_RECALL_QUALITY_POLICY,
  applyRecallQualityPolicy,
  prepareRecallQualityPolicy,
  type RecallQualityCandidate,
  type RecallQualityDecision,
  type RecallQualityPolicy,
  type RecallQualityPolicyContext,
} from '../src/recall-quality/index.ts'

function context(policy = 'strict-v1', requestedLimit = 10, recallQuality: RecallQualityConfig = {}): RecallQualityPolicyContext {
  return { requestedLimit, config: resolveMemorySpacesConfig({ recallQuality: { policy, ...recallQuality } }).recallQuality }
}

/** A search that more than one Provider answers, as the service passes it. */
const mixed = (policyContext: RecallQualityPolicyContext): RecallQualityPolicyContext => ({ ...policyContext, mixedProviders: true })
const BOOSTED: ProviderScoreSemantics = Object.freeze({ kind: 'normalized-relevance', scale: 'boosted' })
const SIMILARITY: ProviderScoreSemantics = Object.freeze({ kind: 'normalized-relevance', scale: 'embedding-similarity' })

/** One Provider's answer, rows in its own order. */
function answer(prefix: string, providerId: string, scores: ReadonlyArray<number | undefined>, scoreSemantics?: ProviderScoreSemantics): RecallQualityCandidate[] {
  return scores.map((score, index) => ({
    insight: { id: `${prefix}${index + 1}`, content: prefix, ...(score === undefined ? {} : { score }) },
    memoryBodyId: prefix, providerId, providerRank: index + 1, bodyOrder: 0,
    ...(scoreSemantics === undefined ? {} : { scoreSemantics }),
  }))
}

/** The service's order across Providers: every Provider's first row, then every second row, and so on. */
function federated(...answers: RecallQualityCandidate[][]): RecallQualityCandidate[] {
  return Array.from({ length: Math.max(...answers.map(rows => rows.length)) }, (_, rank) => answers.flatMap(rows => rows.slice(rank, rank + 1)))
    .flat()
}

function selection(policy: RecallQualityPolicy, candidates: readonly RecallQualityCandidate[], policyContext: RecallQualityPolicyContext): string[] {
  return applyRecallQualityPolicy(prepareRecallQualityPolicy(policy, policyContext), candidates, policyContext)
    .selected.map(entry => `${entry.candidate.insight.id}:${entry.decision.tier}`)
}

/** strict-v1, balanced-v1 and exhaustive-v1 exactly as main a7e3bc54 shipped them, for the byte-identity check. */
function mainDecision(candidate: RecallQualityCandidate, policyContext: RecallQualityPolicyContext, lowScoreAction: RecallQualityDecision['action'], nonPositiveAction: RecallQualityDecision['action']): RecallQualityDecision {
  const score = candidate.insight.score
  if (score === undefined) return { action: 'keep', tier: 'unknown', reason: 'unscored' }
  if (!Number.isFinite(score)) return { action: 'drop', tier: 'unknown', reason: 'invalid-score' }
  if (candidate.scoreSemantics?.kind !== 'normalized-relevance') return { action: 'keep', tier: 'unknown', reason: 'unscaled-score' }
  if (score <= 0) return { action: nonPositiveAction, tier: 'low', reason: 'non-positive-score', normalizedScore: 0 }
  if (score > 1) return { action: 'keep', tier: 'unknown', reason: 'unscaled-score' }
  if (score < policyContext.config.lowScoreThreshold) return { action: lowScoreAction, tier: 'low', reason: 'low-score', normalizedScore: score }
  if (score < policyContext.config.highScoreThreshold) return { action: 'keep', tier: 'medium', reason: 'medium-score', normalizedScore: score }
  return { action: 'keep', tier: 'high', reason: 'high-score', normalizedScore: score }
}
const MAIN_POLICIES: Record<string, RecallQualityPolicy> = {
  'strict-v1': { ...STRICT_RECALL_QUALITY_POLICY,
    evaluate: (entry, policyContext) => mainDecision(entry, policyContext, 'drop', 'drop'),
    select(candidates, policyContext) {
      const kept = candidates.filter(entry => entry.decision.action === 'keep')
      return [
        ...kept.filter(entry => entry.decision.tier === 'high'),
        ...kept.filter(entry => entry.decision.tier === 'medium').slice(0, policyContext.config.maxMediumResults),
        ...kept.filter(entry => entry.decision.tier === 'unknown').slice(0, policyContext.config.maxUnknownResults),
      ].slice(0, policyContext.requestedLimit)
    } },
  'balanced-v1': { ...BALANCED_RECALL_QUALITY_POLICY, evaluate: (entry, policyContext) => mainDecision(entry, policyContext, 'keep', 'drop') },
  'exhaustive-v1': { ...EXHAUSTIVE_RECALL_QUALITY_POLICY, evaluate: (entry, policyContext) => mainDecision(entry, policyContext, 'keep', 'keep') },
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
      ['unscaled', expect.objectContaining({ action: 'keep', tier: 'unknown', reason: 'unscaled-score' })],
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

  it('#454: a boosted answer above 1 is high, and OpenViking similarity follows it in OpenViking\'s order', () => {
    const policyContext = mixed(context('strict-v1', 4))
    const result = applyRecallQualityPolicy(prepareRecallQualityPolicy(STRICT_RECALL_QUALITY_POLICY, policyContext), federated(
      answer('h', 'hindsight', [1.0379764538482916], BOOSTED),
      answer('ov', 'openviking', [0.7107269167900085, 0.7017678022384644, 0.685615599155426, 0.6702136397361755], SIMILARITY),
    ), policyContext)

    expect(result.selected.map(entry => [entry.candidate.insight.id, entry.decision])).toEqual([
      ['h1', { action: 'keep', tier: 'high', reason: 'high-score', normalizedScore: 1 }],
      ['ov1', { action: 'keep', tier: 'ranked', reason: 'uncalibrated-score' }],
      ['ov2', { action: 'keep', tier: 'ranked', reason: 'uncalibrated-score' }],
    ])
    // main: ov1-ov4 high or medium first, and the answer last as unknown, outside a limit of 4.
    expect(selection(MAIN_POLICIES['strict-v1']!, result.evaluated.map(entry => entry.candidate), policyContext)).toEqual(['ov1:high', 'ov2:high', 'ov3:high', 'ov4:high'])
  })

  it('keeps ranked rows after calibrated high rows and before medium ones, at most maxRankedResults', () => {
    const rows = federated(
      answer('n', 'mnemon-native', [0.9, 0.4, 0.8, 0.1], NORMALIZED_RELEVANCE_SCORE),
      // ov4 is a keyword match without a score: it is ranked and counted like the others.
      answer('ov', 'openviking', [0.82, 0.8, 0.79, undefined], SIMILARITY),
    )
    expect(selection(STRICT_RECALL_QUALITY_POLICY, rows, mixed(context()))).toEqual(['n1:high', 'n3:high', 'ov1:ranked', 'ov2:ranked', 'n2:medium'])
    expect(selection(STRICT_RECALL_QUALITY_POLICY, rows, mixed(context('strict-v1', 10, { maxRankedResults: 4 }))))
      .toEqual(['n1:high', 'n3:high', 'ov1:ranked', 'ov2:ranked', 'ov3:ranked', 'ov4:ranked', 'n2:medium'])
    expect(selection(STRICT_RECALL_QUALITY_POLICY, rows, mixed(context('strict-v1', 10, { maxRankedResults: 0 })))).toEqual(['n1:high', 'n3:high', 'n2:medium'])
    // Non-finite and non-positive similarity is still dropped.
    expect(selection(STRICT_RECALL_QUALITY_POLICY, answer('ov', 'openviking', [Number.NaN, 0, -0.1, 0.3], SIMILARITY), mixed(context()))).toEqual(['ov4:ranked'])
  })

  it('bands OpenViking similarity as before when it is searched alone, under thresholds a user set, or in balanced-v1 and exhaustive-v1', () => {
    expect(selection(STRICT_RECALL_QUALITY_POLICY, answer('ov', 'openviking', [0.82, 0.5, 0.2, undefined], SIMILARITY), context()))
      .toEqual(['ov1:high', 'ov2:medium', 'ov4:unknown'])
    // The reporter's thresholds (#454): OpenViking is banded by them, and Hindsight's boosted answer is still high.
    const reporter = mixed(context('strict-v1', 4, { lowScoreThreshold: 0.67, highScoreThreshold: 0.78 }))
    const rows = federated(answer('h', 'hindsight', [1.0379764538482916], BOOSTED), answer('ov', 'openviking', [0.7107, 0.7018, 0.6856, 0.6702, 0.66], SIMILARITY))
    expect(selection(STRICT_RECALL_QUALITY_POLICY, rows, reporter)).toEqual(['h1:high', 'ov1:medium', 'ov2:medium', 'ov3:medium'])
    expect(selection(MAIN_POLICIES['strict-v1']!, rows, reporter)).toEqual(['ov1:medium', 'ov2:medium', 'ov3:medium', 'ov4:medium'])
    const others = federated(answer('n', 'mnemon-native', [0.9], NORMALIZED_RELEVANCE_SCORE), answer('ov', 'openviking', [0.82, 0.2], SIMILARITY))
    expect(selection(BALANCED_RECALL_QUALITY_POLICY, others, mixed(context('balanced-v1')))).toEqual(['n1:high', 'ov1:high', 'ov2:low'])
    expect(selection(EXHAUSTIVE_RECALL_QUALITY_POLICY, others, mixed(context('exhaustive-v1')))).toEqual(['n1:high', 'ov1:high', 'ov2:low'])
  })

  it('counts a boosted score above 1 as 1 in every policy and bands the rest as declared', () => {
    const rows = answer('h', 'hindsight', [1.2, 1, 0.5, 0.00002], BOOSTED)
    expect(selection(STRICT_RECALL_QUALITY_POLICY, rows, context())).toEqual(['h1:high', 'h2:high', 'h3:medium'])
    expect(selection(BALANCED_RECALL_QUALITY_POLICY, rows, context('balanced-v1'))).toEqual(['h1:high', 'h2:high', 'h3:medium', 'h4:low'])
    expect(selection(EXHAUSTIVE_RECALL_QUALITY_POLICY, rows, context('exhaustive-v1'))).toEqual(['h1:high', 'h2:high', 'h3:medium', 'h4:low'])
    // A score above 1 that is not declared boosted is still unknown-scale.
    expect(selection(STRICT_RECALL_QUALITY_POLICY, answer('n', 'mnemon-native', [1.2, 0.7], NORMALIZED_RELEVANCE_SCORE), context())).toEqual(['n2:high', 'n1:unknown'])
  })

  it('selects what main selects in the review scenarios without OpenViking', () => {
    const native = answer('n', 'mnemon-native', [0.92, 0.88, 0.81, 0.77, 0.7, 0.66], NORMALIZED_RELEVANCE_SCORE)
    const unrelated = answer('h', 'hindsight', Array.from({ length: 18 }, () => 0.00002), BOOSTED)
    const honcho = answer('ho', 'honcho', Array.from({ length: 18 }, () => undefined))
    const scenarios: Array<[RecallQualityCandidate[], RecallQualityPolicyContext, string[]]> = [
      [federated(native, unrelated), mixed(context('strict-v1', 6)), ['n1:high', 'n2:high', 'n3:high', 'n4:high', 'n5:high', 'n6:high']],
      [federated(native, honcho), mixed(context('strict-v1', 6)), ['n1:high', 'n2:high', 'n3:high', 'n4:high', 'n5:high', 'n6:high']],
      [unrelated, context('strict-v1', 6), []],
      [federated(answer('n', 'mnemon-native', [0.5, 0.3, 0.1], NORMALIZED_RELEVANCE_SCORE), unrelated), mixed(context('strict-v1', 6)), ['n1:medium', 'n2:medium']],
    ]
    for (const [rows, policyContext, expected] of scenarios) {
      expect(selection(STRICT_RECALL_QUALITY_POLICY, rows, policyContext)).toEqual(expected)
      expect(selection(MAIN_POLICIES['strict-v1']!, rows, policyContext)).toEqual(expected)
    }
  })

  it('is byte-identical to main for recalls without boosted scores above 1 or ranked OpenViking similarity', () => {
    let seed = 454
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!
    const scores = [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.2, 0, 1e-9, 0.1, 0.249, 0.25, 0.4, 0.599, 0.6, 0.67, 0.75, 0.78, 0.999, 1, 1.0379, 2]
    const thresholds = [{}, { lowScoreThreshold: 0.67, highScoreThreshold: 0.78 }, { lowScoreThreshold: 0, highScoreThreshold: 1 }, { lowScoreThreshold: 0.5, highScoreThreshold: 0.51 }]
    let compared = 0
    for (let round = 0; round < 400; round += 1) {
      const policyId = pick(['strict-v1', 'balanced-v1', 'exhaustive-v1'] as const)
      const custom = pick(thresholds)
      const policyContext = { ...context(policyId, 1 + Math.floor(next() * 12), { ...custom, maxMediumResults: pick([0, 1, 4, 50]), maxUnknownResults: pick([0, 2, 50]), maxRankedResults: pick([0, 2, 5]) }), mixedProviders: next() < 0.6 }
      // OpenViking similarity is ranked only by strict-v1 beside another Provider under the default thresholds.
      const similarityRanked = policyId === 'strict-v1' && policyContext.mixedProviders && Object.keys(custom).length === 0
      const providers: Array<[string, ProviderScoreSemantics | undefined, (score: number | undefined) => boolean]> = [
        ['mnemon-native', NORMALIZED_RELEVANCE_SCORE, () => true],
        ['holographic', NORMALIZED_RELEVANCE_SCORE, () => true],
        ['hindsight', BOOSTED, score => score === undefined || !Number.isFinite(score) || score <= 1],
        ['honcho', undefined, () => true],
        ...(similarityRanked ? [] : [['openviking', SIMILARITY, () => true] as [string, ProviderScoreSemantics, () => boolean]]),
      ]
      const rows: RecallQualityCandidate[] = []
      for (let space = 0; space < 1 + Math.floor(next() * 4); space += 1) {
        const [providerId, scoreSemantics, allowed] = pick(providers)
        const spaceScores = Array.from({ length: Math.floor(next() * 10) }, () => pick(scores)).filter(allowed)
        rows.push(...answer(`s${space}-`, providerId, spaceScores, scoreSemantics))
      }
      rows.sort(() => next() - 0.5)
      const run = (policy: RecallQualityPolicy) => {
        const prepared = prepareRecallQualityPolicy(policy, policyContext)
        const result = applyRecallQualityPolicy(prepared, rows, policyContext)
        return JSON.stringify({ candidateLimit: prepared.candidateLimit, policyId: result.policyId, fallbackFrom: result.fallbackFrom,
          evaluated: result.evaluated.map(entry => [entry.candidate.insight.id, entry.decision]), selected: result.selected.map(entry => entry.candidate.insight.id) })
      }
      const current = { 'strict-v1': STRICT_RECALL_QUALITY_POLICY, 'balanced-v1': BALANCED_RECALL_QUALITY_POLICY, 'exhaustive-v1': EXHAUSTIVE_RECALL_QUALITY_POLICY }[policyId]
      expect(run(current)).toBe(run(MAIN_POLICIES[policyId]!))
      compared += 1
    }
    expect(compared).toBe(400)
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
