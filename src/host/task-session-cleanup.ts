export interface WorkspaceRegistryArchiveHost {
  list(): Array<{ sessionIds?: readonly string[] }>
  readonly archivedSessionIds?: readonly string[]
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
}

interface SessionPersistenceListHost {
  list(options?: { signal?: AbortSignal }): Promise<ReadonlyArray<{ header: { id: string } }>>
}

export interface TaskSessionArchiveHost {
  get?(name: string): unknown
  agents?: { get?(id: string): unknown }
}

const ARCHIVABLE_TASK_PREFIXES = ['mnemon-task-v1-', 'mnemon-review-v1-'] as const

/** Whether a session id identifies an ephemeral Mnemon background task or review carrier. */
export function isArchivableTaskSessionId(sessionId: string): boolean {
  return ARCHIVABLE_TASK_PREFIXES.some(prefix => sessionId.startsWith(prefix))
}

function archiveHostRegistry(host: TaskSessionArchiveHost | undefined): WorkspaceRegistryArchiveHost | undefined {
  const registry = host?.get?.('workspaceRegistry') as WorkspaceRegistryArchiveHost | undefined
  if (registry === undefined || typeof registry.archiveSession !== 'function') return undefined
  return registry
}

/**
 * Archive one finished Mnemon task/review session via DSH's workspace registry.
 * Best-effort and non-destructive: keeps the persisted session log resumable
 * while excluding empty or finished shells from blank reuse and sidebars (#472, #651).
 */
export async function archiveTaskSession(host: TaskSessionArchiveHost | undefined, sessionId: string): Promise<boolean> {
  const id = sessionId.trim()
  if (id === '') return false
  const registry = archiveHostRegistry(host)
  if (registry === undefined) return false
  if (registry.archivedSessionIds?.includes(id) === true) return false
  try {
    await registry.archiveSession!(id)
    return true
  } catch {
    return false
  }
}

/**
 * Archive previously persisted non-live Mnemon task/review sessions that remain
 * unarchived in the workspace registry so an upgrade immediately clears Web New Session blocks.
 */
export async function sweepUnarchivedTaskSessions(
  host: TaskSessionArchiveHost | undefined,
  activeIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) return 0
  const registry = archiveHostRegistry(host)
  if (registry === undefined) return 0
  const archived = new Set(registry.archivedSessionIds ?? [])
  const candidates = new Set<string>()
  for (const workspace of registry.list?.() ?? []) {
    for (const id of workspace.sessionIds ?? []) {
      if (isArchivableTaskSessionId(id)) candidates.add(id)
    }
  }
  const persistence = host?.get?.('sessionPersistence') as SessionPersistenceListHost | undefined
  if (typeof persistence?.list === 'function') {
    try {
      for (const snapshot of await persistence.list(signal === undefined ? {} : { signal })) {
        if (signal?.aborted) return 0
        const id = snapshot.header?.id
        if (typeof id === 'string' && isArchivableTaskSessionId(id)) candidates.add(id)
      }
    } catch {
      // Ignore persistence list failures during opportunistic startup archival.
    }
  }
  let count = 0
  for (const id of candidates) {
    if (signal?.aborted) break
    if (archived.has(id) || activeIds.has(id) || host?.agents?.get?.(id) !== undefined) continue
    if (await archiveTaskSession(host, id)) {
      archived.add(id)
      count += 1
    }
  }
  return count
}
