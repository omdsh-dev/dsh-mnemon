import { SessionEventCursor } from './session-events.ts'
import type { HostSession, HostSessionEvent } from "./dsh.ts"
import { memoryTool, type TurnMemoryActivity, type TurnMemoryActivitySnapshot } from "./protocol.ts"
import { parseMnemonActivityMeta } from './activity-presentation.ts'

export type { TurnMemoryActivity, TurnMemoryActivitySnapshot } from "./protocol.ts"

interface PendingCall {
  turn: number
  name: string
}

/**
 * The counter a settled call adds to: a named tool's write, inspection, or read, a read of
 * Documents being a document search. The generic View tools and other tools count only by name.
 */
function counter(name: string): 'recalls' | 'writes' | 'documentSearches' | 'inspections' | undefined {
  const tool = memoryTool(name)
  if (tool?.sourceTypeId === undefined) return undefined
  if (tool.kind === 'write') return 'writes'
  if (tool.kind === 'inspect') return 'inspections'
  return tool.sourceTypeId === 'documents' ? 'documentSearches' : 'recalls'
}

function eventTurn(event: HostSessionEvent): number | undefined {
  return typeof event.data.turn === 'number' ? event.data.turn : undefined
}

function resultCallId(event: HostSessionEvent): string | undefined {
  const message = event.data.message as { source?: { callId?: unknown } } | undefined
  return typeof message?.source?.callId === 'string' && message.source.callId !== '' ? message.source.callId : undefined
}

function emptyActivity(turn: number): TurnMemoryActivity {
  return { turn, count: 0, names: [], recalls: 0, writes: 0, documentSearches: 0, inspections: 0, failures: 0,
    retrieved: [], writebacks: [] }
}

/**
 * Incremental durable-log projection. Repeated UI reads process only events
 * appended since the previous snapshot instead of rescanning the full session.
 */
export class TurnActivityProjection {
  private readonly cursor = new SessionEventCursor()
  private eventCount = 0
  private lastEventSeq: number | undefined
  private readonly pending = new Map<string, PendingCall>()
  private readonly byTurn = new Map<number, TurnMemoryActivity>()

  reset(): void {
    this.eventCount = 0
    this.lastEventSeq = undefined
    this.pending.clear()
    this.byTurn.clear()
  }

  snapshot(events: readonly HostSessionEvent[]): TurnMemoryActivitySnapshot {
    const currentLastSeq = events.at(-1)?.seq
    if (events.length < this.eventCount || (events.length === this.eventCount && this.lastEventSeq !== currentLastSeq)) this.reset()

    for (let index = this.eventCount; index < events.length; index += 1) this.consume(events[index]!)
    this.eventCount = events.length
    this.lastEventSeq = currentLastSeq

    return this.result(typeof currentLastSeq === 'number' ? currentLastSeq : events.length)
  }

  snapshotSession(session: HostSession): TurnMemoryActivitySnapshot {
    return this.result(this.cursor.consume(session, event => this.consume(event), () => this.reset()))
  }

  private result(cursor: number): TurnMemoryActivitySnapshot {
    return {
      cursor,
      activities: [...this.byTurn.values()]
        .sort((left, right) => left.turn - right.turn)
        .map(activity => ({ ...activity, names: [...activity.names],
          retrieved: activity.retrieved.map(read => ({ ...read, items: read.items.map(item => ({ ...item })) })),
          writebacks: activity.writebacks.map(write => ({ ...write, item: { ...write.item } })),
        })),
    }
  }

  private consume(event: HostSessionEvent): void {
    if (event.type === 'tool/call') {
      const turn = eventTurn(event)
      const callId = event.data.callId
      const name = event.data.name
      if (turn !== undefined && typeof callId === 'string' && typeof name === 'string' && name.startsWith('mnemon_')) {
        this.pending.set(callId, { turn, name })
      }
      return
    }
    if (event.type !== 'tool/result') return
    const callId = resultCallId(event)
    if (callId === undefined) return
    const call = this.pending.get(callId)
    if (call === undefined) return
    this.pending.delete(callId)

    let activity = this.byTurn.get(call.turn)
    if (activity === undefined) {
      activity = emptyActivity(call.turn)
      this.byTurn.set(call.turn, activity)
    }
    activity.count += 1
    activity.names.push(call.name)
    if (event.data.error !== undefined) {
      activity.failures += 1
      return
    }
    const semantic = parseMnemonActivityMeta(event.data.meta, callId, call.name)
    if (semantic.read !== undefined) activity.retrieved.push(semantic.read)
    if (semantic.writeback !== undefined) activity.writebacks.push(semantic.writeback)
    const counted = counter(call.name)
    if (counted !== undefined) activity[counted] += 1
  }
}
