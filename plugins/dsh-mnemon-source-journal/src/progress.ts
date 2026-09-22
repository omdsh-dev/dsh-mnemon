import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { digest, newRecord, RecordStore } from 'dsh-mnemon/source-sdk'
import { agentMemoryScope, visibleMessages } from 'dsh-mnemon-workspace-kit/dsh'

/** Source-owned durable accounting. The Strategy receives a due hint, never write authority. */
export class JournalProgress {
  constructor(readonly store: RecordStore, readonly threshold: number) {}
  async status(scope: MemoryOperationScope, signal?: AbortSignal) {
    const record = (await this.store.read(signal)).records.find(value => value.id === digest([scope.workspaceId, scope.sessionId]))
    const gap = Number(record?.data.gap ?? 0)
    return { enabled: this.threshold > 0, threshold: this.threshold, gap, due: this.threshold > 0 && gap >= this.threshold }
  }
  async written(scope: MemoryOperationScope, signal?: AbortSignal) {
    if (!this.threshold || !scope.sessionId || !scope.workspaceId) return
    await this.update(scope, data => { data.gap = 0; data.writtenAt = Date.now() }, signal)
  }
  async completed(agent: Agent, event: SessionEvent, signal?: AbortSignal) {
    if (!this.threshold || event.type !== 'turn/end' || !agent.session.header.cwd || agent.session.header.origin === 'subagent') return
    const events = agent.session.ownEvents(), start = events.findLastIndex(value => value.type === 'turn/start' && value.data.turn === event.data.turn), round = events.slice(Math.max(0, start)).filter(value => value.seq <= event.seq)
    if (!visibleMessages(round).messages.some(message => message.role === 'user')) return
    await this.update(agentMemoryScope(agent), data => {
      if (Number(data.lastSeq ?? -1) >= event.seq) return
      data.lastSeq = Number(event.seq)
      data.gap = Number(data.writtenAt ?? 0) >= (round[0]?.time ?? event.time) ? 0 : Math.min(1000000, Number(data.gap ?? 0) + 1)
    }, signal)
  }
  private async update(scope: MemoryOperationScope, change: (data: Record<string, import('dsh-mnemon/contracts').MemoryJsonValue>) => void, signal?: AbortSignal) {
    const id = digest([scope.workspaceId, scope.sessionId])
    await this.store.change(undefined, records => {
      let record = records.find(value => value.id === id)
      if (!record) { record = newRecord('progress-state', 'Journal progress', '', 'session', scope, { gap: 0 }); record.id = id; records.push(record) }
      change(record.data); record.updatedAt = new Date().toISOString()
    }, signal)
  }
}
