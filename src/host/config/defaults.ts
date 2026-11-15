import { resolveRecallQuality } from 'dsh-mnemon-source-memory-spaces'
import {
  DEFAULT_EMBEDDING_ENDPOINT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROTOCOL,
  MNEMON_EMBEDDING_PROTOCOLS,
} from 'dsh-mnemon-source-memory-spaces/contracts'
import { RUNTIME_MEMORY_LIMIT_MAX_BYTES, RUNTIME_MEMORY_LIMITS } from 'dsh-mnemon-source-runtime/contracts'
import {
  DEFAULT_IDLE_REVIEW,
  DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS,
  DEFAULT_SKILLS_CONFIG,
  DOCUMENTS_DEFAULT_LIMIT_BYTES,
  DOCUMENTS_MAX_LIMIT_BYTES,
} from '../protocol.ts'

export {
  DEFAULT_EMBEDDING_ENDPOINT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROTOCOL,
  DEFAULT_IDLE_REVIEW,
  DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS,
  DEFAULT_SKILLS_CONFIG,
  DOCUMENTS_DEFAULT_LIMIT_BYTES,
  DOCUMENTS_MAX_LIMIT_BYTES,
  MNEMON_EMBEDDING_PROTOCOLS,
}

export const MIN_DOCUMENTS_LIMIT_BYTES = 1

export const DEFAULT_TIMEOUT_MS = 10_000
export const MIN_TIMEOUT_MS = 100
export const MAX_TIMEOUT_MS = 120_000

export const DEFAULT_RECALL_LIMIT = 10
export const MIN_RECALL_LIMIT = 1
export const MAX_RECALL_LIMIT = 50

export const DEFAULT_IDLE_REVIEW_MS = 30_000
export const MIN_IDLE_REVIEW_MS = 5_000
export const MAX_IDLE_REVIEW_MS = 600_000

export const IDLE_REVIEW_BOUNDS = Object.freeze({
  minIntervalMs: { min: 5_000, max: 86_400_000 },
  maxPerSession: { min: 0, max: 200 },
  maxContextChars: { min: 1_000, max: 1_000_000 },
  maxTokens: { min: 128, max: 131_072 },
})

// The Runtime Source's own defaults and ceiling for its two files, which these settings configure.
export const DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES = RUNTIME_MEMORY_LIMITS.memory
export const DEFAULT_RUNTIME_USER_LIMIT_BYTES = RUNTIME_MEMORY_LIMITS.user
export const MIN_RUNTIME_MEMORY_LIMIT_BYTES = 1
export const MAX_RUNTIME_MEMORY_LIMIT_BYTES = RUNTIME_MEMORY_LIMIT_MAX_BYTES
export const MIN_RUNTIME_MAINTENANCE_MAX_TOKENS = 1
export const MAX_RUNTIME_MAINTENANCE_MAX_TOKENS = 1_000_000

export const SKILLS_BOUNDS = Object.freeze({
  autoAdoptDailyLimit: { min: 0, max: 100 },
  draftMaxTokens: { min: 128, max: 131_072 },
  draftRetryMaxTokens: { min: 128, max: 131_072 },
  reviewThreshold: { min: 1, max: 50 },
  idleSeconds: { min: 0, max: 3_600 },
  cooldownSeconds: { min: 0, max: 86_400 },
  minConfidence: { min: 0, max: 1 },
  expiryDays: { min: 1, max: 90 },
  maxPendingPerSession: { min: 1, max: 20 },
  casesPerRun: { min: 1, max: 20 },
})

export const DEFAULT_INTERACTION_CONFIG = Object.freeze({
  turnBar: true,
  saveAction: true,
})

const recallDefaults = resolveRecallQuality(undefined)
export const DEFAULT_RECALL_QUALITY_POLICY = recallDefaults.policy
export const DEFAULT_RECALL_LOW_SCORE_THRESHOLD = recallDefaults.lowScoreThreshold
export const DEFAULT_RECALL_HIGH_SCORE_THRESHOLD = recallDefaults.highScoreThreshold
export const DEFAULT_RECALL_CANDIDATE_MULTIPLIER = recallDefaults.candidateMultiplier
export const DEFAULT_RECALL_MAX_MEDIUM_RESULTS = recallDefaults.maxMediumResults
export const DEFAULT_RECALL_MAX_RANKED_RESULTS = recallDefaults.maxRankedResults
export const DEFAULT_RECALL_MAX_UNKNOWN_RESULTS = recallDefaults.maxUnknownResults

export const RECALL_QUALITY_BOUNDS = Object.freeze({
  scoreThreshold: { min: 0, max: 1 },
  candidateMultiplier: { min: 1, max: 5 },
  maxResults: { min: 0, max: 50 },
})
