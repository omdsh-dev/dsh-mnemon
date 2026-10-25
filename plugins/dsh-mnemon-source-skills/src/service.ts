import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk'
import {
  SKILL_ROOT_KINDS,
  type BacktestRun, type CaseResult, type CatalogView, type DraftView, type EvalCase, type EvidencePack, type SuggestionView,
  type MarketEntry, type MarketInstall, type MarketInstallState, type MarketItem, type MarketPreview, type MarketRegistry, type MarketRegistryFile, type MarketSearchResult,
  type MarketSourceKind, type MarketView, type ReviewRecordInput, type ReviewRecordResult, type RunTarget, type SkillCatalog, type SkillDocument,
  type SkillDraft, type SkillRootKind, type SkillSuggestion, type SkillSummary, type SkillVersion, type SkillVersionReason, type SkillsOverview, type Trajectory, type TrajectorySummary, type TrashEntry, type TrashRestoreInput, type TrashRestorePreview,
} from './contracts.ts'
import { activeSkill, catalogFingerprint, findSkill, readCatalog, readSkillDocument, rootPath, sha256, type SkillRootOptions } from './catalog.ts'
import { isSkillName, setFrontmatterKey, skillTemplate, validateSkillContent, withInvocation } from './frontmatter.ts'
import { admitReview, expireSuggestions, OPEN_STATUSES, policyFrom, similarCase, trajectorySummary } from './policy.ts'
import { entryExists, MAX_CASES_PER_SKILL, MAX_VERSIONS_PER_SKILL, SkillsStore, type EvalsFile, type LedgerFile, type RegistryRecord } from './store.ts'
import {
  bundledOfficialRegistry, defaultFetcher, fetchSkillDocument, fetchSkillFiles, indexedParts, isDiscoveryIndex, isPluginMarketplace, listSkillFiles, loadDiscovery,
  loadJson, loadRegistry, loadRepository, marketplaceRepository, OFFICIAL_REGISTRY_ID, OFFICIAL_REGISTRY_URL, parseDiscovery, parseRegistry, REGISTRY_REFRESH_MS,
  registryId, resolveIndexed, searchSkillsSh, skillMeta, SKILLS_SH_ID, SKILLS_SH_URL, skillsShAudits, skillsShSnapshot, type Fetcher, type SkillFile,
} from './market.ts'
import { detectSource, parseGithub } from './source-kind.ts'

/** A run still `running` after this long outlived the Host that started it. */
const RUN_STALE_MS = 45 * 60 * 1000

export interface CaseInput {
  id?: string
  skillName: string
  title: string
  prompt: string
  context?: string
  requiresVision?: boolean
  checks: Array<{ id?: string; text: string; must: boolean }>
  enabled?: boolean
}

function clip(value: string, maximum: number): string {
  const text = value.trim()
  return text.length <= maximum ? text : text.slice(0, maximum - 1) + '…'
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content)
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

/** Where a new skill goes when nothing says otherwise: the user's own DSH skills. */
const DEFAULT_ROOT: SkillRootKind = 'user-dsh'

function staleRun(run: BacktestRun, now: number): BacktestRun {
  return run.status === 'running' && now - Date.parse(run.startedAt) > RUN_STALE_MS ? { ...run, status: 'interrupted' } : run
}

/** A case that could not run says nothing about the skill, so only graded cases count. */
function runScore(results: readonly CaseResult[]): { passRate?: number; score?: number; errors: number } {
  const graded = results.filter(result => result.verdict !== 'error')
  const errors = results.length - graded.length
  if (graded.length === 0) return { errors }
  return {
    passRate: graded.filter(result => result.verdict === 'pass').length / graded.length,
    score: graded.reduce((sum, result) => sum + result.score, 0) / graded.length,
    errors,
  }
}

/**
 * Everything the Skills Source does, over its store and the DSH skill roots.
 * Reads take no lock; every write runs under the storage lock and leaves the
 * files consistent if it fails half way.
 */
export class SkillsService {
  readonly store: SkillsStore

  constructor(private readonly dataDir: string, private readonly roots: Omit<SkillRootOptions, 'workspace'> = {}, private readonly clock: () => Date = () => new Date(), private readonly fetcher: Fetcher = defaultFetcher) {
    this.store = new SkillsStore(join(dataDir, 'skills'))
  }

  private options(workspace: string | undefined): SkillRootOptions {
    return { ...this.roots, ...(workspace === undefined ? {} : { workspace }) }
  }

  private write<T>(operation: () => T): Promise<T> {
    return withMemoryStorageLock(this.store.directory, operation)
  }

  revision(workspace: string | undefined): string {
    return 'skills:' + sha256(`${this.store.fingerprint()}#${catalogFingerprint(this.options(workspace))}`).slice(0, 32)
  }

  catalog(workspace: string | undefined): SkillCatalog {
    return readCatalog(this.options(workspace))
  }

  // ---- reads ---------------------------------------------------------------

  catalogView(workspace: string | undefined): CatalogView {
    const catalog = this.catalog(workspace)
    const ledger = this.store.ledger()
    const evals = this.store.evals()
    expireSuggestions(ledger, this.clock())
    const stats: CatalogView['stats'] = {}
    for (const skill of catalog.skills) {
      if (stats[skill.name] !== undefined) continue
      const loaded = activeSkill(catalog, skill.name)
      const last = evals.runs.find(run => run.skillName === skill.name && run.status === 'completed' && run.target.kind === 'current' && run.target.hash === loaded?.hash)
      stats[skill.name] = {
        open: ledger.suggestions.filter(suggestion => suggestion.skillName === skill.name && OPEN_STATUSES.has(suggestion.status)).length,
        cases: evals.cases.filter(entry => entry.skillName === skill.name && entry.enabled).length,
        ...(last?.passRate === undefined ? {} : { lastPassRate: last.passRate }),
        ...(last?.score === undefined ? {} : { lastScore: last.score }),
        ...(last?.finishedAt === undefined ? {} : { lastRunAt: last.finishedAt }),
      }
    }
    return { ...catalog, stats }
  }

  overview(workspace: string | undefined): SkillsOverview {
    const now = this.clock()
    const ledger = this.store.ledger()
    const evals = this.store.evals()
    expireSuggestions(ledger, now)
    const catalog = this.catalog(workspace)
    const attention: SkillsOverview['attention'] = [
      ...ledger.suggestions.filter(suggestion => suggestion.status === 'pending').map(suggestion => ({ kind: 'suggestion' as const, id: suggestion.id, skillName: suggestion.skillName, title: suggestion.summary, at: suggestion.updatedAt })),
      ...ledger.drafts.filter(draft => draft.status === 'ready').map(draft => ({ kind: 'draft' as const, id: draft.id, skillName: draft.skillName, title: draft.notes || draft.skillName, at: draft.updatedAt })),
    ]
    // The live version scoring below its own previous backtest is a regression to look at; draft runs are compared on their own page.
    const finished = evals.runs.filter(run => run.status === 'completed' && run.target.kind === 'current' && run.score !== undefined)
    for (const name of new Set(finished.map(run => run.skillName))) {
      const [latest, previous] = finished.filter(run => run.skillName === name)
      if (latest !== undefined && previous !== undefined && latest.score! < previous.score! - 0.05) {
        attention.push({ kind: 'regression', id: latest.id, skillName: name, title: `${Math.round(previous.score! * 100)} → ${Math.round(latest.score! * 100)}`, at: latest.finishedAt ?? latest.startedAt })
      }
    }
    attention.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    return {
      counts: {
        skills: new Set(catalog.skills.map(skill => skill.name)).size,
        pending: ledger.suggestions.filter(suggestion => suggestion.status === 'pending').length,
        drafting: ledger.suggestions.filter(suggestion => suggestion.status === 'drafting').length,
        drafts: ledger.drafts.filter(draft => draft.status === 'ready').length,
        trajectories: ledger.trajectories.length,
        cases: evals.cases.filter(entry => entry.enabled).length,
        runsRunning: evals.runs.filter(run => staleRun(run, now.getTime()).status === 'running').length,
        trash: this.store.trashEntries().length,
      },
      ...(ledger.reviews[0] === undefined ? {} : { lastReviewAt: ledger.reviews[0].at }),
      attention: attention.slice(0, 20),
      reviews: ledger.reviews.slice(0, 20),
    }
  }

  skill(workspace: string | undefined, key: string): SkillDocument & { versions: SkillVersion[] } {
    const summary = findSkill(this.catalog(workspace), key)
    return { ...readSkillDocument(summary), versions: this.versions(key) }
  }

  versions(key: string): SkillVersion[] {
    return this.store.ledger().versions.filter(version => version.skillKey === key)
  }

  version(key: string, id: string): { version: SkillVersion; content: string } {
    const version = this.versions(key).find(candidate => candidate.id === id)
    if (version === undefined) throw new Error('version not found: ' + id)
    return { version, content: this.store.versionContent(version) }
  }

  suggestions(statuses?: readonly string[]): SkillSuggestion[] {
    const ledger = this.store.ledger()
    expireSuggestions(ledger, this.clock())
    return statuses === undefined || statuses.length === 0 ? ledger.suggestions : ledger.suggestions.filter(suggestion => statuses.includes(suggestion.status))
  }

  suggestion(workspace: string | undefined, id: string): SuggestionView {
    const ledger = this.store.ledger()
    expireSuggestions(ledger, this.clock())
    const suggestion = ledger.suggestions.find(candidate => candidate.id === id)
    if (suggestion === undefined) throw new Error('suggestion not found: ' + id)
    const skill = activeSkill(this.catalog(workspace), suggestion.skillName)
    const draft = suggestion.draftId === undefined ? undefined : ledger.drafts.find(candidate => candidate.id === suggestion.draftId)
    const cited = new Set(suggestion.evidence.map(reference => reference.trajectoryId))
    return {
      suggestion,
      hashCurrent: suggestion.action === 'create' ? skill === undefined : skill !== undefined && skill.hash === suggestion.skillFileHash,
      ...(skill === undefined ? {} : { skill }),
      ...(draft === undefined ? {} : { draft }),
      trajectories: ledger.trajectories.filter(entry => cited.has(entry.id)),
    }
  }

  trajectories(filter: { skill?: string; signal?: string; sessionId?: string } = {}): TrajectorySummary[] {
    return this.store.ledger().trajectories.filter(entry => (filter.skill === undefined || entry.stats.skills.includes(filter.skill) || this.citesSkill(entry, filter.skill))
      && (filter.signal === undefined || entry.signals.includes(filter.signal as never))
      && (filter.sessionId === undefined || entry.sessionId === filter.sessionId))
  }

  private citesSkill(entry: TrajectorySummary, skill: string): boolean {
    const ledger = this.store.ledger()
    return entry.suggestionIds.some(id => ledger.suggestions.find(suggestion => suggestion.id === id)?.skillName === skill)
  }

  trajectory(id: string): Trajectory {
    return this.store.trajectory(id)
  }

  cases(skillName?: string): EvalCase[] {
    const cases = this.store.evals().cases
    return skillName === undefined ? cases : cases.filter(entry => entry.skillName === skillName)
  }

  runs(skillName?: string): BacktestRun[] {
    const now = this.clock().getTime()
    return this.store.evals().runs.filter(run => skillName === undefined || run.skillName === skillName).map(run => staleRun(run, now))
  }

  run(id: string): BacktestRun {
    const run = this.store.evals().runs.find(candidate => candidate.id === id)
    if (run === undefined) throw new Error('run not found: ' + id)
    return staleRun(run, this.clock().getTime())
  }

  drafts(filter: { suggestionId?: string; skill?: string } = {}): SkillDraft[] {
    return this.store.ledger().drafts.filter(draft => (filter.suggestionId === undefined || draft.suggestionId === filter.suggestionId) && (filter.skill === undefined || draft.skillName === filter.skill))
  }

  draft(workspace: string | undefined, id: string): DraftView {
    const draft = this.store.ledger().drafts.find(candidate => candidate.id === id)
    if (draft === undefined) throw new Error('draft not found: ' + id)
    const catalog = this.catalog(workspace)
    const base = draft.baseKey === undefined ? undefined : catalog.skills.find(skill => skill.key === draft.baseKey)
    const now = this.clock().getTime()
    return { draft, ...(base === undefined ? {} : { base: readSkillDocument(base) }), runs: draft.runIds.flatMap(id => { const run = this.store.evals().runs.find(candidate => candidate.id === id); return run === undefined ? [] : [staleRun(run, now)] }) }
  }

  reviews(filter: { sessionId?: string; limit?: number } = {}): LedgerFile['reviews'] {
    const reviews = this.store.ledger().reviews
    return (filter.sessionId === undefined ? reviews : reviews.filter(review => review.sessionId === filter.sessionId)).slice(0, Math.max(1, Math.min(200, filter.limit ?? 50)))
  }

  /** What a draft or a case derivation needs, gathered once. */
  evidencePack(workspace: string | undefined, input: { suggestionId?: string; skill?: string; action?: 'create' | 'update' }): EvidencePack {
    const ledger = this.store.ledger()
    const evals = this.store.evals()
    const catalog = this.catalog(workspace)
    const suggestion = input.suggestionId === undefined ? undefined : ledger.suggestions.find(candidate => candidate.id === input.suggestionId)
    if (input.suggestionId !== undefined && suggestion === undefined) throw new Error('suggestion not found: ' + input.suggestionId)
    const skillName = suggestion?.skillName ?? input.skill
    if (skillName === undefined || !isSkillName(skillName)) throw new Error('a skill name or a suggestion is required')
    const loaded = activeSkill(catalog, skillName)
    const action = loaded === undefined ? 'create' : 'update'
    const references = suggestion?.evidence ?? ledger.trajectories.filter(entry => entry.stats.skills.includes(skillName) || entry.suggestionIds.some(id => ledger.suggestions.find(candidate => candidate.id === id)?.skillName === skillName)).slice(0, 3).map(entry => ({ trajectoryId: entry.id, steps: [] as number[] }))
    const excerpts: EvidencePack['excerpts'] = []
    for (const reference of references.slice(-4)) {
      let trajectory: Trajectory
      try { trajectory = this.store.trajectory(reference.trajectoryId) } catch { continue }
      const wanted = new Set(reference.steps)
      // The cited steps with one step of context on either side; the whole window when nothing is cited.
      const keep = wanted.size === 0 ? trajectory.steps : trajectory.steps.filter(step => [...wanted].some(index => Math.abs(index - step.index) <= 1))
      excerpts.push({
        trajectoryId: trajectory.id,
        ...(trajectory.sessionTitle === undefined ? {} : { sessionTitle: trajectory.sessionTitle }),
        steps: keep.slice(0, 60),
        annotations: trajectory.annotations.filter(annotation => keep.some(step => step.index === annotation.step)),
      })
    }
    const cases = evals.cases.filter(entry => entry.skillName === skillName && entry.enabled)
    const lastRun = loaded === undefined ? undefined : evals.runs.find(run => run.skillName === skillName && run.status === 'completed' && run.target.kind === 'current' && run.target.hash === loaded.hash)
    return {
      skillName,
      action,
      ...(suggestion === undefined ? {} : { suggestion }),
      ...(loaded === undefined ? {} : { skill: readSkillDocument(loaded) }),
      excerpts,
      cases,
      ...(lastRun === undefined ? {} : { lastRun }),
      catalog: catalog.skills.filter(skill => skill.shadowedBy === undefined).slice(0, 80).map(skill => ({ name: skill.name, description: clip(skill.description, 200), root: skill.root })),
      drafts: ledger.drafts.filter(draft => draft.skillName === skillName).slice(0, 3),
    }
  }

  // ---- writes --------------------------------------------------------------

  /** Bump the ledger generation, so the revision moves with every write. */
  private touch(): void {
    this.store.saveLedger(this.store.ledger())
  }

  private recordVersion(ledger: LedgerFile, skillKey: string, content: string, reason: SkillVersionReason, previous: string | undefined, links: { suggestionId?: string; draftId?: string; note?: string } = {}): SkillVersion {
    const now = this.clock()
    const existing = ledger.versions.filter(version => version.skillKey === skillKey)
    const make = (body: string, why: SkillVersionReason, extra: typeof links, offset: number): SkillVersion => {
      const hash = sha256(body)
      const version: SkillVersion = {
        id: `${(now.getTime() + offset).toString(36)}-${hash.slice(0, 8)}`, skillKey, hash, bytes: Buffer.byteLength(body, 'utf8'), reason: why,
        createdAt: new Date(now.getTime() + offset).toISOString(), ...extra,
      }
      this.store.saveVersionContent(version, body)
      ledger.versions.unshift(version)
      return version
    }
    // The content as it was before the first write this Source made, so it can come back.
    if (existing.length === 0 && previous !== undefined && sha256(previous) !== sha256(content)) make(previous, 'original', {}, 0)
    const version = make(content, reason, links, 1)
    const forSkill = ledger.versions.filter(candidate => candidate.skillKey === skillKey)
    if (forSkill.length > MAX_VERSIONS_PER_SKILL) {
      const removable = forSkill.filter(candidate => candidate.reason !== 'original').slice(MAX_VERSIONS_PER_SKILL - 1)
      for (const old of removable) this.store.deleteVersionContent(old)
      ledger.versions = ledger.versions.filter(candidate => !removable.includes(candidate))
    }
    return version
  }

  private requireHash(skill: SkillSummary, expectedHash: string | undefined): string {
    const current = readFileSync(skill.path, 'utf8')
    if (expectedHash === undefined || sha256(current) !== expectedHash) throw new Error(`${skill.name} changed since it was read; reload it and try again`)
    return current
  }

  createSkill(workspace: string | undefined, input: { name: string; description: string; root?: SkillRootKind; content?: string }): Promise<SkillSummary> {
    return this.write(() => {
      if (!isSkillName(input.name)) throw new Error('a skill name uses lowercase letters, digits and single hyphens (max 64)')
      const catalog = this.catalog(workspace)
      const root = input.root ?? DEFAULT_ROOT
      if (!SKILL_ROOT_KINDS.includes(root)) throw new Error('unknown skill root: ' + root)
      const directory = join(rootPath(catalog, root), input.name)
      if (catalog.skills.some(skill => skill.root === root && skill.name === input.name) || existsSync(directory) || existsSync(directory + '.md')) throw new Error(`${input.name} already exists in this root`)
      const content = input.content?.trim() ? input.content : skillTemplate(input.name, input.description)
      validateSkillContent(content, input.name)
      writeFileAtomic(join(directory, 'SKILL.md'), content)
      const ledger = this.store.ledger()
      this.recordVersion(ledger, `${root}:${input.name}`, content, 'create', undefined)
      this.store.saveLedger(ledger)
      return findSkill(this.catalog(workspace), `${root}:${input.name}`)
    })
  }

  saveSkill(workspace: string | undefined, input: { key: string; content: string; expectedHash: string }): Promise<SkillSummary> {
    return this.write(() => {
      const skill = findSkill(this.catalog(workspace), input.key)
      const previous = this.requireHash(skill, input.expectedHash)
      validateSkillContent(input.content, skill.name)
      writeFileAtomic(skill.path, input.content)
      const ledger = this.store.ledger()
      this.recordVersion(ledger, skill.key, input.content, 'edit', previous)
      this.store.saveLedger(ledger)
      return findSkill(this.catalog(workspace), skill.key)
    })
  }

  setInvocation(workspace: string | undefined, input: { key: string; modelInvocable: boolean; userInvocable: boolean; expectedHash: string }): Promise<SkillSummary> {
    return this.write(() => {
      const skill = findSkill(this.catalog(workspace), input.key)
      const previous = this.requireHash(skill, input.expectedHash)
      const content = withInvocation(previous, { modelInvocable: input.modelInvocable, userInvocable: input.userInvocable })
      validateSkillContent(content, skill.name)
      writeFileAtomic(skill.path, content)
      const ledger = this.store.ledger()
      this.recordVersion(ledger, skill.key, content, 'invocation', previous)
      this.store.saveLedger(ledger)
      return findSkill(this.catalog(workspace), skill.key)
    })
  }

  deleteSkill(workspace: string | undefined, input: { key: string; expectedHash: string }): Promise<{ trashedTo: string }> {
    return this.write(() => {
      const skill = findSkill(this.catalog(workspace), input.key)
      const previous = this.requireHash(skill, input.expectedHash)
      const ledger = this.store.ledger()
      if (ledger.versions.every(version => version.skillKey !== skill.key)) this.recordVersion(ledger, skill.key, previous, 'original', undefined)
      const path = skill.layout === 'bundle' ? dirname(skill.path) : skill.path
      const trashedTo = this.store.trash(path, skill.name, this.trashOrigin(skill, this.catalog(workspace)))
      const now = this.clock().toISOString()
      for (const suggestion of ledger.suggestions) {
        if (suggestion.skillKey === skill.key && suggestion.action === 'update' && OPEN_STATUSES.has(suggestion.status)) { suggestion.status = 'invalidated'; suggestion.updatedAt = now }
      }
      this.store.saveLedger(ledger)
      return { trashedTo }
    })
  }

  /** Skills removed and waiting in the Trash, newest first. */
  trashItems(): TrashEntry[] {
    return this.store.trashEntries()
  }

  private trashOrigin(skill: SkillSummary, catalog: SkillCatalog) {
    return {
      root: skill.root, key: skill.key, originalPath: skill.layout === 'bundle' ? dirname(skill.path) : skill.path,
      ...(skill.root.startsWith('project-') && catalog.projectRoot !== undefined ? { workspace: catalog.projectRoot } : {}),
    }
  }

  private trashTarget(workspace: string | undefined, input: TrashRestoreInput) {
    const entry = this.store.trashEntry(input.id)
    const name = input.name ?? entry.name
    if (!isSkillName(name)) throw new Error('a skill name uses lowercase letters, digits and single hyphens (max 64)')
    const selected = this.catalog(workspace)
    const root = input.root ?? entry.root
    if (root !== undefined && !SKILL_ROOT_KINDS.includes(root)) throw new Error('unknown skill root: ' + root)
    if (root === undefined || (input.root === undefined && root.startsWith('project-') && entry.workspace === undefined)) {
      return { entry, name, roots: selected.roots.map(item => item.kind), destination: undefined }
    }
    const catalog = input.root === undefined && entry.workspace !== undefined ? this.catalog(entry.workspace) : selected
    const directory = rootPath(catalog, root)
    let path = join(directory, entry.kind === 'file' ? `${name}.md` : name)
    if (input.root === undefined && name === entry.name && entry.originalPath !== undefined) {
      if (!isAbsolute(entry.originalPath) || resolve(dirname(entry.originalPath)) !== resolve(directory)) throw new Error('the original skill root has changed; choose a restore location')
      path = entry.originalPath
    }
    const conflict = catalog.skills.find(skill => skill.root === root && skill.name === name)
    const occupied = [path, join(directory, name), join(directory, `${name}.md`)].filter(entryExists)
    const conflictPath = conflict === undefined ? undefined : conflict.layout === 'bundle' ? dirname(conflict.path) : conflict.path
    if (occupied.some(candidate => candidate !== conflictPath)) throw new Error('the restore location already holds another file; choose a different name')
    return { entry, name, roots: selected.roots.map(item => item.kind), destination: { root, path, catalog, conflict, conflictPath } }
  }

  previewTrashRestore(workspace: string | undefined, input: TrashRestoreInput): TrashRestorePreview {
    const target = this.trashTarget(workspace, input)
    return {
      name: target.name, roots: target.roots, needsRoot: target.destination === undefined,
      ...(target.destination === undefined ? {} : { path: target.destination.path }),
      ...(target.destination?.conflict === undefined ? {} : { conflict: { hash: target.destination.conflict.hash } }),
    }
  }

  /** Restore to the recorded origin, or an explicitly selected root; replacement preserves its predecessor. */
  restoreTrash(workspace: string | undefined, input: TrashRestoreInput): Promise<{ key: string; path: string }> {
    return this.write(() => {
      const { entry, name, destination } = this.trashTarget(workspace, input)
      if (destination === undefined) throw new Error('choose a root for this Trash entry; its original location is unknown')
      const { root, path, catalog, conflict, conflictPath } = destination
      if (conflict !== undefined && (input.replace !== true || input.expectedHash !== conflict.hash)) throw new Error(`${name} already exists in ${root}; rename it or confirm replacement of the current version`)
      let content: string | undefined
      if (name !== entry.name) {
        content = setFrontmatterKey(this.store.trashContent(entry), 'name', name)
        validateSkillContent(content, name)
      }
      let displaced: string | undefined
      try {
        if (conflict !== undefined) displaced = this.store.trash(conflictPath!, conflict.name, this.trashOrigin(conflict, catalog))
        this.store.restoreTrash(entry, path, content)
      } catch (error) {
        if (displaced !== undefined && !existsSync(conflictPath!)) try { renameSync(displaced, conflictPath!) } catch { /* The predecessor stays recoverable in the Trash. */ }
        throw error
      }
      const key = `${root}:${name}`
      const ledger = this.store.ledger()
      // Relative links become readable again only after returning to their original location.
      try { content ??= readFileSync(entry.kind === 'file' ? path : join(path, 'SKILL.md'), 'utf8') } catch { /* Restoring the files must also work when a linked target is unavailable. */ }
      if (content !== undefined) this.recordVersion(ledger, key, content, 'restore', undefined)
      this.store.saveLedger(ledger)
      return { key, path }
    })
  }

  /** Delete a Trash entry for good. */
  purgeTrash(input: { id: string }): Promise<{ purged: string }> {
    return this.write(() => {
      const entry = this.store.trashEntry(input.id)
      this.store.purgeTrash(entry)
      this.store.saveLedger(this.store.ledger())
      return { purged: entry.id }
    })
  }

  /** Delete everything waiting in the Trash for good, and say how much went. */
  emptyTrash(): Promise<{ purged: number }> {
    return this.write(() => {
      const entries = this.store.trashEntries()
      for (const entry of entries) this.store.purgeTrash(entry)
      if (entries.length > 0) this.store.saveLedger(this.store.ledger())
      return { purged: entries.length }
    })
  }

  restoreVersion(workspace: string | undefined, input: { key: string; versionId: string; expectedHash: string }): Promise<SkillSummary> {
    return this.write(() => {
      const skill = findSkill(this.catalog(workspace), input.key)
      const previous = this.requireHash(skill, input.expectedHash)
      const ledger = this.store.ledger()
      const version = ledger.versions.find(candidate => candidate.skillKey === skill.key && candidate.id === input.versionId)
      if (version === undefined) throw new Error('version not found: ' + input.versionId)
      const content = this.store.versionContent(version)
      validateSkillContent(content, skill.name)
      writeFileAtomic(skill.path, content)
      this.recordVersion(ledger, skill.key, content, 'restore', previous, { note: version.id })
      this.store.saveLedger(ledger)
      return findSkill(this.catalog(workspace), skill.key)
    })
  }

  private withSuggestion<T>(id: string, change: (suggestion: SkillSuggestion, ledger: LedgerFile) => T): Promise<T> {
    return this.write(() => {
      const ledger = this.store.ledger()
      expireSuggestions(ledger, this.clock())
      const suggestion = ledger.suggestions.find(candidate => candidate.id === id)
      if (suggestion === undefined) throw new Error('suggestion not found: ' + id)
      const value = change(suggestion, ledger)
      suggestion.updatedAt = this.clock().toISOString()
      this.store.saveLedger(ledger)
      return value
    })
  }

  dismissSuggestion(id: string): Promise<SkillSuggestion> {
    return this.withSuggestion(id, (suggestion, ledger) => {
      if (!OPEN_STATUSES.has(suggestion.status)) throw new Error('this suggestion is already ' + suggestion.status)
      if (suggestion.status === 'drafting') throw new Error('a draft is being written for this suggestion; wait for it to finish')
      suggestion.status = 'dismissed'
      for (const draft of ledger.drafts) if (draft.suggestionId === id && draft.status === 'ready') { draft.status = 'discarded'; draft.updatedAt = suggestion.updatedAt }
      return suggestion
    })
  }

  /** The Host marks a suggestion `drafting` before a task Agent writes, and back to `pending` if it fails. */
  suggestionStatus(input: { id: string; status: 'drafting' | 'pending'; error?: string }): Promise<SkillSuggestion> {
    return this.withSuggestion(input.id, suggestion => {
      if (input.status === 'drafting') {
        if (suggestion.status !== 'pending' && suggestion.status !== 'review') throw new Error('this suggestion is ' + suggestion.status + '; only an open suggestion can be drafted')
        suggestion.status = 'drafting'
        delete suggestion.lastError
      } else {
        if (suggestion.status !== 'drafting') return suggestion
        suggestion.status = suggestion.draftId === undefined ? 'pending' : 'review'
        if (input.error !== undefined) suggestion.lastError = clip(input.error, 500)
      }
      return suggestion
    })
  }

  pinTrajectory(id: string, pinned: boolean): Promise<TrajectorySummary> {
    return this.write(() => {
      const ledger = this.store.ledger()
      const entry = ledger.trajectories.find(candidate => candidate.id === id)
      if (entry === undefined) throw new Error('trajectory not found: ' + id)
      entry.pinned = pinned
      const trajectory = this.store.trajectory(id)
      this.store.saveTrajectory({ ...trajectory, pinned })
      this.store.saveLedger(ledger)
      return entry
    })
  }

  deleteTrajectory(id: string): Promise<{ deleted: string }> {
    return this.write(() => {
      const ledger = this.store.ledger()
      const citing = ledger.suggestions.filter(suggestion => OPEN_STATUSES.has(suggestion.status) && suggestion.evidence.some(reference => reference.trajectoryId === id))
      if (citing.length > 0) throw new Error('an open suggestion cites this trajectory; dismiss or finish it first')
      ledger.trajectories = ledger.trajectories.filter(candidate => candidate.id !== id)
      this.store.deleteTrajectory(id)
      this.store.saveLedger(ledger)
      return { deleted: id }
    })
  }

  private normalizeCase(input: CaseInput, existing: EvalCase | undefined, origin: EvalCase['origin']): EvalCase {
    if (input.requiresVision !== undefined && typeof input.requiresVision !== 'boolean') throw new Error('requiresVision must be a boolean')
    if (!isSkillName(input.skillName)) throw new Error('a case belongs to a skill with a valid name')
    const title = clip(input.title, 120)
    const prompt = clip(input.prompt, 4_000)
    if (title === '' || prompt === '') throw new Error('a case needs a title and a task')
    const checks = input.checks.map(check => ({ id: check.id?.trim() || randomUUID(), text: clip(check.text, 300), must: check.must === true })).filter(check => check.text !== '').slice(0, 8)
    if (checks.length === 0) throw new Error('a case needs at least one check')
    if (!checks.some(check => check.must)) checks[0]!.must = true
    const now = this.clock().toISOString()
    return {
      id: existing?.id ?? randomUUID(), skillName: input.skillName, title, prompt,
      ...(input.context === undefined || input.context.trim() === '' ? {} : { context: clip(input.context, 4_000) }),
      ...((input.requiresVision ?? existing?.requiresVision) === true ? { requiresVision: true } : {}),
      checks, origin: existing?.origin ?? origin, enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    }
  }

  saveCase(input: CaseInput): Promise<EvalCase> {
    return this.write(() => {
      const evals = this.store.evals()
      const existing = input.id === undefined ? undefined : evals.cases.find(candidate => candidate.id === input.id)
      if (input.id !== undefined && existing === undefined) throw new Error('case not found: ' + input.id)
      if (existing === undefined && evals.cases.filter(entry => entry.skillName === input.skillName).length >= MAX_CASES_PER_SKILL) throw new Error(`a skill keeps at most ${MAX_CASES_PER_SKILL} cases`)
      const entry = this.normalizeCase(input, existing, { kind: 'manual' })
      evals.cases = existing === undefined ? [entry, ...evals.cases] : evals.cases.map(candidate => candidate.id === entry.id ? entry : candidate)
      this.store.saveEvals(evals)
      this.touch()
      return entry
    })
  }

  deleteCase(id: string): Promise<{ deleted: string }> {
    return this.write(() => {
      const evals = this.store.evals()
      if (!evals.cases.some(entry => entry.id === id)) throw new Error('case not found: ' + id)
      evals.cases = evals.cases.filter(entry => entry.id !== id)
      this.store.saveEvals(evals)
      this.touch()
      return { deleted: id }
    })
  }

  /** Cases a task Agent derived from a trajectory; similar ones are skipped, not duplicated. */
  addCases(input: { skillName: string; trajectoryId?: string; steps?: number[]; cases: CaseInput[] }): Promise<{ added: EvalCase[]; skipped: number }> {
    return this.write(() => {
      const evals = this.store.evals()
      const added: EvalCase[] = []
      let skipped = 0
      for (const raw of input.cases) {
        const entry = this.normalizeCase({ ...raw, skillName: input.skillName }, undefined, {
          kind: 'trajectory', ...(input.trajectoryId === undefined ? {} : { trajectoryId: input.trajectoryId }), ...(input.steps === undefined ? {} : { steps: input.steps }),
        })
        if (similarCase(evals.cases, entry.skillName, entry.title, entry.prompt) !== undefined || evals.cases.filter(candidate => candidate.skillName === entry.skillName).length >= MAX_CASES_PER_SKILL) { skipped++; continue }
        evals.cases.unshift(entry)
        added.push(entry)
      }
      this.store.saveEvals(evals)
      if (input.trajectoryId !== undefined && added.length > 0) {
        const ledger = this.store.ledger()
        const summary = ledger.trajectories.find(candidate => candidate.id === input.trajectoryId)
        if (summary !== undefined) {
          summary.caseIds = [...summary.caseIds, ...added.map(entry => entry.id)]
          try {
            const trajectory = this.store.trajectory(input.trajectoryId)
            this.store.saveTrajectory({ ...trajectory, caseIds: summary.caseIds })
          } catch { /* The summary alone still links the cases. */ }
        }
        this.store.saveLedger(ledger)
      } else this.touch()
      return { added, skipped }
    })
  }

  recordDraft(workspace: string | undefined, input: { suggestionId?: string; skillName: string; content: string; notes: string; changes: string[]; guidance: string[]; targetRoot?: SkillRootKind }): Promise<SkillDraft> {
    return this.write(() => {
      validateSkillContent(input.content, input.skillName)
      const ledger = this.store.ledger()
      const catalog = this.catalog(workspace)
      const loaded = activeSkill(catalog, input.skillName)
      const now = this.clock().toISOString()
      const suggestion = input.suggestionId === undefined ? undefined : ledger.suggestions.find(candidate => candidate.id === input.suggestionId)
      if (input.suggestionId !== undefined && suggestion === undefined) throw new Error('suggestion not found: ' + input.suggestionId)
      for (const draft of ledger.drafts) {
        if (draft.status === 'ready' && draft.skillName === input.skillName && draft.suggestionId === input.suggestionId) { draft.status = 'discarded'; draft.updatedAt = now }
      }
      const draft: SkillDraft = {
        id: randomUUID(),
        ...(input.suggestionId === undefined ? {} : { suggestionId: input.suggestionId }),
        skillName: input.skillName,
        action: loaded === undefined ? 'create' : 'update',
        ...(loaded === undefined ? { targetRoot: input.targetRoot ?? DEFAULT_ROOT } : { baseKey: loaded.key, baseHash: loaded.hash }),
        content: input.content,
        notes: clip(input.notes, 2_000),
        changes: input.changes.map(change => clip(change, 300)).filter(Boolean).slice(0, 12),
        guidance: input.guidance.map(text => clip(text, 2_000)).filter(Boolean).slice(-8),
        status: 'ready',
        runIds: [],
        createdAt: now,
        updatedAt: now,
      }
      ledger.drafts.unshift(draft)
      if (suggestion !== undefined) { suggestion.status = 'review'; suggestion.draftId = draft.id; suggestion.updatedAt = now; delete suggestion.lastError }
      this.store.saveLedger(ledger)
      return draft
    })
  }

  updateDraft(input: { id: string; content: string }): Promise<SkillDraft> {
    return this.write(() => {
      const ledger = this.store.ledger()
      const draft = ledger.drafts.find(candidate => candidate.id === input.id)
      if (draft === undefined || draft.status !== 'ready') throw new Error('only a draft waiting for review can be edited')
      validateSkillContent(input.content, draft.skillName)
      draft.content = input.content
      draft.updatedAt = this.clock().toISOString()
      this.store.saveLedger(ledger)
      return draft
    })
  }

  /** Adopt a draft; a new skill goes to `root` when given, else where the draft was meant to go. */
  adoptDraft(workspace: string | undefined, id: string, input: { root?: SkillRootKind } = {}): Promise<{ skill: SkillSummary; version: SkillVersion }> {
    return this.write(() => {
      const ledger = this.store.ledger()
      const draft = ledger.drafts.find(candidate => candidate.id === id)
      if (draft === undefined || draft.status !== 'ready') throw new Error('only a draft waiting for review can be adopted')
      validateSkillContent(draft.content, draft.skillName)
      const catalog = this.catalog(workspace)
      let key: string
      let previous: string | undefined
      if (draft.action === 'update') {
        const base = catalog.skills.find(skill => skill.key === draft.baseKey)
        if (base === undefined) throw new Error(`${draft.skillName} is no longer in ${draft.baseKey?.split(':')[0]}; draft it again`)
        previous = this.requireHash(base, draft.baseHash)
        writeFileAtomic(base.path, draft.content)
        key = base.key
      } else {
        const root = input.root ?? draft.targetRoot ?? DEFAULT_ROOT
        if (activeSkill(catalog, draft.skillName) !== undefined) throw new Error(`${draft.skillName} exists now; draft it again as an update`)
        const directory = join(rootPath(catalog, root), draft.skillName)
        if (existsSync(directory) || existsSync(directory + '.md')) throw new Error(`${draft.skillName} already exists in this root`)
        writeFileAtomic(join(directory, 'SKILL.md'), draft.content)
        key = `${root}:${draft.skillName}`
      }
      const now = this.clock().toISOString()
      const version = this.recordVersion(ledger, key, draft.content, 'evolution', previous, { draftId: draft.id, ...(draft.suggestionId === undefined ? {} : { suggestionId: draft.suggestionId }) })
      draft.status = 'adopted'
      draft.updatedAt = now
      const suggestion = draft.suggestionId === undefined ? undefined : ledger.suggestions.find(candidate => candidate.id === draft.suggestionId)
      if (suggestion !== undefined) { suggestion.status = 'adopted'; suggestion.updatedAt = now }
      this.store.saveLedger(ledger)
      return { skill: findSkill(this.catalog(workspace), key), version }
    })
  }

  discardDraft(id: string): Promise<SkillDraft> {
    return this.write(() => {
      const ledger = this.store.ledger()
      const draft = ledger.drafts.find(candidate => candidate.id === id)
      if (draft === undefined || draft.status !== 'ready') throw new Error('only a draft waiting for review can be discarded')
      const now = this.clock().toISOString()
      draft.status = 'discarded'
      draft.updatedAt = now
      const suggestion = draft.suggestionId === undefined ? undefined : ledger.suggestions.find(candidate => candidate.id === draft.suggestionId)
      if (suggestion !== undefined && suggestion.status === 'review') { suggestion.status = 'pending'; delete suggestion.draftId; suggestion.updatedAt = now }
      this.store.saveLedger(ledger)
      return draft
    })
  }

  /** The content a run tests, resolved from its target. */
  targetContent(workspace: string | undefined, skillName: string, target: RunTarget): { content?: string; target: RunTarget } {
    if (target.kind === 'none') return { target: { kind: 'none' } }
    if (target.kind === 'draft') {
      const draft = this.store.ledger().drafts.find(candidate => candidate.id === target.draftId)
      if (draft === undefined || draft.skillName !== skillName) throw new Error('draft not found for this skill')
      return { content: draft.content, target: { kind: 'draft', draftId: draft.id, hash: sha256(draft.content) } }
    }
    if (target.kind === 'version') {
      const version = this.store.ledger().versions.find(candidate => candidate.id === target.versionId)
      if (version === undefined) throw new Error('version not found: ' + target.versionId)
      return { content: this.store.versionContent(version), target: { kind: 'version', versionId: version.id, skillKey: version.skillKey, hash: version.hash } }
    }
    const loaded = activeSkill(this.catalog(workspace), skillName)
    if (loaded === undefined) throw new Error(`${skillName} has no file to test; test a draft or no skill`)
    const document = readSkillDocument(loaded)
    return { content: document.content, target: { kind: 'current', skillKey: loaded.key, hash: document.hash } }
  }

  startRun(input: { skillName: string; target: RunTarget; caseIds: string[] }): Promise<BacktestRun> {
    return this.write(() => {
      const evals = this.store.evals()
      const cases = input.caseIds.map(id => evals.cases.find(entry => entry.id === id && entry.skillName === input.skillName))
      if (cases.length === 0 || cases.some(entry => entry === undefined)) throw new Error('a run needs at least one case of this skill')
      const run: BacktestRun = {
        id: randomUUID(), skillName: input.skillName, target: input.target, status: 'running',
        progress: { done: 0, total: cases.length }, caseIds: input.caseIds, results: [], startedAt: this.clock().toISOString(),
      }
      evals.runs.unshift(run)
      this.store.saveEvals(evals)
      if (input.target.draftId !== undefined) {
        const ledger = this.store.ledger()
        const draft = ledger.drafts.find(candidate => candidate.id === input.target.draftId)
        if (draft !== undefined) draft.runIds = [...draft.runIds, run.id].slice(-12)
        this.store.saveLedger(ledger)
      } else this.touch()
      return run
    })
  }

  /** Attach a baseline run to the draft it is compared with. */
  linkRun(draftId: string, runId: string): Promise<void> {
    return this.write(() => {
      const ledger = this.store.ledger()
      const draft = ledger.drafts.find(candidate => candidate.id === draftId)
      if (draft === undefined) throw new Error('draft not found: ' + draftId)
      if (!draft.runIds.includes(runId)) draft.runIds = [...draft.runIds, runId].slice(-12)
      this.store.saveLedger(ledger)
    })
  }

  progressRun(input: { id: string; result: CaseResult }): Promise<BacktestRun> {
    return this.write(() => {
      const evals = this.store.evals()
      const run = evals.runs.find(candidate => candidate.id === input.id)
      if (run === undefined || run.status !== 'running') throw new Error('run is not running: ' + input.id)
      const result: CaseResult = {
        ...input.result,
        steps: input.result.steps.map(step => clip(step, 400)).slice(0, 20),
        answer: clip(input.result.answer, 2_000),
        checks: input.result.checks.map(check => ({ ...check, note: clip(check.note, 300) })),
        ...(input.result.summary === undefined ? {} : { summary: clip(input.result.summary, 500) }),
        ...(input.result.error === undefined ? {} : { error: clip(input.result.error, 500) }),
      }
      run.results = [...run.results.filter(existing => existing.caseId !== result.caseId), result]
      run.progress = { done: run.results.length, total: run.progress.total }
      this.store.saveEvals(evals)
      this.touch()
      return run
    })
  }

  finishRun(input: { id: string; status: 'completed' | 'failed'; error?: string }): Promise<BacktestRun> {
    return this.write(() => {
      const evals = this.store.evals()
      const run = evals.runs.find(candidate => candidate.id === input.id)
      if (run === undefined) throw new Error('run not found: ' + input.id)
      run.status = input.status
      run.finishedAt = this.clock().toISOString()
      if (input.error !== undefined) run.error = clip(input.error, 500)
      if (run.results.length > 0) {
        const { passRate, score, errors } = runScore(run.results)
        delete run.passRate
        delete run.score
        Object.assign(run, passRate === undefined ? {} : { passRate }, score === undefined ? {} : { score }, errors > 0 ? { errors } : {})
      }
      this.store.saveEvals(evals)
      this.touch()
      return run
    })
  }

  recordReview(workspace: string | undefined, input: ReviewRecordInput): Promise<ReviewRecordResult> {
    return this.write(() => {
      const ledger = this.store.ledger()
      const evals: EvalsFile = this.store.evals()
      const { result, trajectory, removedTrajectories } = admitReview({
        ledger, evals, policy: policyFrom(input.policy), catalog: this.catalog(workspace), now: this.clock(), id: randomUUID,
      }, input)
      this.store.saveTrajectory(trajectory)
      for (const id of removedTrajectories) this.store.deleteTrajectory(id)
      this.store.saveEvals(evals)
      this.store.saveLedger(ledger)
      return result
    })
  }

  trajectorySummary(trajectory: Trajectory): TrajectorySummary {
    return trajectorySummary(trajectory)
  }

  // ---- market --------------------------------------------------------------

  /** The sources this Source knows: the built-in catalog and search index first, then the ones added. */
  private registryRecords(): Array<RegistryRecord & { kind: MarketSourceKind }> {
    const stored = this.store.registries()
    const enabled = (id: string) => stored.find(record => record.id === id)?.enabled ?? true
    return [
      { id: OFFICIAL_REGISTRY_ID, kind: 'catalog', location: OFFICIAL_REGISTRY_URL, builtin: true, enabled: enabled(OFFICIAL_REGISTRY_ID) },
      { id: SKILLS_SH_ID, kind: 'search', location: SKILLS_SH_URL, builtin: true, enabled: enabled(SKILLS_SH_ID) },
      ...stored.filter(record => record.id !== OFFICIAL_REGISTRY_ID && record.id !== SKILLS_SH_ID).map(record => ({ ...record, kind: record.kind ?? 'catalog', builtin: false })),
    ]
  }

  /** The newest copy of a registry: its cache, or the packaged snapshot for the official one. */
  private registryFile(record: RegistryRecord): { registry?: MarketRegistryFile; fetchedAt?: string; error?: string } {
    const cache = this.store.registryCache(record.id)
    if (cache?.registry !== undefined) return cache
    if (record.id === OFFICIAL_REGISTRY_ID) return { registry: bundledOfficialRegistry(), ...(cache?.error === undefined ? {} : { error: cache.error }) }
    return cache ?? {}
  }

  /** A listed source's skills as it publishes them now. */
  private loadSource(kind: MarketSourceKind, location: string, signal?: AbortSignal): Promise<MarketRegistryFile> {
    switch (kind) {
      case 'catalog': return loadRegistry(location, this.fetcher, signal)
      case 'well-known': return loadDiscovery(location, this.fetcher, signal)
      case 'github': return loadRepository(location, this.fetcher, signal)
      case 'search': return Promise.reject(new Error('a search source is searched, not listed'))
    }
  }

  /** The state of a market skill against what is loaded now and where it was installed from. */
  private installState(catalog: SkillCatalog, installs: readonly MarketInstall[], registry: string, name: string, version: string | undefined, sameOrigin?: (install: MarketInstall) => boolean): { state: MarketInstallState; skillKey?: string; installedVersion?: string } {
    const skill = activeSkill(catalog, name)
    if (skill === undefined) return { state: 'available' }
    const install = installs.find(candidate => candidate.skillKey === skill.key)
    const fromHere = install !== undefined && install.name === name && (install.registryId === registry || sameOrigin?.(install) === true)
    const state: MarketInstallState = !fromHere ? 'conflict'
      : skill.hash !== install!.hash ? 'modified'
      : version !== undefined && install!.version !== undefined && version !== install!.version ? 'update'
      : 'installed'
    return { state, skillKey: skill.key, ...(fromHere && install!.version !== undefined ? { installedVersion: install!.version } : {}) }
  }

  marketView(workspace: string | undefined): MarketView {
    const now = this.clock().getTime()
    const catalog = this.catalog(workspace)
    const installs = this.store.ledger().installs
    const registries: MarketRegistry[] = []
    const items: MarketItem[] = []
    const categories = new Map<string, MarketView['categories'][number]>()
    const stale: string[] = []
    for (const record of this.registryRecords()) {
      const file = record.kind === 'search' ? {} : this.registryFile(record)
      registries.push({
        id: record.id, kind: record.kind, location: record.location, builtin: record.builtin, enabled: record.enabled, entries: file.registry?.skills.length ?? 0,
        ...(file.registry?.name === undefined ? {} : { name: file.registry.name }),
        ...(file.registry?.description === undefined ? {} : { description: file.registry.description }),
        ...(file.registry?.homepage === undefined ? {} : { homepage: file.registry.homepage }),
        ...(file.fetchedAt === undefined ? {} : { fetchedAt: file.fetchedAt }),
        ...(file.error === undefined || record.builtin && file.fetchedAt === undefined ? {} : { error: file.error }),
      })
      if (!record.enabled || record.kind === 'search') continue
      if (file.fetchedAt === undefined || now - Date.parse(file.fetchedAt) > REGISTRY_REFRESH_MS) stale.push(record.id)
      for (const category of file.registry?.categories ?? []) if (!categories.has(category.id)) categories.set(category.id, category)
      for (const entry of file.registry?.skills ?? []) items.push({ ...entry, registryId: record.id, ...this.installState(catalog, installs, record.id, entry.name, entry.version) })
    }
    return { registries, categories: [...categories.values()], items, stale }
  }

  /**
   * Search the search sources. Each result says whether it is installed; one
   * installed from a catalog out of the same repository counts as installed.
   */
  async searchMarket(workspace: string | undefined, query: string, signal?: AbortSignal): Promise<MarketSearchResult> {
    const text = query.trim().slice(0, 200)
    const index = this.registryRecords().find(record => record.id === SKILLS_SH_ID)!
    if (text.length < 2 || !index.enabled) return { query: text, items: [] }
    let found: Awaited<ReturnType<typeof searchSkillsSh>>
    try { found = await searchSkillsSh(text, this.fetcher, signal) } catch (error) {
      if (signal?.aborted === true) throw error
      return { query: text, items: [], error: error instanceof Error ? error.message : String(error) }
    }
    const catalog = this.catalog(workspace)
    const installs = this.store.ledger().installs
    return {
      query: text,
      items: found.map(skill => ({
        name: skill.name, description: '', source: { type: 'indexed', id: skill.id }, origin: skill.origin, installs: skill.installs, author: skill.origin.split('/')[0]!,
        registryId: SKILLS_SH_ID,
        ...this.installState(catalog, installs, SKILLS_SH_ID, skill.name, undefined, install => install.source.type === 'github' && install.source.repo === skill.origin),
      })),
    }
  }

  private entry(registry: string, name: string): { record: RegistryRecord; entry: MarketRegistryFile['skills'][number] } {
    const record = this.registryRecords().find(candidate => candidate.id === registry)
    if (record === undefined) throw new Error('unknown skill registry: ' + registry)
    const entry = this.registryFile(record).registry?.skills.find(candidate => candidate.name === name)
    if (entry === undefined) throw new Error(`${name} is not in registry ${registry}; refresh the market and try again`)
    return { record, entry }
  }

  /** Where a skill the search index found lives: its repository folder, or its site's index entry. */
  private indexedEntry(id: string, signal?: AbortSignal): Promise<MarketEntry> {
    const parts = indexedParts(id)
    if (parts === undefined) throw new Error('not a skill id of skills.sh: ' + id)
    return resolveIndexed({ origin: parts.origin, skill: parts.skill, name: parts.skill }, this.fetcher, signal)
  }

  async marketPreview(registry: string, name: string, signal?: AbortSignal): Promise<MarketPreview> {
    if (registry === SKILLS_SH_ID) {
      const audits = skillsShAudits(name, this.fetcher, signal)
      try {
        const entry = await this.indexedEntry(name, signal)
        const [content, files] = await Promise.all([fetchSkillDocument(entry, '', this.fetcher, signal), listSkillFiles(entry, '', this.fetcher, signal)])
        return { registryId: registry, name, content, files: files.slice(0, 200), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), audits: await audits, ...(entry.homepage === undefined ? {} : { homepage: entry.homepage }) }
      } catch (error) {
        // GitHub may decline to list a repository for a while; the index's own copy still shows the skill.
        if (signal?.aborted === true) throw error
        const snapshot = await skillsShSnapshot(name, this.fetcher, signal).catch(() => { throw error })
        return {
          registryId: registry, name, content: snapshot.find(file => file.path === 'SKILL.md')!.data.toString('utf8'),
          files: snapshot.map(file => ({ path: file.path, bytes: file.data.byteLength })).slice(0, 200), totalBytes: snapshot.reduce((sum, file) => sum + file.data.byteLength, 0),
          audits: await audits, partial: true, homepage: `${SKILLS_SH_URL}/${name}`,
        }
      }
    }
    const { record, entry } = this.entry(registry, name)
    const [content, files] = await Promise.all([fetchSkillDocument(entry, record.location, this.fetcher, signal), listSkillFiles(entry, record.location, this.fetcher, signal)])
    return { registryId: registry, name, content, files: files.slice(0, 200), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), ...(entry.homepage === undefined ? {} : { homepage: entry.homepage }) }
  }

  /** Fetch the named sources (all enabled ones by default) and keep what each answered. */
  async refreshMarket(ids?: readonly string[], signal?: AbortSignal): Promise<MarketView['registries']> {
    const records = this.registryRecords().filter(record => record.enabled && record.kind !== 'search' && (ids === undefined || ids.includes(record.id)))
    const results = await Promise.all(records.map(async record => {
      try { return { record, registry: await this.loadSource(record.kind, record.location, signal) } } catch (error) { return { record, error: error instanceof Error ? error.message : String(error) } }
    }))
    await this.write(() => {
      const at = this.clock().toISOString()
      for (const result of results) {
        const previous = this.store.registryCache(result.record.id)
        this.store.saveRegistryCache(result.record.id, result.registry !== undefined
          ? { fetchedAt: at, registry: result.registry }
          // A failed refresh keeps the copy it had, and says why it is not newer.
          : { ...(previous?.registry === undefined ? {} : { registry: previous.registry }), ...(previous?.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt }), error: result.error! })
      }
      this.touch()
    })
    return this.marketView(undefined).registries
  }

  /**
   * Add a source from what the user pasted: a GitHub repository, a site
   * publishing an Agent Skills index, or a JSON file by URL or path — a
   * catalog, a discovery index, or a plugin marketplace on GitHub.
   */
  async addRegistry(input: string, signal?: AbortSignal): Promise<MarketRegistry> {
    const detected = detectSource(input)
    if (detected === undefined) throw new Error('add a GitHub repository (owner/repo), a website, or a JSON file by URL or absolute path')
    const taken = () => this.registryRecords().some(record => record.location === detected.location)
    if (taken()) throw new Error('this source is already added')
    let kind: MarketSourceKind
    let location = detected.location
    let registry: MarketRegistryFile
    if (detected.kind === 'json' || detected.kind === 'catalog') {
      const value = await loadJson(location, this.fetcher, signal)
      if (isPluginMarketplace(value)) {
        const repository = /^https?:\/\//u.test(location) ? marketplaceRepository(location) : undefined
        if (repository === undefined) throw new Error('a plugin marketplace is read from its GitHub repository; add the repository instead')
        kind = 'github'
        location = repository
        if (this.registryRecords().some(record => record.location === location)) throw new Error('this source is already added')
        registry = await loadRepository(location, this.fetcher, signal)
      } else if (isDiscoveryIndex(value)) {
        if (!/^https?:\/\//u.test(location)) throw new Error('an Agent Skills index is read from the site that publishes it')
        kind = 'well-known'
        registry = parseDiscovery(value, location)
      } else {
        kind = 'catalog'
        registry = parseRegistry(value).registry
      }
    } else {
      kind = detected.kind
      registry = await this.loadSource(kind, location, signal)
    }
    if (kind !== 'catalog' && registry.skills.length === 0) throw new Error('this source publishes no skill DSH can load')
    const id = await this.write(() => {
      const stored = this.store.registries()
      const added = stored.filter(record => record.id !== OFFICIAL_REGISTRY_ID && record.id !== SKILLS_SH_ID)
      if (added.some(record => record.location === location)) throw new Error('this source is already added')
      const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 56)
      const declared = kind === 'catalog' ? registry.id : kind === 'github' ? slug(parseGithub(location)!.repo) : slug(new URL(location).host)
      const id = registryId(location, declared === '' ? undefined : declared, new Set(added.map(record => record.id)))
      this.store.saveRegistries([...stored.filter(record => record.id === OFFICIAL_REGISTRY_ID || record.id === SKILLS_SH_ID), ...added, { id, kind, location, enabled: true, builtin: false }])
      this.store.saveRegistryCache(id, { fetchedAt: this.clock().toISOString(), registry })
      this.touch()
      return id
    })
    return this.marketView(undefined).registries.find(record => record.id === id)!
  }

  removeRegistry(id: string): Promise<{ removed: string }> {
    return this.write(() => {
      if (id === OFFICIAL_REGISTRY_ID || id === SKILLS_SH_ID) throw new Error('a built-in source can be switched off, not removed')
      const records = this.store.registries()
      if (!records.some(record => record.id === id)) throw new Error('unknown skill registry: ' + id)
      this.store.saveRegistries(records.filter(record => record.id !== id))
      this.store.deleteRegistryCache(id)
      this.touch()
      return { removed: id }
    })
  }

  toggleRegistry(id: string, enabled: boolean): Promise<MarketRegistry> {
    return this.write(() => {
      const records = this.registryRecords()
      const record = records.find(candidate => candidate.id === id)
      if (record === undefined) throw new Error('unknown skill registry: ' + id)
      this.store.saveRegistries(records.map(candidate => candidate.id === id ? { ...candidate, enabled } : candidate))
      this.touch()
      return this.marketView(undefined).registries.find(candidate => candidate.id === id)!
    })
  }

  /**
   * Install a market skill, or update one installed from the same entry. The
   * files are fetched before the lock, staged, checked against DSH's rules,
   * then moved into place; a replaced folder goes to the trash first. A
   * skill the search index found installs from its repository or site, under
   * the name its own `SKILL.md` gives.
   */
  async installMarket(workspace: string | undefined, input: { registryId: string; name: string; root?: SkillRootKind; overwrite?: boolean }, signal?: AbortSignal): Promise<{ skill: SkillSummary; updated: boolean }> {
    const indexed = input.registryId === SKILLS_SH_ID
    const { record, entry } = indexed
      ? { record: this.registryRecords().find(candidate => candidate.id === SKILLS_SH_ID)!, entry: await this.indexedEntry(input.name, signal) }
      : this.entry(input.registryId, input.name)
    const files = await fetchSkillFiles(entry, record.location, this.fetcher, signal)
    const document = files.find(file => file.path === 'SKILL.md')!.data.toString('utf8')
    const name = indexed ? skillMeta(document)?.name ?? entry.name : entry.name
    validateSkillContent(document, name)
    return this.write(() => {
      const catalog = this.catalog(workspace)
      const ledger = this.store.ledger()
      const existing = activeSkill(catalog, name)
      const install = existing === undefined ? undefined : ledger.installs.find(candidate => candidate.skillKey === existing.key)
      if (existing !== undefined && (install === undefined || install.registryId !== record.id || install.name !== name)) {
        throw new Error(`a skill named ${name} already exists in ${existing.root}; it did not come from this market entry`)
      }
      if (existing !== undefined && existing.hash !== install!.hash && input.overwrite !== true) {
        throw new Error(`${name} was edited after it was installed; confirm to replace your changes`)
      }
      const root = existing?.root ?? input.root ?? DEFAULT_ROOT
      const target = existing === undefined ? join(rootPath(catalog, root), name) : existing.layout === 'bundle' ? dirname(existing.path) : existing.path
      if (existing === undefined && (existsSync(target) || existsSync(target + '.md'))) throw new Error(`${name} already exists in this root`)
      const staged = stageFiles(this.store.stagingDirectory(), files)
      const previous = existing === undefined ? undefined : readFileSync(existing.path, 'utf8')
      let trashed: string | undefined
      try {
        if (existing !== undefined) trashed = this.store.trash(target, name, this.trashOrigin(existing, catalog))
        const finalTarget = existing?.layout === 'flat' ? join(dirname(target), name) : target
        moveInto(staged, finalTarget)
      } catch (error) {
        rmSync(staged, { recursive: true, force: true })
        if (trashed !== undefined && !existsSync(target)) try { renameSync(trashed, target) } catch { /* The trash keeps it. */ }
        throw error
      }
      const key = `${root}:${name}`
      const now = this.clock().toISOString()
      const hash = sha256(document)
      ledger.installs = [
        { skillKey: key, registryId: record.id, name, ...(entry.version === undefined ? {} : { version: entry.version }), source: entry.source, hash, files: files.length, installedAt: now } satisfies MarketInstall,
        ...ledger.installs.filter(candidate => candidate.skillKey !== key),
      ]
      this.recordVersion(ledger, key, document, 'install', previous, { note: `${record.id}/${indexed ? input.name : name}` })
      this.store.saveLedger(ledger)
      return { skill: findSkill(this.catalog(workspace), key), updated: existing !== undefined }
    })
  }

  installs(): MarketInstall[] {
    return this.store.ledger().installs
  }
}

/** Write downloaded files into a fresh staging folder, never outside it. */
function stageFiles(stagingRoot: string, files: readonly SkillFile[]): string {
  const directory = join(stagingRoot, randomUUID())
  for (const file of files) {
    const path = join(directory, ...file.path.split('/'))
    if (!path.startsWith(directory)) throw new Error('a file of the skill escapes its folder: ' + file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.data)
  }
  return directory
}

/** Move a staged folder into place, copying when it lives on another volume. */
function moveInto(staged: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true })
  try {
    renameSync(staged, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    cpSync(staged, target, { recursive: true, errorOnExist: true })
    rmSync(staged, { recursive: true, force: true })
  }
}
