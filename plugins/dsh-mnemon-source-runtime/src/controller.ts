import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import {
  MAX_RUNTIME_MEMORY_LIMIT_BYTES,
} from './defaults.ts'
import type { RuntimeMemoryStorage } from './config.ts'
import type {
  RuntimeMemoryAction,
  RuntimeMemoryCompactedEntry,
  RuntimeMemoryEntry,
  RuntimeMemoryEntryOrigin,
  RuntimeMemoryImportance,
  RuntimeMemoryMaintenancePlan,
  RuntimeMemoryMutation,
  RuntimeMemoryMutationResult,
  RuntimeMemorySnapshot,
  RuntimeMemoryTarget,
  RuntimeMemoryTargetView,
} from './contracts.ts'
import {
  RUNTIME_MEMORY_VERSION, RUNTIME_ENTRY_DELIMITER, RUNTIME_MEMORY_LIMITS, RUNTIME_BRANCH_NAME_MAX, RUNTIME_BRANCHES_PER_ENTRY_MAX,
  RUNTIME_ARCHIVE_DIRECTORY, RUNTIME_DIRECTORY, RUNTIME_ENTRY_MAX_BYTES, RUNTIME_LOCK_FILE, RUNTIME_LOCK_STALE_MS, RUNTIME_MEMORIES_FILE, RUNTIME_PROJECTION_FILES,
  isValidRuntimeBranchName, parseRuntimeBranches, runtimeBytes, runtimeProjection, runtimePinnedProjection, assertRuntimePinnedBudget, RUNTIME_PINNED_PROJECTION_LIMIT, type RuntimeMemoryLimits,
} from './contracts.ts'

export { RUNTIME_BRANCH_NAME_MAX, RUNTIME_BRANCHES_PER_ENTRY_MAX }

export interface RuntimeMemoryContextProjection {
  revision: string
  branchVisibility: string
  text: string
  entries: RuntimeMemoryEntry[]
  deferredEntries: RuntimeMemoryEntry[]
  totalEntries: number
  minimumCharacters: number
  bm25?: { text: string }
}

const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 20

interface RuntimeMemoryFile {
  version: typeof RUNTIME_MEMORY_VERSION
  entries: RuntimeMemoryEntry[]
}

type RuntimeMemoryResultFields = Pick<RuntimeMemoryMutationResult, 'message' | 'added' | 'replaced' | 'removed'>

interface PreparedRuntimeMemoryMutation {
  changed: boolean
  projectedEntries: RuntimeMemoryEntry[]
  compactableEntries: RuntimeMemoryEntry[]
  pendingEntry?: RuntimeMemoryEntry
  excludedEntry?: RuntimeMemoryEntry
  fields: RuntimeMemoryResultFields
}

function appendWithoutLinks(path: string, text: string): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const bytes = Buffer.from(text, 'utf8')
    for (let offset = 0; offset < bytes.length;) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
  } finally { closeSync(descriptor) }
}

export class RuntimeMemoryCapacityError extends Error {
  readonly code = 'runtime-capacity' as const
  constructor(
    readonly target: RuntimeMemoryTarget,
    readonly used: number,
    readonly projected: number,
    readonly limit: number,
  ) {
    super(`Would exceed ${target} runtime memory capacity: ${projected} bytes (current ${used}, limit ${limit}). Archive and compact runtime memory before retrying.`)
    this.name = 'RuntimeMemoryCapacityError'
  }
}

export class RuntimeMemoryConflictError extends Error {
  readonly code = 'revision-conflict' as const
  constructor() {
    super('runtime memory changed while archival was running; no compacted data was applied')
    this.name = 'RuntimeMemoryConflictError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTarget(value: unknown): value is RuntimeMemoryTarget {
  return value === 'memory' || value === 'user'
}

function isImportance(value: unknown): value is RuntimeMemoryImportance {
  return value === 'critical' || value === 'normal' || value === 'low'
}

export function normalizeRuntimeBranches(value: unknown, field = 'branches'): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of git branch names`)
  const branches: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${field} must contain only git branch names`)
    const branch = item.trim()
    if (!isValidRuntimeBranchName(branch)) {
      throw new Error(`${field} must contain git branch names (letters, numbers, dot, underscore, slash, dash)`)
    }
    if (seen.has(branch)) throw new Error(`${field} must not repeat a branch name`)
    seen.add(branch)
    branches.push(branch)
  }
  if (branches.length > RUNTIME_BRANCHES_PER_ENTRY_MAX) {
    throw new Error(`${field} supports at most ${RUNTIME_BRANCHES_PER_ENTRY_MAX} branch names`)
  }
  return branches
}

function entryMatchesBranch(entry: RuntimeMemoryEntry, branch: string): boolean {
  return entry.branches === undefined || entry.branches.length === 0 || entry.branches.includes(branch)
}

function selectedBranches(target: RuntimeMemoryTarget, value: string[] | undefined): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  if (target !== 'memory') throw new Error('matchBranches applies to target=memory only')
  return new Set(normalizeRuntimeBranches(value, 'matchBranches'))
}

function matchesSelectedBranches(entry: RuntimeMemoryEntry, selection: ReadonlySet<string> | undefined): boolean {
  if (selection === undefined) return true
  const branches = entry.branches ?? []
  return branches.length === selection.size && branches.every(branch => selection.has(branch))
}

function scopeBranch(branch: string | undefined): string | undefined {
  const value = branch?.trim()
  return value === undefined || value === '' ? undefined : value
}

function missingMutationFieldError(action: RuntimeMemoryAction, target: RuntimeMemoryTarget, missing: 'content' | 'oldText' | 'both'): string {
  if (action === 'add') {
    return `content is required for action=add (example: ${JSON.stringify({ action: 'add', target, content: '...' })})`
  }
  if (action === 'replace') {
    const subject = missing === 'both' ? 'oldText and content are' : `${missing} is`
    return `${subject} required for action=replace (example: ${JSON.stringify({ action: 'replace', target, oldText: '...', content: '...' })})`
  }
  return `oldText is required for action=remove (example: ${JSON.stringify({ action: 'remove', target, oldText: '...' })})`
}

function normalizeContent(value: string | undefined, field: string, missingHint?: string): string {
  const content = value?.trim().replace(/\s+/gu, ' ') ?? ''
  if (content === '') throw new Error(missingHint ?? `${field} is required`)
  if (content.includes('§')) throw new Error(`${field} must not contain the reserved § entry delimiter`)
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > RUNTIME_ENTRY_MAX_BYTES) throw new Error(`${field} is too large (${bytes} bytes; max ${RUNTIME_ENTRY_MAX_BYTES})`)
  return content
}

function parseOrigin(value: unknown): RuntimeMemoryEntryOrigin | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.machine !== 'string' || typeof value.label !== 'string' || typeof value.at !== 'string') return undefined
  return { machine: value.machine, label: value.label, at: value.at }
}

function parseEntry(value: unknown): RuntimeMemoryEntry | undefined {
  if (!isRecord(value) || typeof value.content !== 'string' || !isTarget(value.target) || !isImportance(value.importance)) return undefined
  if (typeof value.created_at !== 'string' || typeof value.updated_at !== 'string') return undefined
  const content = value.content.trim().replace(/\s+/gu, ' ')
  if (content === '' || content.includes('§')) return undefined
  if (value.target === 'user' && value.branches !== undefined) return undefined
  if (value.pinned !== undefined && typeof value.pinned !== 'boolean') return undefined
  const branches = parseRuntimeBranches(value.branches)
  const origin = parseOrigin(value.origin)
  return {
    content,
    created_at: value.created_at,
    updated_at: value.updated_at,
    target: value.target,
    importance: value.importance,
    ...(value.pinned === undefined ? {} : { pinned: value.pinned }),
    ...(branches === undefined ? {} : { branches }),
    ...(origin === undefined ? {} : { origin }),
  }
}

function runtimeEntryKey(entry: { target: RuntimeMemoryTarget; content: string; branches?: readonly string[] | undefined }): string {
  return JSON.stringify([entry.target, entry.content, [...(entry.branches ?? [])].sort()])
}

function isNewerEntry(entry: RuntimeMemoryEntry, previous: RuntimeMemoryEntry): boolean {
  const updated = Date.parse(entry.updated_at)
  const previousUpdated = Date.parse(previous.updated_at)
  return Number.isFinite(updated) && (!Number.isFinite(previousUpdated) || updated > previousUpdated)
}

function collapseDuplicateEntries(entries: readonly RuntimeMemoryEntry[]): RuntimeMemoryEntry[] {
  const groups = new Map<string, { latest: RuntimeMemoryEntry; pin?: RuntimeMemoryEntry }>()
  for (const entry of entries) {
    const key = runtimeEntryKey(entry)
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { latest: entry, ...(entry.pinned === undefined ? {} : { pin: entry }) })
      continue
    }
    if (isNewerEntry(entry, group.latest)) group.latest = entry
    if (entry.pinned !== undefined && (group.pin === undefined || isNewerEntry(entry, group.pin))) group.pin = entry
  }
  return [...groups.values()].map(({ latest, pin }) => pin?.pinned === undefined ? latest : { ...latest, pinned: pin.pinned })
}

function age(timestamp: string, projectedAt: number): string {
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time)) return 'unknown'
  if (time > projectedAt) return 'future'
  return `${Math.floor((projectedAt - time) / 86_400_000)}d`
}

function contextMarkdown(entries: readonly RuntimeMemoryEntry[], target: RuntimeMemoryTarget, projectedAt: number): string {
  return entries.filter(entry => entry.target === target).map(entry => {
    const annotations: string[] = []
    if (entry.importance !== 'normal') annotations.push(`importance=${entry.importance}`)
    for (const [name, timestamp] of [['created', entry.created_at], ['updated', entry.updated_at]] as const) {
      const elapsed = age(timestamp, projectedAt)
      if (elapsed !== '0d') annotations.push(`${name}=${elapsed}`)
    }
    return `${annotations.length === 0 ? '' : `[${annotations.join('; ')}]\n`}${entry.content}`
  }).join(RUNTIME_ENTRY_DELIMITER)
}

function revision(file: RuntimeMemoryFile): string {
  return createHash('sha256').update(JSON.stringify(file)).digest('hex')
}

function prepareMutation(
  before: readonly RuntimeMemoryEntry[],
  request: RuntimeMemoryMutation,
  now: string,
  preserveImportance = false,
): PreparedRuntimeMemoryMutation {
  if (!isTarget(request.target)) throw new Error('target must be memory or user')
  if (!['add', 'replace', 'remove'].includes(request.action)) throw new Error('action must be add, replace, or remove')
  if (request.importance !== undefined && !isImportance(request.importance)) throw new Error('importance must be critical, normal, or low')
  if (request.target === 'user' && request.branches !== undefined) throw new Error('branches applies to target=memory only')
  const branchScope = request.branches === undefined ? undefined : normalizeRuntimeBranches(request.branches)
  const selection = selectedBranches(request.target, request.matchBranches)
  const entries = before.map(entry => ({ ...entry }))

  if (request.action === 'add') {
    if (selection !== undefined) throw new Error('matchBranches applies to replace and remove only')
    const content = normalizeContent(request.content, 'content', missingMutationFieldError('add', request.target, 'content'))
    const duplicate = entries.find(entry => entry.target === request.target && entry.content === content)
    if (duplicate !== undefined) {
      return {
        changed: false,
        projectedEntries: entries,
        compactableEntries: entries.filter(entry => entry.target === request.target),
        fields: { message: 'Entry already exists (no duplicate added).', added: duplicate.content },
      }
    }
    const pendingEntry: RuntimeMemoryEntry = {
      content,
      created_at: now,
      updated_at: now,
      target: request.target,
      importance: request.importance ?? 'normal',
      ...(branchScope !== undefined && branchScope.length > 0 ? { branches: branchScope } : {}),
    }
    return {
      changed: true,
      projectedEntries: [...entries, pendingEntry],
      compactableEntries: entries.filter(entry => entry.target === request.target),
      pendingEntry,
      fields: { message: 'Entry added.', added: content },
    }
  }

  if (request.action === 'replace') {
    const missingOldText = (request.oldText?.trim() ?? '') === ''
    const missingContent = (request.content?.trim() ?? '') === ''
    if (missingOldText || missingContent) {
      throw new Error(missingMutationFieldError('replace', request.target, missingOldText && missingContent ? 'both' : missingOldText ? 'oldText' : 'content'))
    }
  }

  const oldText = normalizeContent(request.oldText, 'oldText', missingMutationFieldError(request.action, request.target, 'oldText'))
  const substringMatches = entries
    .map((entry, index) => entry.target === request.target && entry.content.includes(oldText) && matchesSelectedBranches(entry, selection) ? index : -1)
    .filter(index => index >= 0)
  const exactMatches = substringMatches.filter(index => entries[index]!.content === oldText)
  const matches = exactMatches.length > 0 || selection !== undefined ? exactMatches : substringMatches
  if (matches.length === 0 && selection !== undefined) throw new Error('No exact working-memory entry matches this branch scope. Reload and retry.')
  if (matches.length === 0) throw new Error(`No ${request.target} entry contains ${JSON.stringify(oldText)}.`)
  if (matches.length > 1) throw new Error(`Multiple ${request.target} entries contain ${JSON.stringify(oldText)}; use a unique substring.`)
  const index = matches[0]!
  const previous = entries[index]!
  const compactableEntries = entries.filter((entry, entryIndex) => entry.target === request.target && entryIndex !== index)

  if (request.action === 'replace') {
    const ranks = { low: 0, normal: 1, critical: 2 }
    const requested = request.importance ?? previous.importance
    const importance = preserveImportance && ranks[requested] < ranks[previous.importance] ? previous.importance : requested
    const content = normalizeContent(request.content, 'content', missingMutationFieldError('replace', request.target, 'content'))
    const pendingEntry: RuntimeMemoryEntry = {
      ...previous,
      content,
      updated_at: now,
      importance,
    }
    if (branchScope !== undefined) {
      if (branchScope.length === 0) delete pendingEntry.branches
      else pendingEntry.branches = branchScope
    }
    const key = runtimeEntryKey(pendingEntry)
    if (entries.some((entry, entryIndex) => entryIndex !== index && entry.target === request.target
      && entry.content === content && runtimeEntryKey(entry) === key)) {
      throw new Error(`An identical ${request.target} entry already exists in this scope. Remove the old entry to consolidate them.`)
    }
    entries[index] = pendingEntry
    return {
      changed: true,
      projectedEntries: entries,
      compactableEntries,
      pendingEntry,
      excludedEntry: previous,
      fields: { message: importance === requested ? 'Entry replaced.' : 'Entry replaced; original importance preserved.', replaced: { from: previous.content, to: content } },
    }
  }

  return {
    changed: true,
    projectedEntries: entries.filter((_, entryIndex) => entryIndex !== index),
    compactableEntries,
    excludedEntry: previous,
    fields: { message: 'Entry removed.', removed: previous.content },
  }
}

function compactionCandidates(
  compacted: readonly RuntimeMemoryCompactedEntry[],
  existing: readonly RuntimeMemoryEntry[],
  target: RuntimeMemoryTarget,
  now: string,
): RuntimeMemoryEntry[] {
  const seen = new Set<string>()
  const existingByKey = new Map(existing.map(entry => [runtimeEntryKey(entry), entry]))
  const firstByContent = new Map<string, RuntimeMemoryEntry>()
  for (const entry of existing) if (!firstByContent.has(entry.content)) firstByContent.set(entry.content, entry)
  return compacted.map((entry): RuntimeMemoryEntry => {
    const content = normalizeContent(entry.content, 'compacted content')
    if (!isImportance(entry.importance)) throw new Error('compacted importance must be critical, normal, or low')
    const branches = entry.branches === undefined ? undefined : normalizeRuntimeBranches(entry.branches, 'compacted branches')
    if (target === 'user' && branches?.length) throw new Error('compacted branches apply to target=memory only')
    const unchanged = existingByKey.get(runtimeEntryKey({ target, content, branches }))
      ?? (branches === undefined ? firstByContent.get(content) : undefined)
    const scope = unchanged?.branches ?? branches
    if (unchanged === undefined && firstByContent.has(content)) throw new Error('Compaction cannot change the branch scope of an existing entry')
    if (entry.pinned !== undefined && entry.pinned !== unchanged?.pinned) throw new Error('Compaction cannot change pin state')
    if (unchanged?.pinned === true && entry.importance !== unchanged.importance) throw new Error('Compaction cannot change a pinned entry')
    const candidate: RuntimeMemoryEntry = {
      content,
      created_at: unchanged?.created_at ?? now,
      updated_at: unchanged?.updated_at ?? now,
      target,
      importance: entry.importance,
      ...(unchanged?.pinned === undefined ? {} : { pinned: unchanged.pinned }),
      ...(unchanged?.origin === undefined ? {} : { origin: unchanged.origin }),
      ...(scope !== undefined && scope.length > 0 ? { branches: scope } : {}),
    }
    const key = runtimeEntryKey(candidate)
    if (seen.has(key)) throw new Error('compacted runtime memory contains duplicate entries')
    seen.add(key)
    return candidate
  })
}

function packCompactionCandidates(
  replacements: readonly RuntimeMemoryEntry[],
  target: RuntimeMemoryTarget,
  maxBytes: number,
): RuntimeMemoryEntry[] {
  if (runtimeBytes(replacements.filter(entry => entry.pinned === true), target) > maxBytes) throw new Error('Pinned runtime entries exceed the available capacity. Unpin entries or increase the capacity; no data was changed.')
  const ranked: Record<'pinned' | RuntimeMemoryImportance, number[]> = { pinned: [], critical: [], normal: [], low: [] }
  replacements.forEach((entry, index) => ranked[entry.pinned === true ? 'pinned' : entry.importance].push(index))
  const selected = new Set<number>()
  const delimiterBytes = Buffer.byteLength(RUNTIME_ENTRY_DELIMITER, 'utf8')
  let used = 0
  let count = 0
  for (const importance of ['pinned', 'critical', 'normal', 'low'] as const) for (const index of ranked[importance]) {
    const entry = replacements[index]!
    const matchesTarget = entry.target === target
    const added = matchesTarget ? Buffer.byteLength(entry.content, 'utf8') + (count === 0 ? 0 : delimiterBytes) : 0
    if (used + added > maxBytes) continue
    used += added
    if (matchesTarget) count += 1
    selected.add(index)
  }
  return replacements.filter((_, index) => selected.has(index))
}

function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buffer, 0, 0, milliseconds)
}

export class RuntimeMemoryController {
  readonly directory: string
  readonly sourcePath: string
  readonly userSourcePath: string
  readonly memoryPath: string
  readonly userPath: string
  readonly lockPath: string
  readonly archivePath: string
  readonly archiveSourcePath: string
  readonly limits: RuntimeMemoryLimits

  private queue: Promise<unknown> = Promise.resolve()
  private readonly localUserPath: string
  private readonly userController: RuntimeMemoryController | undefined

  constructor(
    runner: RuntimeMemoryStorage,
    private readonly now: () => Date = () => new Date(),
    limits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS,
    userRunner?: RuntimeMemoryStorage,
  ) {
    for (const [target, limit] of Object.entries(limits)) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUNTIME_MEMORY_LIMIT_BYTES) {
        throw new Error(`runtime ${target} memory limit must be an integer within 1..${MAX_RUNTIME_MEMORY_LIMIT_BYTES} bytes`)
      }
    }
    this.limits = { memory: limits.memory, user: limits.user }
    this.directory = join(runner.effectiveDataDir(), RUNTIME_DIRECTORY)
    this.sourcePath = join(this.directory, RUNTIME_MEMORIES_FILE)
    this.memoryPath = join(this.directory, RUNTIME_PROJECTION_FILES.memory)
    this.localUserPath = join(this.directory, RUNTIME_PROJECTION_FILES.user)
    this.lockPath = join(this.directory, RUNTIME_LOCK_FILE)
    this.archivePath = join(this.directory, RUNTIME_ARCHIVE_DIRECTORY, 'MEMORY.md')
    this.archiveSourcePath = join(this.directory, RUNTIME_ARCHIVE_DIRECTORY, 'memories.jsonl')
    const userDirectory = userRunner === undefined ? this.directory : join(userRunner.effectiveDataDir(), RUNTIME_DIRECTORY)
    this.userController = userDirectory === this.directory || userRunner === undefined
      ? undefined
      : new RuntimeMemoryController(userRunner, now, this.limits)
    this.userPath = this.userController?.userPath ?? this.localUserPath
    this.userSourcePath = this.userController?.sourcePath ?? this.sourcePath
    this.initialize()
  }

  snapshot(): RuntimeMemorySnapshot {
    const local = this.readSource()
    if (this.userController === undefined) return this.snapshotUnlocked(local)
    const global = this.userController.readSource()
    return this.snapshotUnlocked({
      version: RUNTIME_MEMORY_VERSION,
      entries: [
        ...global.entries.filter(entry => entry.target === 'user'),
        ...local.entries.filter(entry => entry.target === 'memory'),
      ],
    })
  }

  contextProjection(branch?: string, deferLowPriority = false, bm25Recall = false): RuntimeMemoryContextProjection {
    const branchScope = scopeBranch(branch)
    const projectedAt = this.now().getTime()
    const local = this.localContextProjection(projectedAt, branchScope)
    const global = this.userController?.localContextProjection(projectedAt)
    const entries = global === undefined
      ? local.snapshot.entries
      : [
          ...global.snapshot.entries.filter(entry => entry.target === 'user'),
          ...local.snapshot.entries.filter(entry => entry.target === 'memory'),
        ]
    const visibleMemory = local.snapshot.targets.memory
    const visibleUser = global?.snapshot.targets.user ?? local.snapshot.targets.user
    const snapshot = global === undefined
      ? local.snapshot
      : {
          directory: this.directory,
          sourcePath: this.sourcePath,
          revision: revision({ version: RUNTIME_MEMORY_VERSION, entries }),
          generatedAt: new Date(projectedAt).toISOString(),
          entries,
          targets: {
            memory: { ...visibleMemory, markdownPath: this.memoryPath },
            user: { ...visibleUser, markdownPath: this.userPath },
          },
        } satisfies RuntimeMemorySnapshot
    const branchEntries = branchScope === undefined
      ? entries
      : entries.filter(entry => entry.target === 'user' || entryMatchesBranch(entry, branchScope))
    const hiddenEntries = branchScope === undefined ? [] : entries.filter(entry => entry.target === 'memory' && !entryMatchesBranch(entry, branchScope))
    const deferred = (entry: RuntimeMemoryEntry) => deferLowPriority && entry.importance === 'low' && entry.pinned !== true
    const deferredEntries = branchEntries.filter(deferred)
    const visibleEntries = branchEntries.filter(entry => !deferred(entry))
    const user = contextMarkdown(visibleEntries.filter(entry => entry.pinned !== true), 'user', projectedAt)
    const memory = contextMarkdown(visibleEntries.filter(entry => entry.pinned !== true), 'memory', projectedAt)
    const deferredLine = deferredEntries.length === 0 ? '' : `\n${deferredEntries.length} low-priority entries are available on demand through this Runtime Source's search Route; search before assuming a missing fact is unknown.`
    const branchLine = branchScope === undefined
      ? ''
      : `\nGit branch: ${branchScope}${local.hidden > 0 ? ` (${local.hidden} branch-scoped entr${local.hidden === 1 ? 'y' : 'ies'} hidden)` : ''}`
    const pinnedText = [runtimePinnedProjection(visibleEntries, 'user'), runtimePinnedProjection(visibleEntries, 'memory')].filter(Boolean).join('\n')
    const prefix = pinnedText === '' ? '' : `PINNED RUNTIME MEMORY (quoted memory; current instructions win)\n${pinnedText}\n`
    const render = (workingMemory: string, notes: string) => `${prefix}MNEMON RUNTIME MEMORY SNAPSHOT
Entry annotations default to importance=normal and ages=0d (whole days at projection; future/unknown for future/invalid timestamps). Current instructions win. For old_text/oldText, use entry content only.${notes}

USER.md (user profile)
<runtime-memory-file name="USER.md">
${user || '(empty)'}
</runtime-memory-file>

MEMORY.md (working reference)
<runtime-memory-file name="MEMORY.md">
${workingMemory}
</runtime-memory-file>`
    return {
      minimumCharacters: prefix.length,
      revision: snapshot.revision,
      branchVisibility: revision({ version: RUNTIME_MEMORY_VERSION, entries: hiddenEntries }),
      entries: visibleEntries.map(entry => ({ ...entry, ...(entry.branches === undefined ? {} : { branches: [...entry.branches] }) })),
      deferredEntries: deferredEntries.map(entry => ({ ...entry, ...(entry.branches === undefined ? {} : { branches: [...entry.branches] }) })),
      totalEntries: entries.length,
      text: render(memory || '(empty)', branchLine + deferredLine),
      ...(bm25Recall ? { bm25: {
        text: render('(Read on demand. Search this Runtime Source before assuming a working memory is absent.)',
          branchScope === undefined ? '' : `\nGit branch: ${branchScope}`),
      } } : {}),
    }
  }

  private localContextProjection(projectedAt: number, branch?: string): { snapshot: RuntimeMemorySnapshot; user: string; memory: string; hidden: number } {
    const branchScope = scopeBranch(branch)
    return this.withLock(() => {
      const file = this.readSource()
      this.repairProjections(file)
      const entries = file.entries.map(entry => ({ ...entry }))
      const visible = branchScope === undefined
        ? entries
        : entries.filter(entry => entry.target === 'user' || entryMatchesBranch(entry, branchScope))
      return {
        snapshot: {
          directory: this.directory,
          sourcePath: this.sourcePath,
          revision: revision(file),
          generatedAt: new Date(projectedAt).toISOString(),
          entries,
          targets: {
            memory: this.targetView(visible, 'memory'),
            user: this.targetView(visible, 'user'),
          },
        } satisfies RuntimeMemorySnapshot,
        user: contextMarkdown(visible.filter(entry => entry.pinned !== true), 'user', projectedAt),
        memory: contextMarkdown(visible.filter(entry => entry.pinned !== true), 'memory', projectedAt),
        hidden: branchScope === undefined ? 0 : entries.length - visible.length,
      }
    })
  }

  mutate(request: RuntimeMemoryMutation, options: { preserveImportance?: boolean } = {}): Promise<RuntimeMemoryMutationResult> {
    return this.mutateCommitted(request, options).then(committed => committed.result)
  }

  mutateCommitted(
    request: RuntimeMemoryMutation,
    options: { preserveImportance?: boolean } = {},
  ): Promise<{ revision: string; result: RuntimeMemoryMutationResult }> {
    if (request.target === 'user' && this.userController !== undefined) {
      return this.userController.mutateInternal(request, options.preserveImportance).then(({ file: globalFile, result }) => ({
        revision: this.combinedRevision(this.withLock(() => this.readSource()), globalFile),
        result,
      }))
    }
    return this.mutateInternal(request, options.preserveImportance).then(({ file, result }) => ({
      revision: this.combinedRevision(file),
      result,
    }))
  }

  private mutateInternal(
    request: RuntimeMemoryMutation,
    preserveImportance = false,
  ): Promise<{ file: RuntimeMemoryFile; result: RuntimeMemoryMutationResult }> {
    const operation = this.queue.then(() => this.withLock(() => this.mutateLocked(request, preserveImportance)))
    this.queue = operation.catch(() => undefined)
    return operation
  }

  setPinned(target: RuntimeMemoryTarget, content: string, pinned: boolean, matchBranches?: string[]): Promise<RuntimeMemorySnapshot> {
    if (target === 'user' && this.userController !== undefined) {
      return this.userController.setPinned(target, content, pinned, matchBranches).then(globalSnapshot => {
        const local = this.withLock(() => this.readSource())
        return this.snapshotUnlocked(this.combineFiles(local, { version: RUNTIME_MEMORY_VERSION, entries: globalSnapshot.entries }))
      })
    }
    const operation = this.queue.then(() => this.withLock(() => {
      const file = this.readSource()
      const selection = selectedBranches(target, matchBranches)
      const matches = file.entries.filter(entry => entry.target === target && entry.content === content && matchesSelectedBranches(entry, selection))
      if (matches.length !== 1) throw new Error('Pin requires one exact current entry; reload and retry')
      const entry = matches[0]!
      file.entries[file.entries.indexOf(entry)] = parseEntry({ ...entry, pinned, updated_at: this.now().toISOString() })!
      if (pinned) assertRuntimePinnedBudget(file.entries)
      this.persist(file)
      return this.snapshotUnlocked(this.userController === undefined ? file : this.combineFiles(file, this.userController.readSource()))
    }))
    this.queue = operation.catch(() => undefined)
    return operation
  }

  planMaintenance(request: RuntimeMemoryMutation, options: { preserveImportance?: boolean } = {}): Promise<RuntimeMemoryMaintenancePlan> {
    return this.planMaintenanceCommitted(request, options).then(planned => planned.plan)
  }

  planMaintenanceCommitted(
    request: RuntimeMemoryMutation,
    options: { preserveImportance?: boolean } = {},
  ): Promise<{ revision: string; plan: RuntimeMemoryMaintenancePlan }> {
    if (request.target === 'user' && this.userController !== undefined) {
      return this.userController.planMaintenanceInternal(request, options.preserveImportance).then(({ file: globalFile, plan }) => ({
        revision: this.combinedRevision(this.withLock(() => this.readSource()), globalFile),
        plan,
      }))
    }
    return this.planMaintenanceInternal(request, options.preserveImportance).then(({ file, plan }) => ({
      revision: this.combinedRevision(file),
      plan,
    }))
  }

  private planMaintenanceInternal(
    request: RuntimeMemoryMutation,
    preserveImportance = false,
  ): Promise<{ file: RuntimeMemoryFile; plan: RuntimeMemoryMaintenancePlan }> {
    const operation = this.queue.then(() => this.withLock(() => {
      const file = this.readSource()
      const prepared = prepareMutation(file.entries, request, this.now().toISOString(), preserveImportance)
      assertRuntimePinnedBudget(prepared.projectedEntries)
      const used = runtimeBytes(file.entries, request.target)
      const projected = runtimeBytes(prepared.projectedEntries, request.target)
      const limit = this.limits[request.target]
      return {
        file,
        plan: {
          revision: revision(file),
          action: request.action,
          target: request.target,
          entries: prepared.compactableEntries.map(entry => ({ ...entry })),
          ...(prepared.pendingEntry === undefined ? {} : {
            pending: { content: prepared.pendingEntry.content, importance: prepared.pendingEntry.importance, ...(prepared.pendingEntry.pinned === undefined ? {} : { pinned: prepared.pendingEntry.pinned }) },
          }),
          ...(prepared.excludedEntry === undefined ? {} : { excluded: { ...prepared.excludedEntry } }),
          used,
          projected,
          limit,
          requiresMaintenance: prepared.changed && projected > limit,
          localArchive: true as const,
        },
      }
    }))
    this.queue = operation.catch(() => undefined)
    return operation
  }

  compactAndMutate(
    expectedRevision: string,
    request: RuntimeMemoryMutation,
    compacted: RuntimeMemoryCompactedEntry[],
    maxCompactedBytes?: number,
    options: { archive?: 'local'; preserveImportance?: boolean } = {},
  ): Promise<RuntimeMemoryMutationResult> {
    return this.compactAndMutateCommitted(expectedRevision, request, compacted, maxCompactedBytes, options).then(committed => committed.result)
  }

  compactAndMutateCommitted(
    expectedRevision: string,
    request: RuntimeMemoryMutation,
    compacted: RuntimeMemoryCompactedEntry[],
    maxCompactedBytes?: number,
    options: { archive?: 'local'; preserveImportance?: boolean } = {},
  ): Promise<{ revision: string; result: RuntimeMemoryMutationResult }> {
    if (request.target === 'user' && this.userController !== undefined) {
      return this.userController.compactAndMutateInternal(expectedRevision, request, compacted, maxCompactedBytes, options)
        .then(({ file: globalFile, result }) => ({
          revision: this.combinedRevision(this.withLock(() => this.readSource()), globalFile),
          result,
        }))
    }
    return this.compactAndMutateInternal(expectedRevision, request, compacted, maxCompactedBytes, options)
      .then(({ file, result }) => ({
        revision: this.combinedRevision(file),
        result,
      }))
  }

  private compactAndMutateInternal(
    expectedRevision: string,
    request: RuntimeMemoryMutation,
    compacted: RuntimeMemoryCompactedEntry[],
    maxCompactedBytes?: number,
    options: { archive?: 'local'; preserveImportance?: boolean } = {},
  ): Promise<{ file: RuntimeMemoryFile; result: RuntimeMemoryMutationResult }> {
    const operation = this.queue.then(() => this.withLock(() => {
      const file = this.readSource()
      const beforeRevision = revision(file)
      if (beforeRevision !== expectedRevision) throw new RuntimeMemoryConflictError()
      const now = this.now().toISOString()
      const prepared = prepareMutation(file.entries, request, now, options.preserveImportance)
      assertRuntimePinnedBudget(prepared.projectedEntries)
      const compactedByteBudget = maxCompactedBytes ?? this.limits[request.target]
      if (!Number.isInteger(compactedByteBudget) || compactedByteBudget < 0 || compactedByteBudget > this.limits[request.target]) {
        throw new Error('compaction byte budget is invalid')
      }
      if (!prepared.changed) {
        return {
          file,
          result: this.result(request.target, prepared.projectedEntries, prepared.fields),
        }
      }
      const replacements = compactionCandidates(compacted, prepared.compactableEntries, request.target, now)
      const byKey = new Map(replacements.map(entry => [runtimeEntryKey(entry), entry]))
      for (const pinned of prepared.compactableEntries.filter(entry => entry.pinned === true)) {
        if (byKey.get(runtimeEntryKey(pinned))?.pinned !== true) throw new Error('Compaction omitted a pinned entry; no data was changed')
      }
      const survivingKeys = new Set(prepared.compactableEntries.map(runtimeEntryKey))
      const conflicts = (entry: RuntimeMemoryEntry): boolean => {
        const key = runtimeEntryKey(entry)
        return replacements.some(candidate => {
          if (candidate.content !== entry.content) return false
          const candidateKey = runtimeEntryKey(candidate)
          return candidateKey === key || !survivingKeys.has(candidateKey)
        })
      }
      if (prepared.pendingEntry !== undefined && conflicts(prepared.pendingEntry)) {
        throw new Error('compacted runtime memory duplicates the pending mutation')
      }
      if (prepared.excludedEntry !== undefined && conflicts(prepared.excludedEntry)) {
        throw new Error('compacted runtime memory reintroduces the replaced or removed entry')
      }
      const fitted = packCompactionCandidates(replacements, request.target, compactedByteBudget)
      const targetEntries = [...fitted, ...(prepared.pendingEntry === undefined ? [] : [prepared.pendingEntry])]
      const entries = [...file.entries.filter(entry => entry.target !== request.target), ...targetEntries]
      const used = runtimeBytes(entries, request.target)
      const limit = this.limits[request.target]
      if (used > limit) throw new RuntimeMemoryCapacityError(request.target, runtimeBytes(file.entries, request.target), used, limit)
      const next: RuntimeMemoryFile = { version: RUNTIME_MEMORY_VERSION, entries }
      const kept = new Set(fitted.map(runtimeEntryKey))
      const archived = options.archive === 'local' && request.target === 'memory'
        ? prepared.compactableEntries.filter(entry => !kept.has(runtimeEntryKey(entry)))
        : undefined
      if (archived !== undefined && archived.length > 0) this.archiveLocally(archived, beforeRevision, now)
      this.persist(next)
      return {
        file: next,
        result: {
          ...this.result(request.target, entries, prepared.fields),
          ...(archived === undefined ? {} : { archived: { entries: archived.length, path: this.archivePath } }),
        },
      }
    }))
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private combineFiles(local: RuntimeMemoryFile, global: RuntimeMemoryFile): RuntimeMemoryFile {
    return {
      version: RUNTIME_MEMORY_VERSION,
      entries: [
        ...global.entries.filter(entry => entry.target === 'user'),
        ...local.entries.filter(entry => entry.target === 'memory'),
      ],
    }
  }

  private combinedRevision(local: RuntimeMemoryFile, globalOverride?: RuntimeMemoryFile): string {
    if (this.userController === undefined) return revision(local)
    const global = globalOverride ?? this.userController.withLock(() => this.userController!.readSource())
    return revision(this.combineFiles(local, global))
  }

  private archiveLocally(entries: readonly RuntimeMemoryEntry[], fromRevision: string, archivedAt: string): void {
    const directory = join(this.directory, RUNTIME_ARCHIVE_DIRECTORY)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Runtime Memory archive is not a directory: ${directory}`)
    for (const path of [this.archiveSourcePath, this.archivePath]) {
      let file
      try { file = lstatSync(path) } catch { continue }
      if (!file.isFile()) throw new Error(`Runtime Memory archive file is not a regular file: ${path}`)
    }
    appendWithoutLinks(this.archiveSourcePath, entries.map(entry => `${JSON.stringify({ archivedAt, fromRevision, ...entry })}\n`).join(''))
    const header = existsSync(this.archivePath) ? '' : '# MEMORY.md archive\n\nEntries that left MEMORY.md at its limit while no Memory Space could take them, oldest first.\n'
    appendWithoutLinks(this.archivePath, `${header}\n## ${archivedAt}\n\n${entries.map(entry => entry.content).join(RUNTIME_ENTRY_DELIMITER)}\n`)
  }

  private initialize(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.withLock(() => {
      const file = this.readSource()
      this.persist(file)
    })
  }

  private mutateLocked(request: RuntimeMemoryMutation, preserveImportance = false): { file: RuntimeMemoryFile; result: RuntimeMemoryMutationResult } {
    const file = this.readSource()
    const prepared = prepareMutation(file.entries, request, this.now().toISOString(), preserveImportance)
    assertRuntimePinnedBudget(prepared.projectedEntries)
    if (!prepared.changed) return { file, result: this.result(request.target, prepared.projectedEntries, prepared.fields) }
    const used = runtimeBytes(prepared.projectedEntries, request.target)
    const limit = this.limits[request.target]
    if (used > limit) throw new RuntimeMemoryCapacityError(request.target, runtimeBytes(file.entries, request.target), used, limit)
    const next: RuntimeMemoryFile = { version: RUNTIME_MEMORY_VERSION, entries: prepared.projectedEntries }
    this.persist(next)
    return { file: next, result: this.result(request.target, prepared.projectedEntries, prepared.fields) }
  }

  private result(
    target: RuntimeMemoryTarget,
    entries: readonly RuntimeMemoryEntry[],
    fields: RuntimeMemoryResultFields,
  ): RuntimeMemoryMutationResult {
    return {
      success: true,
      message: fields.message,
      target,
      entryCount: entries.filter(entry => entry.target === target).length,
      usage: { used: runtimeBytes(entries, target), limit: this.limits[target] },
      ...(fields.added === undefined ? {} : { added: fields.added }),
      ...(fields.replaced === undefined ? {} : { replaced: fields.replaced }),
      ...(fields.removed === undefined ? {} : { removed: fields.removed }),
    }
  }

  private targetView(entries: readonly RuntimeMemoryEntry[], target: RuntimeMemoryTarget): RuntimeMemoryTargetView {
    return {
      target,
      entryCount: entries.filter(entry => entry.target === target).length,
      used: runtimeBytes(entries, target),
      limit: this.limits[target],
      markdownPath: target === 'memory' ? this.memoryPath : this.userPath,
      pinned: { count: entries.filter(entry => entry.target === target && entry.pinned === true).length, characters: runtimePinnedProjection(entries, target).length, limit: RUNTIME_PINNED_PROJECTION_LIMIT },
    }
  }

  private snapshotUnlocked(file: RuntimeMemoryFile): RuntimeMemorySnapshot {
    const entries = file.entries.map(entry => ({ ...entry }))
    return {
      directory: this.directory,
      sourcePath: this.sourcePath,
      revision: revision(file),
      generatedAt: this.now().toISOString(),
      entries,
      targets: {
        memory: this.targetView(entries, 'memory'),
        user: this.targetView(entries, 'user'),
      },
    }
  }

  private readSource(): RuntimeMemoryFile {
    if (!existsSync(this.sourcePath)) return { version: RUNTIME_MEMORY_VERSION, entries: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.sourcePath, 'utf8'))
    } catch (error) {
      throw new Error(`runtime memories.json is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRecord(parsed) || parsed.version !== RUNTIME_MEMORY_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error(`runtime memories.json must use version ${RUNTIME_MEMORY_VERSION}`)
    }
    const entries = parsed.entries.map(parseEntry)
    if (entries.some(entry => entry === undefined)) throw new Error('runtime memories.json contains an invalid entry')
    return { version: RUNTIME_MEMORY_VERSION, entries: collapseDuplicateEntries(entries as RuntimeMemoryEntry[]) }
  }

  private persist(file: RuntimeMemoryFile): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const nonce = `${process.pid}.${randomUUID()}`
    const writes: Array<[string, string]> = [
      ...(this.userController === undefined ? [[this.localUserPath, runtimeProjection(file.entries, 'user')] as [string, string]] : []),
      [this.memoryPath, runtimeProjection(file.entries, 'memory')],
      [this.sourcePath, `${JSON.stringify(file, null, 2)}\n`],
    ]
    const temporaries = writes.map(([path]) => join(this.directory, `.${basename(path)}.${nonce}.tmp`))
    try {
      writes.forEach(([, content], index) => writeFileSync(temporaries[index]!, content, { encoding: 'utf8', mode: 0o600 }))
      writes.forEach(([path], index) => renameSync(temporaries[index]!, path))
    } finally {
      for (const temporary of temporaries) rmSync(temporary, { force: true })
    }
  }

  private repairProjections(file: RuntimeMemoryFile): void {
    const targets: ReadonlyArray<readonly [string, RuntimeMemoryTarget]> = this.userController === undefined
      ? [[this.localUserPath, 'user'], [this.memoryPath, 'memory']]
      : [[this.memoryPath, 'memory']]
    for (const [path, target] of targets) {
      const expected = runtimeProjection(file.entries, target)
      let current: string | undefined
      try {
        current = readFileSync(path, 'utf8')
      } catch {
        current = undefined
      }
      if (current === expected) continue
      const temporary = join(this.directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, expected, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
  }

  private withLock<T>(callback: () => T): T {
    const started = Date.now()
    let descriptor: number | undefined
    while (descriptor === undefined) {
      try {
        descriptor = openSync(this.lockPath, 'wx', 0o600)
      } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
        if (code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > RUNTIME_LOCK_STALE_MS) {
            rmSync(this.lockPath, { force: true })
            continue
          }
        } catch {
          continue
        }
        if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error('timed out waiting for the runtime memory controller lock')
        sleepSync(LOCK_RETRY_MS)
      }
    }
    try {
      return callback()
    } finally {
      closeSync(descriptor)
      rmSync(this.lockPath, { force: true })
    }
  }
}
