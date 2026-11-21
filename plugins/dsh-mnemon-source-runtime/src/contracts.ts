export type RuntimeMemoryTarget = 'memory' | 'user'
export type RuntimeMemoryImportance = 'critical' | 'normal' | 'low'
export type RuntimeMemoryAction = 'add' | 'replace' | 'remove'

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
  pinned?: boolean
  branches?: string[]
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
  branches?: string[]
}

export interface RuntimeMemoryMutation {
  action: RuntimeMemoryAction
  target: RuntimeMemoryTarget
  content?: string
  oldText?: string
  importance?: RuntimeMemoryImportance
  matchBranches?: string[]
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
  localArchive?: true
}

import { DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES, DEFAULT_RUNTIME_USER_LIMIT_BYTES, MAX_RUNTIME_MEMORY_LIMIT_BYTES } from './defaults.ts'
export const RUNTIME_MEMORY_VERSION = 1
export const RUNTIME_ENTRY_DELIMITER = '\n§\n'
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
export const RUNTIME_MEMORY_LIMIT_MAX_BYTES = MAX_RUNTIME_MEMORY_LIMIT_BYTES

export const RUNTIME_BRANCH_NAME_MAX = 128
export const RUNTIME_BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/u
export const RUNTIME_BRANCHES_PER_ENTRY_MAX = 16

export function isValidRuntimeBranchName(branch: string): boolean {
  return branch !== ''
    && branch.length <= RUNTIME_BRANCH_NAME_MAX
    && RUNTIME_BRANCH_NAME_PATTERN.test(branch)
    && branch !== '-'
    && !branch.startsWith('/') && !branch.startsWith('-')
    && !branch.endsWith('/') && !branch.endsWith('.')
    && !branch.includes('..') && !branch.includes('//') && !branch.includes('@{')
}

export function parseRuntimeBranches(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > RUNTIME_BRANCHES_PER_ENTRY_MAX) return undefined
  const branches: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !isValidRuntimeBranchName(item) || seen.has(item)) return undefined
    seen.add(item)
    branches.push(item)
  }
  return branches
}

export const RUNTIME_DIRECTORY = 'runtime'
export const RUNTIME_MEMORIES_FILE = 'memories.json'
export const RUNTIME_PROJECTION_FILES = { user: 'USER.md', memory: 'MEMORY.md' } as const satisfies Readonly<Record<RuntimeMemoryTarget, string>>
export const RUNTIME_LOCK_FILE = '.memories.lock'
export const RUNTIME_LOCK_STALE_MS = 30_000
export const RUNTIME_ARCHIVE_DIRECTORY = 'archived'
export const RUNTIME_ENTRY_MAX_BYTES = 8 * 1024

type RuntimeEntryText = Pick<RuntimeMemoryEntry, 'target' | 'content'>

let utf8: TextEncoder | undefined

function joinedContent(entries: ReadonlyArray<RuntimeEntryText>, target: RuntimeMemoryTarget): string {
  return entries.filter(entry => entry.target === target).map(entry => entry.content).join(RUNTIME_ENTRY_DELIMITER)
}

export function runtimeBytes(entries: ReadonlyArray<RuntimeEntryText>, target: RuntimeMemoryTarget): number {
  utf8 ??= new TextEncoder()
  return utf8.encode(joinedContent(entries, target)).byteLength
}

export function runtimeProjection(entries: ReadonlyArray<RuntimeEntryText>, target: RuntimeMemoryTarget): string {
  const content = joinedContent(entries, target)
  return content === '' ? '' : `${content}\n`
}

export interface RuntimeMemoriesSummary {
  valid: boolean
  entries: number
  user: number
  memory: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function summarizeRuntimeMemories(value: unknown): RuntimeMemoriesSummary {
  const entries = isObject(value) && Array.isArray(value.entries) ? value.entries.filter(isObject) : []
  return {
    valid: isObject(value) && Array.isArray(value.entries),
    entries: entries.length,
    user: entries.filter(entry => entry.target === 'user').length,
    memory: entries.filter(entry => entry.target === 'memory').length,
  }
}
