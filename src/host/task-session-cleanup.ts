import type { HostSession } from './dsh.ts'
import { sessionEvents } from './session-events.ts'

export interface WorkspaceRegistryArchiveHost {
  readonly archivedSessionIds?: readonly string[]
  readonly pinnedSessionIds?: readonly string[]
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
}

export interface TaskSessionArchiveHost {
  get?(name: string): unknown
  agents?: { get?(id: string): unknown }
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
    if (event.type !== 'user/message') continue
    const message = (event.data.message ?? event.data) as { id?: string; source?: { kind?: string } }
    if (message.source?.kind === 'user' && (taskMessageId === undefined || message.id !== taskMessageId)) return false
  }
  if (host?.agents?.get?.(id) !== undefined) return false
  try {
    await registry.archiveSession(id)
    return true
  } catch {
    return false
  }
}
