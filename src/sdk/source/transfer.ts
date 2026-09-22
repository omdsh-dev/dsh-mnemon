import { MEMORY_TRANSFER_FORMAT, type MemoryJsonValue, type MemoryOperationScope, type MemoryTransferSnapshot, type MemoryTransferTrack } from '../../core/contracts/index.ts'
import { digest, json, recordScope, reviseRecord, validateRecord, visibleRecord, type RecordValue } from './records.ts'

export function recordTransferTracks(scopes: readonly string[]): MemoryTransferTrack[] {
  return scopes.filter(scope => scope !== 'session').map(id => ({ id, scope: id === 'project' ? 'project' : 'global', label: { en: id === 'project' ? 'Project records' : id === 'daily' ? 'Daily records' : 'Global records', 'zh-CN': id === 'project' ? '项目记录' : id === 'daily' ? '每日记录' : '全局记录' } }))
}
function payload(record: RecordValue): MemoryJsonValue {
  const { id: _id, workspaceId: _workspace, sessionId: _session, updatedAt: _updated, version: _version, history: _history, ...value } = record
  return json(value)
}
export function exportRecordTrack(records: RecordValue[], track: string, scope: MemoryOperationScope): MemoryTransferSnapshot {
  return { format: MEMORY_TRANSFER_FORMAT, track, entries: records.filter(record => record.scope === track && visibleRecord(record, scope)).map(record => ({ id: record.id, value: payload(record) })).sort((a, b) => a.id.localeCompare(b.id)) }
}
export function importRecordTrack(records: RecordValue[], raw: unknown, tracks: MemoryTransferTrack[], scope: MemoryOperationScope, validate: (record: RecordValue) => void): void {
  const value = raw as MemoryTransferSnapshot
  if (!value || value.format !== MEMORY_TRANSFER_FORMAT || !tracks.some(track => track.id === value.track) || !Array.isArray(value.entries) || value.entries.length > 10000) throw new Error('Unsupported transfer snapshot')
  const ids = new Set<string>()
  for (const entry of value.entries) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) throw new Error('Invalid or duplicate transfer entry')
    ids.add(entry.id)
    const data = structuredClone(entry.value) as Record<string, MemoryJsonValue>
    if (data.scope !== value.track || ['workspaceId', 'sessionId', 'id', 'version', 'history', 'updatedAt'].some(key => key in data)) throw new Error('Portable records cannot set local authority or history')
    const incoming: unknown = { ...data, id: entry.id, ...recordScope(value.track as RecordValue['scope'], scope, typeof data.date === 'string' ? data.date : undefined), version: 1, history: [], updatedAt: new Date().toISOString() }
    validateRecord(incoming); validate(incoming)
    const existing = records.find(record => record.id === entry.id)
    if (existing && (existing.scope !== value.track || !visibleRecord(existing, scope))) throw new Error('Imported id belongs to another scope')
    if (!existing) records.push(incoming)
    else if (digest(payload(existing)) !== digest(entry.value)) { reviseRecord(existing, 'transfer-import'); Object.assign(existing, incoming, { version: existing.version, history: existing.history, updatedAt: existing.updatedAt }) }
  }
  // Collections carry explicit deleted/rejected states. Absence is not a delete
  // command: an incomplete remote snapshot cannot erase a local record.
}
