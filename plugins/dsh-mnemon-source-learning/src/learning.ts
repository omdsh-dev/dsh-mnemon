import type { MemoryJsonValue, MemoryOperationObservation, MemoryOperationScope } from 'dsh-mnemon/contracts'
import { memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { digest, json, newRecord, RecordStore, reviseRecord, visibleRecord, type RecordSnapshot, type RecordValue } from 'dsh-mnemon/source-sdk'

export interface LearningConfig { dataDir?: string; captureFeedback?: boolean; captureOutcomes?: boolean; autoAcceptFacts?: boolean; autoAcceptPreferences?: boolean; evidenceLimit?: number; provider?: string; model?: string }
export function learningPolicy(snapshot: Pick<RecordSnapshot, 'records'>, config: LearningConfig = {}): LearningConfig { return { captureFeedback: true, captureOutcomes: true, autoAcceptFacts: false, autoAcceptPreferences: false, evidenceLimit: 1000, ...config, ...snapshot.records.find(record => record.kind === 'policy')?.data } }
export type EvidenceOrigin = 'human-turn' | 'human-feedback' | 'task-outcome' | 'job-outcome' | 'review-output'
export interface LearningProposal { category: 'preference' | 'fact' | 'procedure'; title: string; content: string; scope: 'global' | 'project'; evidenceIds: string[]; slug?: string; supersedes?: string }
export interface LearningReview { token: string; summary: string; proposals: LearningProposal[] }
export interface LearningWindow { token: string; cycleId: string; throughRound: number; throughFeedback: number; throughOutcomes: number; evidence: RecordValue[]; proposals: RecordValue[] }
const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
const array = (value: MemoryJsonValue | undefined): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

export function redactLearningText(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|Bearer\s+[a-zA-Z0-9._~+\/-]{16,})/gi, '[redacted credential]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;"']{6,}/gi, '$1[redacted]')
}
export function parseLearningReview(value: unknown): LearningReview {
  const input = memoryInputRecord(json(value), 'learning review')
  const token = memoryInputText(input.token, 'review token', 64)!, summary = memoryInputText(input.summary, 'review summary', 2000)!
  if (!Array.isArray(input.proposals) || input.proposals.length > 3) throw new Error('A review allows at most two memories and one procedure')
  const proposals = input.proposals.map(value => {
    const p = memoryInputRecord(value, 'learning proposal')
    if (!['preference', 'fact', 'procedure'].includes(String(p.category)) || !['global', 'project'].includes(String(p.scope))) throw new Error('Choose a supported proposal category and scope')
    const title = memoryInputText(p.title, 'proposal title', 300)!, content = memoryInputText(p.content, 'proposal content', 8000)!
    if (redactLearningText(title + '\n' + content) !== title + '\n' + content) throw new Error('Credentials cannot become learning proposals')
    if (!Array.isArray(p.evidenceIds) || !p.evidenceIds.length || p.evidenceIds.length > 20 || p.evidenceIds.some(id => typeof id !== 'string' || id.length > 100)) throw new Error('Each proposal needs bounded evidence identifiers')
    const category = p.category as LearningProposal['category']
    if (category === 'preference' && p.scope !== 'global') throw new Error('Stable preferences use global scope')
    const slug = p.slug === undefined ? undefined : memoryInputText(p.slug, 'procedure name', 100)!
    if (category === 'procedure' && (!slug || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug))) throw new Error('A procedure needs a reusable kebab-case name')
    return { category, title, content, scope: p.scope as 'global' | 'project', evidenceIds: [...new Set(p.evidenceIds as string[])], ...(slug ? { slug } : {}), ...(p.supersedes ? { supersedes: memoryInputText(p.supersedes, 'superseded proposal', 100)! } : {}) }
  })
  if (proposals.filter(p => p.category === 'procedure').length > 1 || proposals.filter(p => p.category !== 'procedure').length > 2) throw new Error('A review allows at most two memories and one procedure')
  return { token, summary: redactLearningText(summary), proposals }
}
export function learningWindow(snapshot: RecordSnapshot, scope: MemoryOperationScope): LearningWindow | undefined {
  const cycle = snapshot.records.find(record => record.kind === 'cycle' && visibleRecord(record, scope))
  if (!cycle) return
  const throughRound = Number(cycle.data.rounds), completed = Number(cycle.data.completedRound)
  return { cycleId: cycle.id, token: digest([cycle.id, completed, throughRound, cycle.data.feedback ?? 0, cycle.data.completedFeedback ?? 0, cycle.data.outcomes ?? 0, cycle.data.completedOutcomes ?? 0]), throughRound, throughFeedback: Number(cycle.data.feedback ?? 0), throughOutcomes: Number(cycle.data.outcomes ?? 0),
    evidence: snapshot.records.filter(record => record.kind === 'observation' && visibleRecord(record, scope) && record.state === 'active').slice(-60),
    proposals: snapshot.records.filter(record => record.kind === 'proposal' && visibleRecord(record, scope) && record.state !== 'deleted').slice(-40) }
}
function cycleFor(records: RecordValue[], scope: MemoryOperationScope): RecordValue {
  let cycle = records.find(record => record.kind === 'cycle' && visibleRecord(record, scope))
  if (!cycle) { cycle = newRecord('cycle', 'Learning cycle', '', 'session', scope, { rounds: 0, completedRound: 0, reviews: 0, feedback: 0, completedFeedback: 0, outcomes: 0, completedOutcomes: 0 }); records.push(cycle) }
  return cycle
}
export class LearningStore {
  readonly store: RecordStore
  constructor(directory: string, readonly config: LearningConfig = {}) { this.store = new RecordStore(directory) }
  async policy(signal?: AbortSignal): Promise<LearningConfig> { return learningPolicy(await this.store.read(signal), this.config) }
  async observe(scope: MemoryOperationScope, value: { eventKey: string; origin: EvidenceOrigin; title: string; content: string; independentKey?: string; data?: RecordValue['data'] }, signal?: AbortSignal): Promise<void> {
    if (!scope.sessionId && !scope.workspaceId) return
    const content = redactLearningText(value.content).slice(0, 6000)
    if (!content.trim()) return
    await this.store.change(undefined, records => {
      if (records.some(record => record.kind === 'observation' && record.data.eventKey === value.eventKey)) return
      let round = 0
      if (scope.sessionId) {
        const cycle = cycleFor(records, scope)
        reviseRecord(cycle, value.origin)
        if (value.origin === 'human-turn') cycle.data.rounds = Number(cycle.data.rounds) + 1
        else if (value.origin === 'human-feedback') cycle.data.feedback = Number(cycle.data.feedback ?? 0) + 1
        else cycle.data.outcomes = Number(cycle.data.outcomes ?? 0) + 1
        round = Number(cycle.data.rounds)
      }
      records.push(newRecord('observation', redactLearningText(value.title).slice(0, 300) || 'Learning evidence', content, scope.sessionId ? 'session' : 'project', scope,
        { ...value.data, eventKey: value.eventKey, independentKey: value.independentKey ?? value.eventKey, origin: value.origin, round, ...(value.data?.exactQuote === true ? { exactQuote: content === value.content } : {}), redacted: content !== value.content, capturedAt: new Date().toISOString() }))
      this.prune(records)
    }, signal)
  }
  async complete(scope: MemoryOperationScope, review: LearningReview, pinned: LearningWindow, revision?: string, signal?: AbortSignal): Promise<RecordSnapshot> {
    if (review.token !== pinned.token) throw new Error('Review token does not match the inspected evidence')
    const proposals = parseLearningReview(review).proposals
    return this.store.change(revision, records => {
      if (records.some(record => record.kind === 'run' && record.data.token === review.token && visibleRecord(record, scope))) return
      const cycle = records.find(record => record.id === pinned.cycleId && visibleRecord(record, scope))
      if (!cycle || Number(cycle.data.completedRound) >= pinned.throughRound && Number(cycle.data.completedFeedback ?? 0) >= pinned.throughFeedback && Number(cycle.data.completedOutcomes ?? 0) >= pinned.throughOutcomes) throw new Error('No new evidence remains in this review')
      const policy = learningPolicy({ records }, this.config)
      const proposalIds: string[] = []
      for (const proposal of proposals) {
        const evidence = proposal.evidenceIds.map(id => {
          const observed = pinned.evidence.find(item => item.id === id)
          const current = records.find(item => item.id === id && item.kind === 'observation' && item.state === 'active' && visibleRecord(item, scope))
          if (!observed || !current || observed.version !== current.version) throw new Error('Proposal evidence was not inspected or is no longer available')
          return current
        })
        if (proposal.scope === 'project' && !scope.workspaceId) throw new Error('Choose a workspace for project learning')
        const keys = [...new Set(evidence.map(record => String(record.data.independentKey)))]
        const humanKeys = [...new Set(evidence.filter(record => ['human-turn', 'human-feedback'].includes(String(record.data.origin))).map(record => String(record.data.independentKey)))]
        const fingerprint = digest([proposal.category, proposal.scope, proposal.scope === 'project' ? scope.workspaceId : '', normalize(proposal.content)])
        let candidate = records.find(record => record.kind === 'proposal' && record.data.fingerprint === fingerprint && visibleRecord(record, scope) && record.state !== 'deleted')
        if (candidate) {
          const merged = [...new Set([...array(candidate.data.evidenceIds), ...proposal.evidenceIds])]
          if (merged.length === array(candidate.data.evidenceIds).length) { proposalIds.push(candidate.id); continue }
          reviseRecord(candidate, 'independent-evidence')
          candidate.data.evidenceIds = merged.slice(-100)
          candidate.data.independentKeys = [...new Set([...array(candidate.data.independentKeys), ...keys])].slice(-100)
          candidate.data.humanKeys = [...new Set([...array(candidate.data.humanKeys), ...humanKeys])].slice(-100)
          candidate.signals = array(candidate.data.independentKeys).length
        } else {
          if (proposal.supersedes && !pinned.proposals.some(p => p.id === proposal.supersedes && p.state === 'active' && p.scope === proposal.scope && p.data.category === proposal.category)) throw new Error('Read the active proposal in the same category before suggesting a replacement')
          candidate = newRecord('proposal', proposal.title, proposal.content, proposal.scope, scope, {
            category: proposal.category, fingerprint, evidenceIds: proposal.evidenceIds, independentKeys: keys, humanKeys,
            ...(proposal.slug ? { slug: proposal.slug } : {}), ...(proposal.supersedes ? { supersedes: proposal.supersedes } : {}),
            reads: 0, uses: 0, helpful: 0, concerns: 0, needsReview: false, originSessionId: scope.sessionId ?? '',
          }, 'pending')
          candidate.signals = keys.length; records.push(candidate)
        }
        const automatic = proposal.category === 'fact' && policy.autoAcceptFacts === true || proposal.category === 'preference' && policy.autoAcceptPreferences === true
        const enough = candidate.signals >= 2 && (proposal.category !== 'preference' || array(candidate.data.humanKeys).length >= 2)
        if (automatic && enough && candidate.state === 'pending' && !candidate.data.supersedes && candidate.data.needsReview !== true) { reviseRecord(candidate, 'automatic-adoption'); candidate.state = 'active'; candidate.data.adoptedAt = new Date().toISOString() }
        proposalIds.push(candidate.id)
      }
      records.push(newRecord('run', 'Learning review', redactLearningText(review.summary), 'session', scope, { token: review.token, throughRound: pinned.throughRound, proposalIds, evidenceIds: pinned.evidence.map(item => item.id), completedAt: new Date().toISOString() }))
      reviseRecord(cycle, 'review-completed'); cycle.data.completedRound = Math.max(Number(cycle.data.completedRound), pinned.throughRound); cycle.data.completedFeedback = Math.max(Number(cycle.data.completedFeedback ?? 0), pinned.throughFeedback); cycle.data.completedOutcomes = Math.max(Number(cycle.data.completedOutcomes ?? 0), pinned.throughOutcomes); cycle.data.reviews = Number(cycle.data.reviews) + 1; cycle.data.lastReviewAt = new Date().toISOString()
      this.prune(records)
    }, signal)
  }
  async change(scope: MemoryOperationScope, operation: string, input: RecordValue['data'], revision?: string, signal?: AbortSignal): Promise<RecordSnapshot> {
    return this.store.change(revision, records => {
      if (['batch-approve', 'batch-reject', 'batch-archive'].includes(operation)) {
        const ids = input.recordIds, versions = memoryInputRecord(input.versions ?? {}, 'proposal versions'), replacements = memoryInputRecord(input.supersededVersions ?? {}, 'replacement versions')
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Select between one and fifty unique proposals')
        for (const id of ids as string[]) this.applyChange(records, scope, operation.slice(6), { id, version: versions[id] ?? null, supersededVersion: replacements[id] ?? null })
        return
      }
      this.applyChange(records, scope, operation, input)
    }, signal)
  }
  private applyChange(records: RecordValue[], scope: MemoryOperationScope, operation: string, input: RecordValue['data']): void {
      if (operation === 'configure') {
        const settings = memoryInputRecord(input.settings ?? {}, 'learning policy')
        if (Object.keys(settings).some(key => !['captureFeedback', 'captureOutcomes', 'autoAcceptFacts', 'autoAcceptPreferences', 'evidenceLimit'].includes(key))) throw new Error('Unknown learning policy setting')
        for (const [key, value] of Object.entries(settings)) if (key === 'evidenceLimit' ? !Number.isInteger(value) || Number(value) < 100 || Number(value) > 5000 : typeof value !== 'boolean') throw new Error('Invalid learning policy setting')
        let policy = records.find(record => record.kind === 'policy')
        if (!policy) { policy = newRecord('policy', 'Learning policy', '', 'global', scope); records.push(policy) }
        reviseRecord(policy, 'policy-updated'); Object.assign(policy.data, settings); return
      }
      const record = records.find(r => r.id === input.id && r.kind === 'proposal' && visibleRecord(r, scope))
      if (!record || input.version !== record.version) throw new Error('Choose the current proposal version')
      if (operation === 'record-feedback') {
        const verdict = String(input.verdict)
        if (!['helpful', 'incorrect', 'outdated', 'irrelevant'].includes(verdict) || !['active', 'archived'].includes(record.state)) throw new Error('Feedback needs an adopted or transferred proposal')
        const rawQuote = memoryInputText(input.quote, 'feedback', 2000)!, quote = redactLearningText(rawQuote)
        const key = memoryInputText(input.eventKey, 'feedback event', 100)!
        if (records.some(r => r.kind === 'assessment' && r.data.eventKey === key)) return
        records.push(newRecord('assessment', verdict, quote, record.scope, scope, { proposalId: record.id, verdict, eventKey: key, actor: 'operator' }))
        if (scope.sessionId) { const cycle = cycleFor(records, scope); reviseRecord(cycle, 'explicit-feedback'); cycle.data.feedback = Number(cycle.data.feedback ?? 0) + 1; records.push(newRecord('observation', 'Learning feedback', quote, 'session', scope, { eventKey: key, independentKey: key, origin: 'human-feedback', proposalId: record.id, verdict, exactQuote: quote === rawQuote, redacted: quote !== rawQuote, round: Number(cycle.data.rounds) })) }
        reviseRecord(record, 'human-feedback'); record.data[verdict === 'helpful' ? 'helpful' : 'concerns'] = Number(record.data[verdict === 'helpful' ? 'helpful' : 'concerns']) + 1
        if (verdict !== 'helpful') record.data.needsReview = true
        return
      }
      if (operation === 'link-destination') {
        if (!['pending', 'active', 'archived'].includes(record.state)) throw new Error('Only reviewed or pending proposals can be transferred')
        const sourceInstanceKey = memoryInputText(input.sourceInstanceKey, 'destination Source', 300)!, recordId = memoryInputText(input.recordId, 'destination record', 100)!
        if (!sourceInstanceKey.startsWith('source:') || sourceInstanceKey === input.learningSourceInstanceKey) throw new Error('Choose an independent destination Source')
        if (record.data.destination && digest(record.data.destination) !== digest({ sourceInstanceKey, recordId })) throw new Error('This proposal already has another destination')
        reviseRecord(record, 'destination-linked'); record.data.destination = { sourceInstanceKey, recordId }; record.data.destinationState = input.destinationState === 'active' ? 'active' : 'pending'; record.state = 'archived'
        return
      }
      if (!['approve', 'reject', 'archive', 'restore', 'update', 'resolve-feedback'].includes(operation)) throw new Error('Unsupported learning operation')
      if (operation === 'approve' && record.state !== 'pending' || operation === 'reject' && record.state !== 'pending') throw new Error('Only pending proposals can be adopted or rejected')
      if (operation === 'approve' && record.data.category === 'preference' && array(record.data.humanKeys).length < 2) throw new Error('A stable preference needs two independent human observations')
      if (operation === 'restore' && (!['archived', 'rejected'].includes(record.state) || record.data.destination)) throw new Error('Only archived or rejected local proposals can return to review')
      if (operation === 'update' && record.state !== 'pending') throw new Error('Only pending proposals can be edited; archive and propose a revision for active learning')
      reviseRecord(record, operation)
      if (operation === 'update') {
        const title = memoryInputText(input.title, 'title', 300)!, content = memoryInputText(input.content, 'content', 8000)!
        if (redactLearningText(title + content) !== title + content) throw new Error('Credentials cannot become learning proposals')
        record.title = title; record.content = content; record.data.editedByOperator = true; record.data.fingerprint = digest([record.data.category, record.scope, record.scope === 'project' ? record.workspaceId : '', normalize(content)])
      }
      if (operation === 'approve') {
        if (record.data.supersedes) {
          const previous = records.find(r => r.id === record.data.supersedes && r.kind === 'proposal' && r.state === 'active' && r.scope === record.scope && r.data.category === record.data.category && visibleRecord(r, scope))
          if (!previous || input.supersededVersion !== previous.version) throw new Error('Review the current replacement before adoption')
          reviseRecord(previous, 'superseded'); previous.state = 'archived'; previous.data.replacedBy = record.id
          if (previous.data.needsReview === true) { previous.data.needsReview = false; previous.data.feedbackResolution = 'Replaced by an approved revision.'; previous.data.feedbackResolvedAt = new Date().toISOString() }
        }
        record.state = 'active'; record.data.adoptedAt = new Date().toISOString()
      }
      if (operation === 'reject') record.state = 'rejected'
      if (operation === 'archive') record.state = 'archived'
      if (operation === 'restore') record.state = 'pending'
      if (operation === 'resolve-feedback') { record.data.needsReview = false; record.data.feedbackResolution = redactLearningText(memoryInputText(input.reason, 'resolution', 2000)!) }
  }

  async operation(event: Readonly<MemoryOperationObservation>, ownSource: string, signal?: AbortSignal): Promise<void> {
    if (event.kind !== 'read' && event.kind !== 'mutation' && event.kind !== 'management') return
    if (!event.recordIds.length || event.sourceInstanceKey === ownSource && event.kind !== 'read') return
    await this.store.change(undefined, records => {
      if (records.some(r => r.kind === 'effect' && r.data.eventKey === event.id)) return
      const linked = records.filter(record => {
        if (record.kind !== 'proposal' || !visibleRecord(record, event.scope)) return false
        if (ownSource === event.sourceInstanceKey) return record.state === 'active' && event.recordIds.includes(record.id)
        const target = record.data.destination
        return !!target && typeof target === 'object' && !Array.isArray(target) && target.sourceInstanceKey === event.sourceInstanceKey && event.recordIds.includes(String(target.recordId))
      })
      for (const record of linked) {
        const read = event.kind === 'read', adopted = event.kind === 'management' && ['approve', 'batch-approve'].includes(event.operation)
        reviseRecord(record, read ? 'context-read' : 'destination-operation')
        if (read) record.data.reads = Number(record.data.reads) + 1
        if (adopted) record.data.destinationState = 'active'
        if (event.kind === 'management' && ['archive', 'batch-archive', 'reject', 'batch-reject', 'delete'].includes(event.operation)) record.data.destinationState = event.operation.includes('archive') ? 'archived' : event.operation.includes('reject') ? 'rejected' : 'deleted'
        if (event.kind === 'management' && event.operation === 'restore') record.data.destinationState = 'active'
        if (event.kind === 'management' && event.operation === 'update') record.data.needsReview = true
        const destination = record.data.destination
        const changed = destination && typeof destination === 'object' && !Array.isArray(destination) ? event.records?.find(item => item.id === destination.recordId) : undefined
        if (changed?.state && ['active', 'pending', 'archived', 'rejected', 'deleted'].includes(changed.state)) record.data.destinationState = changed.state
        if (changed?.revision) record.data.destinationRevision = changed.revision
        records.push(newRecord('effect', read ? 'Context read' : event.operation, '', record.scope, event.scope, { eventKey: event.id, proposalId: record.id, operation: event.operation, kind: event.kind, actor: event.actor, sourceInstanceKey: event.sourceInstanceKey, ...(event.completion ? { completion: event.completion } : {}), occurredAt: event.occurredAt }))
      }
      this.prune(records)
    }, signal)
  }
  private prune(records: RecordValue[]): void {
    const protectedIds = new Set(records.filter(r => r.kind === 'proposal' && r.state !== 'deleted').flatMap(r => array(r.data.evidenceIds)))
    const retained = records.filter(r => r.kind === 'observation' && !protectedIds.has(r.id)).slice(-(learningPolicy({ records }, this.config).evidenceLimit ?? 1000))
    const keep = new Set([...retained, ...records.filter(r => ['run', 'effect', 'failure'].includes(r.kind)).slice(-500)].map(r => r.id))
    for (let i = records.length - 1; i >= 0; i--) if (['observation', 'run', 'effect', 'failure'].includes(records[i]!.kind) && !protectedIds.has(records[i]!.id) && !keep.has(records[i]!.id)) records.splice(i, 1)
  }
}
