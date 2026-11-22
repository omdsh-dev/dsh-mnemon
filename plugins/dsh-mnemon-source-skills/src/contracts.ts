import type { MarketSourceKind } from './source-kind.ts'

export const MAX_SKILL_BYTES = 64 * 1024

export type SkillRootKind = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents'
export const SKILL_ROOT_KINDS: readonly SkillRootKind[] = ['project-dsh', 'project-agents', 'user-dsh', 'user-agents']
export const SKILL_ROOT_RANK: Readonly<Record<SkillRootKind, number>> = { 'project-dsh': 100, 'project-agents': 200, 'user-dsh': 400, 'user-agents': 500 }

export interface SkillCreationConfig {
  create: SkillRootKind[]
  default: SkillRootKind
}

export interface SkillCreationChoices {
  roots: SkillRootKind[]
  default: SkillRootKind
}

export interface SkillRoot {
  kind: SkillRootKind
  path: string
  exists: boolean
  readOnly?: boolean
}

export interface SkillInvocation {
  modelInvocable: boolean
  userInvocable: boolean
}

export interface SkillSummary {
  key: string
  name: string
  description: string
  whenToUse?: string
  root: SkillRootKind
  rootPath: string
  path: string
  layout: 'bundle' | 'flat'
  linked?: boolean
  readOnly?: boolean
  invocation: SkillInvocation
  hash: string
  bytes: number
  modifiedAt: string
  shadowedBy?: string
  resources?: string[]
}

export interface SkillProblem {
  root: SkillRootKind
  path: string
  reason: string
}

export interface SkillCatalog {
  creation?: SkillCreationChoices
  projectRoot?: string
  roots: SkillRoot[]
  skills: SkillSummary[]
  problems: SkillProblem[]
}

export interface SkillResourceFile {
  path: string
  hash: string
  bytes: number
  content?: string
  binary?: boolean
}

export interface SkillDraftFileChange {
  path: string
  action: 'upsert' | 'delete'
  content?: string
  baseHash?: string | null
}

export function parseSkillDraftFiles(value: unknown): SkillDraftFileChange[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 20) throw new Error('files must be an array of at most 20 items')
  if (value.length === 0) return undefined
  return value.map((item: unknown) => {
    if (item === null || typeof item !== 'object') throw new Error('each supporting file needs a path and action')
    const { path, action, content, baseHash } = item as Record<string, unknown>
    if (typeof path !== 'string' || path.trim() === '' || path.length > 200 || (action !== 'upsert' && action !== 'delete')) {
      throw new Error('each supporting file needs a relative path and action (upsert or delete)')
    }
    if (action === 'upsert' && (typeof content !== 'string' || content.trim() === '')) throw new Error(`supporting file "${path}" requires non-empty content`)
    if (baseHash !== undefined && baseHash !== null && (typeof baseHash !== 'string' || baseHash.trim() === '' || baseHash.length > 100)) throw new Error('invalid supporting file baseHash')
    return { path: path.trim(), action, ...(action === 'upsert' ? { content: content as string } : {}),
      ...(baseHash === undefined ? {} : { baseHash: baseHash === null ? null : (baseHash as string).trim() }) }
  })
}

export interface SkillDocument extends SkillSummary {
  content: string
  frontmatter: string
  body: string
  resourceFiles?: SkillResourceFile[]
}

export type SkillVersionReason = 'original' | 'edit' | 'evolution' | 'restore' | 'invocation' | 'create' | 'install'

export interface SkillVersion {
  bundleSnapshot?: boolean
  id: string
  skillKey: string
  hash: string
  bytes: number
  reason: SkillVersionReason
  createdAt: string
  suggestionId?: string
  draftId?: string
  note?: string
}

export type EvolutionSignal =
  | 'correction'
  | 'directive'
  | 'tool-failure'
  | 'approach-change'
  | 'procedure'
  | 'skill-gap'
  | 'skill-misleading'
  | 'success'
export const EVOLUTION_SIGNALS: readonly EvolutionSignal[] = ['correction', 'directive', 'tool-failure', 'approach-change', 'procedure', 'skill-gap', 'skill-misleading', 'success']

export type TrajectoryStepKind = 'user' | 'assistant' | 'tool' | 'skill'

export interface TrajectoryStep {
  index: number
  turn: number
  kind: TrajectoryStepKind
  text: string
  tool?: { name: string; ok: boolean; input?: string; error?: string }
  skill?: { name: string; by: 'model' | 'user' }
  at?: string
}

export interface TrajectoryAnnotation {
  step: number
  signal: EvolutionSignal
  note: string
  suggestionIds?: string[]
}

export interface TrajectoryStats {
  turns: number
  userCharacters: number
  toolCalls: number
  toolFailures: number
  uniqueTools: number
  skills: string[]
}

export interface ReviewScore {
  score: number
  threshold: number
  textLengthScore: number
  turnScore: number
  toolCallScore: number
  toolDiversityScore: number
}

export interface TrajectorySummary {
  id: string
  sessionId: string
  sessionTitle?: string
  workspace?: string
  startedAt: string
  endedAt: string
  stats: TrajectoryStats
  score?: ReviewScore
  annotationCount: number
  signals: EvolutionSignal[]
  suggestionIds: string[]
  caseIds: string[]
  reviewId?: string
  outcome: 'suggested' | 'nothing' | 'error' | 'captured'
  pinned: boolean
  createdAt: string
}

export interface Trajectory extends TrajectorySummary {
  steps: TrajectoryStep[]
  annotations: TrajectoryAnnotation[]
  reviewSummary?: string
}

export interface EvidenceReference {
  trajectoryId: string
  steps: number[]
}

export type SuggestionStatus = 'pending' | 'drafting' | 'review' | 'adopted' | 'dismissed' | 'expired' | 'invalidated'
export const SUGGESTION_STATUSES: readonly SuggestionStatus[] = ['pending', 'drafting', 'review', 'adopted', 'dismissed', 'expired', 'invalidated']

export interface SkillOrigin {
  path: string
  workspace?: string
}

export type SkillResolution = 'available' | 'missing' | 'origin-unavailable'

export interface SkillSuggestion {
  id: string
  skillName: string
  action: 'create' | 'update'
  targetRoot?: SkillRootKind
  summary: string
  rationale?: string
  confidence: number
  signals: EvolutionSignal[]
  evidence: EvidenceReference[]
  triage?: SuggestionTriage
  skillKey?: string
  skillFileHash?: string
  origin?: SkillOrigin
  sourceSessionId?: string
  sourceSessionTitle?: string
  reviewId?: string
  status: SuggestionStatus
  draftId?: string
  lastError?: string
  autoAdoption?: AutoAdoptionEvent[]
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export type DraftStatus = 'ready' | 'adopted' | 'discarded'

export interface SkillDraft {
  id: string
  suggestionId?: string
  skillName: string
  action: 'create' | 'update'
  baseKey?: string
  baseHash?: string
  origin?: SkillOrigin
  targetRoot?: SkillRootKind
  content: string
  files?: SkillDraftFileChange[]
  baseFileHashes?: Record<string, string | null>
  notes: string
  changes: string[]
  guidance: string[]
  status: DraftStatus
  runIds: string[]
  createdAt: string
  updatedAt: string
}

export interface EvalCheck {
  id: string
  text: string
  must: boolean
}

export interface EvalCase {
  id: string
  skillName: string
  title: string
  prompt: string
  context?: string
  requiresVision?: boolean
  checks: EvalCheck[]
  origin: { kind: 'review' | 'trajectory' | 'manual'; trajectoryId?: string; steps?: number[]; suggestionId?: string }
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type RunTargetKind = 'current' | 'draft' | 'version' | 'none'

export interface RunTarget {
  kind: RunTargetKind
  hash?: string
  skillKey?: string
  draftId?: string
  versionId?: string
}

export interface ModelRoute {
  provider: string
  model: string
}

export interface DraftPreferences {
  version: 1
  draftModel?: ModelRoute
  runModel?: ModelRoute
  suggestionModels: Record<string, ModelRoute>
  skillRunModels: Record<string, ModelRoute>
}

export interface DraftPreferencesView {
  model?: ModelRoute
  runModel?: ModelRoute
  suggestionModels: Record<string, ModelRoute>
  skillRunModels: Record<string, ModelRoute>
}

export interface CaseResult {
  caseId: string
  title: string
  verdict: 'pass' | 'fail' | 'error'
  score: number
  checks: Array<{ checkId: string; pass: boolean; note: string }>
  steps: string[]
  answer: string
  summary?: string
  error?: string
  unmeasuredReason?: 'requires-vision'
  fullyGraded?: boolean
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface BacktestRun {
  id: string
  skillName: string
  target: RunTarget
  status: RunStatus
  progress: { done: number; total: number }
  caseIds: string[]
  casesHash?: string
  model?: ModelRoute & { reasoningEffort?: string }
  results: CaseResult[]
  passRate?: number
  score?: number
  errors?: number
  error?: string
  startedAt: string
  finishedAt?: string
}

export interface ReviewLogEntry {
  id: string
  at: string
  sessionId: string
  sessionTitle?: string
  trigger: 'automatic' | 'manual'
  score?: ReviewScore
  durationMs: number
  outcome: 'suggested' | 'nothing' | 'error'
  summary?: string
  suggestions: number
  cases: number
  trajectoryId?: string
  error?: string
  turn?: number
  autoAdoptions?: Array<AutoAdoptionEvent & { suggestionId: string; skillName: string }>
  suggestionIds?: string[]
}

export interface SkillsPolicy {
  allowCreate?: boolean
  allowUpdate?: boolean
  minConfidence: number
  expiryDays: number
  maxPendingPerSession: number
}

export const DEFAULT_SKILLS_POLICY: Readonly<SkillsPolicy> = Object.freeze({
  allowCreate: true,
  allowUpdate: true,
  minConfidence: 0.6,
  expiryDays: 7,
  maxPendingPerSession: 5,
})

export interface TrashEntry {
  id: string
  name: string
  kind: 'bundle' | 'file'
  trashedAt: string
  bytes: number
  root?: SkillRootKind
  key?: string
  originalPath?: string
  workspace?: string
}

export interface TrashRestoreInput {
  id: string
  root?: SkillRootKind
  name?: string
  replace?: boolean
  expectedHash?: string
}

export interface TrashRestorePreview {
  name: string
  roots: SkillRootKind[]
  needsRoot: boolean
  path?: string
  conflict?: { hash: string }
}

export interface SkillsOverview {
  counts: {
    skills: number
    pending: number
    drafting: number
    drafts: number
    trajectories: number
    cases: number
    runsRunning: number
    trash: number
  }
  lastReviewAt?: string
  attention: Array<{ kind: 'suggestion' | 'draft' | 'regression'; id: string; skillName: string; title: string; at: string }>
  reviews: ReviewLogEntry[]
}

export interface ReviewRecordInput {
  review: Omit<ReviewLogEntry, 'id' | 'trajectoryId' | 'suggestions' | 'cases' | 'suggestionIds'>
  policy?: Partial<SkillsPolicy>
  trajectory: Omit<Trajectory, 'id' | 'createdAt' | 'pinned' | 'suggestionIds' | 'caseIds' | 'annotationCount' | 'signals' | 'outcome' | 'reviewId'>
  annotations: TrajectoryAnnotation[]
  suggestions: Array<{
    skillName: string
    action: 'create' | 'update'
    targetRoot?: SkillRootKind
    summary: string
    rationale?: string
    confidence: number
    signals: EvolutionSignal[]
    steps: number[]
  }>
  cases: Array<{
    skillName: string
    title: string
    prompt: string
    checks: Array<{ text: string; must: boolean }>
    steps: number[]
  }>
}

export interface ReviewRecordResult {
  reviewId: string
  trajectoryId?: string
  suggestionIds: string[]
  createdSuggestionIds?: string[]
  inserted: number
  updated: number
  casesAdded: number
  skipped: Array<{ skillName?: string; action?: string; reason: string }>
}

export interface EvidencePack {
  skillName: string
  action: 'create' | 'update'
  suggestion?: SkillSuggestion
  skill?: SkillDocument
  excerpts: Array<{ trajectoryId: string; sessionTitle?: string; steps: TrajectoryStep[]; annotations: TrajectoryAnnotation[] }>
  cases: EvalCase[]
  lastRun?: BacktestRun
  catalog: Array<{ name: string; description: string; root: SkillRootKind }>
  drafts: SkillDraft[]
}

export interface CatalogView extends SkillCatalog {
  stats: Record<string, { open: number; cases: number; lastPassRate?: number; lastScore?: number; lastRunAt?: string }>
}

export interface SuggestionView {
  suggestion: SkillSuggestion
  hashCurrent: boolean
  skill?: SkillDocument
  resolution?: SkillResolution
  skillInCatalog?: boolean
  draft?: SkillDraft
  trajectories: TrajectorySummary[]
}

export interface DraftView {
  draft: SkillDraft
  conflict?: 'base-changed' | 'target-exists'
  base?: SkillDocument
  baseFileContents?: Record<string, string>
  resolution?: SkillResolution
  runs: BacktestRun[]
}

export type { DetectedSource, MarketSourceKind } from './source-kind.ts'

export type LocalizedText = string | Partial<Record<string, string>>

export type MarketSource =
  | { type: 'github'; repo: string; path: string; ref?: string }
  | { type: 'url'; url: string }
  | { type: 'path'; path: string }
  | { type: 'artifact'; url: string; format: 'skill-md' | 'archive'; digest: string }
  | { type: 'files'; base: string; files: string[] }
  | { type: 'indexed'; id: string }

export interface MarketEntry {
  name: string
  title?: LocalizedText
  description: LocalizedText
  category?: string
  tags?: string[]
  author?: string
  license?: string
  version?: string
  homepage?: string
  source: MarketSource
  installs?: number
  origin?: string
}

export interface MarketRegistryFile {
  version: 1
  id?: string
  name: LocalizedText
  description?: LocalizedText
  homepage?: string
  categories?: Array<{ id: string; label: LocalizedText }>
  skills: MarketEntry[]
}

export interface MarketRegistry {
  id: string
  kind: MarketSourceKind
  location: string
  builtin: boolean
  enabled: boolean
  name?: LocalizedText
  description?: LocalizedText
  homepage?: string
  fetchedAt?: string
  entries: number
  error?: string
}

export type MarketInstallState = 'available' | 'installed' | 'update' | 'modified' | 'conflict'

export interface MarketItem extends MarketEntry {
  registryId: string
  state: MarketInstallState
  skillKey?: string
  installedVersion?: string
}

export interface MarketView {
  registries: MarketRegistry[]
  categories: Array<{ id: string; label: LocalizedText }>
  items: MarketItem[]
  stale: string[]
}

export interface MarketAudit {
  provider: string
  status: 'pass' | 'warn' | 'fail'
  summary?: string
  risk?: string
}

export interface MarketPreview {
  registryId: string
  name: string
  content: string
  files: Array<{ path: string; bytes: number }>
  totalBytes: number
  audits?: MarketAudit[]
  homepage?: string
  partial?: boolean
}

export interface MarketSearchResult {
  query: string
  items: MarketItem[]
  error?: string
}

export interface MarketInstall {
  skillKey: string
  registryId: string
  name: string
  version?: string
  source: MarketSource
  hash: string
  files: number
  installedAt: string
}

export const AUTO_ADOPTION_STAGES = ['queued', 'drafting', 'backtesting', 'rewriting', 'adopted', 'paused', 'review'] as const
export const AUTO_ADOPTION_REASONS = ['disabled', 'no-cases', 'case-limit', 'unmeasured', 'regressed', 'changed', 'failed', 'queue-full', 'model-unavailable', 'interrupted', 'daily-limit', 'duplicate-skill'] as const
export interface AutoAdoptionEvent {
  at: string
  stage: typeof AUTO_ADOPTION_STAGES[number]
  attempt: number
  reason?: typeof AUTO_ADOPTION_REASONS[number]
  detail?: string
  baselineScore?: number
  draftScore?: number
}
export type DraftExpectation = { id: string; hash: string } | null
export interface AutomaticAdoption {
  reservationId?: string
  attempt: number
  draftHash: string
  baselineRunId: string
  draftRunId: string
  casesHash: string
}
export { skillCaseSignature, compareAutomaticSkillRuns } from './auto-adoption.ts'

export function skillDraftSignature(draft: Pick<SkillDraft, 'content' | 'files'>): string {
  if (draft.files === undefined || draft.files.length === 0) return draft.content
  const ordered = [...draft.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(file => [file.path, file.action, file.action === 'delete' ? null : (file.content ?? '')])
  return JSON.stringify([draft.content, ordered])
}

export interface SuggestionTriage {
  version: 1
  classification: 'durable' | 'one-off' | 'uncertain'
  windows: number
  sessions: number
  steps: number
  confidence: number
}
export interface AutoAdoptionQuota {
  date: string
  timeZone: string
  used: number
  limit: number
}
export type AutoAdoptionReservation = AutoAdoptionQuota & (
  { allowed: true; reservationId: string } | { allowed: false; reason: 'daily-limit' | 'duplicate-skill' }
)
