import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import type { MemoryJsonValue, MemoryOperationScope } from '../../core/contracts/index.ts'
import { withMemoryStorageLock } from '../index.ts'

export type RecordState = 'pending' | 'active' | 'archived' | 'rejected' | 'deleted'
export type RecordScope = 'global' | 'project' | 'session' | 'daily'
export interface RecordValue {
  id: string
  kind: string
  title: string
  content: string
  scope: RecordScope
  workspaceId?: string
  sessionId?: string
  date?: string
  state: RecordState
  data: { [key: string]: MemoryJsonValue }
  signals: number
  createdAt: string
  updatedAt: string
  version: number
  history: Array<{ at: string; operation: string; title: string; content: string; state: RecordState; data: { [key: string]: MemoryJsonValue } }>
}
export interface RecordSnapshot { revision: string; records: RecordValue[] }
interface RecordFile { format: 'mnemon-records/v1'; records: RecordValue[] }
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const json = (value: unknown): MemoryJsonValue => JSON.parse(JSON.stringify(value)) as MemoryJsonValue
export const today = (): string => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function visibleRecord(record: RecordValue, scope: MemoryOperationScope): boolean {
  if (record.scope === 'project') return !!scope.workspaceId && record.workspaceId === resolve(scope.workspaceId)
  if (record.scope === 'session') return !!scope.sessionId && record.sessionId === scope.sessionId && record.workspaceId === (scope.workspaceId ? resolve(scope.workspaceId) : undefined)
  return true
}

export function recordScope(scope: RecordScope, context: MemoryOperationScope, date?: string): Pick<RecordValue, 'scope' | 'workspaceId' | 'sessionId' | 'date'> {
  if (!['global', 'project', 'session', 'daily'].includes(scope)) throw new Error('Unsupported record scope')
  if (scope === 'project' && !context.workspaceId) throw new Error('Select a workspace before adding a project record')
  if (scope === 'session' && !context.sessionId) throw new Error('A session is required')
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Date must be YYYY-MM-DD')
  return { scope,
    ...((scope === 'project' || scope === 'session') && context.workspaceId ? { workspaceId: resolve(context.workspaceId) } : {}),
    ...(scope === 'session' ? { sessionId: context.sessionId! } : {}),
    ...(scope === 'daily' ? { date: date ?? today() } : {}),
  }
}

export function validateRecord(value: unknown): asserts value is RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record')
  const r = value as RecordValue
  if (typeof r.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(r.id) || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 300
    || typeof r.content !== 'string' || r.content.length > 100_000 || typeof r.kind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(r.kind)
    || !['global', 'project', 'session', 'daily'].includes(r.scope) || !['pending', 'active', 'archived', 'rejected', 'deleted'].includes(r.state)
    || !Number.isSafeInteger(r.version) || r.version < 1 || !Number.isSafeInteger(r.signals) || r.signals < 1
    || typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt))
    || typeof r.updatedAt !== 'string' || !Number.isFinite(Date.parse(r.updatedAt))
    || !r.data || typeof r.data !== 'object' || Array.isArray(r.data) || JSON.stringify(r.data).length > 128_000
    || !Array.isArray(r.history) || r.history.length > 50) throw new Error('Invalid record fields')
  for (const entry of r.history) {
    if (!entry || typeof entry.operation !== 'string' || entry.operation.length > 100 || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
      || typeof entry.title !== 'string' || entry.title.length > 300 || typeof entry.content !== 'string' || entry.content.length > 100_000
      || !['pending', 'active', 'archived', 'rejected', 'deleted'].includes(entry.state) || !entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data) || JSON.stringify(entry.data).length > 128_000) throw new Error('Invalid record history')
  }
  if (r.scope === 'project' && (typeof r.workspaceId !== 'string' || !isAbsolute(r.workspaceId))) throw new Error('Invalid project scope')
  if (r.scope === 'session' && (typeof r.sessionId !== 'string' || !r.sessionId)) throw new Error('Invalid session scope')
  if (r.scope === 'daily' && (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(Date.parse(r.date)) || new Date(r.date).toISOString().slice(0, 10) !== r.date)) throw new Error('Invalid daily scope')
}

/** One Source-owned directory; no global registry or access to other Sources. */
export class RecordStore {
  readonly directory: string
  readonly file: string
  constructor(directory: string) { this.directory = resolve(directory); this.file = join(this.directory, 'records.json') }
  async read(signal?: AbortSignal): Promise<RecordSnapshot> {
    signal?.throwIfAborted()
    let content: string
    try {
      if ((await stat(this.file)).size > 32 * 1024 * 1024) throw new Error('Record collection exceeds 32 MiB')
      content = await readFile(this.file, { encoding: 'utf8', ...(signal ? { signal } : {}) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: digest([]), records: [] }
      throw error
    }
    let parsed: RecordFile
    try { parsed = JSON.parse(content) as RecordFile } catch { throw new Error('Record file is damaged; the original file has been preserved') }
    if (parsed.format !== 'mnemon-records/v1' || !Array.isArray(parsed.records) || parsed.records.length > 10_000) throw new Error('Unsupported or damaged record file')
    const ids = new Set<string>()
    for (const record of parsed.records) { validateRecord(record); if (ids.has(record.id)) throw new Error('Duplicate record id'); ids.add(record.id) }
    return { revision: digest(parsed.records), records: parsed.records }
  }
  async change(expectedRevision: string | undefined, operation: (records: RecordValue[]) => void | Promise<void>, signal?: AbortSignal): Promise<RecordSnapshot> {
    return withMemoryStorageLock(this.directory, async () => {
      signal?.throwIfAborted()
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const owner = randomUUID()
      let compromised: Error | undefined
      const release = await lock(this.directory, { lockfilePath: join(this.directory, 'records.lock'), stale: 10_000, update: 2_000,
        retries: { retries: 24, minTimeout: 50, maxTimeout: 500, factor: 1.4, randomize: false },
        onCompromised(error) { compromised = error },
      })
      const temporary = join(this.directory, `records.${owner}.tmp`)
      try {
        const current = await this.read(signal)
        if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error('Record revision changed; refresh before saving')
        await operation(current.records)
        signal?.throwIfAborted()
        const ids = new Set<string>()
        for (const record of current.records) { validateRecord(record); if (ids.has(record.id)) throw new Error('Duplicate record id'); ids.add(record.id) }
        const content = JSON.stringify({ format: 'mnemon-records/v1', records: current.records } satisfies RecordFile, null, 2) + '\n'
        if (current.records.length > 10_000 || Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('Record collection capacity exceeded')
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
        signal?.throwIfAborted()
        if (compromised) throw compromised
        await rename(temporary, this.file)
        return { revision: digest(current.records), records: current.records }
      } finally {
        await rm(temporary, { force: true })
        await release()
      }
    })
  }
}

export function reviseRecord(record: RecordValue, operation: string): void {
  record.history = [...record.history, { at: record.updatedAt, operation, title: record.title, content: record.content, state: record.state, data: structuredClone(record.data) }].slice(-50)
  record.version++
  record.updatedAt = new Date().toISOString()
}

export function newRecord(kind: string, title: string, content: string, scope: RecordScope, context: MemoryOperationScope, data: RecordValue['data'] = {}, state: RecordState = 'active'): RecordValue {
  const at = new Date().toISOString()
  return { id: randomUUID(), kind, title, content, ...recordScope(scope, context), state, data: structuredClone(data), signals: 1, version: 1, createdAt: at, updatedAt: at, history: [] }
}
