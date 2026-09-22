import { assertMemoryOperationPlan } from 'dsh-mnemon/source-sdk'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MemoryJsonValue, MemoryOperationScope } from 'dsh-mnemon/contracts'
import { memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { AssetStore, RecordStore, digest, json, reviseRecord, type AssetInput, type AssetReference, type RecordValue } from 'dsh-mnemon/source-sdk'
import { type WorkspaceActivity } from 'dsh-mnemon-workspace-kit'
import { configurationStamp, deliverWithin, planFor, sendWebhook, type ChannelPayload, type ChannelSender, type DeliveryPlan, type NotificationConfig } from './delivery.ts'

export interface NotificationPort {
  resolveSessionImage?(id: string | undefined, scope: MemoryOperationScope, signal?: AbortSignal): Promise<{ data: Uint8Array; name: string }>
  send?: ChannelSender
  subscribe?(listener: (activity: WorkspaceActivity) => void): () => void
}
export function makeNotice(title: string, content: string, scope: MemoryOperationScope, data: Record<string, MemoryJsonValue> = {}): RecordValue {
  const now = new Date().toISOString()
  return { id: randomUUID(), title, content, kind: 'notification', scope: 'global', state: 'active', data: { level: 'info', read: false, workspace: scope.workspaceId ?? null, session: scope.sessionId ?? null, assets: [], ...data }, signals: 1, version: 1, createdAt: now, updatedAt: now, history: [] }
}
export function sameWorkspace(record: RecordValue, scope: MemoryOperationScope): boolean { return record.data.workspace === (scope.workspaceId ?? null) }
export function validateNotice(record: RecordValue): void {
  if (!['notification', 'delivery'].includes(record.kind) || record.scope !== 'global' || !['info', 'warning', 'error'].includes(String(record.data.level)) || typeof record.data.read !== 'boolean'
    || record.content.length > 20_000 || !Array.isArray(record.data.assets) || record.data.assets.length > 10 || ![null, 'string'].includes(record.data.workspace === null ? null : typeof record.data.workspace)
    || ![null, 'string'].includes(record.data.session === null ? null : typeof record.data.session)) throw new Error('Invalid notification record')
  for (const value of record.data.assets) {
    const asset = value as unknown as AssetReference
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.id) || typeof asset.name !== 'string' || asset.name.length > 200 || typeof asset.mediaType !== 'string' || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 5 * 1024 * 1024) throw new Error('Invalid notification attachment')
  }
  if (record.kind === 'delivery' && (!record.data.plan || typeof record.data.plan !== 'object' || !['draft', 'sending', 'sent', 'partial'].includes(String(record.data.status)))) throw new Error('Invalid delivery record')
}

export class NotificationEngine {
  readonly store: RecordStore
  readonly assets: AssetStore
  readonly controller = new AbortController()
  private queue: Promise<void> = Promise.resolve()
  private readonly pending = new Set<Promise<unknown>>()
  private stop?: () => void
  lastActivityError = ''
  constructor(directory: string, readonly config: NotificationConfig, readonly port: NotificationPort) {
    this.store = new RecordStore(directory); this.assets = new AssetStore(join(directory, 'assets'))
    if (config.captureActivity !== false && port.subscribe) this.stop = port.subscribe(activity => {
      const value = structuredClone(activity)
      this.queue = this.queue.then(() => this.capture(value)).catch(error => { this.lastActivityError = String(error).slice(0, 500) })
    })
  }
  async capture(activity: WorkspaceActivity) {
    if (!activity.eventKey || activity.eventKey.length > 300 || !activity.title?.trim() || activity.title.length > 300 || activity.summary.length > 20_000) throw new Error('Invalid workspace activity')
    await this.store.change(undefined, records => {
      if (records.some(record => record.data.eventKey === activity.eventKey && record.data.originSource === activity.sourceInstanceKey)) return
      const record = makeNotice(activity.title, activity.summary, activity.scope, { eventKey: activity.eventKey, originSource: activity.sourceInstanceKey, level: activity.level, activityKind: activity.kind, sourceRecordId: activity.recordId ?? null })
      validateNotice(record); records.push(record)
    }, this.controller.signal)
  }
  async ingest(input: unknown, scope: MemoryOperationScope, signal?: AbortSignal): Promise<AssetReference[]> {
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > 10) throw new Error('At most ten attachments')
    const refs: AssetReference[] = []
    for (const value of input) {
      const attachment = memoryInputRecord(value, 'attachment') as unknown as AssetInput
      if (Object.keys(attachment).some(key => !['path', 'url', 'base64', 'name', 'sessionAttachmentId', 'latestSessionImage'].includes(key)) || Object.entries(attachment).some(([key, value]) => key === 'latestSessionImage' ? typeof value !== 'boolean' : typeof value !== 'string')) throw new Error('Invalid attachment input')
      const reference = await this.assets.ingest(attachment, { roots: this.config.attachmentRoots ?? [], urlOrigins: this.config.attachmentUrlOrigins ?? [], ...(scope.workspaceId ? { workspace: scope.workspaceId } : {}), ...(this.port.resolveSessionImage ? { resolveSessionImage: (id, signal) => this.port.resolveSessionImage!(id, scope, signal) } : {}) }, signal)
      refs.push(reference)
      if (refs.reduce((sum, asset) => sum + asset.bytes, 0) > 25 * 1024 * 1024) throw new Error('Attachments exceed 25 MiB in total')
    }
    return refs
  }
  async stage(input: Record<string, MemoryJsonValue>, scope: MemoryOperationScope, revision?: string, signal?: AbortSignal) {
    const title = memoryInputText(input.title, 'title', 300)!, content = memoryInputText(input.content, 'content', 20_000, false) ?? ''
    const assets = await this.ingest(input.attachments, scope, signal)
    const record = makeNotice(title, content, scope, { assets: json(assets) })
    if (input.delivery === true) {
      record.kind = 'delivery'
      record.data.status = 'draft'; record.data.read = true
      record.data.plan = json(planFor(record.id, title, content, input.mode ?? 'notification', input.channels, assets, scope, this.config))
      record.data.receipts = {}
    }
    validateNotice(record)
    const snapshot = await this.store.change(revision, records => { records.push(record) }, signal)
    return { revision: snapshot.revision, record }
  }
  send(id: string, expected: unknown, scope: MemoryOperationScope, revision?: string, signal?: AbortSignal) {
    const promise = this.performSend(id, expected, scope, revision, signal)
    this.pending.add(promise); void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }
  private async performSend(id: string, expected: unknown, scope: MemoryOperationScope, revision?: string, signal?: AbortSignal) {
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    let plan!: DeliveryPlan
    await this.store.change(revision, records => {
      const record = records.find(record => record.id === id && record.kind === 'delivery' && record.state === 'active' && sameWorkspace(record, scope))
      if (!record || record.data.status !== 'draft') throw new Error('Only an unsent draft in this workspace can be sent')
      plan = record.data.plan as unknown as DeliveryPlan
      assertMemoryOperationPlan(expected, plan, 'The delivery plan changed; prepare a new draft')
      if (plan.configurationStamp !== configurationStamp(this.config)) throw new Error('The delivery plan or channel configuration changed; prepare a new draft')
      // Claim durably before any external effect. A crash never causes an automatic resend.
      reviseRecord(record, 'send-requested'); record.data.status = 'sending'
    }, combined)
    const receipts: Record<string, { status: 'accepted' | 'failed' | 'uncertain'; detail: string; at: string }> = {}
    let attachments: ChannelPayload['attachments'] = []
    try {
      for (const asset of plan.assets) attachments.push({ ...asset, base64: (await this.assets.read(asset, combined)).toString('base64') })
      for (const target of plan.channels) {
        let attempted = false
        try {
          combined.throwIfAborted()
          const channel = this.config.channels?.find(channel => channel.id === target.id)
          if (!channel || plan.configurationStamp !== configurationStamp(this.config)) throw new Error('Channel configuration changed')
          attempted = true
          const detail = await deliverWithin(this.port.send ?? sendWebhook, channel, { format: 'mnemon-notification/v1', deliveryId: id, target: target.target, mode: plan.mode, title: plan.title, content: plan.content, sessionId: plan.session, attachments }, AbortSignal.any([combined, AbortSignal.timeout(20_000)]))
          receipts[target.id] = { status: 'accepted', detail: detail.slice(0, 500), at: new Date().toISOString() }
        } catch {
          receipts[target.id] = { status: attempted ? 'uncertain' : 'failed', detail: attempted ? 'Delivery was not confirmed. Check the channel before explicitly preparing another message.' : 'Delivery was not attempted.', at: new Date().toISOString() }
        }
        await this.store.change(undefined, records => { const record = records.find(record => record.id === id)!; reviseRecord(record, 'channel-receipt'); record.data.receipts = json(receipts) })
      }
    } finally {
      attachments = []
      await this.store.change(undefined, records => {
        const record = records.find(record => record.id === id)!
        reviseRecord(record, 'delivery-completed')
        record.data.status = Object.keys(receipts).length === plan.channels.length && Object.values(receipts).every(receipt => receipt.status === 'accepted') ? 'sent' : 'partial'
        record.data.read = false
        for (const target of plan.channels) if (!receipts[target.id]) receipts[target.id] = { status: 'failed', detail: 'Attachment preparation failed; delivery was not attempted.', at: new Date().toISOString() }
        record.data.receipts = json(receipts)
      })
    }
    return receipts
  }
  async asset(id: string, assetId: string, scope: MemoryOperationScope, signal?: AbortSignal) {
    const record = (await this.store.read(signal)).records.find(record => record.id === id && record.state !== 'deleted' && sameWorkspace(record, scope))
    const reference = (record?.data.assets as unknown as AssetReference[] | undefined)?.find(asset => asset.id === assetId)
    if (!reference) throw new Error('Attachment is not registered to this workspace record')
    return { reference, base64: (await this.assets.read(reference, signal)).toString('base64') }
  }
  async dispose() { this.stop?.(); this.controller.abort(new Error('Notifications Source unloaded')); await Promise.allSettled([this.queue, ...this.pending]) }
}
