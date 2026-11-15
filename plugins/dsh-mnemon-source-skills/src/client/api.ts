import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { MnemonSourceManagementClient, TaskAgentModelCatalog } from 'dsh-mnemon/client'
import type {
  BacktestRun, CatalogView, DraftPreferencesView, DraftView, EvalCase, MarketPreview, MarketRegistry, MarketSearchResult, MarketView, EvidencePack, ModelRoute, ReviewLogEntry, ReviewRecordResult, RunTarget, SkillDocument, SkillDraft, SkillRootKind, SkillSuggestion, SkillSummary,
  SkillVersion, SkillsOverview, SuggestionStatus, SuggestionView, Trajectory, TrajectorySummary, TrashEntry, TrashRestoreInput, TrashRestorePreview,
} from '../contracts.ts'

export interface CaseDraft {
  id?: string
  skillName: string
  title: string
  prompt: string
  context?: string
  requiresVision?: boolean
  checks: Array<{ id?: string; text: string; must: boolean }>
  enabled?: boolean
}

/** Everything the Skills page asks of its Source and of the Host's assistance. */
export interface SkillsPageClient {
  overview(): Promise<SkillsOverview>
  catalog(): Promise<CatalogView>
  skill(key: string): Promise<SkillDocument & { versions: SkillVersion[] }>
  version(key: string, id: string): Promise<{ version: SkillVersion; content: string }>
  suggestions(status?: readonly SuggestionStatus[]): Promise<SkillSuggestion[]>
  suggestion(id: string): Promise<SuggestionView>
  trajectories(filter?: { skill?: string; signal?: string }): Promise<TrajectorySummary[]>
  trajectory(id: string): Promise<Trajectory>
  cases(skill?: string): Promise<EvalCase[]>
  runs(skill?: string): Promise<BacktestRun[]>
  run(id: string): Promise<BacktestRun>
  draft(id: string): Promise<DraftView>
  reviews(filter?: { sessionId?: string; limit?: number }): Promise<ReviewLogEntry[]>
  evidencePack(input: { suggestionId?: string; draftId?: string; skill?: string }): Promise<EvidencePack>

  createSkill(input: { name: string; description: string; root?: SkillRootKind }): Promise<SkillSummary>
  saveSkill(key: string, content: string, expectedHash: string): Promise<SkillSummary>
  setInvocation(key: string, invocation: { modelInvocable: boolean; userInvocable: boolean }, expectedHash: string): Promise<SkillSummary>
  deleteSkill(key: string, expectedHash: string): Promise<{ trashedTo: string }>
  /** Removed skills waiting in the Trash, newest first. */
  trash(): Promise<TrashEntry[]>
  /** Put a removed skill back; a new root moves it out of the one it came from. */
  previewTrashRestore(input: TrashRestoreInput): Promise<TrashRestorePreview>
  restoreTrash(input: TrashRestoreInput): Promise<{ key: string; path: string }>
  /** Delete a Trash entry for good. */
  purgeTrash(id: string): Promise<{ purged: string }>
  /** Delete everything waiting in the Trash. */
  emptyTrash(): Promise<{ purged: number }>
  restoreVersion(key: string, versionId: string, expectedHash: string): Promise<SkillSummary>
  dismissSuggestion(id: string): Promise<SkillSuggestion>
  /** Delete a waiting suggestion and any draft written for it. */
  deleteSuggestion(id: string): Promise<{ deleted: string }>
  /** Delete a draft; its suggestion goes back to waiting. */
  deleteDraft(id: string): Promise<{ deleted: string }>
  pinTrajectory(id: string, pinned: boolean): Promise<TrajectorySummary>
  deleteTrajectory(id: string): Promise<{ deleted: string }>
  saveCase(input: CaseDraft): Promise<EvalCase>
  deleteCase(id: string): Promise<{ deleted: string }>
  updateDraft(id: string, content: string): Promise<SkillDraft>
  /** Adopt a draft; a new skill goes to `root` when given. */
  adoptDraft(id: string, root?: SkillRootKind): Promise<{ skill: SkillSummary; version: SkillVersion }>
  discardDraft(id: string): Promise<SkillDraft>
  /** Attach a baseline run to the draft it is compared with. */
  linkRun(draftId: string, runId: string): Promise<void>
  cancelRun(id: string): Promise<BacktestRun>

  /** The model each piece of model work follows: the two global picks and their per-item overrides. */
  draftPreferences(): Promise<DraftPreferencesView>
  /** Pick the model for drafts, for backtests, or for one suggestion or skill; `null` follows the task Agent again. */
  saveDraftModel(model: ModelRoute | null): Promise<DraftPreferencesView>
  saveSuggestionModel(id: string, model: ModelRoute | null): Promise<DraftPreferencesView>
  saveRunModel(model: ModelRoute | null): Promise<DraftPreferencesView>
  saveSkillRunModel(skillName: string, model: ModelRoute | null): Promise<DraftPreferencesView>
  /**
   * The routes and model directory a page may offer. Rejects when the Host
   * offers none, which is also when the page hides its pickers.
   */
  models(): Promise<TaskAgentModelCatalog>

  market(): Promise<MarketView>
  marketPreview(registryId: string, name: string): Promise<MarketPreview>
  /** Search the search sources; the page filters the listed ones itself. */
  searchMarket(query: string): Promise<MarketSearchResult>
  refreshMarket(ids?: string[]): Promise<MarketRegistry[]>
  installMarket(input: { registryId: string; name: string; root?: SkillRootKind; overwrite?: boolean }): Promise<{ skill: SkillSummary; updated: boolean }>
  addRegistry(location: string): Promise<MarketRegistry>
  removeRegistry(id: string): Promise<{ removed: string }>
  toggleRegistry(id: string, enabled: boolean): Promise<MarketRegistry>

  /** Whether the Host offers a task Agent for this model work. */
  canAssist(operation: 'skill-draft' | 'skill-backtest' | 'skill-derive-cases' | 'skill-review-now'): boolean
  generateDraft(input: { suggestionId?: string; draftId?: string; skill?: string; guidance?: string; targetRoot?: SkillRootKind; backtest?: boolean; provider?: string; model?: string }): Promise<{ started: true }>
  backtest(input: { skillName: string; target: RunTarget; caseIds?: string[]; provider?: string; model?: string }): Promise<{ runId: string }>
  deriveCases(input: { trajectoryId: string; skillName: string; steps?: number[] }): Promise<{ added: EvalCase[]; skipped: number }>
  reviewNow(): Promise<ReviewRecordResult>

  /** Clear cached static preferences when resuming from another window or manual refresh. */
  invalidatePreferences?(): void
  /** Track read revisions across a poll wave so completion reconciles only when a card saw an older ledger (#448). */
  beginReadWave?(onLateStaleRead?: () => void): void
  markWaveIdleAndCheckStale?(): boolean
}

function json(value: unknown): MemoryJsonValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : json(item))
  if (typeof value === 'object') {
    const out: Record<string, MemoryJsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = json(entry)
    }
    return out
  }
  return null
}

const CONFLICT = /revision conflict|Skills Source changed since it was read; reload/u
const MAX_TRAJECTORY_CACHE = 64

/**
 * The Source's revision is tracked from every read and mutation response so
 * writes use the cached revision immediately, fetching `'revision'` only when
 * uninitialized or retrying once on a concurrent background conflict.
 */
export function skillsPageClient(management: MnemonSourceManagementClient): SkillsPageClient {
  let cachedRevision: string | undefined = typeof management.revision === 'string' && management.revision !== ''
    ? management.revision
    : undefined
  let preferencesPromise: Promise<DraftPreferencesView> | undefined
  const trajectoryCache = new Map<string, Trajectory>()
  const trajectoryInFlight = new Map<string, Promise<Trajectory>>()

  let waveOverviewRevision: string | undefined
  let waveOtherRevisions = new Set<string>()
  let waveIdleObserved = false
  let waveLateStaleCallback: (() => void) | undefined

  const recordRevision = (revision: unknown): void => {
    if (typeof revision === 'string' && revision !== '') cachedRevision = revision
  }

  const read = async <T,>(operation: string, input: unknown = null, coalesce = false): Promise<T> => {
    const response = await management.read(operation, json(input), { coalesce })
    recordRevision(response.revision)
    if (typeof response.revision === 'string' && response.revision !== '') {
      if (operation === 'overview') {
        waveOverviewRevision = response.revision
      } else {
        waveOtherRevisions.add(response.revision)
        if (waveIdleObserved && waveOverviewRevision !== undefined && response.revision !== waveOverviewRevision) {
          waveIdleObserved = false
          const notify = waveLateStaleCallback
          waveLateStaleCallback = undefined
          notify?.()
        }
      }
    }
    return response.value as T
  }

  const fresh = async (): Promise<string> => {
    const response = await management.read('revision', null)
    recordRevision(response.revision)
    return response.revision
  }

  const retry = async <T,>(attempt: (revision: string) => Promise<{ revision?: string; value: MemoryJsonValue }>): Promise<T> => {
    for (let count = 1; ; count++) {
      const revision = cachedRevision ?? await fresh()
      try {
        const response = await attempt(revision)
        recordRevision(response.revision)
        return response.value as T
      } catch (error) {
        if (count >= 3 || !CONFLICT.test(error instanceof Error ? error.message : String(error))) throw error
        cachedRevision = undefined
      }
    }
  }

  const mutate = <T,>(operation: string, input: unknown) => retry<T>(revision => management.mutate(operation, json(input), { confirmed: true, expectedRevision: revision }))
  const assist = <T,>(operation: string, input: unknown) => {
    if (management.assistance?.operations.includes(operation) !== true) return Promise.reject<T>(new Error('a task Agent is not available for this action'))
    return retry<T>(revision => management.assistance!.execute(operation, json(input), { expectedRevision: revision, confirmed: true }))
  }

  const readDraftPreferences = (): Promise<DraftPreferencesView> => {
    preferencesPromise ??= read<DraftPreferencesView>('draft-preferences').catch(error => {
      preferencesPromise = undefined
      throw error
    })
    return preferencesPromise
  }

  const writeDraftPreferences = (payload: Record<string, unknown>): Promise<DraftPreferencesView> =>
    mutate<DraftPreferencesView>('draft-preference', payload).then(
      next => {
        preferencesPromise = Promise.resolve(next)
        return next
      },
      error => {
        preferencesPromise = undefined
        throw error
      },
    )

  const readTrajectory = (id: string): Promise<Trajectory> => {
    const cached = trajectoryCache.get(id)
    if (cached !== undefined) {
      trajectoryCache.delete(id)
      trajectoryCache.set(id, cached)
      return Promise.resolve(cached)
    }
    const existing = trajectoryInFlight.get(id)
    if (existing !== undefined) return existing
    const request = read<Trajectory>('trajectory', { id }).then(value => {
      trajectoryInFlight.delete(id)
      trajectoryCache.delete(id)
      trajectoryCache.set(id, value)
      while (trajectoryCache.size > MAX_TRAJECTORY_CACHE) {
        const oldest = trajectoryCache.keys().next().value
        if (oldest === undefined) break
        trajectoryCache.delete(oldest)
      }
      return value
    }, error => {
      trajectoryInFlight.delete(id)
      throw error
    })
    trajectoryInFlight.set(id, request)
    return request
  }

  const evictTrajectory = (id: string): void => {
    trajectoryCache.delete(id)
    trajectoryInFlight.delete(id)
  }

  // Detail cards have no pickers of their own. Resolve their saved choice here
  // too, while leaving explicit (including invalid partial) routes to the Host.
  const savedModel = async (slot: 'draft' | 'run', input: { provider?: string; model?: string; suggestionId?: string; skillName?: string }): Promise<ModelRoute | undefined> => {
    if (input.provider !== undefined || input.model !== undefined) return undefined
    const preferences = await readDraftPreferences()
    const overrides = slot === 'draft' ? preferences.suggestionModels : preferences.skillRunModels
    const key = slot === 'draft' ? input.suggestionId : input.skillName
    return key !== undefined && Object.hasOwn(overrides, key) ? overrides[key] : slot === 'draft' ? preferences.model : preferences.runModel
  }

  return {
    overview: () => read('overview', null, true),
    catalog: () => read('catalog', null, true),
    skill: key => read('skill', { key }),
    version: (key, id) => read('version', { key, id }),
    suggestions: status => read('suggestions', status === undefined ? {} : { status }, true),
    suggestion: id => read('suggestion', { id }),
    trajectories: filter => read<TrajectorySummary[]>('trajectories', filter ?? {}, true).then(list => {
      for (const summary of list) {
        const cached = trajectoryCache.get(summary.id)
        if (
          cached !== undefined
          && (
            cached.pinned !== summary.pinned
            || cached.suggestionIds.length !== summary.suggestionIds.length
            || cached.suggestionIds.some((id, index) => id !== summary.suggestionIds[index])
          )
        ) {
          trajectoryCache.delete(summary.id)
        }
      }
      return list
    }),
    trajectory: readTrajectory,
    cases: skill => read('cases', skill === undefined ? {} : { skill }, true),
    runs: skill => read('runs', skill === undefined ? {} : { skill }, true),
    run: id => read('run', { id }),
    draft: id => read('draft', { id }),
    reviews: filter => read('reviews', filter ?? {}, true),
    evidencePack: input => read('evidence-pack', input),

    createSkill: input => mutate('skill-create', input),
    saveSkill: (key, content, expectedHash) => mutate('skill-save', { key, content, expectedHash }),
    setInvocation: (key, invocation, expectedHash) => mutate('skill-invocation', { key, ...invocation, expectedHash }),
    deleteSkill: (key, expectedHash) => mutate('skill-delete', { key, expectedHash }),
    trash: () => read('trash-list'),
    previewTrashRestore: input => read('trash-restore-preview', input),
    restoreTrash: input => mutate('trash-restore', input),
    purgeTrash: id => mutate('trash-purge', { id }),
    emptyTrash: () => mutate('trash-empty', {}),
    restoreVersion: (key, versionId, expectedHash) => mutate('version-restore', { key, versionId, expectedHash }),
    dismissSuggestion: id => mutate('suggestion-dismiss', { id }),
    deleteSuggestion: id => {
      for (const [trajectoryId, cached] of trajectoryCache.entries()) {
        if (cached.suggestionIds.includes(id)) trajectoryCache.delete(trajectoryId)
      }
      trajectoryInFlight.clear()
      return mutate('suggestion-delete', { id })
    },
    deleteDraft: id => mutate('draft-delete', { id }),
    pinTrajectory: (id, pinned) => {
      evictTrajectory(id)
      return mutate('trajectory-pin', { id, pinned })
    },
    deleteTrajectory: id => {
      evictTrajectory(id)
      return mutate('trajectory-delete', { id })
    },
    saveCase: input => mutate('case-save', { case: input }),
    deleteCase: id => mutate('case-delete', { id }),
    updateDraft: (id, content) => mutate('draft-update', { id, content }),
    cancelRun: id => mutate('run-cancel', { id }),
    adoptDraft: (id, root) => mutate('draft-adopt', root === undefined ? { id } : { id, root }),
    discardDraft: id => mutate('draft-discard', { id }),
    linkRun: (draftId, runId) => mutate('run-link', { draftId, runId }),

    draftPreferences: readDraftPreferences,
    saveDraftModel: model => writeDraftPreferences({ model }),
    saveSuggestionModel: (id, model) => writeDraftPreferences({ suggestionId: id, model }),
    saveRunModel: model => writeDraftPreferences({ slot: 'run', model }),
    saveSkillRunModel: (skillName, model) => writeDraftPreferences({ slot: 'run', skillName, model }),
    models: () => management.models === undefined ? Promise.reject<TaskAgentModelCatalog>(new Error('model catalog is unavailable')) : management.models(),

    market: () => read('market'),
    marketPreview: (registryId, name) => read('market-preview', { registryId, name }),
    searchMarket: query => read('market-search', { query }),
    refreshMarket: ids => mutate('market-refresh', ids === undefined ? {} : { ids }),
    installMarket: input => mutate('market-install', input),
    addRegistry: location => mutate('registry-add', { location }),
    removeRegistry: id => mutate('registry-remove', { id }),
    toggleRegistry: (id, enabled) => mutate('registry-toggle', { id, enabled }),

    canAssist: operation => management.assistance?.operations.includes(operation) === true,
    generateDraft: async input => assist('skill-draft', { ...await savedModel('draft', input), ...input }),
    backtest: async input => assist('skill-backtest', { ...await savedModel('run', input), ...input }),
    deriveCases: input => assist('skill-derive-cases', input),
    reviewNow: () => {
      trajectoryCache.clear()
      trajectoryInFlight.clear()
      return assist('skill-review-now', {})
    },

    invalidatePreferences: () => { preferencesPromise = undefined },
    beginReadWave: onLateStaleRead => {
      waveOverviewRevision = undefined
      waveOtherRevisions = new Set()
      waveIdleObserved = false
      waveLateStaleCallback = onLateStaleRead
    },
    markWaveIdleAndCheckStale: () => {
      const stale = waveOverviewRevision !== undefined && [...waveOtherRevisions].some(rev => rev !== waveOverviewRevision)
      waveIdleObserved = !stale
      if (stale) waveLateStaleCallback = undefined
      return stale
    },
  }
}
