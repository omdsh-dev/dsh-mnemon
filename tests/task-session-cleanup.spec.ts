import { describe, expect, it, vi } from 'vitest'
import type { HostSession, HostSessionEvent } from '../src/host/dsh.ts'
import { archiveOrphanedIdleReviews, archiveTaskSession } from '../src/host/task-session-cleanup.ts'

function fixture(messages: Array<{ id: string; source: { kind: string } }> = []) {
  const events: HostSessionEvent[] = messages.map((message, seq) => ({ type: 'user/message', seq, data: { message } }))
  const session: HostSession = {
    seq: events.length, snapshotEvents: (from, to) => events.slice(from, to),
    eventAt: seq => events[seq], surface: { nodes: [] },
  }
  const archiveSession = vi.fn(async () => {})
  const registry = { archivedSessionIds: [] as string[], pinnedSessionIds: [] as string[], archiveSession }
  const host = { get: () => registry, agents: { get: vi.fn((): unknown => undefined) } }
  return { session, host, registry, archiveSession }
}

describe('archival of an owned completed task', () => {
  it('keeps a human takeover visible while exempting only the exact automatic review prompt', async () => {
    const f = fixture([{ id: 'review-prompt', source: { kind: 'user' } }])
    await expect(archiveTaskSession(f.host, 'task', f.session, 'review-prompt')).resolves.toBe(true)
    const continued = fixture([
      { id: 'review-prompt', source: { kind: 'user' } },
      { id: 'human-steer', source: { kind: 'user' } },
    ])
    await expect(archiveTaskSession(continued.host, 'task', continued.session, 'review-prompt')).resolves.toBe(false)
    expect(continued.archiveSession).not.toHaveBeenCalled()
  })

  it('preserves human-started roots, pinned tasks, and tasks resumed during disposal', async () => {
    const human = fixture([{ id: 'hello', source: { kind: 'user' } }])
    await expect(archiveTaskSession(human.host, 'task', human.session)).resolves.toBe(false)
    const pinned = fixture()
    pinned.registry.pinnedSessionIds.push('task')
    await expect(archiveTaskSession(pinned.host, 'task', pinned.session)).resolves.toBe(false)
    const resumed = fixture()
    resumed.host.agents.get.mockReturnValue({ id: 'task' })
    await expect(archiveTaskSession(resumed.host, 'task', resumed.session)).resolves.toBe(false)
    for (const f of [human, pinned, resumed]) expect(f.archiveSession).not.toHaveBeenCalled()
  })

  it('does not require archival support or turn an archival failure into a task failure', async () => {
    const f = fixture([{ id: 'instructions', source: { kind: 'plugin' } }])
    await expect(archiveTaskSession({}, 'task', f.session)).resolves.toBe(false)
    f.archiveSession.mockRejectedValueOnce(new Error('Host still reports activity'))
    await expect(archiveTaskSession(f.host, 'task', f.session)).resolves.toBe(false)
    await expect(archiveTaskSession(f.host, 'task', undefined)).resolves.toBe(false)
  })
})

it('repairs only proven leftover idle-review records and their blank owners', async () => {
  const ids = Array.from({ length: 9 }, (_, index) => `mnemon-review-v1-01234567-89ab-4abc-8123-${String(index).padStart(12, '0')}`)
  const ownerId = 'mnemon-review-owner-v1-01234567-89ab-4abc-8123-000000000000'
  const prompt = { type: 'user/message', data: { id: 'mnemon-review-01234567-89ab-4abc-8123-000000000000', source: { kind: 'user' },
    content: [{ type: 'text', text: '[dsh-mnemon:delegated review]\nSynthetic task.' }] } }
  const readSession = vi.fn(async (id: string) => ({ session: { id }, inheritedEventCount: 0, events: id === ownerId
    ? [{ type: 'subagent/catalog', data: { childId: ids[0] } }]
    : id === ids[1] ? [prompt, { type: 'user/message', data: { source: { kind: 'user' } } }]
    : id === ids[2] ? [{ ...prompt, data: { ...prompt.data, id: 'text-but-no-ownership' } }]
    : id === ids[3] ? [prompt, { type: 'session/title', data: { source: { kind: 'user' }, title: 'My notes' } }]
    : [prompt] }))
  const { registry, archiveSession } = fixture()
  registry.archivedSessionIds.push(ids[4]!)
  registry.pinnedSessionIds.push(ids[5]!)
  const query = {
    listSessions: async () => [...ids, ownerId].map(id => ({ header: { id, ...(id === ids[8] ? { origin: 'subagent' } : {}) }, persisted: true, live: id === ids[6] })),
    readSession,
  }
  const host = { get: (name: string) => name === 'sessionQuery' ? query : { ...registry, list: () => [{ sessionIds: [ids[7]] }] } }
  await archiveOrphanedIdleReviews(host, new AbortController().signal)
  expect(archiveSession.mock.calls).toEqual([[ids[0]], [ownerId]])
  expect(readSession.mock.calls.flat()).toEqual([...ids.slice(0, 4), ownerId])
})
