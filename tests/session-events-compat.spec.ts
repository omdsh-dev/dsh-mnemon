import { describe, expect, it } from 'vitest'
import { openAgentTurn } from '../src/host/agent-memory-turn.ts'
import type { HostAgent, HostSession, HostSessionEvent } from '../src/host/dsh.ts'
import { hostSessionEventAt, hostSessionEvents } from '../src/host/session-events.ts'

const turnStart: HostSessionEvent = { type: 'turn/start', seq: 0, data: { turn: 1 } }

const generations = [
  {
    name: 'stable 0.1.1-rc.2 events[]',
    create(): HostSession {
      return { events: [turnStart] }
    },
  },
  {
    name: 'reported 0.1.2-alpha.4 snapshotEvents()',
    create(): HostSession {
      const events = [turnStart]
      return {
        snapshotEvents: () => events,
        eventAt: seq => events[seq],
      }
    },
  },
  {
    name: 'latest 0.1.2-alpha.5 snapshotEvents()',
    create(): HostSession {
      const events = [turnStart]
      return {
        snapshotEvents: () => events,
        eventAt: seq => events[seq],
      }
    },
  },
] as const

describe.each(generations)('DSH Session compatibility: $name', ({ create }) => {
  it('reads complete and indexed durable history', () => {
    const session = create()

    expect(hostSessionEvents(session)).toEqual([
      expect.objectContaining({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
    ])
    expect(hostSessionEventAt(session, 0)).toEqual(
      expect.objectContaining({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
    )
    expect(hostSessionEventAt(session, 1)).toBeUndefined()
    expect(openAgentTurn({ session } as HostAgent)).toBe(1)
  })
})

describe('unsupported DSH Session compatibility', () => {
  it('fails explicitly instead of silently dropping durable history', () => {
    expect(() => hostSessionEvents({})).toThrow('expected snapshotEvents() or events[]')
  })
})
