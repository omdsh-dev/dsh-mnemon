import type { HostSession, HostSessionEvent } from './dsh.ts'

export const SESSION_EVENT_PAGE_SIZE = 256

/** Read the public offset without constructing a snapshot. Older adapters can expose indexed reads only. */
export function sessionLength(session: HostSession): number {
  if (typeof session.seq === 'number') return session.seq
  let low = 0, high = 1
  while (session.eventAt(high - 1) !== undefined) { low = high; high *= 2 }
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (session.eventAt(middle) === undefined) high = middle
    else low = middle + 1
  }
  return low
}

/** Never retain the transcript or invoke DSH's full-log snapshot cache. */
export function* sessionEvents(session: HostSession, from = 0, to = sessionLength(session)): Generator<HostSessionEvent> {
  for (let offset = from; offset < to; offset += SESSION_EVENT_PAGE_SIZE) {
    yield* session.snapshotEvents(offset, Math.min(to, offset + SESSION_EVENT_PAGE_SIZE))
  }
}

export function* reverseSessionEvents(session: HostSession, from = 0, to = sessionLength(session)): Generator<{ seq: number; event: HostSessionEvent }> {
  for (let end = to; end > from;) {
    const start = Math.max(from, end - SESSION_EVENT_PAGE_SIZE)
    const page = session.snapshotEvents(start, end)
    for (let index = page.length - 1; index >= 0; index--) yield { seq: start + index, event: page[index]! }
    end = start
  }
}

export function findSessionEvent(session: HostSession, predicate: (event: HostSessionEvent) => boolean, from = 0): { seq: number; event: HostSessionEvent } | undefined {
  for (const entry of reverseSessionEvents(session, from)) if (predicate(entry.event)) return entry
  return undefined
}

/** A completed/current turn can be long; page it without truncating its evidence. */
export function* sessionTurnEvents(session: HostSession, turn: number): Generator<HostSessionEvent> {
  const end = sessionLength(session)
  for (const entry of reverseSessionEvents(session, 0, end)) {
    if (entry.event.type !== 'turn/start' || entry.event.data.turn !== turn) continue
    for (const event of sessionEvents(session, entry.seq, end)) {
      yield event
      if (event.type === 'turn/end' && event.data.turn === turn) break
    }
    return
  }
}

/** Cursor for small derived projections; no event objects or transcript text are retained. */
export class SessionEventCursor {
  private session: HostSession | undefined
  private offset = 0
  private lastSeq: number | undefined

  consume(session: HostSession, consume: (event: HostSessionEvent) => void, reset: () => void): number {
    const end = sessionLength(session)
    const last = this.offset > 0 ? session.eventAt(this.offset - 1) : undefined
    if (this.session !== session || end < this.offset || last?.seq !== this.lastSeq) {
      reset()
      this.offset = 0
      this.lastSeq = undefined
    }
    this.session = session
    for (const event of sessionEvents(session, this.offset, end)) {
      consume(event)
      this.offset++
      this.lastSeq = event.seq
    }
    return this.lastSeq ?? end
  }
}
