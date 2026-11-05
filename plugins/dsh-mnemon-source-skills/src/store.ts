import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  BacktestRun, DraftPreferences, EvalCase, MarketInstall, MarketRegistryFile, MarketSourceKind, ModelRoute, ReviewLogEntry, SkillDraft, SkillRootKind, SkillSuggestion, SkillVersion, Trajectory, TrajectorySummary, TrashEntry,
} from './contracts.ts'

export const MAX_TRAJECTORIES = 100
export const MAX_REVIEWS = 200
export const MAX_DRAFTS = 60
export const MAX_RUNS_PER_SKILL = 20
export const MAX_VERSIONS_PER_SKILL = 30
export const MAX_CASES_PER_SKILL = 40

export interface LedgerFile {
  version: 1
  /** Bumped by every write this Source makes; part of the management revision. */
  generation: number
  suggestions: SkillSuggestion[]
  drafts: SkillDraft[]
  reviews: ReviewLogEntry[]
  versions: SkillVersion[]
  trajectories: TrajectorySummary[]
  /** Skills installed from a market, by skill key. */
  installs: MarketInstall[]
}

export interface RegistryRecord {
  id: string
  /** How the source publishes; records written before kinds existed are catalogs. */
  kind?: MarketSourceKind
  location: string
  enabled: boolean
  builtin: boolean
}

export interface RegistryCache {
  fetchedAt?: string
  registry?: MarketRegistryFile
  error?: string
}

export interface EvalsFile {
  version: 1
  cases: EvalCase[]
  runs: BacktestRun[]
}

function emptyLedger(): LedgerFile {
  return { version: 1, generation: 0, suggestions: [], drafts: [], reviews: [], versions: [], trajectories: [], installs: [] }
}

function emptyEvals(): EvalsFile {
  return { version: 1, cases: [], runs: [] }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

/** An opaque, filesystem-safe directory name for one skill key. */
export function keyDirectory(skillKey: string): string {
  return createHash('sha256').update(skillKey).digest('hex').slice(0, 16)
}

/** A dangling symlink still occupies its name and must never be overwritten. */
export function entryExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

/** Where a trashed entry came from, as recorded beside it. */
interface TrashSource {
  root?: SkillRootKind
  key?: string
  originalPath?: string
  workspace?: string
}

/** The sidecar a trashed entry keeps, so the page can name and restore it later. */
interface TrashRecord extends TrashSource {
  version: 1
  name: string
  kind: 'bundle' | 'file'
  trashedAt: string
}

/** Bytes an entry occupies on disk; an unreadable entry reports 0. */
function trashSize(path: string): number {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return 0
    if (!info.isDirectory()) return info.size
    return readdirSync(path).reduce((total, name) => total + trashSize(join(path, name)), 0)
  } catch { return 0 }
}

/** The removal time encoded in an entry id, for entries that predate sidecars. */
function trashStamp(id: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/u.exec(id)
  return match === null ? undefined : `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
}

/** References are navigation links, not evidence: keep the records when a suggestion is deleted. */
function pruneSuggestionLinks(ledger: LedgerFile): LedgerFile {
  const ids = new Set(ledger.suggestions.map(suggestion => suggestion.id))
  for (const review of ledger.reviews) {
    if (review.suggestionIds === undefined) continue
    const kept = review.suggestionIds.filter(id => ids.has(id))
    // A review can strengthen evidence without counting an inserted/updated suggestion.
    if (kept.length !== review.suggestionIds.length) review.suggestions = Math.min(review.suggestions, kept.length)
    if (kept.length === 0) delete review.suggestionIds
    else review.suggestionIds = kept
  }
  for (const trajectory of ledger.trajectories) trajectory.suggestionIds = trajectory.suggestionIds.filter(id => ids.has(id))
  return ledger
}

/**
 * The Skills Source's own files under `<dataDir>/skills`. Every file is
 * replaced atomically; callers serialize writes with the storage lock.
 */
export class SkillsStore {
  constructor(readonly directory: string) {}

  private path(name: string): string {
    return join(this.directory, name)
  }

  /** A directory beside the data, for staging a download before it is moved into place. */
  stagingDirectory(): string {
    return this.path('staging')
  }

  private readJson(name: string): unknown {
    const path = this.path(name)
    if (!existsSync(path)) return undefined
    try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch (error) {
      throw new Error(`Skills Source file is unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private writeAtomic(path: string, content: string): void {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, content, { mode: 0o600 })
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  private writeJson(name: string, value: unknown): void {
    this.writeAtomic(this.path(name), `${JSON.stringify(value, null, 2)}\n`)
  }

  /** Name, size and time of each file the revision depends on. */
  fingerprint(): string {
    return ['ledger.json', 'evals.json'].map(name => {
      try {
        const info = statSync(this.path(name))
        return `${name}:${info.size}:${info.mtimeMs}`
      } catch { return `${name}:-` }
    }).join('|')
  }

  ledger(): LedgerFile {
    const value = object(this.readJson('ledger.json'))
    if (value === undefined) return emptyLedger()
    // Normalize legacy links in memory; reads must not write or invalidate management revisions.
    return pruneSuggestionLinks({
      version: 1,
      generation: typeof value.generation === 'number' ? value.generation : 0,
      suggestions: array(value.suggestions),
      drafts: array(value.drafts),
      reviews: array(value.reviews),
      versions: array(value.versions),
      trajectories: array(value.trajectories),
      installs: array(value.installs),
    })
  }

  /**
   * What the user picked for draft and backtest runs, kept out of `fingerprint()`
   * on purpose: changing a picker must not invalidate an open page's revision.
   */
  preferences(): DraftPreferences {
    const stored = object(this.readJson('preferences.json')) ?? {}
    const route = (value: unknown): ModelRoute | undefined => {
      const picked = object(value)
      const provider = typeof picked?.provider === 'string' ? picked.provider : undefined
      const model = typeof picked?.model === 'string' ? picked.model : undefined
      return provider !== undefined && model !== undefined ? { provider, model } : undefined
    }
    const routes = (value: unknown): Record<string, ModelRoute> => {
      const result: Record<string, ModelRoute> = {}
      const map = object(value)
      if (map !== undefined) for (const [key, item] of Object.entries(map)) {
        const picked = route(item)
        if (picked !== undefined) result[key] = picked
      }
      return result
    }
    const draft = route(stored.draftModel)
    const run = route(stored.runModel)
    return {
      version: 1,
      ...(draft === undefined ? {} : { draftModel: draft }),
      ...(run === undefined ? {} : { runModel: run }),
      suggestionModels: routes(stored.suggestionModels),
      skillRunModels: routes(stored.skillRunModels),
    }
  }

  savePreferences(preferences: DraftPreferences): void {
    this.writeJson('preferences.json', preferences)
  }

  saveLedger(ledger: LedgerFile): void {
    pruneSuggestionLinks(ledger)
    ledger.generation += 1
    ledger.reviews = ledger.reviews.slice(0, MAX_REVIEWS)
    const kept = new Set<string>()
    ledger.drafts = ledger.drafts.filter(draft => {
      if (draft.status === 'ready') return true
      kept.add(draft.id)
      return kept.size <= MAX_DRAFTS
    })
    this.writeJson('ledger.json', ledger)
  }

  evals(): EvalsFile {
    const value = object(this.readJson('evals.json'))
    return value === undefined ? emptyEvals() : { version: 1, cases: array(value.cases), runs: array(value.runs) }
  }

  saveEvals(evals: EvalsFile): void {
    const counts = new Map<string, number>()
    // Runs are newest first; keep the newest per skill, and every running one.
    evals.runs = evals.runs.filter(run => {
      const count = (counts.get(run.skillName) ?? 0) + 1
      counts.set(run.skillName, count)
      return run.status === 'running' || count <= MAX_RUNS_PER_SKILL
    })
    this.writeJson('evals.json', evals)
  }

  trajectory(id: string): Trajectory {
    if (!/^[a-z0-9-]{1,80}$/u.test(id)) throw new Error('invalid trajectory id')
    const value = object(this.readJson(join('trajectories', `${id}.json`)))
    if (value === undefined) throw new Error('trajectory not found: ' + id)
    const trajectory = value as unknown as Trajectory
    const ids = new Set(this.ledger().suggestions.map(suggestion => suggestion.id))
    trajectory.suggestionIds = trajectory.suggestionIds.filter(id => ids.has(id))
    for (const annotation of trajectory.annotations) {
      if (annotation.suggestionIds === undefined) continue
      const kept = annotation.suggestionIds.filter(id => ids.has(id))
      if (kept.length === 0) delete annotation.suggestionIds
      else annotation.suggestionIds = kept
    }
    return trajectory
  }

  saveTrajectory(trajectory: Trajectory): void {
    this.writeJson(join('trajectories', `${trajectory.id}.json`), trajectory)
  }

  deleteTrajectory(id: string): void {
    if (!/^[a-z0-9-]{1,80}$/u.test(id)) throw new Error('invalid trajectory id')
    rmSync(this.path(join('trajectories', `${id}.json`)), { force: true })
  }

  versionContent(version: SkillVersion): string {
    return readFileSync(this.path(join('versions', keyDirectory(version.skillKey), `${version.id}.md`)), 'utf8')
  }

  saveVersionContent(version: SkillVersion, content: string): void {
    this.writeAtomic(this.path(join('versions', keyDirectory(version.skillKey), `${version.id}.md`)), content)
  }

  deleteVersionContent(version: SkillVersion): void {
    rmSync(this.path(join('versions', keyDirectory(version.skillKey), `${version.id}.md`)), { force: true })
  }

  registries(): RegistryRecord[] {
    return array<RegistryRecord>(object(this.readJson(join('market', 'registries.json')))?.registries)
  }

  saveRegistries(registries: RegistryRecord[]): void {
    this.writeJson(join('market', 'registries.json'), { version: 1, registries })
  }

  registryCache(id: string): RegistryCache | undefined {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(id)) return undefined
    return object(this.readJson(join('market', 'cache', `${id}.json`))) as RegistryCache | undefined
  }

  saveRegistryCache(id: string, cache: RegistryCache): void {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(id)) throw new Error('invalid registry id')
    this.writeJson(join('market', 'cache', `${id}.json`), cache)
  }

  deleteRegistryCache(id: string): void {
    if (/^[a-z0-9][a-z0-9-]{0,62}$/u.test(id)) rmSync(this.path(join('market', 'cache', `${id}.json`)), { force: true })
  }

  /**
   * Move a bundle or a flat file out of DSH's reach, never deleting it, and
   * record where it came from so the page can offer to put it back.
   */
  trash(path: string, name: string, source: TrashSource = {}): string {
    const file = basename(path).endsWith('.md') && !existsSync(join(path, 'SKILL.md'))
    const trashedAt = new Date()
    let id: string
    let target: string
    do {
      id = `${trashedAt.toISOString().replace(/[:.]/gu, '-')}-${name}${file ? '.md' : ''}`
      target = this.path(join('trash', id))
      if (!entryExists(target)) break
      trashedAt.setTime(trashedAt.getTime() + 1)
    } while (true)
    mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 })
    try {
      renameSync(path, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      cpSync(path, target, { recursive: true, errorOnExist: true })
      rmSync(path, { recursive: true, force: true })
    }
    // The entry is already safe; a record is a convenience, so never fail the removal over it.
    try {
      this.writeJson(join('trash', `${id}.json`), { version: 1, name, kind: file ? 'file' : 'bundle', trashedAt: trashedAt.toISOString(), ...source } satisfies TrashRecord)
    } catch { /* an entry without a record still lists, but only as a name */ }
    return target
  }

  /** Every entry waiting in the Trash, newest first; entries removed before records existed still list. */
  trashEntries(): TrashEntry[] {
    let names: string[]
    try { names = readdirSync(this.path('trash')) } catch { return [] }
    const entries: TrashEntry[] = []
    for (const id of names) {
      if (id.endsWith('.json')) continue
      let record: Record<string, unknown> | undefined
      try { record = object(this.readJson(join('trash', `${id}.json`))) } catch { /* Older or damaged optional metadata must not hide the entry. */ }
      const stored = record === undefined ? undefined : record as Partial<TrashRecord>
      const name = typeof stored?.name === 'string' ? stored.name : /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)$/u.exec(id)?.[1]?.replace(/\.md$/u, '') ?? id
      entries.push({
        id,
        name,
        kind: stored?.kind === 'file' || stored?.kind === 'bundle' ? stored.kind : id.endsWith('.md') ? 'file' : 'bundle',
        trashedAt: typeof stored?.trashedAt === 'string' ? stored.trashedAt : trashStamp(id) ?? new Date(0).toISOString(),
        bytes: trashSize(this.path(join('trash', id))),
        ...(stored?.root === undefined ? {} : { root: stored.root }),
        ...(typeof stored?.key === 'string' ? { key: stored.key } : {}),
        ...(typeof stored?.originalPath === 'string' ? { originalPath: stored.originalPath } : {}),
        ...(typeof stored?.workspace === 'string' ? { workspace: stored.workspace } : {}),
      })
    }
    return entries.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt) || b.id.localeCompare(a.id))
  }

  /** The entry with this id, or a refusal: the caller names what it wants back or gone. */
  trashEntry(id: string): TrashEntry {
    const entry = this.trashEntries().find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error('trash entry not found: ' + id)
    return entry
  }

  /** Stage a complete restore beside the target before removing the recoverable entry. */
  restoreTrash(entry: TrashEntry, to: string, content?: string): string {
    const from = this.path(join('trash', entry.id))
    if (entryExists(to)) throw new Error(`${entry.name} already exists there; rename or remove it first`)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    const staging = join(dirname(to), `.mnemon-restore-${randomUUID()}`)
    try {
      if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), staging, entry.kind === 'bundle' ? 'dir' : 'file')
      else cpSync(from, staging, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
      if (content !== undefined) {
        const document = entry.kind === 'file' ? staging : join(staging, 'SKILL.md')
        if (lstatSync(staging).isSymbolicLink() || lstatSync(document).isSymbolicLink()) throw new Error('a linked skill cannot be renamed during restore')
        writeFileSync(document, content)
      }
      if (entryExists(to)) throw new Error(`${entry.name} already exists there; rename or remove it first`)
      renameSync(staging, to)
      rmSync(from, { recursive: true, force: true })
      rmSync(this.path(join('trash', `${entry.id}.json`)), { force: true })
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    return to
  }

  trashContent(entry: TrashEntry): string {
    return readFileSync(this.path(join('trash', entry.id, ...(entry.kind === 'file' ? [] : ['SKILL.md']))), 'utf8')
  }

  /** Delete an entry for good. */
  purgeTrash(entry: TrashEntry): void {
    rmSync(this.path(join('trash', entry.id)), { recursive: true, force: true })
    rmSync(this.path(join('trash', `${entry.id}.json`)), { force: true })
  }
}
