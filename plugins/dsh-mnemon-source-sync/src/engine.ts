import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MemoryJsonValue, MemoryOperationScope, MemoryTransferEntry, MemoryTransferSnapshot } from 'dsh-mnemon/contracts'
import { memoryInputText } from 'dsh-mnemon/extension-sdk'
import { json, newRecord, RecordStore, reviseRecord, visibleRecord, type RecordValue } from 'dsh-mnemon/source-sdk'
import { hash, remoteAddress, repositoryIdentity, SnapshotGit, suggestedIdentity } from './git.ts'
import { canonical, type Binding, type Bundle, type CapturedTrack, type Conflict, type SyncPlan } from './protocol.ts'

export interface SyncConfig { dataDir?: string; allowLocalRemotes?: boolean }
interface TargetSettings { enabled: boolean; remote: string; identity: string; projectKey: string; branch: string; bindings: Binding[]; planId?: string; lastCommit?: string; lastPush?: string; lastPushAt?: string }
const targetSettings = (record: RecordValue) => record.data as unknown as TargetSettings
function snapshot(raw: unknown): MemoryTransferSnapshot {
  const value = raw as MemoryTransferSnapshot
  if (!value || value.format !== 'mnemon-source-transfer/v1' || typeof value.track !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(value.track) || !Array.isArray(value.entries) || value.entries.length > 10000) throw new Error('Unsupported portable Source snapshot')
  const ids = new Set<string>()
  for (const entry of value.entries) { if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(entry.id) || ids.has(entry.id) || entry.value === undefined) throw new Error('Invalid portable entry id'); ids.add(entry.id) }
  if (Buffer.byteLength(canonical(value)) > 4 * 1024 * 1024) throw new Error('A selected Source track exceeds 4 MiB')
  return structuredClone({ ...value, entries: value.entries.slice().sort((a, b) => a.id.localeCompare(b.id)) })
}
function bindings(raw: unknown): Binding[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 24) throw new Error('Select 1–24 Source tracks')
  const slots = new Set<string>(), clients = new Set<string>()
  return raw.map(value => {
    const b = value as Binding
    if (!b || typeof b.slot !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(b.slot) || slots.has(b.slot) || typeof b.track !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(b.track) || typeof b.sourceKey !== 'string' || !b.sourceKey.trim() || b.sourceKey.length > 300 || clients.has(b.sourceKey + '/' + b.track)) throw new Error('Choose unique portable names and Source tracks')
    slots.add(b.slot); clients.add(b.sourceKey + '/' + b.track)
    return { slot: b.slot, sourceKey: b.sourceKey, track: b.track }
  })
}
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null)
const empty = (track: string): MemoryTransferSnapshot => ({ format: 'mnemon-source-transfer/v1', track, entries: [] })
export function mergeTracks(base: MemoryTransferSnapshot, local: MemoryTransferSnapshot, remote: MemoryTransferSnapshot, slot: string): { snapshot: MemoryTransferSnapshot; conflicts: Conflict[] } {
  const maps = [base, local, remote].map(value => new Map(value.entries.map(entry => [entry.id, entry])))
  const ids = [...new Set(maps.flatMap(map => [...map.keys()]))].sort(), entries: MemoryTransferEntry[] = [], conflicts: Conflict[] = []
  for (const id of ids) {
    const [b, l, r] = maps.map(map => map.get(id))
    if (same(l, r) || same(r, b)) { if (l) entries.push(l) }
    else if (same(l, b)) { if (r) entries.push(r) }
    else conflicts.push({ key: hash([slot, id]).slice(0, 24), slot, id, base: b ?? null, local: l ?? null, remote: r ?? null })
  }
  return { snapshot: { ...local, entries }, conflicts }
}
export class SyncEngine {
  readonly store: RecordStore
  readonly stop = new AbortController()
  constructor(readonly directory: string, readonly config: SyncConfig = {}) { this.store = new RecordStore(directory) }
  private repository(target: RecordValue): SnapshotGit { return new SnapshotGit(join(this.directory, 'repositories', hash([target.id, targetSettings(target).identity, targetSettings(target).remote])), this.config.allowLocalRemotes === true) }
  private planFile(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid sync plan'); return join(this.directory, 'plans', id + '.json') }
  private signal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal }
  private target(records: RecordValue[], id: unknown, scope: MemoryOperationScope) { const item = records.find(record => record.id === id && record.kind === 'target' && visibleRecord(record, scope)); if (!item) throw new Error('Sync target is not available in this scope'); return item }
  private async readPlanFile(id: string): Promise<SyncPlan> { const file = this.planFile(id); if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error('Sync plan exceeds its bound'); return JSON.parse(await readFile(file, 'utf8')) as SyncPlan }
  private async savePlan(plan: SyncPlan) { const file = this.planFile(plan.id), content = JSON.stringify(plan) + '\n'; if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('Merge plan exceeds 32 MiB'); await mkdir(join(this.directory, 'plans'), { recursive: true, mode: 0o700 }); const temporary = file + '.' + randomUUID() + '.tmp'; await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, file) }
  private configHash(target: RecordValue) { const value = targetSettings(target); return hash([value.identity, value.remote, value.branch, value.bindings, value.enabled]) }
  async status(scope: MemoryOperationScope, signal?: AbortSignal) { const state = await this.store.read(this.signal(signal)); return { revision: state.revision, value: json({ targets: state.records.filter(record => visibleRecord(record, scope)), suggestion: await suggestedIdentity(scope.workspaceId) }) } }
  async plan(scope: MemoryOperationScope, targetId: unknown) {
    const state = await this.store.read(), target = this.target(state.records, targetId, scope), id = targetSettings(target).planId
    return { revision: state.revision, value: id ? json(await this.readPlanFile(id)) : null }
  }
  async configure(scope: MemoryOperationScope, input: Record<string, MemoryJsonValue>, revision: string, signal?: AbortSignal) {
    const selectedScope = input.scope === 'global' ? 'global' : 'project'
    if (selectedScope === 'project' && !scope.workspaceId) throw new Error('Select a workspace')
    const suggestion = await suggestedIdentity(scope.workspaceId)
    const projectKey = memoryInputText(input.projectKey, 'projectKey', 300, false) || (selectedScope === 'project' ? suggestion.projectKey : 'personal')
    if (!projectKey) throw new Error('Enter a stable project identity for this non-Git workspace')
    const remote = remoteAddress(memoryInputText(input.remote, 'remote', 2000, selectedScope === 'global') || suggestion.origin, this.config.allowLocalRemotes === true)
    const identity = hash([selectedScope, repositoryIdentity(projectKey)]).slice(0, 32)
    const selected = bindings(input.bindings), title = memoryInputText(input.title, 'title', 300, false) ?? (selectedScope === 'project' ? 'Project memory' : 'Global memory')
    await this.store.change(revision, async records => {
      const existing = input.id ? this.target(records, input.id, scope) : undefined
      if (existing && existing.scope !== selectedScope) throw new Error('A target cannot change its scope')
      if (existing && targetSettings(existing).planId) { const plan = await this.readPlanFile(targetSettings(existing).planId!); if (!['complete', 'cancelled'].includes(plan.status)) throw new Error('Finish or cancel the existing merge before changing its target') }
      const data: TargetSettings = { enabled: input.enabled !== false, remote, identity, projectKey, branch: 'memory/' + selectedScope + '-' + identity, bindings: selected }
      if (existing) { const previous = targetSettings(existing); reviseRecord(existing, 'configure-sync'); existing.title = title; existing.data = json({ ...(previous.identity === identity && previous.remote === remote ? previous : {}), ...data }) as RecordValue['data'] }
      else { if (records.filter(record => visibleRecord(record, scope)).length >= 30) throw new Error('Too many sync targets in this scope'); records.push(newRecord('target', title, '', selectedScope, scope, json(data) as RecordValue['data'])) }
    }, this.signal(signal))
    return this.status(scope, signal)
  }
  async prepare(scope: MemoryOperationScope, input: Record<string, MemoryJsonValue>, revision: string, externalSignal?: AbortSignal) {
    const signal = this.signal(externalSignal)
    let result: SyncPlan | undefined
    await this.store.change(revision, async records => {
      const target = this.target(records, input.id, scope), settings = targetSettings(target)
      if (!settings.enabled) throw new Error('Enable this sync target first')
      if (settings.planId) { const plan = await this.readPlanFile(settings.planId); if (!['complete', 'cancelled'].includes(plan.status)) throw new Error('Finish or cancel the existing merge first') }
      if (!Array.isArray(input.captures) || input.captures.length !== settings.bindings.length) throw new Error('Capture every selected Source track')
      const captures = settings.bindings.map(binding => {
        const value = (input.captures as unknown as CapturedTrack[]).find(value => same(value.binding, binding))
        if (!value || typeof value.revision !== 'string' || !value.revision || value.revision.length > 400) throw new Error('A Source capture is missing its revision')
        const portable = snapshot(value.snapshot); if (portable.track !== binding.track) throw new Error('Captured track differs from the selected binding')
        return { binding, revision: value.revision, snapshot: portable }
      })
      const repository = this.repository(target); await repository.initialize(signal)
      const head = await repository.head(settings.branch, signal), remoteHead = await repository.fetch(settings.remote, settings.branch, signal), commonHead = await repository.common(head, remoteHead, signal)
      const local = await repository.bundle(head, settings.identity, target.scope as Bundle['scope'], signal), remote = await repository.bundle(remoteHead, settings.identity, target.scope as Bundle['scope'], signal), base = await repository.bundle(commonHead, settings.identity, target.scope as Bundle['scope'], signal)
      for (const bundle of [local, remote, base]) for (const [slot, track] of Object.entries(bundle.tracks)) { if (!/^[a-z][a-z0-9-]{0,99}$/.test(slot)) throw new Error('Invalid remote Source track'); bundle.tracks[slot] = snapshot(track) }
      const merged: Bundle = { ...remote, tracks: { ...local.tracks, ...remote.tracks } }, conflicts: Conflict[] = []
      for (const capture of captures) {
        const { slot, track } = capture.binding
        for (const value of [base, remote]) if (Object.hasOwn(value.tracks, slot) && value.tracks[slot]!.track !== track) throw new Error('The portable track name belongs to a different Source track')
        const result = mergeTracks(Object.hasOwn(base.tracks, slot) ? base.tracks[slot]! : empty(track), capture.snapshot, Object.hasOwn(remote.tracks, slot) ? remote.tracks[slot]! : empty(track), slot)
        merged.tracks[slot] = result.snapshot; conflicts.push(...result.conflicts)
      }
      if (Buffer.byteLength(canonical(merged)) > 8 * 1024 * 1024) throw new Error('Combined snapshot exceeds 8 MiB')
      result = { id: randomUUID(), targetId: target.id, configDigest: this.configHash(target), createdAt: new Date().toISOString(), status: conflicts.length ? 'conflicts' : 'ready', head, remoteHead, commonHead, branch: settings.branch, remote: settings.remote, local: captures, merged, conflicts, receipts: {} }
      await this.savePlan(result); reviseRecord(target, 'prepare-sync'); settings.planId = result.id
    }, signal)
    return { revision: (await this.store.read()).revision, value: json(result) }
  }
  async changePlan(operation: string, scope: MemoryOperationScope, input: Record<string, MemoryJsonValue>, revision: string, externalSignal?: AbortSignal) {
    const signal = this.signal(externalSignal)
    let result: SyncPlan | undefined
    await this.store.change(revision, async records => {
      const target = this.target(records, input.id, scope), settings = targetSettings(target)
      if (!settings.planId || settings.planId !== input.planId) throw new Error('The selected merge plan changed')
      const plan = await this.readPlanFile(settings.planId)
      if (plan.configDigest !== this.configHash(target)) throw new Error('Sync target configuration changed')
      if (operation === 'cancel-plan') { if (plan.status === 'complete') throw new Error('A completed snapshot is retained in history'); plan.status = 'cancelled' }
      else if (operation === 'resolve-conflict') {
        if (plan.status !== 'conflicts') throw new Error('This plan is not awaiting conflict decisions')
        const conflict = plan.conflicts.find(value => value.key === input.key)
        if (!conflict || conflict.choice || !['local', 'remote', 'both'].includes(String(input.choice))) throw new Error('Choose an unresolved conflict and a resolution')
        conflict.choice = input.choice as NonNullable<Conflict['choice']>
        const entries = plan.merged.tracks[conflict.slot]!.entries
        const local = conflict.local as MemoryTransferEntry | null, remote = conflict.remote as MemoryTransferEntry | null
        if (input.choice !== 'remote' && local) entries.push(local)
        if (input.choice !== 'local' && remote) entries.push(input.choice === 'both' && local ? { ...remote, id: conflict.id.slice(0, 70) + '-' + hash([plan.id, conflict.key, 'remote']).slice(0, 16) } : remote)
        entries.sort((a, b) => a.id.localeCompare(b.id))
        if (plan.conflicts.every(value => value.choice)) plan.status = 'ready'
      } else if (operation === 'begin-apply') {
        if (!['ready', 'applying'].includes(plan.status)) throw new Error('Resolve every conflict before applying')
        const repository = this.repository(target)
        if (await repository.head(settings.branch, signal) !== plan.head) {
          if (plan.status !== 'applying' || plan.local.some(value => !plan.receipts[value.binding.slot])) throw new Error('Local snapshot branch changed')
          const acknowledged = structuredClone(plan.merged)
          for (const capture of plan.local) acknowledged.tracks[capture.binding.slot] = plan.receipts[capture.binding.slot]!.snapshot
          await repository.reviewedHead(acknowledged, settings.branch, plan.head, plan.remoteHead, plan.id, signal)
        }
        plan.status = 'applying'
      } else if (operation === 'record-apply') {
        if (plan.status !== 'applying') throw new Error('Begin applying this reviewed plan first')
        const slot = memoryInputText(input.slot, 'slot', 100)!, capture = plan.local.find(value => value.binding.slot === slot)
        if (!capture) throw new Error('Track is outside this plan')
        const actual = snapshot(input.snapshot), sourceRevision = memoryInputText(input.sourceRevision, 'Source revision', 400)!
        if (actual.track !== capture.binding.track) throw new Error('Import receipt belongs to another track')
        // The owning Source returns its normalized snapshot after its own CAS.
        // No Source implementation or data directory is accessed here.
        plan.receipts[slot] = { revision: sourceRevision, snapshot: actual, at: new Date().toISOString() }
      } else if (operation === 'commit-plan') {
        if (plan.status !== 'applying' || plan.local.some(value => !plan.receipts[value.binding.slot])) throw new Error('Every selected Source must acknowledge its import before committing')
        for (const capture of plan.local) plan.merged.tracks[capture.binding.slot] = plan.receipts[capture.binding.slot]!.snapshot
        if (Buffer.byteLength(canonical(plan.merged)) > 8 * 1024 * 1024) throw new Error('Normalized snapshot exceeds 8 MiB')
        plan.commit = await this.repository(target).commit(plan.merged, settings.branch, plan.head, plan.remoteHead, plan.id, signal)
        plan.status = 'complete'; settings.lastCommit = plan.commit
      } else throw new Error('Unsupported sync plan operation')
      await this.savePlan(plan); reviseRecord(target, operation); result = plan
    }, signal)
    return { revision: (await this.store.read()).revision, value: json(result) }
  }
  async pushPlan(scope: MemoryOperationScope, id: unknown) {
    const state = await this.store.read(), target = this.target(state.records, id, scope), value = targetSettings(target), head = await this.repository(target).head(value.branch)
    return { revision: state.revision, value: json({ targetId: target.id, remote: value.remote, branch: value.branch, head, enabled: value.enabled }) }
  }
  async push(scope: MemoryOperationScope, input: Record<string, MemoryJsonValue>, revision: string, externalSignal?: AbortSignal) {
    await this.store.change(revision, async records => {
      const target = this.target(records, input.id, scope), settings = targetSettings(target)
      const plan = settings.planId ? await this.readPlanFile(settings.planId) : undefined
      if (!settings.enabled || input.remote !== settings.remote || input.branch !== settings.branch || input.head !== (plan?.status === 'complete' ? plan.commit : settings.lastCommit) || !input.head) throw new Error('Review the exact destination, branch and committed snapshot before pushing')
      if (plan && plan.status !== 'complete') throw new Error('Finish the current merge before pushing')
      await this.repository(target).push(settings.remote, settings.branch, String(input.head), this.signal(externalSignal))
      reviseRecord(target, 'push-snapshot'); settings.lastPush = String(input.head); settings.lastPushAt = new Date().toISOString()
    }, this.signal(externalSignal))
    return this.status(scope, externalSignal)
  }
  dispose() { this.stop.abort(new Error('Sync Source unloaded')) }
}
