export type RuntimeMemoryTarget = 'memory' | 'user'
export type RuntimeMemoryImportance = 'critical' | 'normal' | 'low'
export type RuntimeMemoryAction = 'add' | 'replace' | 'remove'

/** Provenance a DSH Host stamps when an entry crosses machines; absent for local writes. */
export interface RuntimeMemoryEntryOrigin {
  machine: string
  label: string
  at: string
}

export interface RuntimeMemoryEntry {
  content: string
  created_at: string
  updated_at: string
  target: RuntimeMemoryTarget
  importance: RuntimeMemoryImportance
  /** Explicit human pin state; absent is the legacy unpinned state. */
  pinned?: boolean
  /** Optional git branch names that limit where this entry is projected. Absent means every branch. */
  branches?: string[]
  /** Which installation wrote this entry, so a merge can tell two machines apart. */
  origin?: RuntimeMemoryEntryOrigin
}

export interface RuntimeMemoryUsage {
  used: number
  limit: number
}

export interface RuntimeMemoryTargetView extends RuntimeMemoryUsage {
  target: RuntimeMemoryTarget
  entryCount: number
  markdownPath: string
  pinned?: { count: number; characters: number; limit: number }
}

export interface RuntimeMemorySnapshot {
  directory: string
  sourcePath: string
  revision: string
  generatedAt: string
  entries: RuntimeMemoryEntry[]
  targets: Record<RuntimeMemoryTarget, RuntimeMemoryTargetView>
}

export interface RuntimeMemoryCompactedEntry {
  content: string
  importance: RuntimeMemoryImportance
  pinned?: boolean
  /** Branch scope carried through compaction; absent means the entry is visible on every branch. */
  branches?: string[]
}

export interface RuntimeMemoryMutation {
  action: RuntimeMemoryAction
  target: RuntimeMemoryTarget
  content?: string
  oldText?: string
  importance?: RuntimeMemoryImportance
  /** Git branch names limiting where a target=memory entry is projected. Absent keeps the current scope on replace; an empty list clears it. */
  branches?: string[]
}

export type RuntimeMemoryMutationResult = {
  success: true
  message: string
  target: RuntimeMemoryTarget
  entryCount: number
  usage: RuntimeMemoryUsage
  added?: string
  replaced?: { from: string; to: string }
  removed?: string
  /** MEMORY.md entries a compaction moved to the local archive, when it ran with `archive: 'local'`. */
  archived?: { entries: number; path: string }
  maintenance?: {
    kind: 'local-compaction' | 'mnemon-archive' | 'local-archive'
    runId: string
    provider: string
    summary: string
    memoryBodyIds: string[]
  }
}

export interface RuntimeMemoryMaintenancePlan {
  revision: string
  action: RuntimeMemoryAction
  target: RuntimeMemoryTarget
  entries: RuntimeMemoryEntry[]
  pending?: RuntimeMemoryCompactedEntry
  excluded?: RuntimeMemoryEntry
  used: number
  projected: number
  limit: number
  requiresMaintenance: boolean
  /** This Runtime Source moves the entries compaction leaves out to its local archive when asked (#336). */
  localArchive?: true
}

import { DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES, DEFAULT_RUNTIME_USER_LIMIT_BYTES, MAX_RUNTIME_MEMORY_LIMIT_BYTES } from './defaults.ts'
export const RUNTIME_MEMORY_VERSION = 1
export const RUNTIME_ENTRY_DELIMITER = '\n§\n'
/** Per target, including labels and annotations. Fits both targets in the default light View. */
export const RUNTIME_PINNED_PROJECTION_LIMIT = 1536

export function runtimePinnedProjection(entries: readonly RuntimeMemoryEntry[], target: RuntimeMemoryTarget): string {
  const pinned = entries.filter(entry => entry.target === target && entry.pinned === true)
  if (pinned.length === 0) return ''
  return `${target === 'user' ? 'USER.md' : 'MEMORY.md'} pinned entries:\n` + pinned.map(entry => `[pinned; importance=${entry.importance}]\n${entry.content}`).join(RUNTIME_ENTRY_DELIMITER) + '\n'
}

export function assertRuntimePinnedBudget(entries: readonly RuntimeMemoryEntry[]): void {
  for (const target of ['user', 'memory'] as const) {
    const characters = runtimePinnedProjection(entries, target).length
    if (characters > RUNTIME_PINNED_PROJECTION_LIMIT) throw new Error(`Pinned ${target} projection requires ${characters} characters; limit ${RUNTIME_PINNED_PROJECTION_LIMIT}. Unpin or shorten entries before retrying; no data was changed.`)
  }
}
export interface RuntimeMemoryLimits {
  readonly memory: number
  readonly user: number
}
export const RUNTIME_MEMORY_LIMITS: RuntimeMemoryLimits = {
  memory: DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES,
  user: DEFAULT_RUNTIME_USER_LIMIT_BYTES,
}
/** The largest limit, in UTF-8 bytes, either target's file may be given. */
export const RUNTIME_MEMORY_LIMIT_MAX_BYTES = MAX_RUNTIME_MEMORY_LIMIT_BYTES

/** The longest git branch name a scope may hold. */
export const RUNTIME_BRANCH_NAME_MAX = 128
/** The characters a git branch name in a scope may use. */
export const RUNTIME_BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/u

/**
 * Read a stored branch scope. Absent or malformed data reads as no scope, so an entry that
 * a hand edit or another installation left malformed is projected on every branch instead
 * of breaking the projection that reads it.
 */
export function parseRuntimeBranches(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const branches: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > RUNTIME_BRANCH_NAME_MAX || !RUNTIME_BRANCH_NAME_PATTERN.test(item)) return undefined
    branches.push(item)
  }
  return branches
}

// The files below are this Source's own. A Host that copies them, as a Mnemon Pack or a sync
// does, or counts them for a storage inventory, reads their names and rules from here instead
// of keeping a copy that drifts when the Source changes.

/** The Runtime Source's directory under a storage root. */
export const RUNTIME_DIRECTORY = 'runtime'
/** The entries themselves, the source of truth the projections are written from. */
export const RUNTIME_MEMORIES_FILE = 'memories.json'
/** Each target's projection: its entries' plain content, the file a person reads. */
export const RUNTIME_PROJECTION_FILES = { user: 'USER.md', memory: 'MEMORY.md' } as const satisfies Readonly<Record<RuntimeMemoryTarget, string>>
/** Created exclusively while the files above are read or written; whoever copies them takes it too. */
export const RUNTIME_LOCK_FILE = '.memories.lock'
/** A lock file older than this was left by a process that stopped, and may be taken over. */
export const RUNTIME_LOCK_STALE_MS = 30_000
/** The local archive of entries that left MEMORY.md while no Memory Space could take them (#336). */
export const RUNTIME_ARCHIVE_DIRECTORY = 'archived'
/** The longest content one entry may hold, in UTF-8 bytes. */
export const RUNTIME_ENTRY_MAX_BYTES = 8 * 1024

type RuntimeEntryText = Pick<RuntimeMemoryEntry, 'target' | 'content'>

// Made on first use: a module-level encoder would run in every browser bundle that loads these contracts.
let utf8: TextEncoder | undefined

function joinedContent(entries: ReadonlyArray<RuntimeEntryText>, target: RuntimeMemoryTarget): string {
  return entries.filter(entry => entry.target === target).map(entry => entry.content).join(RUNTIME_ENTRY_DELIMITER)
}

/** The UTF-8 bytes one target's entries take against its limit: their contents joined by the delimiter. */
export function runtimeBytes(entries: ReadonlyArray<RuntimeEntryText>, target: RuntimeMemoryTarget): number {
  utf8 ??= new TextEncoder()
  return utf8.encode(joinedContent(entries, target)).byteLength
}

/** One target's projection file, USER.md or MEMORY.md, exactly as the Runtime Source writes it. */
export function runtimeProjection(entries: ReadonlyArray<RuntimeEntryText>, target: RuntimeMemoryTarget): string {
  const content = joinedContent(entries, target)
  return content === '' ? '' : `${content}\n`
}

/** What a stored memories.json holds, counted without judging each entry. */
export interface RuntimeMemoriesSummary {
  /** Whether the file has an entry list at all. Without one, every count is 0. */
  valid: boolean
  /** Every entry that is an object, whatever its target. */
  entries: number
  user: number
  memory: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Count the entries of a parsed memories.json for a read-only inventory. It never throws: a file
 * without an entry list is not `valid`, and a malformed entry is counted or skipped, never refused.
 */
export function summarizeRuntimeMemories(value: unknown): RuntimeMemoriesSummary {
  const entries = isObject(value) && Array.isArray(value.entries) ? value.entries.filter(isObject) : []
  return {
    valid: isObject(value) && Array.isArray(value.entries),
    entries: entries.length,
    user: entries.filter(entry => entry.target === 'user').length,
    memory: entries.filter(entry => entry.target === 'memory').length,
  }
}
