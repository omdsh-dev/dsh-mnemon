import type { HostSession, HostSessionEvent } from './dsh.ts'

function eventArray(value: unknown): readonly HostSessionEvent[] | undefined {
  return Array.isArray(value) ? value as readonly HostSessionEvent[] : undefined
}

/**
 * Materialize one immutable event-log snapshot across supported DSH releases.
 * Capability detection keeps alpha and stable rc behavior on one code path.
 */
export function hostSessionEvents(session: HostSession): readonly HostSessionEvent[] {
  if (typeof session.snapshotEvents === 'function') {
    const events = eventArray(session.snapshotEvents())
    if (events !== undefined) return events
  }
  const events = eventArray(session.events)
  if (events !== undefined) return events
  throw new TypeError('Unsupported DSH Session event API: expected snapshotEvents() or events[]')
}

/** Read one exact event without materializing the alpha log when possible. */
export function hostSessionEventAt(session: HostSession, seq: number): HostSessionEvent | undefined {
  if (typeof session.eventAt === 'function') return session.eventAt(seq)
  return hostSessionEvents(session)[seq]
}
