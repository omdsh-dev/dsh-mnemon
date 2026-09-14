import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { newRecord, RecordStore, reviseRecord, visibleRecord } from 'dsh-mnemon/source-sdk'
import { type WorkspaceActivity } from 'dsh-mnemon-workspace-kit'
import { members } from './rooms.ts'
import { declareResource, releaseOwnedResources, writeConflicts, type ProjectFile } from './resources.ts'

export interface CoordinationHooks {
  beforeWrite(file: ProjectFile, scope: MemoryOperationScope, signal?: AbortSignal): Promise<void>
  written(file: ProjectFile, scope: MemoryOperationScope): void
  presence(scope: MemoryOperationScope, status: string): void
  disposed(scope: MemoryOperationScope): void
}
export interface CoordinationConfig { writeConflictPolicy?: 'off' | 'warn' | 'deny'; captureWrites?: boolean; notifyPresence?: boolean }
export interface CoordinationPort {
  subscribe?(hooks: CoordinationHooks): () => void
  warning?(scope: MemoryOperationScope, text: string, signal?: AbortSignal): Promise<void>
  activity?(activity: WorkspaceActivity): void
}
/** One Source owns its ledger and guards. Notifications consume committed facts only. */
export class Coordination {
  private queue = Promise.resolve()
  private readonly controller = new AbortController()
  private readonly stop: (() => void) | undefined
  lastError = ''
  constructor(readonly store: RecordStore, readonly config: CoordinationConfig, readonly port: CoordinationPort, readonly sourceInstanceKey: string) {
    this.stop = port.subscribe?.({
      beforeWrite: (file, scope, signal) => this.beforeWrite(file, scope, signal),
      written: (file, scope) => this.enqueue(() => this.written(file, scope)),
      presence: (scope, status) => this.enqueue(() => this.presence(scope, status)),
      disposed: scope => this.enqueue(async () => { await this.store.change(undefined, records => releaseOwnedResources(records, scope), this.controller.signal); await this.presence(scope, 'closed') }),
    })
  }
  private enqueue(action: () => Promise<void>) {
    if (this.controller.signal.aborted) return
    this.queue = this.queue.then(action).catch(error => { if (!this.controller.signal.aborted) this.lastError = String(error).slice(0, 1000) })
  }
  async beforeWrite(file: ProjectFile, scope: MemoryOperationScope, signal?: AbortSignal) {
    if (!scope.workspaceId || !scope.sessionId || this.config.writeConflictPolicy === 'off') return
    await this.queue
    const conflicts = writeConflicts((await this.store.read(signal)).records, file, scope)
    if (!conflicts.length) return
    const text = 'Shared file conflict: ' + file.path + '\nDeclared or reserved by: ' + [...new Set(conflicts.map(record => String(record.data.owner)))].join(', ')
    if (this.config.writeConflictPolicy === 'deny') throw new Error(text + '\nAsk the owner to release it before writing.')
    await this.port.warning?.(scope, text, signal)
    this.port.activity?.({ eventKey: 'conflict/' + crypto.randomUUID(), sourceInstanceKey: this.sourceInstanceKey, scope, kind: 'collaboration-conflict', title: 'Shared file conflict', summary: text, level: 'warning' })
  }
  async written(file: ProjectFile, scope: MemoryOperationScope) {
    if (this.config.captureWrites === false || !scope.workspaceId || !scope.sessionId) return
    await this.store.change(undefined, records => {
      for (const room of records.filter(record => record.kind === 'room' && record.state === 'active' && visibleRecord(record, scope) && record.data.status === 'open' && members(record).includes(scope.sessionId!)))
        declareResource(records, { id: room.id, resourceType: 'file' }, scope, file, true)
    }, this.controller.signal)
  }
  async presence(scope: MemoryOperationScope, status: string) {
    if (!scope.workspaceId || !scope.sessionId) return
    const events: WorkspaceActivity[] = []
    await this.store.change(undefined, records => {
      for (const room of records.filter(record => record.kind === 'room' && record.state === 'active' && visibleRecord(record, scope) && members(record).includes(scope.sessionId!))) {
        let record = records.find(record => record.kind === 'presence' && record.data.roomId === room.id && record.data.owner === scope.sessionId && visibleRecord(record, scope))
        if (record?.data.status === status) continue
        if (record) { reviseRecord(record, 'presence-changed'); record.data.status = status }
        else { record = newRecord('presence', 'Session presence', '', 'project', scope, { roomId: room.id, owner: scope.sessionId!, status }); records.push(record) }
        events.push({ eventKey: record.id + '/' + record.version, sourceInstanceKey: this.sourceInstanceKey, scope, kind: 'collaboration-presence', title: room.title + ': member ' + status, summary: 'Session ' + scope.sessionId + ' is ' + status + '.', level: 'info', recordId: record.id })
      }
    }, this.controller.signal)
    if (this.config.notifyPresence !== false) for (const event of events) this.port.activity?.(event)
  }
  async flush() { await this.queue }
  async dispose() { this.stop?.(); await this.queue; this.controller.abort(new Error('Collaboration Source unloaded')) }
}
