import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { LearningStore, learningWindow, parseLearningReview, type LearningConfig, type LearningProposal } from '../src/learning.ts'
import { boundedLearningWindow, LearningRunner, reviewPrompt } from '../src/runner.ts'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const scope: MemoryOperationScope = { storage: 'custom', workspaceId: '/workspace', sessionId: 'session-a' }
async function fixture(config: LearningConfig = {}) { const directory = await mkdtemp(join(tmpdir(), 'mnemon-learning-')); dirs.push(directory); return new LearningStore(directory, config) }
async function human(store: LearningStore, turn: number, content = 'Prefer concise responses', selected = scope) { await store.observe(selected, { eventKey: `${selected.sessionId}:${turn}`, independentKey: `${selected.sessionId}:${turn}`, origin: 'human-turn', title: `Turn ${turn}`, content }) }
async function review(store: LearningStore, category: LearningProposal['category'] = 'preference', content = 'Prefer concise responses') {
  const window = learningWindow(await store.store.read(), scope)!
  return store.complete(scope, { token: window.token, summary: 'Reviewed explicit evidence.', proposals: [{ category, title: 'Response style', content, scope: category === 'preference' ? 'global' : 'project', evidenceIds: window.evidence.map(record => record.id), ...(category === 'procedure' ? { slug: 'check-results' } : {}) }] }, window)
}
it('counts independent human turns, deduplicates retries and redacts credentials before storage', async () => {
  const store = await fixture()
  await human(store, 1, 'Use key sk-abcdefghijklmnopqrstuvwxyz123456')
  await human(store, 1, 'Use key sk-abcdefghijklmnopqrstuvwxyz123456')
  await store.observe(scope, { eventKey: 'outcome-1', independentKey: 'session-a:1', origin: 'task-outcome', title: 'Reported outcome', content: 'Completed by assistant' })
  const snapshot = await store.store.read()
  expect(snapshot.records.filter(r => r.kind === 'observation')).toHaveLength(2)
  expect(snapshot.records.find(r => r.kind === 'cycle')?.data.rounds).toBe(1)
  expect(JSON.stringify(snapshot)).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
  expect(snapshot.records.find(r => r.kind === 'observation')?.data.redacted).toBe(true)
  await review(store)
  expect((await store.store.read()).records.find(r => r.kind === 'proposal')?.signals).toBe(1)
})
it('requires two independent human observations for stable preferences and merges repeated proposals', async () => {
  const store = await fixture(); await human(store, 1); await review(store)
  let candidate = (await store.store.read()).records.find(r => r.kind === 'proposal')!
  await expect(store.change(scope, 'approve', { id: candidate.id, version: candidate.version })).rejects.toThrow('two independent')
  await human(store, 2); await review(store)
  const records = (await store.store.read()).records
  expect(records.filter(r => r.kind === 'proposal')).toHaveLength(1)
  candidate = records.find(r => r.kind === 'proposal')!
  expect(candidate.signals).toBe(2)
  const adopted = await store.change(scope, 'approve', { id: candidate.id, version: candidate.version })
  expect(adopted.records.find(r => r.id === candidate.id)?.state).toBe('active')
  const reopened = new LearningStore(store.store.directory)
  expect((await reopened.store.read()).records.find(r => r.id === candidate.id)?.data.humanKeys).toHaveLength(2)
})
it('leaves new rounds outstanding when a review finishes and replays the same token without duplicates', async () => {
  const store = await fixture(); await human(store, 1)
  const window = learningWindow(await store.store.read(), scope)!, result = { token: window.token, summary: 'No durable conclusion yet.', proposals: [] }
  await human(store, 2); await store.complete(scope, result, window); await store.complete(scope, result, window)
  const records = (await store.store.read()).records
  expect(records.filter(r => r.kind === 'run')).toHaveLength(1)
  expect(records.find(r => r.kind === 'cycle')?.data).toMatchObject({ rounds: 2, completedRound: 1, reviews: 1 })
})
it('rejects unknown or cross-session evidence atomically without completing the cycle', async () => {
  const store = await fixture(); await human(store, 1); await human(store, 1, 'Unrelated', { ...scope, sessionId: 'other' })
  const snapshot = await store.store.read(), window = learningWindow(snapshot, scope)!, alien = snapshot.records.find(r => r.kind === 'observation' && r.sessionId === 'other')!
  await expect(store.complete(scope, { token: window.token, summary: 'Invalid review', proposals: [{ category: 'fact', scope: 'project', title: 'Invalid', content: 'Not visible', evidenceIds: [alien.id] }] }, window)).rejects.toThrow('not inspected')
  expect((await store.store.read()).revision).toBe(snapshot.revision)
  await expect(store.complete(scope, { token: 'wrong', summary: 'Mismatch', proposals: [] }, window)).rejects.toThrow('token')
})
it('distinguishes read exposure from helpfulness and returns negative feedback to review evidence', async () => {
  const store = await fixture(); await human(store, 1); await review(store, 'fact')
  let snapshot = await store.store.read(), candidate = snapshot.records.find(r => r.kind === 'proposal')!
  snapshot = await store.change(scope, 'approve', { id: candidate.id, version: candidate.version }); candidate = snapshot.records.find(r => r.id === candidate.id)!
  const event = { id: 'read-1', occurredAt: new Date().toISOString(), scope, sourceInstanceKey: 'source:learning', sourceTypeId: 'learning', operation: 'search', kind: 'read' as const, actor: 'model' as const, recordIds: [candidate.id] }
  await store.operation(event, 'source:learning'); await store.operation(event, 'source:learning')
  snapshot = await store.store.read(); candidate = snapshot.records.find(r => r.id === candidate.id)!
  expect(candidate.data).toMatchObject({ reads: 1, uses: 0, helpful: 0 })
  await store.change(scope, 'record-feedback', { id: candidate.id, version: candidate.version, verdict: 'incorrect', quote: 'This assumption was wrong for the deployment.', eventKey: 'feedback-1' })
  snapshot = await store.store.read(); candidate = snapshot.records.find(r => r.id === candidate.id)!
  expect(candidate).toMatchObject({ state: 'active', data: { concerns: 1, helpful: 0, needsReview: true } })
  expect(learningWindow(snapshot, scope)?.evidence.some(r => r.data.proposalId === candidate.id && r.data.origin === 'human-feedback')).toBe(true)
  await store.change(scope, 'resolve-feedback', { id: candidate.id, version: candidate.version, reason: 'Archived separately after checking the deployment evidence.' })
  expect((await store.store.read()).records.find(r => r.id === candidate.id)?.data.needsReview).toBe(false)
})
it('only automatically adopts eligible opted-in learning and never resurrects rejected suggestions', async () => {
  const store = await fixture({ autoAcceptFacts: true, autoAcceptPreferences: true })
  await human(store, 1); await review(store, 'fact')
  let candidate = (await store.store.read()).records.find(r => r.kind === 'proposal')!
  expect(candidate.state).toBe('pending')
  await store.change(scope, 'reject', { id: candidate.id, version: candidate.version })
  await human(store, 2); await review(store, 'fact')
  candidate = (await store.store.read()).records.find(r => r.kind === 'proposal')!
  expect(candidate).toMatchObject({ signals: 2, state: 'rejected' })
  await human(store, 3); await review(store, 'preference', 'Keep responses brief')
  expect((await store.store.read()).records.find(r => r.data.category === 'preference')?.state).toBe('active')
})
it('closes feedback only when the reviewed replacement is approved, retaining the evidence and original history', async () => {
  const store = await fixture(); await human(store, 1); await review(store, 'fact')
  let snapshot = await store.store.read(), original = snapshot.records.find(r => r.kind === 'proposal')!
  snapshot = await store.change(scope, 'approve', { id: original.id, version: original.version }); original = snapshot.records.find(r => r.id === original.id)!
  await store.change(scope, 'record-feedback', { id: original.id, version: original.version, verdict: 'incorrect', quote: 'Keep exact technical identifiers.', eventKey: 'correction' })
  const window = learningWindow(await store.store.read(), scope)!
  const proposal = { category: 'fact' as const, scope: 'project' as const, title: 'Reviewed convention', content: 'Use concise reports with exact technical identifiers.', evidenceIds: window.evidence.map(r => r.id), supersedes: original.id }
  await expect(store.complete(scope, { token: window.token, summary: 'Wrong category', proposals: [{ ...proposal, category: 'procedure', slug: 'report-results' }] }, window)).rejects.toThrow('same category')
  snapshot = await store.complete(scope, { token: window.token, summary: 'Apply the explicit correction', proposals: [proposal] }, window)
  original = snapshot.records.find(r => r.id === original.id)!
  const replacement = snapshot.records.find(r => r.data.supersedes === original.id)!
  expect(original).toMatchObject({ state: 'active', data: { needsReview: true } })
  snapshot = await store.change(scope, 'batch-approve', { recordIds: [replacement.id], versions: { [replacement.id]: replacement.version }, supersededVersions: { [replacement.id]: original.version } })
  expect(snapshot.records.find(r => r.id === original.id)).toMatchObject({ state: 'archived', data: { needsReview: false, replacedBy: replacement.id, feedbackResolution: 'Replaced by an approved revision.' } })
  expect(snapshot.records.find(r => r.id === replacement.id)?.state).toBe('active')
  expect(snapshot.records.some(r => r.kind === 'assessment' && r.data.eventKey === 'correction')).toBe(true)
})
it('tracks an exported proposal without duplicating active local memory', async () => {
  const store = await fixture(); await human(store, 1); await review(store, 'fact')
  let candidate = (await store.store.read()).records.find(r => r.kind === 'proposal')!
  await store.change(scope, 'link-destination', { id: candidate.id, version: candidate.version, sourceInstanceKey: 'source:notes', learningSourceInstanceKey: 'source:learning', recordId: 'remote-record', destinationState: 'pending' })
  candidate = (await store.store.read()).records.find(r => r.id === candidate.id)!
  expect(candidate.state).toBe('archived'); expect(candidate.data.destinationState).toBe('pending')
  await store.operation({ id: 'approval', occurredAt: new Date().toISOString(), scope, sourceInstanceKey: 'source:notes', sourceTypeId: 'project-context', operation: 'approve', kind: 'management', actor: 'operator', recordIds: ['remote-record'] }, 'source:learning')
  expect((await store.store.read()).records.find(r => r.id === candidate.id)?.data.destinationState).toBe('active')
})
it('preserves due state when a real completion port fails or returns invalid JSON', async () => {
  const store = await fixture(); await human(store, 1)
  const runner = new LearningRunner(store, { complete: async () => 'Not valid JSON' })
  try {
    await runner.queue(scope, (await store.store.read()).revision); await runner.idle()
    const records = (await store.store.read()).records
    expect(records.find(r => r.kind === 'cycle')?.data).toMatchObject({ completedRound: 0, status: 'failed' })
    expect(records.filter(r => r.kind === 'run' || r.kind === 'proposal')).toHaveLength(0)
    expect(records.filter(r => r.kind === 'failure')).toHaveLength(1)
  } finally { await runner.dispose() }
})
it('bounds model evidence with explicit excerpts and enforces proposal limits and credential exclusion', async () => {
  const store = await fixture(); for (let i = 1; i <= 10; i++) await human(store, i, 'long content '.repeat(500))
  const window = boundedLearningWindow(learningWindow(await store.store.read(), scope)!, 10_000)
  expect(reviewPrompt(window).length).toBeLessThanOrEqual(10_000); expect(window.evidence.length).toBeGreaterThanOrEqual(2)
  expect(reviewPrompt(window)).toContain('"excerpt":true')
  expect(() => parseLearningReview({ token: 't', summary: 'review', proposals: Array(4).fill({}) })).toThrow('at most')
  expect(() => parseLearningReview({ token: 't', summary: 'review', proposals: [{ category: 'fact', scope: 'project', title: 'Secret', content: 'sk-abcdefghijklmnopqrstuvwxyz123456', evidenceIds: ['one'] }] })).toThrow('Credentials')
})

it('carries attribution and terminal outcomes into model evidence without promoting them to human confirmation', async () => {
  const store = await fixture(); await human(store, 1)
  await store.observe(scope, { eventKey: 'assistant-report', origin: 'task-outcome', title: 'Reported result', content: 'Everything succeeded.', data: { attribution: 'assistant-report', verifiedByHuman: false, arbitraryPayload: { private: 'omit' } } })
  await store.observe(scope, { eventKey: 'cancelled-job', origin: 'job-outcome', title: 'Cancelled check', content: 'Waiting before the model request.', data: { activityKind: 'job-completed', status: 'cancelled', level: 'warning', exitCode: 143 } })
  await store.observe(scope, { eventKey: 'failed-job', origin: 'job-outcome', title: 'Failed check', content: 'Started successfully but then failed.', data: { activityKind: 'job-completed', status: 'failed', level: 'warning', exitCode: 9 } })
  await store.observe(scope, { eventKey: 'successful-process', origin: 'job-outcome', title: 'Finished process', content: 'An unverified generated conclusion.', data: { activityKind: 'job-completed', status: 'succeeded', level: 'info', exitCode: 0 } })
  await store.observe(scope, { eventKey: 'explicit-correction', origin: 'human-feedback', title: 'Correction', content: 'The process did not finish the check.', data: { proposalId: 'candidate-1', verdict: 'incorrect', exactQuote: true } })
  const window = learningWindow(await store.store.read(), scope)!, prompt = JSON.parse(reviewPrompt(window))
  expect(prompt.throughRound).toBe(1)
  expect(prompt.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: 'Reported result', attribution: 'assistant-report', verifiedByHuman: false }),
    expect.objectContaining({ title: 'Cancelled check', activityKind: 'job-completed', status: 'cancelled', level: 'warning', exitCode: 143 }),
    expect.objectContaining({ title: 'Failed check', status: 'failed', exitCode: 9 }),
    expect.objectContaining({ title: 'Finished process', status: 'succeeded', exitCode: 0 }),
    expect.objectContaining({ proposalId: 'candidate-1', verdict: 'incorrect', exactQuote: true }),
  ]))
  expect(reviewPrompt(window)).not.toContain('arbitraryPayload')
  expect(prompt.evidence.filter((record: { origin: string }) => record.origin === 'human-turn')).toHaveLength(1)
})

it('persists policy choices and reviews feedback without inventing another human turn', async () => {
  const store = await fixture(); await human(store, 1); await review(store, 'fact')
  let snapshot = await store.store.read(), candidate = snapshot.records.find(r => r.kind === 'proposal')!
  snapshot = await store.change(scope, 'approve', { id: candidate.id, version: candidate.version }); candidate = snapshot.records.find(r => r.id === candidate.id)!
  await store.change(scope, 'record-feedback', { id: candidate.id, version: candidate.version, verdict: 'helpful', quote: 'This convention helped the review.', eventKey: 'explicit-feedback' })
  const runner = new LearningRunner(store, { complete: async (_scope, window) => JSON.stringify({ token: window.token, summary: 'Reviewed the explicit feedback.', proposals: [] }) })
  try { await runner.queue(scope, (await store.store.read()).revision); await runner.idle() } finally { await runner.dispose() }
  expect((await store.store.read()).records.find(r => r.kind === 'cycle')?.data).toMatchObject({ rounds: 1, completedRound: 1, feedback: 1, completedFeedback: 1 })
  await store.change(scope, 'configure', { settings: { captureFeedback: false, autoAcceptFacts: true } })
  expect(await new LearningStore(store.store.directory).policy()).toMatchObject({ captureFeedback: false, autoAcceptFacts: true, autoAcceptPreferences: false })
})

it('does not accept evidence that was removed from the bounded model review', async () => {
  const store = await fixture()
  for (let turn = 1; turn <= 30; turn++) await human(store, turn, 'Long conversation evidence. '.repeat(240))
  const window = learningWindow(await store.store.read(), scope)!, oldest = window.evidence[0]!
  const runner = new LearningRunner(store, { complete: async (_scope, inspected) => {
    expect(inspected.evidence.some(record => record.id === oldest.id)).toBe(false)
    return JSON.stringify({ token: inspected.token, summary: 'Attempted to use omitted evidence', proposals: [{ category: 'fact', title: 'Uninspected fact', content: 'Unsupported fact', scope: 'project', evidenceIds: [oldest.id] }] })
  } })
  try {
    await runner.queue(scope, (await store.store.read()).revision); await runner.idle()
    const records = (await store.store.read()).records
    expect(records.find(record => record.kind === 'cycle')?.data).toMatchObject({ completedRound: 0, status: 'failed' })
    expect(records.some(record => record.kind === 'proposal')).toBe(false)
  } finally { await runner.dispose() }
})

it('does not invalidate its own management snapshots and follows a linked replacement state', async () => {
  const store = await fixture(); await human(store, 1); await review(store, 'fact')
  let snapshot = await store.store.read(), candidate = snapshot.records.find(record => record.kind === 'proposal')!
  snapshot = await store.change(scope, 'approve', { id: candidate.id, version: candidate.version }); candidate = snapshot.records.find(record => record.id === candidate.id)!
  const event = { id: 'operator-approval', occurredAt: new Date().toISOString(), scope, sourceInstanceKey: 'source:learning', sourceTypeId: 'learning', operation: 'approve', kind: 'management' as const, actor: 'operator' as const, recordIds: [candidate.id] }
  await store.operation(event, 'source:learning')
  expect((await store.store.read()).revision).toBe(snapshot.revision)
  await store.change(scope, 'link-destination', { id: candidate.id, version: candidate.version, sourceInstanceKey: 'source:notes', learningSourceInstanceKey: 'source:learning', recordId: 'old-note', destinationState: 'active' })
  await store.operation({ ...event, id: 'replacement', sourceInstanceKey: 'source:notes', sourceTypeId: 'project-context', recordIds: ['new-note', 'old-note'], records: [{ id: 'new-note', state: 'active', revision: '2' }, { id: 'old-note', state: 'archived', revision: '3' }] }, 'source:learning')
  expect((await store.store.read()).records.find(record => record.id === candidate.id)?.data).toMatchObject({ destinationState: 'archived', destinationRevision: '3' })
})
it('never partly approves a batch containing an ineligible preference', async () => {
  const store = await fixture(); await human(store, 1)
  const window = learningWindow(await store.store.read(), scope)!
  await store.complete(scope, { token: window.token, summary: 'Review two observations', proposals: [
    { category: 'fact', title: 'Build command', content: 'Use pnpm verify for checks.', scope: 'project', evidenceIds: [window.evidence[0]!.id] },
    { category: 'preference', title: 'Response format', content: 'Prefer concise responses.', scope: 'global', evidenceIds: [window.evidence[0]!.id] },
  ] }, window)
  const snapshot = await store.store.read(), candidates = snapshot.records.filter(record => record.kind === 'proposal')
  await expect(store.change(scope, 'batch-approve', { recordIds: candidates.map(record => record.id), versions: Object.fromEntries(candidates.map(record => [record.id, record.version])) })).rejects.toThrow('two independent')
  expect((await store.store.read()).revision).toBe(snapshot.revision)
})
