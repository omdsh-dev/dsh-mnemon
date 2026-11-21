import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { MemoryPluginEntryView, MemoryPluginPreference, MemoryViewDashboard } from '../host/view-protocol.ts'
import type { MnemonClient } from './api.ts'
import { message } from './page-kit.tsx'
import { ExternalStore } from './shared/store.ts'

export interface MnemonViewChange {
  seq: number
  origin: 'own' | 'external'
  key?: string
  before: MemoryViewDashboard
  after: MemoryViewDashboard
}

export interface MnemonViewState {
  status: 'loading' | 'ready' | 'unavailable'
  dashboard: MemoryViewDashboard | null
  working: { key: string; before: MemoryViewDashboard; after: MemoryViewDashboard } | null
  failure: { seq: number; key: string; kind: 'apply' | 'refresh' } | null
  change: MnemonViewChange | null
}

interface ViewRequest {
  key: string
  strategyTypeId: string | undefined
  entries: Record<string, MemoryPluginPreference>
  configured: readonly string[]
}

const STALE_REVISION_PATTERN = /configuration changed/u
const OWN_WRITE_ECHO_WINDOW_MS = 5000

function rebase(request: ViewRequest, dashboard: MemoryViewDashboard): Record<string, MemoryPluginPreference> {
  return Object.fromEntries(Object.entries(request.entries).map(([entryId, preference]) => {
    const current = dashboard.entries.find(entry => entry.entryId === entryId)
    const config = request.configured.includes(entryId) ? preference.config : current?.config ?? preference.config
    return [entryId, { enabled: preference.enabled, config: structuredClone(config) }]
  }))
}

export function switchedEntries(before: MemoryViewDashboard, after: MemoryViewDashboard): MemoryPluginEntryView[] {
  return after.entries.filter(entry => {
    const previous = before.entries.find(candidate => candidate.entryId === entry.entryId)
    return previous !== undefined && previous.enabled !== entry.enabled
  })
}

export function reconfiguredEntries(before: MemoryViewDashboard, after: MemoryViewDashboard): MemoryPluginEntryView[] {
  return after.entries.filter(entry => {
    const previous = before.entries.find(candidate => candidate.entryId === entry.entryId)
    return previous !== undefined && JSON.stringify(previous.config) !== JSON.stringify(entry.config)
  })
}

function moved(before: MemoryViewDashboard, after: MemoryViewDashboard): boolean {
  return before.strategyTypeId !== after.strategyTypeId || switchedEntries(before, after).length > 0 || reconfiguredEntries(before, after).length > 0
}

export class MnemonViewStore extends ExternalStore<MnemonViewState> {
  private ticket = 0
  private seq = 0
  private last: ViewRequest | undefined
  private own: { at: number; request: ViewRequest } | undefined

  constructor(private readonly client: MnemonClient | undefined) {
    super({ status: client === undefined ? 'unavailable' : 'loading', dashboard: null, working: null, failure: null, change: null })
  }

  async load(): Promise<void> {
    if (this.client === undefined || this.snapshot.working !== null) return
    const ticket = ++this.ticket
    const previous = this.snapshot.status === 'ready' ? this.snapshot.dashboard : null
    if (this.snapshot.status !== 'ready') this.setSnapshot({ ...this.snapshot, status: 'loading' })
    try {
      const dashboard = await this.client.viewDashboard()
      if (ticket !== this.ticket) return
      const external = previous !== null && moved(previous, dashboard) && !this.echoes(previous, dashboard)
      this.setSnapshot({
        ...this.snapshot, status: 'ready', dashboard, failure: null,
        change: external ? { seq: ++this.seq, origin: 'external', before: previous, after: dashboard } : this.snapshot.change,
      })
    } catch {
      if (ticket === this.ticket) this.setSnapshot({ ...this.snapshot, status: 'unavailable', dashboard: null })
    }
  }

  async apply(key: string, strategyTypeId: string | undefined, entries: Record<string, MemoryPluginPreference>, configured: readonly string[] = []): Promise<boolean> {
    const previous = this.snapshot.dashboard
    if (this.client === undefined || previous === null || this.snapshot.working !== null) return false
    const ticket = ++this.ticket
    const request: ViewRequest = { key, strategyTypeId, entries, configured }
    this.last = request
    this.own = { at: Date.now(), request }
    const optimistic: MemoryViewDashboard = { ...previous, strategyTypeId: strategyTypeId ?? previous.strategyTypeId, entries: previous.entries.map(entry => entries[entry.entryId] === undefined
      ? entry
      : { ...entry, enabled: entries[entry.entryId]!.enabled, active: entries[entry.entryId]!.enabled, ...configured.includes(entry.entryId) ? { config: entries[entry.entryId]!.config } : {} }) }
    this.setSnapshot({ ...this.snapshot, working: { key, before: previous, after: optimistic }, failure: null, dashboard: optimistic })
    let base = previous
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.client.applyView({ expectedRevision: base.revision, strategyTypeId: strategyTypeId ?? base.strategyTypeId, entries: rebase(request, base) })
          break
        } catch (reason) {
          const latest = attempt === 0 && STALE_REVISION_PATTERN.test(message(reason)) ? await this.client.viewDashboard().catch(() => undefined) : undefined
          if (latest === undefined || ticket !== this.ticket) throw reason
          base = latest
        }
      }
    } catch {
      if (ticket !== this.ticket) return false
      const current = await this.client.viewDashboard().catch(() => previous)
      if (ticket === this.ticket) this.setSnapshot({ ...this.snapshot, dashboard: current, working: null, failure: { seq: ++this.seq, key, kind: 'apply' } })
      return false
    }
    try {
      const next = await this.client.viewDashboard()
      if (ticket === this.ticket) this.setSnapshot({ ...this.snapshot, status: 'ready', dashboard: next, working: null, change: { seq: ++this.seq, origin: 'own', key, before: base, after: next } })
    } catch {
      if (ticket === this.ticket) this.setSnapshot({ ...this.snapshot, dashboard: this.snapshot.dashboard === null ? null : { ...this.snapshot.dashboard, writable: false }, working: null, failure: { seq: ++this.seq, key, kind: 'refresh' } })
    }
    return true
  }

  setEnabled(key: string, changes: ReadonlyArray<{ entry: MemoryPluginEntryView; enabled: boolean }>): Promise<boolean> {
    return this.apply(key, undefined, Object.fromEntries(changes.map(({ entry, enabled }) => [entry.entryId, { enabled, config: structuredClone(entry.config) }])))
  }

  configure(key: string, entry: MemoryPluginEntryView, config: Record<string, MemoryPluginPreference['config'][string]>): Promise<boolean> {
    return this.apply(key, undefined, { [entry.entryId]: { enabled: entry.enabled, config: structuredClone(config) } }, [entry.entryId])
  }

  revert(change: MnemonViewChange): Promise<boolean> {
    const reconfigured = reconfiguredEntries(change.before, change.after).map(entry => entry.entryId)
    const touched = new Set([...switchedEntries(change.before, change.after).map(entry => entry.entryId), ...reconfigured])
    const entries = Object.fromEntries([...touched].map(entryId => {
      const before = change.before.entries.find(candidate => candidate.entryId === entryId)!
      return [entryId, { enabled: before.enabled, config: structuredClone(before.config) }]
    }))
    return this.apply('revert:' + String(change.seq), change.before.strategyTypeId, entries, reconfigured)
  }

  retry(): Promise<boolean> {
    const last = this.last
    return last === undefined ? Promise.resolve(false) : this.apply(last.key, last.strategyTypeId, last.entries, last.configured)
  }

  private echoes(before: MemoryViewDashboard, after: MemoryViewDashboard): boolean {
    const own = this.own
    if (own === undefined || Date.now() - own.at > OWN_WRITE_ECHO_WINDOW_MS) return false
    if (before.strategyTypeId !== after.strategyTypeId && after.strategyTypeId !== own.request.strategyTypeId) return false
    return switchedEntries(before, after).every(entry => own.request.entries[entry.entryId]?.enabled === entry.enabled)
      && reconfiguredEntries(before, after).every(entry => own.request.configured.includes(entry.entryId))
  }
}

export function useViewStore(client: MnemonClient | undefined, refreshKey: number): { store: MnemonViewStore; state: MnemonViewState } {
  const store = useMemo(() => new MnemonViewStore(client), [client])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => { void store.load() }, [store, refreshKey])
  return { store, state }
}
