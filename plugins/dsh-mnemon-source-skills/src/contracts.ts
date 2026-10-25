/**
 * JSON contracts of the Skills Source. The Host, the page and the Source share
 * them; nothing here is executable.
 */

import type { MarketSourceKind } from './source-kind.ts'

/** The DSH skill roots this Source reads and writes, in DSH's precedence order. */
export type SkillRootKind = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents'
export const SKILL_ROOT_KINDS: readonly SkillRootKind[] = ['project-dsh', 'project-agents', 'user-dsh', 'user-agents']
export const SKILL_ROOT_RANK: Readonly<Record<SkillRootKind, number>> = { 'project-dsh': 100, 'project-agents': 200, 'user-dsh': 400, 'user-agents': 500 }

export interface SkillRoot {
  kind: SkillRootKind
  path: string
  exists: boolean
}

export interface SkillInvocation {
  /** DSH's `disable-model-invocation` is absent or false. */
  modelInvocable: boolean
  /** DSH's `user-invocable` is absent or true. */
  userInvocable: boolean
}

export interface SkillSummary {
  /** `<root kind>:<name>`; stable while the file stays in its root. */
  key: string
  name: string
  description: string
  whenToUse?: string
  root: SkillRootKind
  rootPath: string
  /** The SKILL.md of a bundle, or the flat Markdown file. */
  path: string
  layout: 'bundle' | 'flat'
  invocation: SkillInvocation
  /** SHA-256 of the file's exact content. */
  hash: string
  bytes: number
  modifiedAt: string
  /** DSH loads the lowest-rank skill of a name; the others are shadowed by it. */
  shadowedBy?: string
  /** Files beside SKILL.md in a bundle, relative and bounded. */
  resources?: string[]
}

/** A file the Source found but DSH would skip, with the reason. */
export interface SkillProblem {
  root: SkillRootKind
  path: string
  reason: string
}

export interface SkillCatalog {
  projectRoot?: string
  roots: SkillRoot[]
  skills: SkillSummary[]
  problems: SkillProblem[]
}

export interface SkillDocument extends SkillSummary {
  content: string
  /** Frontmatter text between the fences, verbatim. */
  frontmatter: string
  body: string
}

export type SkillVersionReason = 'original' | 'edit' | 'evolution' | 'restore' | 'invocation' | 'create' | 'install'

export interface SkillVersion {
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

/** The strong signals a skill reviewer may cite as evidence. */
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
  /** One-based, unique within its trajectory. */
  index: number
  turn: number
  kind: TrajectoryStepKind
  text: string
  tool?: { name: string; ok: boolean; input?: string; error?: string }
  /** The skill loaded at this step, by the model's `skill` tool or the user's `/name`. */
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
  /** What the review made of it. */
  outcome: 'suggested' | 'nothing' | 'error' | 'captured'
  pinned: boolean
  createdAt: string
}

export interface Trajectory extends TrajectorySummary {
  steps: TrajectoryStep[]
  annotations: TrajectoryAnnotation[]
  /** The reviewer's one-sentence reading of the window. */
  reviewSummary?: string
}

export interface EvidenceReference {
  trajectoryId: string
  steps: number[]
}

export type SuggestionStatus = 'pending' | 'drafting' | 'review' | 'adopted' | 'dismissed' | 'expired' | 'invalidated'
export const SUGGESTION_STATUSES: readonly SuggestionStatus[] = ['pending', 'drafting', 'review', 'adopted', 'dismissed', 'expired', 'invalidated']

export interface SkillSuggestion {
  id: string
  skillName: string
  action: 'create' | 'update'
  summary: string
  rationale?: string
  confidence: number
  signals: EvolutionSignal[]
  evidence: EvidenceReference[]
  /** For `update`: the SKILL.md the reviewer read, so a later edit invalidates it. */
  skillKey?: string
  skillFileHash?: string
  sourceSessionId?: string
  sourceSessionTitle?: string
  reviewId?: string
  status: SuggestionStatus
  draftId?: string
  lastError?: string
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
  /** For `update`, the SKILL.md hash the draft was written against. */
  baseKey?: string
  baseHash?: string
  /** For `create`, where adopting writes the new bundle. */
  targetRoot?: SkillRootKind
  content: string
  notes: string
  changes: string[]
  guidance: string[]
  status: DraftStatus
  /** Runs started for this draft and its baseline. */
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
  /** Explicitly depends on image input unavailable to the text-only simulator. */
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
  /** SHA-256 of the SKILL.md under test; absent for `none`. */
  hash?: string
  skillKey?: string
  draftId?: string
  versionId?: string
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
  /** Kept under verdict=error so older readers also exclude it from scores. */
  unmeasuredReason?: 'requires-vision'
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface BacktestRun {
  id: string
  skillName: string
  target: RunTarget
  status: RunStatus
  progress: { done: number; total: number }
  caseIds: string[]
  results: CaseResult[]
  /** Over the graded cases; absent when none could be graded. */
  passRate?: number
  score?: number
  /** Cases that could not run; they are left out of the score. */
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
  /** The conversation turn the reviewed window ended with. */
  turn?: number
  /** The suggestions this review created or strengthened. */
  suggestionIds?: string[]
}

/** How the Source admits a review's suggestions; the Host sends its settings with each review. */
export interface SkillsPolicy {
  minConfidence: number
  expiryDays: number
  maxPendingPerSession: number
}

export const DEFAULT_SKILLS_POLICY: Readonly<SkillsPolicy> = Object.freeze({
  minConfidence: 0.6,
  expiryDays: 7,
  maxPendingPerSession: 5,
})

/** One removed skill waiting in the Trash, and where it came from. */
export interface TrashEntry {
  /** The stored directory name: `<removal time>-<skill name>`. */
  id: string
  name: string
  /** A bundle directory, or a single flat `.md` file. */
  kind: 'bundle' | 'file'
  trashedAt: string
  bytes: number
  /** The root it was removed from; absent for entries removed before this was recorded. */
  root?: SkillRootKind
  key?: string
  /** Exact original file or bundle path; its parent must match the recorded root. */
  originalPath?: string
  /** The project that owned a project-level skill, independent of the selected workspace. */
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
    /** Suggestions whose draft is being written. */
    drafting: number
    drafts: number
    trajectories: number
    cases: number
    runsRunning: number
    /** Skills waiting in the Trash. */
    trash: number
  }
  lastReviewAt?: string
  /** Suggestions and drafts waiting for the user, newest first. */
  attention: Array<{ kind: 'suggestion' | 'draft' | 'regression'; id: string; skillName: string; title: string; at: string }>
  reviews: ReviewLogEntry[]
}

/** What the Host records after one skill review. */
export interface ReviewRecordInput {
  review: Omit<ReviewLogEntry, 'id' | 'trajectoryId' | 'suggestions' | 'cases' | 'suggestionIds'>
  /** The admission rules to apply; missing values fall back to the defaults. */
  policy?: Partial<SkillsPolicy>
  trajectory: Omit<Trajectory, 'id' | 'createdAt' | 'pinned' | 'suggestionIds' | 'caseIds' | 'annotationCount' | 'signals' | 'outcome' | 'reviewId'>
  annotations: TrajectoryAnnotation[]
  suggestions: Array<{
    skillName: string
    action: 'create' | 'update'
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
  inserted: number
  updated: number
  casesAdded: number
  skipped: Array<{ skillName?: string; action?: string; reason: string }>
}

/** Everything a draft prompt needs, read once by the Host. */
export interface EvidencePack {
  skillName: string
  action: 'create' | 'update'
  suggestion?: SkillSuggestion
  skill?: SkillDocument
  excerpts: Array<{ trajectoryId: string; sessionTitle?: string; steps: TrajectoryStep[]; annotations: TrajectoryAnnotation[] }>
  cases: EvalCase[]
  /** The newest finished run against the current file, when there is one. */
  lastRun?: BacktestRun
  catalog: Array<{ name: string; description: string; root: SkillRootKind }>
  drafts: SkillDraft[]
}

export interface CatalogView extends SkillCatalog {
  /** Per skill name: open suggestions, cases and the newest finished run against the loaded file. */
  stats: Record<string, { open: number; cases: number; lastPassRate?: number; lastScore?: number; lastRunAt?: string }>
}

export interface SuggestionView {
  suggestion: SkillSuggestion
  /** The loaded file is still the one the reviewer read. */
  hashCurrent: boolean
  skill?: SkillSummary
  draft?: SkillDraft
  trajectories: TrajectorySummary[]
}

export interface DraftView {
  draft: SkillDraft
  /** The file the draft replaces, as it is now. */
  base?: SkillDocument
  runs: BacktestRun[]
}

// ---- skill market -------------------------------------------------------------

export type { DetectedSource, MarketSourceKind } from './source-kind.ts'

/** A string, or the same text per language. */
export type LocalizedText = string | { en?: string; 'zh-CN'?: string }

/** Where a market entry's files come from. */
export type MarketSource =
  | { type: 'github'; repo: string; path: string; ref?: string }
  | { type: 'url'; url: string }
  | { type: 'path'; path: string }
  /** One artifact an Agent Skills discovery index publishes, checked against its digest. */
  | { type: 'artifact'; url: string; format: 'skill-md' | 'archive'; digest: string }
  /** An entry of a discovery index older than 0.2.0: its files, under `base`. */
  | { type: 'files'; base: string; files: string[] }
  /** A skill a search index found, by the index's own id (`owner/repo/skill`). */
  | { type: 'indexed'; id: string }

export interface MarketEntry {
  /** The SKILL.md name it installs as; unique within its registry. */
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
  /** How often the index that found it counts it installed. */
  installs?: number
  /** The repository or site it lives in, as the index names it. */
  origin?: string
}

/** A skill registry as published: one JSON file anyone can host. */
export interface MarketRegistryFile {
  version: 1
  id?: string
  name: LocalizedText
  description?: LocalizedText
  homepage?: string
  categories?: Array<{ id: string; label: LocalizedText }>
  skills: MarketEntry[]
}

/**
 * A source this Source knows: the built-in catalog and search index, or one
 * the user added — a GitHub repository, a site publishing a discovery index,
 * or a catalog by URL or path.
 */
export interface MarketRegistry {
  id: string
  kind: MarketSourceKind
  /** A canonical GitHub URL, an http(s) URL or an absolute file path. */
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
  /** The installed skill, when one with this name exists. */
  skillKey?: string
  installedVersion?: string
}

export interface MarketView {
  registries: MarketRegistry[]
  categories: Array<{ id: string; label: LocalizedText }>
  items: MarketItem[]
  /** Registries whose copy is older than the refresh window, or missing. */
  stale: string[]
}

/** What a security reviewer said about a skill, as its index reports it. */
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
  /** Reviews of the skill, when its index has them. */
  audits?: MarketAudit[]
  /** Where its files live, to read them there. */
  homepage?: string
  /** The file list is the index's text snapshot; the install fetches every file. */
  partial?: boolean
}

/** One search of the search sources, newest first by installs. */
export interface MarketSearchResult {
  query: string
  items: MarketItem[]
  /** Why a search source could not answer; the local sources still did. */
  error?: string
}

/** Where an installed skill came from, so an update can be offered. */
export interface MarketInstall {
  skillKey: string
  registryId: string
  name: string
  version?: string
  source: MarketSource
  /** SKILL.md hash right after install; a different hash later means it was edited. */
  hash: string
  files: number
  installedAt: string
}
