import { resolveRecallQuality } from 'dsh-mnemon-source-memory-spaces'
import { RUNTIME_MEMORY_LIMIT_MAX_BYTES, RUNTIME_MEMORY_LIMITS } from 'dsh-mnemon-source-runtime/contracts'

export const DEFAULT_IDLE_REVIEW_MS = 30_000
// The Runtime Source's own defaults and ceiling for its two files, which these settings configure.
export const DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES = RUNTIME_MEMORY_LIMITS.memory
export const DEFAULT_RUNTIME_USER_LIMIT_BYTES = RUNTIME_MEMORY_LIMITS.user
export const MAX_RUNTIME_MEMORY_LIMIT_BYTES = RUNTIME_MEMORY_LIMIT_MAX_BYTES
export const DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS = 8_192
export const MAX_RUNTIME_MAINTENANCE_MAX_TOKENS = 1_000_000
export { DEFAULT_EMBEDDING_ENDPOINT, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_PROTOCOL, MNEMON_EMBEDDING_PROTOCOLS } from 'dsh-mnemon-source-memory-spaces/contracts'

export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_RECALL_LIMIT = 10
const recallDefaults = resolveRecallQuality(undefined)
export const DEFAULT_RECALL_QUALITY_POLICY = recallDefaults.policy
export const DEFAULT_RECALL_LOW_SCORE_THRESHOLD = recallDefaults.lowScoreThreshold
export const DEFAULT_RECALL_HIGH_SCORE_THRESHOLD = recallDefaults.highScoreThreshold
export const DEFAULT_RECALL_CANDIDATE_MULTIPLIER = recallDefaults.candidateMultiplier
export const DEFAULT_RECALL_MAX_MEDIUM_RESULTS = recallDefaults.maxMediumResults
export const DEFAULT_RECALL_MAX_UNKNOWN_RESULTS = recallDefaults.maxUnknownResults
export const DEFAULT_RECALL_MAX_RANKED_RESULTS = recallDefaults.maxRankedResults
