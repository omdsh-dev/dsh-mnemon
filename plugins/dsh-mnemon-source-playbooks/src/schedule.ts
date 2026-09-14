import type { MemoryJsonValue, MemoryOperationScope } from 'dsh-mnemon/contracts'
import { newRecord, RecordStore, reviseRecord, visibleRecord, type RecordValue } from 'dsh-mnemon/source-sdk'
export function renderPrompt(content: string, variables: Record<string, MemoryJsonValue>, scope: MemoryOperationScope): string {
  const timestamp = new Date().toISOString()
  const values = { ...variables, date: timestamp.slice(0, 10), time: timestamp.slice(11, 19) + 'Z', workspace: scope.workspaceId ?? '', session: scope.sessionId ?? '' }
  const rendered = content.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_whole, name: string) => {
    const value = values[name as keyof typeof values]
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('Missing prompt variable: ' + name)
    return String(value)
  })
  if (!rendered.trim() || rendered.length > 30_000) throw new Error('Rendered prompts must contain 1–30000 characters')
  return rendered
}
export function makeSchedule(book: RecordValue, scope: MemoryOperationScope, options: { variables: Record<string, MemoryJsonValue>; count: number; interval: number; startAfter: number }): RecordValue {
  if (book.kind === 'schedule' || book.state !== 'active' || !visibleRecord(book, scope) || book.data.enabled === false || !scope.sessionId) throw new Error('An enabled, approved playbook and a current session are required')
  for (const [key, minimum] of [['count', 0], ['interval', 0], ['startAfter', 1]] as const) if (!Number.isInteger(options[key]) || options[key] < minimum || options[key] > 1000) throw new Error('Invalid schedule count or interval')
  if (options.interval === 0) options = { ...options, count: 1, interval: 1 }
  return newRecord('schedule', book.title, renderPrompt(book.content, options.variables, scope), 'session', scope, { template: book.content, variables: options.variables, bookId: book.id, bookVersion: book.version, enabled: true, status: 'scheduled', remaining: options.count, continuous: options.count === 0, interval: options.interval, next: options.startAfter, rounds: 0, uses: 0, lastTurn: -1 })
}
/** Reserve each invocation durably before it enters a DSH step; never replay a consumed reservation. */
export async function advanceSchedules(store: RecordStore, scope: MemoryOperationScope, turn: number, signal?: AbortSignal): Promise<Array<{ id: string; title: string; text: string }>> {
  const due: Array<{ id: string; title: string; text: string }> = []
  const current = await store.read(signal)
  if (!current.records.some(record => record.kind === 'schedule' && visibleRecord(record, scope) && record.state === 'active' && record.data.status === 'scheduled' && record.data.lastTurn !== turn)) return due
  await store.change(undefined, records => {
    for (const record of records) {
      if (record.kind !== 'schedule' || !visibleRecord(record, scope) || record.state !== 'active' || record.data.status !== 'scheduled' || record.data.lastTurn === turn) continue
      const book = records.find(value => value.id === record.data.bookId && visibleRecord(value, scope))
      reviseRecord(record, 'advance'); record.data.lastTurn = turn
      if (!book || book.state !== 'active' || book.data.enabled === false) { record.data.status = 'stopped'; record.data.error = 'The source playbook is disabled or unavailable'; continue }
      record.data.rounds = Number(record.data.rounds) + 1
      if (Number(record.data.rounds) < Number(record.data.next)) continue
      let text: string
      try { text = typeof record.data.template === 'string' ? renderPrompt(record.data.template, record.data.variables as Record<string, MemoryJsonValue>, scope) : record.content }
      catch { record.data.status = 'failed'; record.data.error = 'The saved prompt cannot be expanded; review its variables before creating another schedule'; continue }
      if (due.length >= 8 || due.reduce((total, value) => total + value.text.length, 0) + text.length > 40_000) { record.data.error = 'Invocation deferred by the per-turn prompt budget'; continue }
      due.push({ id: record.id, title: record.title, text })
      record.data.uses = Number(record.data.uses) + 1; record.data.lastUsedAt = new Date().toISOString(); record.data.next = Number(record.data.rounds) + Number(record.data.interval)
      if (!record.data.continuous) { record.data.remaining = Number(record.data.remaining) - 1; if (record.data.remaining === 0) record.data.status = 'completed' }
      reviseRecord(book, 'scheduled-use'); book.data.uses = Number(book.data.uses ?? 0) + 1
    }
  }, signal)
  return due
}
