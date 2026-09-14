import { randomUUID } from 'node:crypto'
import type { MemoryJsonValue, MemoryOperationScope } from 'dsh-mnemon/contracts'
import { digest, newRecord, RecordStore, reviseRecord, visibleRecord, type RecordValue } from 'dsh-mnemon/source-sdk'
import type { VisibleMessage } from 'dsh-mnemon-workspace-kit/dsh'
export const severities = ['info', 'nit', 'concern', 'blocker'] as const
export interface ReviewResult { severity: typeof severities[number]; summary: string; issues: Array<{ severity: typeof severities[number]; text: string }>; proposals: Array<{ kind: 'fact' | 'decision'; title: string; content: string }>; skill?: { title: string; content: string; slug: string } }
export interface ReviewPort {
  transcript(scope: MemoryOperationScope, signal: AbortSignal): Promise<{ messages: VisibleMessage[]; truncated: boolean }>
  complete(input: { scope: MemoryOperationScope; reviewerId: string; prompt: string; history: Array<{ prompt: string; answer: string }>; signal: AbortSignal }): Promise<string>
  completed?(scope: MemoryOperationScope, reviewId: string, result: ReviewResult): void
  deliver?(scope: MemoryOperationScope, text: string, signal: AbortSignal): Promise<void>
}
export function parseReview(text: string): ReviewResult {
  let parsed: unknown
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) } catch { throw new Error('The reviewer did not return a structured result; inspect the retained response') }
  const value = parsed as ReviewResult
  if (!value || !severities.includes(value.severity) || typeof value.summary !== 'string' || value.summary.length > 4000 || !Array.isArray(value.issues) || value.issues.length > 12 || value.issues.some(issue => !issue || !severities.includes(issue.severity) || typeof issue.text !== 'string' || issue.text.length > 2000)) throw new Error('Invalid review severity or findings')
  if (!Array.isArray(value.proposals) || value.proposals.length > 2 || value.proposals.some(proposal => !['fact', 'decision'].includes(proposal.kind) || typeof proposal.title !== 'string' || !proposal.title.trim() || proposal.title.length > 300 || typeof proposal.content !== 'string' || proposal.content.length > 4000)) throw new Error('A review permits at most two bounded durable proposals')
  if (value.skill && (typeof value.skill.title !== 'string' || value.skill.title.length > 300 || typeof value.skill.content !== 'string' || value.skill.content.length > 8000 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.skill.slug))) throw new Error('Invalid reusable skill proposal')
  return value
}
export async function countReviewRound(store: RecordStore, scope: MemoryOperationScope, turn: number, interval: number, signal?: AbortSignal): Promise<void> {
  await store.change(undefined, records => {
    let cycle = records.find(record => record.kind === 'cycle' && visibleRecord(record, scope))
    if (!cycle) { cycle = newRecord('cycle', 'Session review', '', 'session', scope, { interval, rounds: 0, completedRound: 0, lastTurn: -1, due: false, enabled: true, automatic: false, notify: true, reviewerId: randomUUID(), lastAutoCycle: -1, status: 'idle' }); records.push(cycle) }
    if (cycle.data.lastTurn === turn || cycle.data.enabled === false) return
    reviseRecord(cycle, 'user-round'); cycle.data.lastTurn = turn; cycle.data.rounds = Number(cycle.data.rounds) + 1
    if (Number(cycle.data.rounds) - Number(cycle.data.completedRound) >= Number(cycle.data.interval)) cycle.data.due = true
  }, signal)
}
export function completeReviewCycle(records: RecordValue[], scope: MemoryOperationScope, id: string): void {
  const cycle = records.find(record => record.id === id && record.kind === 'cycle' && visibleRecord(record, scope))
  const review = records.find(record => record.id === cycle?.data.lastReviewId && record.kind === 'review' && record.data.status === 'completed' && visibleRecord(record, scope))
  const throughRound = Number(review?.data.throughRound ?? -1)
  if (!cycle || !review || throughRound <= Number(cycle.data.completedRound)) throw new Error('Run the independent review before completing this cycle')
  reviseRecord(cycle, 'complete-cycle'); cycle.data.completedRound = Math.min(Number(cycle.data.rounds), throughRound); cycle.data.due = Number(cycle.data.rounds) - Number(cycle.data.completedRound) >= Number(cycle.data.interval)
}
export class ReviewEngine {
  readonly store: RecordStore
  private running = new Map<string, { promise: Promise<void>; controller: AbortController }>()
  private closed = false
  constructor(directory: string, readonly port: ReviewPort) { this.store = new RecordStore(directory) }
  async queue(scope: MemoryOperationScope, question = '', automatic = false, signal?: AbortSignal, revision?: string): Promise<string> {
    signal?.throwIfAborted()
    if (this.closed || !scope.sessionId) throw new Error('A live review Source and session are required')
    if (this.running.has(scope.sessionId)) throw new Error('A review is already running for this session')
    if (this.running.size >= 4) throw new Error('Review concurrency capacity reached')
    const controller = new AbortController(), id = randomUUID()
    let resolveTask!: () => void
    const promise = new Promise<void>(resolve => { resolveTask = resolve })
    this.running.set(scope.sessionId, { promise, controller })
    try {
      await this.store.change(revision, records => {
        const cycle = records.find(record => record.kind === 'cycle' && visibleRecord(record, scope))
        if (!cycle || cycle.data.enabled === false) throw new Error('Enable the session review first')
        if (cycle.data.status === 'running') {
          let alive = false
          try { process.kill(Number(cycle.data.ownerPid), 0); alive = true } catch {}
          if (alive) throw new Error('A review is already running for this session')
        }
        if (automatic && (!cycle.data.due || cycle.data.automatic !== true || cycle.data.lastAutoCycle === cycle.data.completedRound)) throw new Error('No automatic review is due')
        reviseRecord(cycle, 'review-queued'); cycle.data.status = 'running'; cycle.data.runId = id; cycle.data.ownerPid = process.pid
        if (automatic) cycle.data.lastAutoCycle = Number(cycle.data.completedRound)
      }, signal)
      if (this.closed) controller.abort(new Error('Review Source unloaded'))
      void this.run(id, scope, question, controller.signal).finally(() => { this.running.delete(scope.sessionId!); resolveTask() })
      return id
    } catch (error) { this.running.delete(scope.sessionId); resolveTask(); throw error }
  }
  private async run(id: string, scope: MemoryOperationScope, question: string, lifetime: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(120_000), signal = AbortSignal.any([lifetime, timeout])
    let raw = '', prompt = ''
    try {
      const snapshot = await this.store.read(signal), cycle = snapshot.records.find(record => record.kind === 'cycle' && visibleRecord(record, scope))!
      const constraints = snapshot.records.filter(record => record.kind === 'constraint' && record.state === 'active' && record.data.enabled !== false && visibleRecord(record, scope)).sort((a, b) => ['global', 'project', 'session'].indexOf(a.scope) - ['global', 'project', 'session'].indexOf(b.scope))
      const transcript = await this.port.transcript(scope, signal)
      const lines = transcript.messages.map(message => `[${message.role} #${message.seq}] ${message.text}`).join('\n\n')
      prompt = `Visible conversation${transcript.truncated ? ' (bounded excerpt)' : ''}:\n${lines}\n\nReview constraints:\n${constraints.map(record => `[${record.scope}] ${record.title}: ${record.content}`).join('\n').slice(0, 12000)}\n\nUser question for the reviewer: ${question.slice(0, 4000) || 'Review the latest visible conversation.'}`
      const history = snapshot.records.filter(record => record.kind === 'review' && record.data.reviewerId === cycle.data.reviewerId && visibleRecord(record, scope) && record.data.status === 'completed').slice(-4).map(record => ({ prompt: String(record.data.question ?? '').slice(0, 2000), answer: record.content.slice(0, 4000) }))
      raw = await this.port.complete({ scope, reviewerId: String(cycle.data.reviewerId), prompt, history, signal }); signal.throwIfAborted()
      const result = parseReview(raw)
      let completedReviewId = ''
      await this.store.change(undefined, records => {
        const current = records.find(record => record.id === cycle.id)!
        if (current.data.runId !== id || current.data.reviewerId !== cycle.data.reviewerId) throw new Error('Review was reset before its result arrived')
        const review = newRecord('review', result.summary.slice(0, 150) || 'Conversation review', result.summary + '\n' + result.issues.map(issue => `[${issue.severity}] ${issue.text}`).join('\n'), 'session', scope, { status: 'completed', throughRound: Number(cycle.data.rounds), reviewerId: String(cycle.data.reviewerId), runId: id, severity: result.severity, result: JSON.parse(JSON.stringify(result)) as MemoryJsonValue, question, raw: raw.slice(0, 20000), transcriptDigest: digest(lines), transcriptLastSeq: transcript.messages.at(-1)?.seq ?? 0, truncated: transcript.truncated })
        records.push(review); completedReviewId = review.id; reviseRecord(current, 'review-completed'); current.data.status = 'idle'; current.data.lastReviewId = review.id
      }, signal)
      // Optional observers cannot invalidate a persisted review.
      try { this.port.completed?.(scope, completedReviewId, result) } catch {}
      if (cycle.data.notify !== false && this.port.deliver) await this.port.deliver(scope, `Conversation reviewer · ${result.severity}\n${result.summary}\n${result.issues.map(issue => `[${issue.severity}] ${issue.text}`).join('\n')}\nReview ${id}. Suggestions require explicit approval.`, signal)
    } catch (error) {
      try { await this.store.change(undefined, records => {
        const cycle = records.find(record => record.kind === 'cycle' && visibleRecord(record, scope))
        if (cycle?.data.runId === id) { reviseRecord(cycle, 'review-failed'); cycle.data.status = 'failed'; cycle.data.error = String(error).slice(0, 2000) }
        records.push(newRecord('review', 'Review did not complete', raw.slice(0, 20000), 'session', scope, { status: 'failed', runId: id, error: String(error).slice(0, 2000) }))
      }) } catch { /* The request remains incomplete when persistence fails. */ }
    }
  }
  async reset(scope: MemoryOperationScope, revision?: string): Promise<void> {
    await this.store.change(revision, records => { const cycle = records.find(record => record.kind === 'cycle' && visibleRecord(record, scope)); if (!cycle) throw new Error('Review cycle not found'); reviseRecord(cycle, 'reset'); cycle.data.reviewerId = randomUUID(); cycle.data.status = 'idle'; cycle.data.lastAutoCycle = -1; delete cycle.data.error; delete cycle.data.runId })
    const active = this.running.get(scope.sessionId ?? '')
    active?.controller.abort(new Error('Review session reset')); await active?.promise

  }
  async dispose(): Promise<void> { this.closed = true; for (const task of this.running.values()) task.controller.abort(new Error('Review Source unloaded')); await Promise.allSettled([...this.running.values()].map(task => task.promise)) }
}
