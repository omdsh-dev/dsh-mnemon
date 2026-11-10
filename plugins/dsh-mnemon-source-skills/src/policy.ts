import { DEFAULT_SKILLS_POLICY, EVOLUTION_SIGNALS, type AutoAdoptionEvent, type EvalCase, type EvolutionSignal, type ReviewLogEntry, type ReviewRecordInput, type ReviewRecordResult, type SkillCatalog, type SkillSuggestion, type SkillsPolicy, type Trajectory, type TrajectoryAnnotation, type TrajectorySummary } from './contracts.ts'
import { activeSkill } from './catalog.ts'
import { sameSuggestionSkill, skillOrigin } from './identity.ts'
import { isSkillName } from './frontmatter.ts'
import { MAX_CASES_PER_SKILL, MAX_TRAJECTORIES, type EvalsFile, type LedgerFile } from './store.ts'

const DISMISSED_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** Statuses in which a suggestion still holds its skill+action. */
export const OPEN_STATUSES = new Set<SkillSuggestion['status']>(['pending', 'drafting', 'review'])

/** Character bigrams, so similarity works for Chinese as well as English. */
function bigrams(value: string): Map<string, number> {
  const text = value.toLowerCase().replace(/\s+/gu, ' ').trim()
  const grams = new Map<string, number>()
  const characters = [...text]
  for (let index = 0; index < characters.length - 1; index++) {
    const gram = characters[index]! + characters[index + 1]!
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  return grams
}

/** Dice coefficient over character bigrams. */
export function similarity(left: string, right: string): number {
  const a = bigrams(left)
  const b = bigrams(right)
  let total = 0
  let shared = 0
  for (const count of a.values()) total += count
  for (const count of b.values()) total += count
  if (total === 0) return left.trim() === right.trim() ? 1 : 0
  for (const [gram, count] of a) shared += Math.min(count, b.get(gram) ?? 0)
  return 2 * shared / total
}

/** A reviewer's free-form name, made into DSH's kebab-case when it can be. */
export function normalizeSkillName(value: string): string | undefined {
  const name = value.trim().toLowerCase().replace(/[\s_]+/gu, '-').replace(/[^a-z0-9-]/gu, '').replace(/-+/gu, '-').replace(/^-|-$/gu, '')
  return isSkillName(name) ? name : undefined
}

function signals(values: readonly string[]): EvolutionSignal[] {
  return [...new Set(values.filter((value): value is EvolutionSignal => (EVOLUTION_SIGNALS as readonly string[]).includes(value)))]
}

function clip(value: string, maximum: number): string {
  const text = value.trim()
  return text.length <= maximum ? text : text.slice(0, maximum - 1) + '…'
}

/**
 * `drafting` was set before this process started, so no live writer owns it any
 * more. A draft write is cancelled only by the Host going away, and the catch
 * that would put the suggestion back never runs then, so the row would sit in
 * "drafting" forever and refuse both a retry and a delete.
 */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1_000)
export const ORPHAN_DRAFT_ERROR = 'the host restarted while this draft was being written'

function orphanedDraft(suggestion: SkillSuggestion): boolean {
  const at = Date.parse(suggestion.updatedAt)
  return !Number.isFinite(at) || at < PROCESS_STARTED_AT
}

/**
 * Move pending suggestions past their expiry to `expired`, and suggestions whose
 * draft was abandoned by a dead process back to `pending`; true when anything changed.
 */
export function expireSuggestions(ledger: LedgerFile, now: Date): boolean {
  let changed = false
  for (const suggestion of ledger.suggestions) {
    const lastAuto = suggestion.autoAdoption?.at(-1)
    if (lastAuto !== undefined && ['queued', 'drafting', 'backtesting', 'rewriting'].includes(lastAuto.stage)
      && (!Number.isFinite(Date.parse(lastAuto.at)) || Date.parse(lastAuto.at) < PROCESS_STARTED_AT)) {
      const event: AutoAdoptionEvent = { at: now.toISOString(), stage: 'paused', attempt: lastAuto.attempt, reason: 'interrupted' }
      suggestion.autoAdoption = [...suggestion.autoAdoption!, event].slice(-16)
      const review = ledger.reviews.find(entry => entry.id === suggestion.reviewId)
      if (review !== undefined) review.autoAdoptions = [...(review.autoAdoptions ?? []), { ...event, suggestionId: suggestion.id, skillName: suggestion.skillName }].slice(-160)
      changed = true
    }
    if (suggestion.status === 'pending' && Date.parse(suggestion.expiresAt) < now.getTime()) {
      suggestion.status = 'expired'
      suggestion.updatedAt = now.toISOString()
      changed = true
    } else if (suggestion.status === 'drafting' && orphanedDraft(suggestion)) {
      suggestion.status = 'pending'
      suggestion.updatedAt = now.toISOString()
      suggestion.lastError = ORPHAN_DRAFT_ERROR
      changed = true
    }
  }
  return changed
}

function summaryOf(trajectory: Trajectory): TrajectorySummary {
  const { steps: _steps, annotations: _annotations, reviewSummary: _summary, ...summary } = trajectory
  return summary
}

/** Keep the newest trajectories; pinned ones and those a suggestion or case cites stay longest. */
export function boundedTrajectories(ledger: LedgerFile, evals: EvalsFile): string[] {
  if (ledger.trajectories.length <= MAX_TRAJECTORIES) return []
  const cited = new Set<string>([
    ...ledger.suggestions.filter(suggestion => OPEN_STATUSES.has(suggestion.status)).flatMap(suggestion => suggestion.evidence.map(reference => reference.trajectoryId)),
    ...evals.cases.flatMap(entry => entry.origin.trajectoryId === undefined ? [] : [entry.origin.trajectoryId]),
  ])
  const order = [...ledger.trajectories].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const removable = [
    ...order.filter(entry => !entry.pinned && !cited.has(entry.id) && entry.outcome !== 'suggested'),
    ...order.filter(entry => !entry.pinned && !cited.has(entry.id) && entry.outcome === 'suggested'),
  ]
  const removed = removable.slice(0, ledger.trajectories.length - MAX_TRAJECTORIES).map(entry => entry.id)
  ledger.trajectories = ledger.trajectories.filter(entry => !removed.includes(entry.id))
  return removed
}

/** Similar cases already in a skill's set, by title and prompt. */
export function similarCase(cases: readonly EvalCase[], skillName: string, title: string, prompt: string): EvalCase | undefined {
  const candidate = `${title}\n${prompt}`
  return cases.find(entry => entry.skillName === skillName && similarity(`${entry.title}\n${entry.prompt}`, candidate) >= 0.8)
}

/** The admission rules a review asked for, each kept within its range or left at its default. */
export function policyFrom(value: Partial<SkillsPolicy> | undefined): SkillsPolicy {
  const pick = (key: 'minConfidence' | 'expiryDays' | 'maxPendingPerSession', minimum: number, maximum: number): number => {
    const candidate = value?.[key]
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum ? candidate : DEFAULT_SKILLS_POLICY[key]
  }
  const allowed = (key: 'allowCreate' | 'allowUpdate'): boolean => {
    const candidate = value?.[key]
    if (candidate !== undefined && typeof candidate !== 'boolean') throw new Error(`skills policy ${key} must be a boolean`)
    return candidate ?? true
  }
  return {
    allowCreate: allowed('allowCreate'),
    allowUpdate: allowed('allowUpdate'),
    minConfidence: pick('minConfidence', 0, 1),
    expiryDays: Math.round(pick('expiryDays', 1, 90)),
    maxPendingPerSession: Math.round(pick('maxPendingPerSession', 1, 20)),
  }
}

export interface AdmissionContext {
  ledger: LedgerFile
  evals: EvalsFile
  policy: SkillsPolicy
  catalog: SkillCatalog
  now: Date
  id: () => string
}

/**
 * Record one review: the trajectory it read, the log entry, and whatever of
 * its suggestions and cases pass the admission rules. Mutates the files in
 * the context; returns the trajectory to persist and what happened.
 */
export function admitReview(context: AdmissionContext, input: ReviewRecordInput): { result: ReviewRecordResult; trajectory: Trajectory; removedTrajectories: string[] } {
  const { ledger, evals, policy, catalog, now } = context
  const at = now.toISOString()
  const reviewId = context.id()
  const trajectoryId = context.id()
  const stepIndexes = new Set(input.trajectory.steps.map(step => step.index))
  const steps = (values: readonly number[]) => [...new Set(values.filter(value => Number.isInteger(value) && stepIndexes.has(value)))].sort((a, b) => a - b)
  const skipped: ReviewRecordResult['skipped'] = []
  const allowed = (action: 'create' | 'update') => (action === 'create' ? policy.allowCreate : policy.allowUpdate) !== false
  const createdSuggestionIds: string[] = []
  let inserted = 0
  let updated = 0
  let casesAdded = 0
  expireSuggestions(ledger, now)

  // One proposal per skill and action in a batch: the most confident wins.
  const batch = new Map<string, ReviewRecordInput['suggestions'][number] & { skillName: string }>()
  for (const raw of input.suggestions) {
    const name = normalizeSkillName(raw.skillName)
    if (name === undefined) { skipped.push({ skillName: raw.skillName, action: raw.action, reason: 'invalid_name' }); continue }
    if (raw.action !== 'create' && raw.action !== 'update') { skipped.push({ skillName: name, action: String(raw.action), reason: 'invalid_action' }); continue }
    if (raw.summary.trim() === '' || !Number.isFinite(raw.confidence)) { skipped.push({ skillName: name, action: raw.action, reason: 'missing_or_invalid_fields' }); continue }
    if (steps(raw.steps).length === 0) { skipped.push({ skillName: name, action: raw.action, reason: 'no_evidence' }); continue }
    // A proposal follows the file DSH actually loads: creating a skill that exists is an update.
    const existing = activeSkill(catalog, name)
    const action = existing !== undefined ? 'update' : 'create'
    if (existing?.readOnly) { skipped.push({ skillName: name, action, reason: 'linked_skill' }); continue }
    if (!allowed(action)) { skipped.push({ skillName: name, action, reason: 'suggestion_type_disabled' }); continue }
    if (raw.action === 'update' && existing === undefined) { skipped.push({ skillName: name, action: raw.action, reason: 'unknown_skill' }); continue }
    const key = `${name}::${action}`
    const previous = batch.get(key)
    if (previous === undefined || raw.confidence >= previous.confidence) batch.set(key, { ...raw, skillName: name, action })
  }

  const touched: SkillSuggestion[] = []
  for (const proposal of batch.values()) {
    const confidence = Math.min(1, Math.max(0, proposal.confidence))
    const cited = steps(proposal.steps)
    const evidence = { trajectoryId, steps: cited }
    if (confidence < policy.minConfidence) { skipped.push({ skillName: proposal.skillName, action: proposal.action, reason: 'low_confidence' }); continue }
    const skill = activeSkill(catalog, proposal.skillName)
    const sameSkill = (suggestion: SkillSuggestion) => suggestion.skillName === proposal.skillName && suggestion.action === proposal.action
      && (skill === undefined || sameSuggestionSkill(ledger, suggestion, catalog, skill))
    const dismissed = ledger.suggestions.find(suggestion => sameSkill(suggestion)
      && suggestion.status === 'dismissed' && suggestion.sourceSessionId === input.review.sessionId && now.getTime() - Date.parse(suggestion.updatedAt) < DISMISSED_COOLDOWN_MS)
    if (dismissed !== undefined) { skipped.push({ skillName: proposal.skillName, action: proposal.action, reason: 'recently_dismissed' }); continue }
    const open = ledger.suggestions.find(suggestion => sameSkill(suggestion) && OPEN_STATUSES.has(suggestion.status))
    if (open !== undefined) {
      // More evidence for an open suggestion is never lost, even when its wording stays.
      open.evidence = [...open.evidence, evidence].slice(-12)
      open.signals = signals([...open.signals, ...proposal.signals])
      if (open.status === 'pending' && confidence >= open.confidence) {
        open.summary = clip(proposal.summary, 600)
        if (proposal.rationale !== undefined && proposal.rationale.trim() !== '') open.rationale = clip(proposal.rationale, 2_000)
        open.confidence = confidence
        open.reviewId = reviewId
        if (skill !== undefined) { open.skillKey = skill.key; open.skillFileHash = skill.hash; open.origin = skillOrigin(catalog, skill) }
        updated++
      } else {
        skipped.push({ skillName: proposal.skillName, action: proposal.action, reason: open.status === 'pending' ? 'duplicate_lower_confidence' : 'in_progress' })
      }
      open.updatedAt = at
      touched.push(open)
      continue
    }
    const suggestion: SkillSuggestion = {
      id: context.id(),
      skillName: proposal.skillName,
      action: proposal.action,
      ...(proposal.action === 'create' && proposal.targetRoot !== undefined ? { targetRoot: proposal.targetRoot } : {}),
      summary: clip(proposal.summary, 600),
      ...(proposal.rationale === undefined || proposal.rationale.trim() === '' ? {} : { rationale: clip(proposal.rationale, 2_000) }),
      confidence,
      signals: signals(proposal.signals),
      evidence: [evidence],
      ...(skill === undefined ? {} : { skillKey: skill.key, skillFileHash: skill.hash, origin: skillOrigin(catalog, skill) }),
      sourceSessionId: input.review.sessionId,
      ...(input.review.sessionTitle === undefined ? {} : { sourceSessionTitle: input.review.sessionTitle }),
      reviewId,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      expiresAt: new Date(now.getTime() + policy.expiryDays * 24 * 60 * 60 * 1000).toISOString(),
    }
    ledger.suggestions.unshift(suggestion)
    createdSuggestionIds.push(suggestion.id)
    touched.push(suggestion)
    inserted++
  }

  // At most N pending per session: the least confident, then the oldest, expire first.
  const pending = ledger.suggestions.filter(suggestion => suggestion.status === 'pending' && suggestion.sourceSessionId === input.review.sessionId)
  if (pending.length > policy.maxPendingPerSession) {
    const excess = [...pending].sort((a, b) => a.confidence - b.confidence || Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, pending.length - policy.maxPendingPerSession)
    for (const suggestion of excess) { suggestion.status = 'expired'; suggestion.updatedAt = at }
  }

  const caseIds: string[] = []
  for (const raw of input.cases) {
    const name = normalizeSkillName(raw.skillName)
    const title = clip(raw.title, 120)
    const prompt = clip(raw.prompt, 4_000)
    const checks = raw.checks.filter(check => check.text.trim() !== '').slice(0, 8).map(check => ({ id: context.id(), text: clip(check.text, 300), must: check.must === true }))
    const cited = steps(raw.steps)
    if (name === undefined || title === '' || prompt === '' || checks.length === 0) { skipped.push({ skillName: raw.skillName, reason: 'invalid_case' }); continue }
    if (!allowed(activeSkill(catalog, name) === undefined ? 'create' : 'update')) { skipped.push({ skillName: name, reason: 'suggestion_type_disabled' }); continue }
    if (similarCase(evals.cases, name, title, prompt) !== undefined) { skipped.push({ skillName: name, reason: 'similar_case' }); continue }
    if (evals.cases.filter(entry => entry.skillName === name).length >= MAX_CASES_PER_SKILL) { skipped.push({ skillName: name, reason: 'case_limit' }); continue }
    if (!checks.some(check => check.must)) checks[0]!.must = true
    const suggestion = touched.find(entry => entry.skillName === name)
    const entry: EvalCase = {
      id: context.id(), skillName: name, title, prompt, checks,
      origin: { kind: 'review', trajectoryId, steps: cited, ...(suggestion === undefined ? {} : { suggestionId: suggestion.id }) },
      enabled: true, createdAt: at, updatedAt: at,
    }
    evals.cases.unshift(entry)
    caseIds.push(entry.id)
    casesAdded++
  }

  const annotations: TrajectoryAnnotation[] = input.annotations
    .filter(annotation => stepIndexes.has(annotation.step) && (EVOLUTION_SIGNALS as readonly string[]).includes(annotation.signal))
    .slice(0, 60)
    .map(annotation => {
      const linked = touched.filter(suggestion => suggestion.evidence.some(reference => reference.trajectoryId === trajectoryId && reference.steps.includes(annotation.step))).map(suggestion => suggestion.id)
      return { step: annotation.step, signal: annotation.signal, note: clip(annotation.note, 400), ...(linked.length === 0 ? {} : { suggestionIds: linked }) }
    })
  const outcome = input.review.outcome === 'error' ? 'error' as const : touched.length > 0 || casesAdded > 0 ? 'suggested' as const : 'nothing' as const
  const trajectory: Trajectory = {
    ...input.trajectory,
    id: trajectoryId,
    annotations,
    annotationCount: annotations.length,
    signals: signals(annotations.map(annotation => annotation.signal)),
    suggestionIds: touched.map(suggestion => suggestion.id),
    caseIds,
    reviewId,
    outcome,
    pinned: false,
    createdAt: at,
    ...(input.review.summary === undefined ? {} : { reviewSummary: clip(input.review.summary, 600) }),
  }
  ledger.trajectories.unshift(summaryOf(trajectory))
  const log: ReviewLogEntry = {
    ...input.review,
    id: reviewId,
    outcome,
    suggestions: inserted + updated,
    cases: casesAdded,
    trajectoryId,
    ...(touched.length === 0 ? {} : { suggestionIds: touched.map(suggestion => suggestion.id) }),
  }
  ledger.reviews.unshift(log)
  const removedTrajectories = boundedTrajectories(ledger, evals)
  return { result: { reviewId, trajectoryId, suggestionIds: touched.map(suggestion => suggestion.id), createdSuggestionIds, inserted, updated, casesAdded, skipped }, trajectory, removedTrajectories }
}

export function trajectorySummary(trajectory: Trajectory): TrajectorySummary {
  return summaryOf(trajectory)
}
