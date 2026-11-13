import { describe, expect, it, vi } from 'vitest'
import type { HostAgent, HostSession, HostSessionEvent } from '../src/host/dsh.ts'
import { openAgentStep, openAgentTurn } from '../src/host/agent-memory-turn.ts'
import { reviewCheckpoint } from '../src/host/review-checkpoint.ts'
import { subagentFailureDetail } from '../src/host/subagent-receipts.ts'
import { TurnActivityProjection } from '../src/host/activity.ts'
import { captureTurn, TurnSkillUseProjection } from '../src/host/skill-trajectory.ts'
import { sessionTurnEvents } from '../src/host/session-events.ts'
import { sessionLog } from './fixtures/session-log.ts'

function longSession(tail: HostSessionEvent[]): HostSession {
  const length = 46_000
  const events = new Map(tail.map((event, index) => [length - tail.length + index, { ...event, seq: length - tail.length + index }]))
  const eventAt = vi.fn((seq: number): HostSessionEvent | undefined => seq < 0 || seq >= length ? undefined
    : events.get(seq) ?? { seq, type: 'fixture/old', data: { text: 'x'.repeat(1_400) } })
  return {
    // Public DSH seq is the log length, not the last event's index.
    seq: length,
    eventAt,
    snapshotEvents: vi.fn((from?: number, to?: number) => {
      if (from === undefined || to === undefined || to - from > 256) throw new Error('unbounded session read')
      return Array.from({ length: Math.max(0, to - from) }, (_, index) => eventAt(from + index)!).filter(Boolean)
    }),
    surface: { nodes: [...events.keys()] },
  } as HostSession
}

describe('large session hot paths (issue 632)', () => {
  it('finds current turn and step without materializing the old transcript', () => {
    const session = longSession([{ type: 'turn/start', data: { turn: 400 } }, { type: 'step/start', data: { turn: 400, step: 2 } }])
    const agent = { session } as HostAgent
    expect(openAgentTurn(agent)).toBe(400)
    expect(openAgentStep(agent)).toEqual({ turn: 400, step: 2 })
    expect(vi.mocked(session.eventAt).mock.calls.length).toBeLessThan(600)
  })

  it('reads a completed visible checkpoint and the contained child error from the tail', () => {
    const session = longSession([
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember the SQLite decision.' }] } },
      { type: 'turn/end', data: { turn: 400, reason: { error: { code: 'MODEL', message: 'Synthetic failure' } } } },
    ])
    expect(reviewCheckpoint(session, 1_000)).toContain('Remember the SQLite decision.')
    expect(subagentFailureDetail({ localAgent: { session } } as never, { stopReason: 'failed' } as never)).toBe('MODEL: Synthetic failure')
    expect(vi.mocked(session.eventAt).mock.calls.length).toBeLessThan(600)
  })

  it('keeps historical receipts across pages and reads only new events on refresh', () => {
    const events: HostSessionEvent[] = Array.from({ length: 2_000 }, (_, seq) => ({ seq, type: 'fixture/padding', data: {} }))
    events[0] = { seq: 0, type: 'turn/start', data: { turn: 1 } }
    events[254] = { seq: 254, type: 'tool/call', data: { turn: 1, callId: 'memory', name: 'mnemon_remember' } }
    events[255] = { seq: 255, type: 'tool/call', data: { turn: 1, callId: 'skill', name: 'skill', arguments: { name: 'old-skill' } } }
    events[256] = { seq: 256, type: 'tool/result', data: { turn: 1, message: { source: { callId: 'memory' } } } }
    events[257] = { seq: 257, type: 'tool/result', data: { turn: 1, message: { source: { callId: 'skill' } } } }
    events[1_999] = { seq: 1_999, type: 'turn/end', data: { turn: 1 } }
    const session = { ...sessionLog(events), get seq() { return events.length } }
    const read = vi.spyOn(session, 'snapshotEvents')
    const activity = new TurnActivityProjection(), skills = new TurnSkillUseProjection()
    expect(activity.snapshotSession(session).activities).toMatchObject([{ turn: 1, count: 1, names: ['mnemon_remember'] }])
    expect(skills.snapshot(session)).toEqual([{ turn: 1, skills: [{ name: 'old-skill', by: 'model' }] }])
    expect(captureTurn(sessionTurnEvents(session, 1), 1)).toMatchObject({ toolCalls: 2, skills: ['old-skill'] })
    expect(read.mock.calls.every(([from, to]) => from !== undefined && to !== undefined && to - from <= 256)).toBe(true)
    read.mockClear()
    activity.snapshotSession(session); skills.snapshot(session)
    expect(read).not.toHaveBeenCalled()
    events.push({ seq: 2_000, type: 'turn/start', data: { turn: 2 } }, { seq: 2_001, type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'new-skill' } } })
    expect(skills.snapshot(session)).toHaveLength(2)
    expect(activity.snapshotSession(session).activities[0]?.count).toBe(1)
    expect(read.mock.calls).toEqual([[2_000, 2_002], [2_000, 2_002]])
    // Replacing/truncating a test adapter cannot leave old counters attached.
    events.splice(0)
    expect(activity.snapshotSession(session).activities).toEqual([])
    expect(skills.snapshot(session)).toEqual([])
  })

  it('does not rescan a long open turn at every tool guard or step', () => {
    const events: HostSessionEvent[] = [{ seq: 0, type: 'turn/start', data: { turn: 3 } }, { seq: 1, type: 'step/start', data: { turn: 3, step: 1 } }]
    const session = { ...sessionLog(events), get seq() { return events.length } }
    const agent = { session } as HostAgent
    expect(openAgentStep(agent)).toEqual({ turn: 3, step: 1 })
    const read = vi.spyOn(session, 'snapshotEvents')
    for (let seq = 2; seq < 5_000; seq++) events.push({ seq, type: 'fixture/padding', data: {} })
    expect(openAgentTurn(agent)).toBe(3)
    read.mockClear()
    expect(openAgentStep(agent)).toEqual({ turn: 3, step: 1 })
    expect(openAgentTurn(agent)).toBe(3)
    expect(read).not.toHaveBeenCalled()
    events.push({ seq: 5_000, type: 'step/end', data: { turn: 3, step: 1 } })
    expect(openAgentStep(agent)).toBeUndefined()
    expect(openAgentTurn(agent)).toBe(3)
    events.push({ seq: 5_001, type: 'turn/end', data: { turn: 3 } })
    expect(openAgentTurn(agent)).toBeUndefined()
    expect(read.mock.calls).toEqual([[5_000, 5_001], [5_001, 5_002]])
  })
})
