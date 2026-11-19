import type { HostSession, HostSessionEvent } from './dsh.ts'
import { sessionEvents } from './session-events.ts'
import { delegatedTaskLine } from './subagent.ts'

const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const reviewSession = new RegExp(`^mnemon-review-v1-${UUID_V4}$`, 'u')
const reviewOwner = new RegExp(`^mnemon-review-owner-v1-${UUID_V4}$`, 'u')
const reviewPrompt = new RegExp(`^mnemon-review-${UUID_V4}$`, 'u')

export function isIdleReviewOwner(id: string): boolean { return reviewOwner.test(id) }

export interface WorkspaceRegistryArchiveHost {
  readonly archivedSessionIds?: readonly string[]
  readonly pinnedSessionIds?: readonly string[]
  list?(): ReadonlyArray<{ sessionIds?: readonly string[] }>
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
}

export interface TaskSessionArchiveHost {
  get?(name: string): unknown
  agents?: { get?(id: string): unknown }
}

function userMessage(event: HostSessionEvent): { id?: string; content?: Array<{ type?: string; text?: string }> } | undefined {
  if (event.type !== 'user/message') return undefined
  const message = (event.data.message ?? event.data) as { id?: string; source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> }
  return message.source?.kind === 'user' ? message : undefined
}

/** Archive only the task instance we just finished; historical IDs do not prove ownership. */
export async function archiveTaskSession(
  host: TaskSessionArchiveHost | undefined,
  sessionId: string,
  session: HostSession | undefined,
  taskMessageId?: string,
): Promise<boolean> {
  const id = sessionId.trim()
  if (id === '' || session === undefined) return false
  const registry = host?.get?.('workspaceRegistry') as WorkspaceRegistryArchiveHost | undefined
  if (typeof registry?.archiveSession !== 'function') return false
  if (registry.archivedSessionIds?.includes(id) || registry.pinnedSessionIds?.includes(id)) return false
  // A human can take over a visible root while its background operation is finishing.
  // Only the exact prompt submitted by this review invocation is exempt.
  for (const event of sessionEvents(session)) {
    const message = userMessage(event)
    if (message !== undefined && (taskMessageId === undefined || message.id !== taskMessageId)) return false
  }
  if (host?.agents?.get?.(id) !== undefined) return false
  try {
    await registry.archiveSession(id)
    return true
  } catch {
    return false
  }
}

type ReviewHeader = { id: string; origin?: string; parentSession?: string; delegationDepth?: number }

function isReviewRoot(header: ReviewHeader): boolean {
  return header.origin === undefined && header.parentSession === undefined && (header.delegationDepth ?? 0) === 0
    && (reviewSession.test(header.id) || isIdleReviewOwner(header.id))
}

/** Repair old ungrouped reviews using the session log, never the ID or title alone. */
export async function archiveOrphanedIdleReviews(host: TaskSessionArchiveHost, signal: AbortSignal): Promise<void> {
  const registry = host.get?.('workspaceRegistry') as WorkspaceRegistryArchiveHost | undefined
  const query = host.get?.('sessionQuery') as {
    listSessions?(signal: AbortSignal): Promise<Array<{ header: ReviewHeader; live: boolean; persisted: boolean }>>
    readSession?(id: string): Promise<{ session: ReviewHeader; inheritedEventCount: number; events: HostSessionEvent[] }>
  } | undefined
  if (typeof registry?.archiveSession !== 'function' || typeof query?.listSessions !== 'function' || typeof query.readSession !== 'function') return
  const userOwned = (id: string): boolean => Boolean(registry.archivedSessionIds?.includes(id) || registry.pinnedSessionIds?.includes(id)
    || registry.list?.().some(workspace => workspace.sessionIds?.includes(id)) || host.agents?.get?.(id) !== undefined)
  for (const { header, live, persisted } of await query.listSessions(signal)) {
    if (signal.aborted) return
    if (live || !persisted || !isReviewRoot(header) || userOwned(header.id)) continue
    try {
      const log = await query.readSession(header.id)
      if (signal.aborted) return
      if (log.session.id !== header.id || !isReviewRoot(log.session) || log.inheritedEventCount !== 0 || userOwned(header.id)) continue
      if (log.events.some(event => event.type === 'session/title' && (event.data.source as { kind?: string } | undefined)?.kind === 'user'
        && event.data.title !== 'Mnemon · Idle review')) continue
      const messages = log.events.flatMap(event => userMessage(event) ?? [])
      const owned = isIdleReviewOwner(header.id)
        ? messages.length === 0 && log.events.some(event => event.type === 'subagent/catalog'
          && typeof event.data.childId === 'string' && reviewSession.test(event.data.childId))
        : messages.length === 1 && reviewPrompt.test(messages[0]?.id ?? '')
          && messages[0]?.content?.[0]?.type === 'text' && messages[0].content[0].text?.startsWith(delegatedTaskLine('review') + '\n')
      if (owned) await registry.archiveSession(header.id)
    } catch { /* A busy, unreadable or missing session can be retried after reload. */ }
  }
}
