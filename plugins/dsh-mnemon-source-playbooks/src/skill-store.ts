import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { memoryInputText } from 'dsh-mnemon/extension-sdk'
import { digest, json, newRecord, RecordStore, reviseRecord, visibleRecord, type RecordSnapshot, type RecordValue } from 'dsh-mnemon/source-sdk'
import { type WorkspaceProcedure } from 'dsh-mnemon-workspace-kit'
import { bundleDigest, inspectSkillBundle, materializeSkillBundle, parseSkillBundle, redactSkillText, type SkillBundle } from './skill-bundle.ts'

export interface SkillBasis {
  id: string
  digest: string
  title: string
  content: string
  kind: 'learning' | 'library' | 'feedback' | 'manual' | 'native'
  signals: number
  scope: 'global' | 'project'
  sourceInstanceKey?: string
  recordId?: string
  recordVersion?: number
  evidence?: WorkspaceProcedure['evidence']
  native?: { name: string; provider: string; source: string; digest: string }
}
export interface SkillValidationResult { label: string; command: string; status: 'passed' | 'failed' | 'blocked' | 'cancelled'; exitCode: number | null; output: string; toolCallId?: string }
export interface SkillProposal { title: string; bundle: SkillBundle; reason: string; basis: SkillBasis; baseId?: string; nativeOriginal?: SkillBundle; reviewedFeedback?: string[] }
export const skillBundle = (record: RecordValue): SkillBundle => parseSkillBundle(record.data.bundle)
export const skillRecords = (snapshot: RecordSnapshot, scope: MemoryOperationScope) => snapshot.records.filter(record => visibleRecord(record, scope))
const versionRecord = (records: RecordValue[], scope: MemoryOperationScope, id: string, version?: number): RecordValue => {
  const record = records.find(record => record.id === id && record.kind === 'skill-version' && visibleRecord(record, scope))
  if (!record || version !== undefined && record.version !== version) throw new Error('The skill version changed or is outside this workspace; refresh before continuing')
  return record
}
export const skillFeedback = (records: readonly RecordValue[], id: string) => records.filter(record => record.kind === 'skill-event' && record.data.skillId === id && record.data.concern === true && !record.data.resolvedBy)

export function procedureBasis(procedure: WorkspaceProcedure): SkillBasis {
  const contentDigest = digest([procedure.content, procedure.scope, procedure.evidence])
  return { id: 'learning:' + procedure.sourceInstanceKey + ':' + procedure.recordId, digest: contentDigest, kind: 'learning', title: procedure.title, content: procedure.content, signals: procedure.signals, scope: procedure.scope, sourceInstanceKey: procedure.sourceInstanceKey, recordId: procedure.recordId, recordVersion: procedure.recordVersion, evidence: procedure.evidence }
}

/** Every candidate, validation and published resource belongs to this Source. */
export class SkillStore {
  readonly store: RecordStore
  readonly resourceRoot: string
  constructor(readonly directory: string) { this.store = new RecordStore(directory); this.resourceRoot = join(directory, 'versions') }

  async snapshot(scope: MemoryOperationScope, signal?: AbortSignal): Promise<RecordSnapshot> {
    const snapshot = await this.store.read(signal)
    return { revision: snapshot.revision, records: skillRecords(snapshot, scope) }
  }

  async propose(scope: MemoryOperationScope, proposal: SkillProposal, expected?: string, signal?: AbortSignal): Promise<RecordValue> {
    const bundle = parseSkillBundle(proposal.bundle), contentDigest = bundleDigest(bundle)
    if (proposal.basis.native && bundle.name !== proposal.basis.native.name) throw new Error('A native skill revision must retain the inspected name')
    const title = memoryInputText(proposal.title, 'skill title', 300)!, reason = memoryInputText(proposal.reason, 'reason', 2000)!
    let selected!: RecordValue
    await this.store.change(expected, records => {
      const sameScope = (record: RecordValue) => record.scope === proposal.basis.scope && visibleRecord(record, scope)
      const base = proposal.baseId ? versionRecord(records, scope, proposal.baseId) : undefined
      if (base && (base.state !== 'active' || base.data.enabled === false || !sameScope(base))) throw new Error('Refine an enabled published skill in the same scope')
      if (base && skillBundle(base).name !== bundle.name) throw new Error('A revision must retain the published skill name')
      const duplicate = records.find(record => record.kind === 'skill-version' && sameScope(record) && ['active', 'pending'].includes(record.state) && record.data.contentDigest === contentDigest)
      if (duplicate) { selected = duplicate; return }
      if (!base && records.some(record => record.kind === 'skill-version' && sameScope(record) && record.state === 'active' && skillBundle(record).name === bundle.name)) throw new Error('Read the published skill and propose a revision instead of creating another copy')
      if (records.some(record => record.kind === 'skill-version' && sameScope(record) && record.state === 'pending' && skillBundle(record).name === bundle.name)) throw new Error('This skill already has a pending candidate; review or dismiss it first')
      const lineageId = base ? String(base.data.lineageId) : randomUUID()
      const release = Math.max(0, ...records.filter(record => record.data.lineageId === lineageId).map(record => Number(record.data.release ?? 0))) + 1
      selected = newRecord('skill-version', title, bundle.files.find(file => file.path === 'SKILL.md')!.content, proposal.basis.scope, scope, {
        bundle: json(bundle), contentDigest, lineageId, release, enabled: true, reason: redactSkillText(reason), basis: json(proposal.basis),
        ...(base ? { baseId: base.id, baseDigest: base.data.contentDigest!, reviewedFeedback: skillFeedback(records, base.id).map(record => record.id).filter(id => proposal.reviewedFeedback === undefined || proposal.reviewedFeedback.includes(id)) } : {}),
        inspection: json(inspectSkillBundle(bundle)),
      }, 'pending')
      if (proposal.nativeOriginal) {
        const original = newRecord('skill-origin', title, '', proposal.basis.scope, scope, { bundle: json(parseSkillBundle(proposal.nativeOriginal)) })
        records.push(original); selected.data.nativeOriginId = original.id
      }
      records.push(selected)
    }, signal)
    return selected
  }

  async update(scope: MemoryOperationScope, id: string, version: number, bundleInput: unknown, title: string, expected: string, signal?: AbortSignal): Promise<RecordValue> {
    const bundle = parseSkillBundle(bundleInput)
    let selected!: RecordValue
    await this.store.change(expected, records => {
      selected = versionRecord(records, scope, id, version)
      if (selected.state !== 'pending') throw new Error('Published skills are immutable; create a reviewed revision')
      if (records.some(record => record.kind === 'skill-run' && record.data.skillId === id && record.data.status === 'running')) throw new Error('Wait for validation or cancel it before editing')
      if ((selected.data.baseId || selected.data.nativeOriginId) && skillBundle(selected).name !== bundle.name) throw new Error('A revision must retain the skill name')
      reviseRecord(selected, 'edit-candidate')
      selected.title = memoryInputText(title, 'skill title', 300)!
      selected.content = bundle.files.find(file => file.path === 'SKILL.md')!.content
      selected.data.bundle = json(bundle); selected.data.contentDigest = bundleDigest(bundle); selected.data.inspection = json(inspectSkillBundle(bundle))
      delete selected.data.validation
    }, signal)
    return selected
  }

  async publish(scope: MemoryOperationScope, id: string, version: number, expected: string, signal?: AbortSignal): Promise<RecordValue> {
    let selected!: RecordValue
    await this.store.change(expected, async records => {
      selected = versionRecord(records, scope, id, version)
      if (selected.state !== 'pending') throw new Error('Only pending skills can be published')
      const bundle = skillBundle(selected), inspection = inspectSkillBundle(bundle)
      if (inspection.errors.length) throw new Error('Resolve skill validation errors before publication: ' + inspection.errors.join('; '))
      const validation = selected.data.validation as { digest?: string; status?: string } | undefined
      if (bundle.checks.length && (validation?.digest !== inspection.digest || validation.status !== 'passed')) throw new Error('Run all declared checks successfully against this exact candidate before publishing')
      const base = selected.data.baseId ? versionRecord(records, scope, String(selected.data.baseId)) : undefined
      if (base && (base.state !== 'active' || base.data.enabled === false || base.data.contentDigest !== selected.data.baseDigest)) throw new Error('The original published skill changed or was disabled; review a new revision')
      if (records.some(record => record.kind === 'skill-version' && record.id !== base?.id && record.state === 'active' && visibleRecord(record, scope) && record.scope === selected.scope && skillBundle(record).name === bundle.name)) throw new Error('Another published skill has this name')
      const directory = await materializeSkillBundle(this.resourceRoot, bundle, signal)
      if (base) {
        reviseRecord(base, 'superseded'); base.state = 'archived'; base.data.supersededBy = selected.id
        for (const event of skillFeedback(records, base.id)) if (Array.isArray(selected.data.reviewedFeedback) && selected.data.reviewedFeedback.includes(event.id)) { reviseRecord(event, 'addressed-by-revision'); event.data.resolvedBy = selected.id }
      }
      reviseRecord(selected, 'publish'); selected.state = 'active'; selected.data.directory = directory; selected.data.publishedAt = new Date().toISOString()
    }, signal)
    return selected
  }

  async changeState(scope: MemoryOperationScope, id: string, version: number, operation: 'toggle' | 'archive' | 'reject', expected: string, signal?: AbortSignal): Promise<RecordValue> {
    let selected!: RecordValue
    await this.store.change(expected, records => {
      selected = versionRecord(records, scope, id, version)
      if (operation === 'reject' ? selected.state !== 'pending' : selected.state !== 'active') throw new Error('This operation is not available for the current skill state')
      reviseRecord(selected, operation)
      if (operation === 'toggle') selected.data.enabled = selected.data.enabled === false
      else selected.state = operation === 'archive' ? 'archived' : 'rejected'
    }, signal)
    return selected
  }

  async restore(scope: MemoryOperationScope, id: string, version: number, expected: string, signal?: AbortSignal): Promise<RecordValue> {
    const snapshot = await this.snapshot(scope, signal), previous = versionRecord(snapshot.records, scope, id, version)
    if (previous.state !== 'archived') throw new Error('Choose an archived skill version')
    const current = snapshot.records.find(record => record.kind === 'skill-version' && record.data.lineageId === previous.data.lineageId && record.state === 'active')
    return this.propose(scope, { title: previous.title, bundle: skillBundle(previous), reason: 'Restore a historical skill version through review',
      basis: { id: 'history:' + previous.id, digest: String(previous.data.contentDigest), title: previous.title, content: previous.content, kind: 'manual', signals: 1, scope: previous.scope as 'global' | 'project', recordId: previous.id, recordVersion: previous.version }, ...(current ? { baseId: current.id } : {}),
    }, expected, signal)
  }

  async event(scope: MemoryOperationScope, id: string, data: { eventKey: string; kind: string; content: string; concern?: boolean; verifiedByHuman?: boolean; exitCode?: number; status?: string }, signal?: AbortSignal): Promise<RecordValue | undefined> {
    let selected: RecordValue | undefined
    await this.store.change(undefined, records => {
      const skill = versionRecord(records, scope, id)
      if (records.some(record => record.kind === 'skill-event' && record.data.eventKey === data.eventKey)) return
      const { content, ...metadata } = data
      selected = newRecord('skill-event', skill.title + ' · ' + data.kind, redactSkillText(content).slice(0, 6000), skill.scope, scope, { ...metadata, skillId: skill.id, contentDigest: skill.data.contentDigest!, release: skill.data.release!, verifiedByHuman: data.verifiedByHuman === true })
      records.push(selected)
      // Retain all unresolved concerns; trim only old resolved observations.
      const expendable = records.filter(record => record.kind === 'skill-event' && (!record.data.concern || record.data.resolvedBy)).slice(0, -1500)
      for (const record of expendable) records.splice(records.indexOf(record), 1)
    }, signal)
    return selected
  }

  async feedback(scope: MemoryOperationScope, id: string, version: number, verdict: string, quote: string, expected: string, signal?: AbortSignal): Promise<RecordValue> {
    if (!['helpful', 'incorrect', 'outdated', 'failed'].includes(verdict)) throw new Error('Choose a supported feedback category')
    const content = redactSkillText(memoryInputText(quote, 'feedback', 2000)!)
    let selected!: RecordValue
    await this.store.change(expected, records => {
      const skill = versionRecord(records, scope, id, version)
      if (!['active', 'archived'].includes(skill.state)) throw new Error('Feedback belongs to a published skill version')
      selected = newRecord('skill-event', skill.title + ' · feedback', content, skill.scope, scope, { eventKey: randomUUID(), skillId: skill.id, contentDigest: skill.data.contentDigest!, release: skill.data.release!, kind: 'feedback', verdict, concern: verdict !== 'helpful', verifiedByHuman: true, originSessionId: scope.sessionId ?? '' })
      records.push(selected)
    }, signal)
    return selected
  }

  async defer(scope: MemoryOperationScope, basis: SkillBasis, reason: string, expected?: string, signal?: AbortSignal): Promise<void> {
    await this.store.change(expected, records => {
      if (records.some(record => record.kind === 'skill-decision' && record.data.basisId === basis.id && record.data.basisDigest === basis.digest && visibleRecord(record, scope))) return
      records.push(newRecord('skill-decision', basis.title, redactSkillText(memoryInputText(reason, 'decision reason', 2000)!), basis.scope, scope, { basisId: basis.id, basisDigest: basis.digest, decision: 'deferred' }))
    }, signal)
  }
}
