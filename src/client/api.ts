import {
  MNEMON_ACTIVATION_CHANNEL,
  MNEMON_PACK_CHANNEL,
  MNEMON_READ_CHANNEL,
  MNEMON_REVIEW_CHANNEL,
  MNEMON_SYNC_CHANNEL,
  MNEMON_WRITE_CHANNEL,
  MNEMON_VIEW_CHANNEL,
  MNEMON_VIEW_WRITE_CHANNEL,
  type MemoryViewDashboard,
  type MemoryViewConfigurationRequest,
  type AssistantMessageText,
  type SkillActivitySnapshot,
  type ClientConnectionHandle,
  type JsonValue,
  type MemoryCompositionStatus,
  type MemorySourceManagementCatalog,
  type MemorySourceManagementResult,
  type MnemonPackComponent,
  type MnemonRpcChannel,
  type MnemonRpcEndpoint,
  type MnemonPackExport,
  type MnemonPackImportResult,
  type MnemonPackPreview,
  type MnemonPackTarget,
  type MnemonReconcileResult,
  type MnemonReviewApplyResult,
  type MnemonReviewEntry,
  type MnemonReviewLedgerView,
  type MnemonSyncBackupList,
  type MnemonSyncConfigView,
  type MnemonSyncDiff,
  type MnemonSyncGitHubPoll,
  type MnemonSyncGitHubRepository,
  type MnemonSyncGitHubRepositoryList,
  type MnemonSyncGitHubStatus,
  type MnemonSyncPreview,
  type MnemonSyncPullResult,
  type MnemonSyncPushResult,
  type MnemonSyncStatus,
  type StatusView,
  type SupervisedWritebackResult,
  type TaskAgentModelCatalog,
  type TurnMemoryActivity,
  type TurnMemoryActivitySnapshot,
  type VersionComponentId,
  type VersionStatus,
  type VersionUpdateResult,
} from "../host/protocol.ts"
import { callMnemonRpc } from './remote-rpc.ts'

/** The channel a component's read or write operation goes on. */
type ComponentChannel<Mode extends 'read' | 'write'> = Mode extends 'read' ? typeof MNEMON_READ_CHANNEL : typeof MNEMON_WRITE_CHANNEL

interface TurnActivityCacheEntry {
  cursor: number
  activities: Map<number, TurnMemoryActivity>
  inFlight?: Promise<TurnMemoryActivitySnapshot>
}

const MAX_TURN_ACTIVITY_SESSIONS = 32
const turnActivityCache = new WeakMap<ClientConnectionHandle, Map<string, TurnActivityCacheEntry>>()

function touchTurnActivityEntry(
  sessions: Map<string, TurnActivityCacheEntry>,
  key: string,
  entry: TurnActivityCacheEntry,
): void {
  sessions.delete(key)
  sessions.set(key, entry)
  if (sessions.size <= MAX_TURN_ACTIVITY_SESSIONS) return
  for (const [candidateKey, candidate] of sessions) {
    if (candidateKey !== key && candidate.inFlight === undefined) {
      sessions.delete(candidateKey)
      if (sessions.size <= MAX_TURN_ACTIVITY_SESSIONS) return
    }
  }
  while (sessions.size > MAX_TURN_ACTIVITY_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest === undefined || oldest === key) break
    sessions.delete(oldest)
  }
}

async function loadTurnActivities(connection: ClientConnectionHandle, sessionId: string | undefined, requiredCursor: number): Promise<TurnMemoryActivitySnapshot> {
  let sessions = turnActivityCache.get(connection)
  if (sessions === undefined) {
    sessions = new Map()
    turnActivityCache.set(connection, sessions)
  }
  const key = sessionId ?? ''
  let entry = sessions.get(key)
  if (entry === undefined) {
    entry = { cursor: -1, activities: new Map() }
  }
  touchTurnActivityEntry(sessions, key, entry)
  if (entry.cursor >= requiredCursor) return { cursor: entry.cursor, activities: [...entry.activities.values()] }
  if (entry.inFlight !== undefined) {
    const snapshot = await entry.inFlight
    return snapshot.cursor >= requiredCursor ? snapshot : loadTurnActivities(connection, sessionId, requiredCursor)
  }

  const request = callMnemonRpc(connection, MNEMON_READ_CHANNEL, 'turn-activities', sessionId === undefined ? {} : { sessionId })
    .then(response => {
      if (!response.ok) throw new Error(response.error.message)
      const snapshot = response.value as TurnMemoryActivitySnapshot
      entry!.cursor = snapshot.cursor
      entry!.activities = new Map(snapshot.activities.map(activity => [activity.turn, activity]))
      return snapshot
    })
    .finally(() => { delete entry!.inFlight })
  entry.inFlight = request
  return request
}

export class MnemonClient {
  constructor(private readonly connection: ClientConnectionHandle, private readonly sessionId?: string, private readonly workspaceId?: string) {}

  private async call<T, Channel extends MnemonRpcChannel = MnemonRpcChannel>(channel: Channel, endpoint: MnemonRpcEndpoint<Channel>, payload: unknown): Promise<T> {
    const response = await callMnemonRpc(this.connection, channel, endpoint, payload)
    if (!response.ok) {
      // A failure the Host could name keeps that name, so the page can translate it.
      const reason = (response.error.details as { reason?: unknown } | undefined)?.reason
      throw Object.assign(new Error(response.error.message), typeof reason === 'string' ? { reason } : {})
    }
    return response.value as T
  }

  private scoped<T extends object = Record<string, never>>(payload: T = {} as T): T & { sessionId?: string; workspaceId?: string } {
    return {
      ...payload,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.workspaceId === undefined ? {} : { workspaceId: this.workspaceId }),
    }
  }

  status(): Promise<StatusView> {
    return this.call(MNEMON_READ_CHANNEL, 'status', this.scoped())
  }

  statusSummary(): Promise<StatusView> {
    return this.call(MNEMON_READ_CHANNEL, 'status-summary', this.scoped())
  }

  memorySystem(): Promise<MemoryCompositionStatus> {
    return this.call(MNEMON_READ_CHANNEL, 'memory-system', this.scoped())
  }

  viewDashboard(): Promise<MemoryViewDashboard> { return this.call(MNEMON_VIEW_CHANNEL, 'dashboard', this.scoped()) }
  applyView(configuration: MemoryViewConfigurationRequest): Promise<{ saved: true }> {
    return this.call(MNEMON_VIEW_WRITE_CHANNEL, 'apply', this.scoped({ configuration, confirmed: true }))
  }

  sourceManagementCatalog(): Promise<MemorySourceManagementCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'source-management-catalog', this.scoped())
  }

  readSourceManagement(sourceInstanceKey: string, operation: string, input: JsonValue = null): Promise<MemorySourceManagementResult> {
    return this.call(MNEMON_READ_CHANNEL, 'source-management-read', this.scoped({ sourceInstanceKey, operation, input }))
  }

  mutateSourceManagement(sourceInstanceKey: string, operation: string, input: JsonValue, expectedRevision: string, confirmed: boolean): Promise<MemorySourceManagementResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'source-management-mutate', this.scoped({ sourceInstanceKey, operation, input, expectedRevision, confirmed }))
  }

  assistSource(sourceInstanceKey: string, operation: string, input: JsonValue, expectedRevision: string, confirmed: boolean): Promise<MemorySourceManagementResult> {
    return this.call(operation === 'activation' ? MNEMON_ACTIVATION_CHANNEL : confirmed ? MNEMON_WRITE_CHANNEL : MNEMON_READ_CHANNEL, 'source-assistance', this.scoped({ sourceInstanceKey, operation, input, expectedRevision, confirmed }))
  }

  /** A session-scoped call reports the route that conversation's background work uses. */
  taskAgentModels(includeCatalog?: boolean): Promise<TaskAgentModelCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'task-agent-models', this.scoped(includeCatalog === undefined ? {} : { includeCatalog }))
  }

  versions(): Promise<VersionStatus> {
    return this.call(MNEMON_READ_CHANNEL, 'versions', {})
  }

  updateVersion(component: VersionComponentId): Promise<VersionUpdateResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'version-update', { component })
  }

  /**
   * One of the Host operations a page lends a component's settings, by its
   * endpoint name (component-host.ts): Memory Spaces reads its Providers and
   * embedding through these.
   */
  componentOperation<T, Mode extends 'read' | 'write' = 'read' | 'write'>(mode: Mode, endpoint: MnemonRpcEndpoint<ComponentChannel<Mode>>, payload: object): Promise<T> {
    return this.call(mode === 'read' ? MNEMON_READ_CHANNEL : MNEMON_WRITE_CHANNEL, endpoint, this.scoped(payload))
  }

  /** Settled memory-tool activity of one turn, shared across all mounted tails. */
  async turnActivity(turn: number, cursor = 0): Promise<TurnMemoryActivity | null> {
    const snapshot = await loadTurnActivities(this.connection, this.sessionId, cursor)
    return snapshot.activities.find(activity => activity.turn === turn) ?? null
  }

  /** What this conversation did with skills: each turn's uses and each review, for the turn bars. */
  skillActivity(): Promise<SkillActivitySnapshot> {
    return this.call(MNEMON_READ_CHANNEL, 'skill-activity', { sessionId: this.sessionId })
  }

  /** Plain text of one finalized assistant message; null when absent or empty. */
  assistantMessageText(messageId: string): Promise<AssistantMessageText | null> {
    return this.call(MNEMON_READ_CHANNEL, 'assistant-message', { sessionId: this.sessionId, messageId })
  }

  supervise(content: string, idempotencyKey?: string): Promise<SupervisedWritebackResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'supervise', this.scoped({ content, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }))
  }

  packTarget(): Promise<MnemonPackTarget> {
    return this.call(MNEMON_PACK_CHANNEL, 'target', this.scoped())
  }

  exportPack(): Promise<MnemonPackExport> {
    return this.call(MNEMON_PACK_CHANNEL, 'export', this.scoped())
  }

  inspectPack(base64: string, fileName?: string): Promise<MnemonPackPreview> {
    return this.call(MNEMON_PACK_CHANNEL, 'inspect', this.scoped({ base64, ...(fileName === undefined ? {} : { fileName }) }))
  }

  importPack(base64: string): Promise<MnemonPackImportResult> {
    return this.call(MNEMON_PACK_CHANNEL, 'import', this.scoped({ base64 }))
  }

  /** Every reconciliation proposal this machine still holds. */
  reviewLedger(): Promise<MnemonReviewLedgerView> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'view', {})
  }

  /**
   * One reconciliation run: it stages a proposal and writes no memory. Guidance is what
   * the reviewer wants the plan to accomplish, in their own words; blank means the plan
   * reads the memory and the branch with no instruction beyond its own rules.
   */
  reconcile(guidance?: string): Promise<MnemonReconcileResult> {
    const text = guidance?.trim() ?? ''
    return this.call(MNEMON_REVIEW_CHANNEL, 'reconcile', this.scoped(text === '' ? {} : { guidance: text }))
  }

  reviewOpinion(id: string, text: string, author: 'user' | 'agent' = 'user'): Promise<MnemonReviewEntry> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'opinion', { id, text, author })
  }

  decideReview(id: string, status: 'accepted' | 'rejected'): Promise<MnemonReviewEntry> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'decide', { id, status })
  }

  reopenReview(id: string): Promise<MnemonReviewEntry> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'reopen', { id })
  }

  /** Applying a subset leaves the rest in the entry, which stays accepted. */
  applyReview(id: string, operations?: number[]): Promise<MnemonReviewApplyResult> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'apply', this.scoped({ id, ...(operations === undefined ? {} : { operations }) }))
  }

  syncStatus(): Promise<MnemonSyncStatus> {
    return this.call(MNEMON_SYNC_CHANNEL, 'status', this.scoped())
  }

  /** Saves a patch; the answer never carries the token back. */
  configureSync(patch: { repoUrl?: string | null; branch?: string; subdir?: string; token?: string | null; authorName?: string; authorEmail?: string; autoBackupMinutes?: number; machineLabel?: string | null }): Promise<MnemonSyncConfigView> {
    return this.call(MNEMON_SYNC_CHANNEL, 'configure', this.scoped(patch))
  }

  pushSync(message?: string): Promise<MnemonSyncPushResult> {
    return this.call(MNEMON_SYNC_CHANNEL, 'push', this.scoped({ ...(message === undefined ? {} : { message }), confirmed: true }))
  }

  previewSync(): Promise<MnemonSyncPreview> {
    return this.call(MNEMON_SYNC_CHANNEL, 'preview', this.scoped())
  }

  /** The commits on the branch that carry a payload, newest first. */
  syncBackups(limit?: number): Promise<MnemonSyncBackupList> {
    return this.call(MNEMON_SYNC_CHANNEL, 'backups', this.scoped(limit === undefined ? {} : { limit }))
  }

  /** Which memories are only here and which are only on the branch. */
  syncDiff(): Promise<MnemonSyncDiff> {
    return this.call(MNEMON_SYNC_CHANNEL, 'diff', this.scoped())
  }

  pullSync(components?: MnemonPackComponent[], revive?: boolean): Promise<MnemonSyncPullResult> {
    return this.call(MNEMON_SYNC_CHANNEL, 'pull', this.scoped({
      ...(components === undefined ? {} : { components }),
      ...(revive === true ? { revive: true } : {}),
      confirmed: true,
    }))
  }

  /** Whether GitHub sign-in is possible here, and how far it has come. */
  githubStatus(): Promise<MnemonSyncGitHubStatus> {
    return this.call(MNEMON_SYNC_CHANNEL, 'github-status', this.scoped())
  }

  /** Ask GitHub for the code the user types into the browser. */
  githubStart(): Promise<MnemonSyncGitHubStatus> {
    return this.call(MNEMON_SYNC_CHANNEL, 'github-start', this.scoped())
  }

  /** Ask once whether the browser step happened; the Host keeps the cadence. */
  githubPoll(): Promise<MnemonSyncGitHubPoll> {
    return this.call(MNEMON_SYNC_CHANNEL, 'github-poll', this.scoped())
  }

  githubCancel(): Promise<MnemonSyncGitHubStatus> {
    return this.call(MNEMON_SYNC_CHANNEL, 'github-cancel', this.scoped())
  }

  /** Forgets the stored grant; the next push asks for a sign-in again. */
  githubSignOut(): Promise<MnemonSyncGitHubStatus> {
    return this.call(MNEMON_SYNC_CHANNEL, 'github-signout', this.scoped())
  }

  githubRepositories(): Promise<MnemonSyncGitHubRepositoryList> {
    return this.call(MNEMON_SYNC_CHANNEL, 'github-repositories', this.scoped())
  }

  /** Creates a repository under the signed-in account and answers with it. */
  githubCreateRepository(name: string, isPrivate: boolean): Promise<MnemonSyncGitHubRepository> {
    return this.call(MNEMON_SYNC_CHANNEL, 'github-create', this.scoped({ name, private: isPrivate }))
  }
}
