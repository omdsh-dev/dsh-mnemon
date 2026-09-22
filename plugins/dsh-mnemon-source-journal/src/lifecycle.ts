import type {} from '@deepseek-ai/dsh-command-feedback'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { newRecord, RecordStore, type RecordValue } from 'dsh-mnemon/source-sdk'
import { type WorkspaceActivity } from 'dsh-mnemon-workspace-kit'
import { agentMemoryScope, visibleMessages } from 'dsh-mnemon-workspace-kit/dsh'
import { sourceOptions } from './source.ts'
export interface JournalCaptureConfig { captureTurns?: boolean; captureFeedback?: boolean; captureJobResults?: boolean }
export async function captureJournalEvent(store: RecordStore, agent: Agent, event: SessionEvent, config: JournalCaptureConfig, signal?: AbortSignal): Promise<boolean> {
  if (!agent.session.header.cwd || agent.session.header.origin === 'subagent') return false
  const scope = agentMemoryScope(agent), key = `${scope.sessionId}:${event.seq}:${event.type}`
  let record: RecordValue | undefined
  if (event.type === 'feedback/record' && config.captureFeedback !== false) {
    // Recent DSH versions also record category-only feedback. A journal quote
    // requires actual user text; the native event remains the category record.
    if (!event.data.text?.trim()) return false
    record = newRecord('feedback', 'Session feedback', event.data.text.slice(0, 30_000), 'project', scope, { sentiment: 'neutral', category: 'explicit-feedback', eventKey: key, sessionId: scope.sessionId!, seq: Number(event.seq), exactQuote: event.data.text.length <= 30_000, truncated: event.data.text.length > 30_000 })
  } else if (event.type === 'turn/end' && config.captureTurns === true) {
    const events = agent.session.ownEvents(), start = events.findLastIndex(value => value.type === 'turn/start' && value.data.turn === event.data.turn)
    const messages = visibleMessages(events.slice(Math.max(start, 0)).filter(value => value.seq <= event.seq), 30_000)
    if (!messages.messages.some(message => message.role === 'user')) return false
    record = newRecord('result', `Conversation turn ${event.data.turn}`, messages.messages.map(message => `[${message.role} #${message.seq}] ${message.text}`).join('\n\n').slice(0, 30_000), 'project', scope, { category: 'conversation', eventKey: key, sessionId: scope.sessionId!, turn: event.data.turn, truncated: messages.truncated })
  }
  if (!record) return false
  await sourceOptions.prepare?.(record, scope)
  record.data.eventAt = new Date(event.time).toISOString()
  let captured = false
  await store.change(undefined, records => { if (!records.some(value => value.data.eventKey === key)) { records.push(record!); captured = true } }, signal)
  return captured
}

/** Consume durable facts without calling or importing the publishing Source. */
export async function captureWorkspaceActivity(store: RecordStore, activity: Readonly<WorkspaceActivity>, config: JournalCaptureConfig, signal?: AbortSignal): Promise<boolean> {
  if (config.captureJobResults !== true || activity.kind !== 'job-completed') return false
  signal?.throwIfAborted()
  const rows: RecordValue[] = []
  for (const target of activity.scope.workspaceId ? ['project', 'daily'] as const : ['daily'] as const) {
    const eventKey = `${activity.sourceInstanceKey}:${activity.eventKey}:${target}`
    const record = newRecord('result', activity.title.slice(0, 300), activity.summary.slice(0, 30_000), target, activity.scope, {
      category: 'background-job', eventKey, sourceInstanceKey: activity.sourceInstanceKey, recordId: activity.recordId ?? '', level: activity.level, eventAt: new Date().toISOString(), truncated: activity.summary.length > 30_000,
    })
    await sourceOptions.prepare?.(record, activity.scope); sourceOptions.validate(record); rows.push(record)
  }
  let captured = false
  await store.change(undefined, records => { for (const row of rows) if (!records.some(record => record.data.eventKey === row.data.eventKey)) { records.push(row); captured = true } }, signal)
  return captured
}
