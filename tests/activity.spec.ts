import { describe, expect, it } from 'vitest'
import { TurnActivityProjection } from "../src/host/activity.ts"
import type { HostSessionEvent } from "../src/host/dsh.ts"

function call(seq: number, turn: number, callId: string, name: string): HostSessionEvent {
  return { type: 'tool/call', seq, data: { turn, step: 1, callId, name, arguments: '{}' } }
}

function result(seq: number, turn: number, callId: string, failed = false): HostSessionEvent {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn,
      step: 1,
      message: { source: { callId } },
      ...(failed ? { error: { name: 'Error', code: 'failed' } } : {}),
    },
  }
}

describe('TurnActivityProjection', () => {
  it('counts only settled successes by semantic category and reports failures separately', () => {
    const projection = new TurnActivityProjection()
    const events = [
      call(1, 1, 'recall', 'mnemon_recall'), result(2, 1, 'recall'),
      call(3, 1, 'documents', 'mnemon_document_search'), result(4, 1, 'documents'),
      call(5, 1, 'write-failed', 'mnemon_remember'), result(6, 1, 'write-failed', true),
      call(7, 1, 'status', 'mnemon_status'), result(8, 1, 'status'),
      call(9, 1, 'write-pending', 'mnemon_runtime_memory'),
    ]

    expect(projection.snapshot(events)).toEqual({
      cursor: 9,
      activities: [{
        turn: 1,
        count: 4,
        names: ['mnemon_recall', 'mnemon_document_search', 'mnemon_remember', 'mnemon_status'],
        recalls: 1,
        writes: 0,
        documentSearches: 1,
        inspections: 1,
        failures: 1,
      }],
    })

    events.push(result(10, 1, 'write-pending'))
    expect(projection.snapshot(events).activities[0]).toMatchObject({ count: 5, writes: 1, failures: 1 })
    expect(projection.snapshot(events).activities[0]).toMatchObject({ count: 5, writes: 1, failures: 1 })
  })

  it('resets when the durable event log is replaced by a shorter session', () => {
    const projection = new TurnActivityProjection()
    projection.snapshot([call(1, 1, 'first', 'mnemon_recall'), result(2, 1, 'first')])

    expect(projection.snapshot([call(1, 2, 'second', 'mnemon_status')])).toEqual({ cursor: 1, activities: [] })
  })
})
