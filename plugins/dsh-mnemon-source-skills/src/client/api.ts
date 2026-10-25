import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { MnemonSourceManagementClient } from 'dsh-mnemon/client'
import type {
  BacktestRun, CatalogView, DraftView, EvalCase, MarketPreview, MarketRegistry, MarketSearchResult, MarketView, EvidencePack, ReviewLogEntry, ReviewRecordResult, RunTarget, SkillDocument, SkillDraft, SkillRootKind, SkillSuggestion, SkillSummary,
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
  evidencePack(input: { suggestionId?: string; skill?: string }): Promise<EvidencePack>

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
  generateDraft(input: { suggestionId?: string; skill?: string; guidance?: string; targetRoot?: SkillRootKind }): Promise<{ started: true }>
  backtest(input: { skillName: string; target: RunTarget; caseIds?: string[] }): Promise<{ runId: string }>
  deriveCases(input: { trajectoryId: string; skillName: string; steps?: number[] }): Promise<{ added: EvalCase[]; skipped: number }>
  reviewNow(): Promise<ReviewRecordResult>
}

function json(value: unknown): MemoryJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as MemoryJsonValue
}

const CONFLICT = /revision conflict|changed since it was read; reload/u

/**
 * The Source's revision moves with every background review and run, so each
 * write fetches it first and tries once more if a background write slipped in
 * between. A conflict is refused before anything runs, and every write here
 * carries its own precondition, so retrying never applies one twice.
 */
export function skillsPageClient(management: MnemonSourceManagementClient): SkillsPageClient {
  const read = async <T,>(operation: string, input: unknown = null): Promise<T> => (await management.read(operation, json(input))).value as T
  const fresh = async () => (await management.read('revision', null)).revision
  const retry = async <T,>(attempt: (revision: string) => Promise<{ value: MemoryJsonValue }>): Promise<T> => {
    for (let count = 1; ; count++) {
      try { return (await attempt(await fresh())).value as T } catch (error) {
        if (count >= 3 || !CONFLICT.test(error instanceof Error ? error.message : String(error))) throw error
      }
    }
  }
  const mutate = <T,>(operation: string, input: unknown) => retry<T>(revision => management.mutate(operation, json(input), { confirmed: true, expectedRevision: revision }))
  const assist = <T,>(operation: string, input: unknown) => {
    if (management.assistance?.operations.includes(operation) !== true) return Promise.reject<T>(new Error('a task Agent is not available for this action'))
    return retry<T>(revision => management.assistance!.execute(operation, json(input), { expectedRevision: revision, confirmed: true }))
  }
  return {
    overview: () => read('overview'),
    catalog: () => read('catalog'),
    skill: key => read('skill', { key }),
    version: (key, id) => read('version', { key, id }),
    suggestions: status => read('suggestions', status === undefined ? {} : { status }),
    suggestion: id => read('suggestion', { id }),
    trajectories: filter => read('trajectories', filter ?? {}),
    trajectory: id => read('trajectory', { id }),
    cases: skill => read('cases', skill === undefined ? {} : { skill }),
    runs: skill => read('runs', skill === undefined ? {} : { skill }),
    run: id => read('run', { id }),
    draft: id => read('draft', { id }),
    reviews: filter => read('reviews', filter ?? {}),
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
    pinTrajectory: (id, pinned) => mutate('trajectory-pin', { id, pinned }),
    deleteTrajectory: id => mutate('trajectory-delete', { id }),
    saveCase: input => mutate('case-save', { case: input }),
    deleteCase: id => mutate('case-delete', { id }),
    updateDraft: (id, content) => mutate('draft-update', { id, content }),
    adoptDraft: (id, root) => mutate('draft-adopt', root === undefined ? { id } : { id, root }),
    discardDraft: id => mutate('draft-discard', { id }),
    linkRun: (draftId, runId) => mutate('run-link', { draftId, runId }),

    market: () => read('market'),
    marketPreview: (registryId, name) => read('market-preview', { registryId, name }),
    searchMarket: query => read('market-search', { query }),
    refreshMarket: ids => mutate('market-refresh', ids === undefined ? {} : { ids }),
    installMarket: input => mutate('market-install', input),
    addRegistry: location => mutate('registry-add', { location }),
    removeRegistry: id => mutate('registry-remove', { id }),
    toggleRegistry: (id, enabled) => mutate('registry-toggle', { id, enabled }),

    canAssist: operation => management.assistance?.operations.includes(operation) === true,
    generateDraft: input => assist('skill-draft', input),
    backtest: input => assist('skill-backtest', input),
    deriveCases: input => assist('skill-derive-cases', input),
    reviewNow: () => assist('skill-review-now', {}),
  }
}
