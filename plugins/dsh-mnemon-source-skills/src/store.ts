import { readBudget, type BudgetEntry } from './auto-adoption-budget.ts'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  BacktestRun, DraftPreferences, EvalCase, MarketInstall, MarketRegistryFile, MarketSourceKind, ModelRoute, ReviewLogEntry, SkillDraft, SkillRootKind, SkillSuggestion, SkillVersion, Trajectory, TrajectorySummary, TrashEntry,
} from './contracts.ts'

export const MAX_BUNDLE_SNAPSHOT_BYTES = 16 * 1024 * 1024
export const MAX_BUNDLE_SNAPSHOT_FILES = 1024

export const MAX_TRAJECTORIES = 100
export const MAX_REVIEWS = 200
export const MAX_DRAFTS = 60
export const MAX_RUNS_PER_SKILL = 20
export const MAX_VERSIONS_PER_SKILL = 30
export const MAX_CASES_PER_SKILL = 40

export interface LedgerFile {
  version: 1
  generation: number
  suggestions: SkillSuggestion[]
  drafts: SkillDraft[]
  reviews: ReviewLogEntry[]
  versions: SkillVersion[]
  trajectories: TrajectorySummary[]
  installs: MarketInstall[]
}

export interface RegistryRecord {
  id: string
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

export function keyDirectory(skillKey: string): string {
  return createHash('sha256').update(skillKey).digest('hex').slice(0, 16)
}

export function entryExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

interface TrashSource {
  root?: SkillRootKind
  key?: string
  originalPath?: string
  workspace?: string
}

interface TrashRecord extends TrashSource {
  version: 1
  name: string
  kind: 'bundle' | 'file'
  trashedAt: string
}

function trashSize(path: string): number {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return 0
    if (!info.isDirectory()) return info.size
    return readdirSync(path).reduce((total, name) => total + trashSize(join(path, name)), 0)
  } catch { return 0 }
}

function trashStamp(id: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/u.exec(id)
  return match === null ? undefined : `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
}

function pruneSuggestionLinks(ledger: LedgerFile): LedgerFile {
  const ids = new Set(ledger.suggestions.map(suggestion => suggestion.id))
  for (const review of ledger.reviews) {
    if (review.suggestionIds === undefined) continue
    const kept = review.suggestionIds.filter(id => ids.has(id))
    if (kept.length !== review.suggestionIds.length) review.suggestions = Math.min(review.suggestions, kept.length)
    if (kept.length === 0) delete review.suggestionIds
    else review.suggestionIds = kept
  }
  for (const trajectory of ledger.trajectories) trajectory.suggestionIds = trajectory.suggestionIds.filter(id => ids.has(id))
  return ledger
}

export function writeFileAtomic(path: string, content: string | Buffer, options?: { dirMode?: number; fileMode?: number }): void {
  mkdirSync(dirname(path), options?.dirMode === undefined ? { recursive: true } : { recursive: true, mode: options.dirMode })
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, options?.fileMode === undefined ? undefined : { mode: options.fileMode })
    if (options?.fileMode !== undefined) chmodSync(temporary, options.fileMode)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function fileStamp(path: string): string {
  try {
    const info = statSync(path, { bigint: true })
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`
  } catch {
    return '-'
  }
}

export class SkillsStore {
  private readonly jsonCache = new Map<string, { stamp: string; value: unknown }>()

  constructor(readonly directory: string) {}

  private path(name: string): string {
    return join(this.directory, name)
  }

  stagingDirectory(): string {
    return this.path('staging')
  }

  private readJson(name: string): unknown {
    const path = this.path(name)
    const stamp = fileStamp(path)
    if (stamp === '-') {
      this.jsonCache.delete(name)
      return undefined
    }
    const cached = this.jsonCache.get(name)
    if (cached !== undefined && cached.stamp === stamp) return structuredClone(cached.value)
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown } catch (error) {
      throw new Error(`Skills Source file is unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (this.jsonCache.size >= 32 && !this.jsonCache.has(name)) {
      const oldest = this.jsonCache.keys().next().value
      if (oldest !== undefined) this.jsonCache.delete(oldest)
    }
    this.jsonCache.set(name, { stamp, value: parsed })
    return structuredClone(parsed)
  }

  private writeAtomic(path: string, content: string): void {
    writeFileAtomic(path, content, { dirMode: 0o700, fileMode: 0o600 })
  }

  private writeJson(name: string, value: unknown): void {
    this.jsonCache.delete(name)
    this.writeAtomic(this.path(name), `${JSON.stringify(value, null, 2)}\n`)
  }

  fingerprint(): string {
    const tracked = [
      'ledger.json',
      'evals.json',
      'auto-adoption-budget.json',
      join('market', 'registries.json'),
      join('market', 'installs.json'),
    ].map(name => `${name}:${fileStamp(this.path(name))}`)
    const cacheDir = this.path(join('market', 'cache'))
    let cacheEntries: string[]
    try {
      cacheEntries = readdirSync(cacheDir)
        .filter(name => name.endsWith('.json'))
        .sort()
        .map(name => `${name}:${fileStamp(join(cacheDir, name))}`)
    } catch {
      cacheEntries = ['-']
    }
    tracked.push(`market/cache:${cacheEntries.join(',')}`)
    return tracked.join('|')
  }

  autoAdoptionBudget(): BudgetEntry[] | undefined {
    return readBudget(this.readJson('auto-adoption-budget.json'))
  }

  saveAutoAdoptionBudget(entries: BudgetEntry[]): void {
    this.writeJson('auto-adoption-budget.json', { version: 1, entries })
  }

  ledger(): LedgerFile {
    const value = object(this.readJson('ledger.json'))
    if (value === undefined) return emptyLedger()
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
    evals.runs = evals.runs.filter(run => {
      const count = (counts.get(run.skillName) ?? 0) + 1
      counts.set(run.skillName, count)
      return run.status === 'running' || count <= MAX_RUNS_PER_SKILL
    })
    this.writeJson('evals.json', evals)
  }

  trajectory(id: string, ledger?: LedgerFile): Trajectory {
    if (!/^[a-z0-9-]{1,80}$/u.test(id)) throw new Error('invalid trajectory id')
    const value = object(this.readJson(join('trajectories', `${id}.json`)))
    if (value === undefined) throw new Error('trajectory not found: ' + id)
    const trajectory = value as unknown as Trajectory
    const ids = new Set((ledger ?? this.ledger()).suggestions.map(suggestion => suggestion.id))
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

  versionResources(version: SkillVersion): SkillBundleSnapshot | undefined {
    const name = join('versions', keyDirectory(version.skillKey), `${version.id}.bundle.json`)
    const raw = this.readJson(name)
    if (raw !== undefined) {
      const value = object(raw)
      const files = object(value?.files)
      if (value?.version !== 1 || value.complete !== true || files === undefined) throw new Error('Invalid supporting-file version snapshot')
      if (Object.keys(files).length > MAX_BUNDLE_SNAPSHOT_FILES) throw new Error('Supporting-file snapshot is too large')
      let bytes = 0
      for (const entry of Object.values(files)) {
        const file = object(entry)
        if (typeof file?.base64 !== 'string' || Buffer.from(file.base64, 'base64').toString('base64') !== file.base64
          || typeof file.mode !== 'number' || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error('Invalid supporting-file version entry')
        bytes += Buffer.from(file.base64, 'base64').length
        if (bytes > MAX_BUNDLE_SNAPSHOT_BYTES) throw new Error('Supporting-file snapshot is too large')
      }
      return value as unknown as SkillBundleSnapshot
    }
    if (version.bundleSnapshot === true) throw new Error('Supporting-file version snapshot is missing; no files were restored')
    const legacy = object(this.readJson(join('versions', keyDirectory(version.skillKey), `${version.id}.files.json`)))
    if (legacy === undefined) return undefined
    const files: SkillBundleSnapshot['files'] = Object.create(null)
    for (const [path, content] of Object.entries(legacy)) {
      if (typeof content !== 'string') throw new Error('Invalid legacy supporting-file version')
      files[path] = { base64: Buffer.from(content, 'utf8').toString('base64') }
    }
    return { version: 1, complete: false, files }
  }

  saveVersionResources(version: SkillVersion, files: SkillBundleSnapshot): void {
    this.writeJson(join('versions', keyDirectory(version.skillKey), `${version.id}.bundle.json`), files)
    version.bundleSnapshot = true
  }

  deleteVersionContent(version: SkillVersion): void {
    rmSync(this.path(join('versions', keyDirectory(version.skillKey), `${version.id}.bundle.json`)), { force: true })
    rmSync(this.path(join('versions', keyDirectory(version.skillKey), `${version.id}.md`)), { force: true })
    rmSync(this.path(join('versions', keyDirectory(version.skillKey), `${version.id}.files.json`)), { force: true })
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
    try {
      this.writeJson(join('trash', `${id}.json`), { version: 1, name, kind: file ? 'file' : 'bundle', trashedAt: trashedAt.toISOString(), ...source } satisfies TrashRecord)
    } catch { }
    return target
  }

  trashEntries(): TrashEntry[] {
    let names: string[]
    try { names = readdirSync(this.path('trash')) } catch { return [] }
    const entries: TrashEntry[] = []
    for (const id of names) {
      if (id.endsWith('.json')) continue
      let record: Record<string, unknown> | undefined
      try { record = object(this.readJson(join('trash', `${id}.json`))) } catch { }
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

  trashEntry(id: string): TrashEntry {
    const entry = this.trashEntries().find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error('trash entry not found: ' + id)
    return entry
  }

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

  purgeTrash(entry: TrashEntry): void {
    rmSync(this.path(join('trash', entry.id)), { recursive: true, force: true })
    rmSync(this.path(join('trash', `${entry.id}.json`)), { force: true })
  }
}

export interface SkillBundleSnapshot {
  version: 1
  complete: boolean
  files: Record<string, { base64: string; mode?: number }>
}
