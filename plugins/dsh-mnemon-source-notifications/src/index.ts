import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import type { MemoryJsonValue, MemorySourceDefinition } from 'dsh-mnemon/contracts'
import { createMemoryMutationReceipt, defineMemoryPlugin, installMemory, memoryConfigurationDigest, memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { createRecordSource, digest, json, reviseRecord, sourceRecordDirectory, withLookupRoutes } from 'dsh-mnemon/source-sdk'
import { DshWorkspaceAdapter, agentMemoryScope, installAgentHooks } from 'dsh-mnemon-workspace-kit/dsh'
import { NotificationEngine, sameWorkspace, validateNotice, type NotificationPort } from './engine.ts'
import { validateConfig, type NotificationConfig } from './delivery.ts'
export type { NotificationChannel, NotificationConfig, DeliveryPlan, ChannelPayload, ChannelSender } from './delivery.ts'
export type { NotificationPort } from './engine.ts'
export const name = 'dsh-mnemon-source-notifications'
export const inject = ['mnemonMemory', 'agents', 'sessionQuery', 'attachments']
export type Config = NotificationConfig
export const Config = z.object({ dataDir: z.string(), captureActivity: z.boolean().default(true), captureTurns: z.boolean().default(false), attachmentRoots: z.array(z.string()).default([]), attachmentUrlOrigins: z.array(z.string()).default([]),
  channels: z.array(z.object({ id: z.string(), label: z.string(), target: z.string(), endpoint: z.string(), bearerEnv: z.string() })).default([]),
}) as z<Config>
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Notifications', 'zh-CN': '通知中心' }, description: { en: 'Local inbox, registered attachments and reviewed channel delivery.', 'zh-CN': '本地收件箱、附件管理与经审核的渠道发送。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.notifications' }] })
const idSchema: MemoryJsonValue = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } }
const stageSchema: MemoryJsonValue = { type: 'object', required: ['title', 'channels'], additionalProperties: false, properties: {
  title: { type: 'string', maxLength: 300 }, content: { type: 'string', maxLength: 20000 }, mode: { type: 'string', enum: ['notification', 'message'] },
  channels: { oneOf: [{ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 }, { const: 'all' }] },
  attachments: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, url: { type: 'string' }, base64: { type: 'string' }, name: { type: 'string' }, sessionAttachmentId: { type: 'string' }, latestSessionImage: { type: 'boolean' } } } },
} }
const sendSchema: MemoryJsonValue = { type: 'object', required: ['id', 'plan'], additionalProperties: false, properties: { id: { type: 'string' }, plan: { type: 'object' } } }
const engines = new Map<string, { engine: NotificationEngine; refs: number }>()

export function createNotificationsSource(config: Config = {}, port: NotificationPort = {}): MemorySourceDefinition {
  validateConfig(config)
  const base = createRecordSource({ context: {"mode":"routed","weight":1} satisfies import('dsh-mnemon/contracts').MemoryContextProfile, typeId: 'notifications', role: 'notifications', label: 'Notifications', description: 'Personal notification inbox and explicit delivery receipts.', kinds: ['notification', 'delivery'], scopes: ['global'], defaultScope: 'global', modelWrites: 'append',
    prepare(record, scope) {
      if (record.kind !== 'notification') throw new Error('Prepare a delivery plan before using a channel')
      record.data = { level: record.data.level ?? 'info', read: false, workspace: scope.workspaceId ?? null, session: scope.sessionId ?? null, assets: [] }
    }, validate: validateNotice, visible: sameWorkspace,
    project(records) { return `Notifications: ${records.filter(record => record.kind === 'notification' && !record.data.read).length} unread; ${records.filter(record => record.kind === 'delivery' && record.data.status === 'draft').length} prepared deliveries. Local notices stay in the inbox. External sends need the exact reviewed delivery plan and a separate authorization.` },
  }, config)
  const actions = [...base.manifest.actions ?? [],
    { operation: {"effects":["propose"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'prepare-delivery', description: 'Prepare a channel message for review, including its exact targets and registered attachment hashes. Does not send.', capability: 'write' as const, inputSchema: stageSchema },
    { operation: {"effects":["deliver"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'send-delivery', description: 'Send the exact reviewed delivery plan to its listed external channel targets once. Requires explicit user authorization.', capability: 'write' as const, authority: 'external-message', inputSchema: sendSchema },
  ]
  const routes = [
    { access: {"kinds":["read"],"result":"records"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'delivery-plan', description: 'Read the complete channel plan for a prepared delivery.', capability: 'recall' as const, inputSchema: idSchema, maxCalls: 4, maxResults: 1, maxCharacters: 12000 },
    { access: {"kinds":["browse"],"result":"records"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'channels', description: 'List configured notification channels and their exact targets before preparing a delivery.', capability: 'recall' as const, inputSchema: { type: 'object', additionalProperties: false } as MemoryJsonValue, maxCalls: 2, maxResults: 16, maxCharacters: 12000 },
  ]
  const capabilities = base.manifest.capabilities.filter(capability => capability !== 'import')
  return { ...base, manifest: { ...base.manifest, capabilities, actions, consistency: 'namespace-pinned-live-read', routes: [...routes, ...base.manifest.routes ?? []] }, create(context) {
    const directory = sourceRecordDirectory('notifications', context, config), key = digest([directory, config])
    let entry = engines.get(key)
    if (!entry) { entry = { engine: new NotificationEngine(directory, config, port), refs: 0 }; engines.set(key, entry) }
    entry.refs++
    const engine = entry.engine
    const wrapped = withLookupRoutes({ ...base, manifest: { ...base.manifest, actions } }, { routes,
      namespace: async scope => ({ workspace: scope.workspaceId ?? null }),
      async run(operation, input, namespace, scope, signal) {
        if (memoryInputRecord(namespace, 'notification namespace').workspace !== (scope.workspaceId ?? null)) throw new Error('Workspace changed')
        if (operation === 'channels') return { items: (config.channels ?? []).map(channel => ({ id: channel.id, text: `${channel.label} → ${channel.target}\n${channel.endpoint}`, provenance: { kind: 'notification-channel' } })) }
        const record = (await engine.store.read(signal)).records.find(record => record.id === input.id && record.kind === 'delivery' && record.state === 'active' && sameWorkspace(record, scope))
        if (!record) throw new Error('Delivery is not available in this workspace')
        const text = JSON.stringify(record.data.plan, null, 2)
        return { items: [{ id: record.id, text: text.length <= 11000 ? text : 'Review this longer delivery plan in Notifications.', provenance: { kind: 'delivery-plan' } }], truncated: text.length > 11000 }
      },
    }).create(context)
    return { ...wrapped,
      async facts(request, signal) { const facts = await wrapped.facts(request, signal); return { ...facts, capabilities: facts.capabilities.filter(capability => capability !== 'import'), actionIds: [...facts.actionIds, 'prepare-delivery', 'send-delivery'] } },
      async manage(request) {
        const input = memoryInputRecord(request.input ?? {}, 'notification operation'), snapshot = await engine.store.read(request.signal)
        if (request.mode === 'read') {
          if (request.operation === 'channels') return { revision: snapshot.revision, value: json((config.channels ?? []).map(({ id, label, target, endpoint }) => ({ id, label, target, endpoint }))) }
          if (request.operation === 'inbox') {
            const query = String(input.query ?? '').toLocaleLowerCase(), offset = Math.max(0, Math.min(10000, Math.floor(Number(input.offset) || 0)))
            const all = snapshot.records.filter(record => ['active', 'archived'].includes(record.state) && (record.kind === 'notification' || record.kind === 'delivery'))
            const rows = all.filter(record => (input.archived === true ? record.state === 'archived' : record.state === 'active') && (input.unread !== true || !record.data.read) && (!query || (record.title + '\n' + record.content).toLocaleLowerCase().includes(query))).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
            return { revision: snapshot.revision, value: json({ unread: all.filter(record => record.state === 'active' && !record.data.read).length, total: rows.length, items: rows.slice(offset, offset + 30).map(record => ({ ...record, content: record.content.slice(0, 200), history: [], data: { ...record.data, plan: record.data.plan ? { mode: (record.data.plan as any).mode } : null } })), activityError: engine.lastActivityError }) }
          }
          if (request.operation === 'detail') {
            const record = snapshot.records.find(record => record.id === input.id && record.state !== 'deleted')
            if (!record) throw new Error('Notification is unavailable')
            return { revision: snapshot.revision, value: json(record) }
          }
          if (request.operation === 'asset') return { revision: snapshot.revision, value: json(await engine.asset(String(input.id ?? ''), String(input.assetId ?? ''), request.scope, request.signal)) }
          if (request.operation === 'export') return { revision: snapshot.revision, value: json({ ...snapshot, records: snapshot.records.filter(record => sameWorkspace(record, request.scope)) }) }
          return wrapped.manage!(request)
        }
        if (!request.confirmed || request.expectedRevision === undefined) throw new Error('Refresh and confirm this notification operation')
        if (request.operation === 'stage') { const result = await engine.stage(input, request.scope, request.expectedRevision, request.signal); return { revision: result.revision, value: json(result.record) } }
        if (request.operation === 'send-delivery') {
          const receipts = await engine.send(memoryInputText(input.id, 'id', 100)!, input.plan, request.scope, request.expectedRevision, request.signal)
          return { revision: (await engine.store.read()).revision, value: json(receipts) }
        }
        if (request.operation === 'prune-assets') {
          let removed = 0
          const result = await engine.store.change(request.expectedRevision, async records => {
            const ids = new Set(records.filter(record => record.state !== 'deleted' || Date.parse(record.updatedAt) > Date.now() - 30 * 86400000).flatMap(record => (record.data.assets as Array<{ id: string }>).map(asset => asset.id)))
            removed = await engine.assets.prune(ids, new Date(Date.now() - 30 * 86400000), request.signal)
          }, request.signal)
          return { revision: result.revision, value: { removed } }
        }
        if (['mark-read', 'mark-unread', 'read-all', 'archive', 'restore', 'delete'].includes(request.operation)) {
          const result = await engine.store.change(request.expectedRevision, records => {
            const selected = request.operation === 'read-all' ? records.filter(record => record.state === 'active' && !record.data.read) : records.filter(record => record.id === input.id && record.state !== 'deleted')
            if (request.operation !== 'read-all' && !selected.length) throw new Error('Notification is unavailable')
            for (const record of selected) {
              if (record.data.status === 'sending') throw new Error('Delivery is in progress; retain its receipt')
              reviseRecord(record, request.operation)
              if (['archive', 'restore', 'delete'].includes(request.operation)) record.state = request.operation === 'archive' ? 'archived' : request.operation === 'restore' ? 'active' : 'deleted'
              else record.data.read = request.operation !== 'mark-unread'
            }
          }, request.signal)
          return { revision: result.revision, value: { saved: true } }
        }
        if (['update', 'import', 'approve', 'reject'].includes(request.operation)) throw new Error('Delivery and inbox history are immutable; prepare a new message or archive the record')
        return wrapped.manage!(request)
      },
      async mutate(request) {
        if (!['prepare-delivery', 'send-delivery'].includes(request.offer.sourceActionId)) return wrapped.mutate!(request)
        const input = memoryInputRecord(request.input, 'delivery')
        if (request.offer.sourceActionId === 'prepare-delivery') {
          const result = await engine.stage({ ...input, delivery: true }, request.view.scope, undefined, request.signal)
          return createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, result.revision, { id: result.record.id, state: 'draft', message: 'Prepared only. Read the delivery plan before requesting external send authorization.' }, 'committed')
        }
        if (request.offer.authority !== 'external-message') throw new Error('External message authorization is required')
        const receipts = await engine.send(memoryInputText(input.id, 'id', 100)!, input.plan, request.view.scope, undefined, request.signal)
        return createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, (await engine.store.read()).revision, json(receipts), Object.values(receipts).every(receipt => receipt.status === 'accepted') ? 'committed' : 'partial')
      },
      async dispose() { await wrapped.dispose?.(); entry!.refs--; if (!entry!.refs) { engines.delete(key); await engine.dispose() } },
    }
  } }
}
export function apply(ctx: Context, config: Config = {}) {
  const adapter = new DshWorkspaceAdapter({ sessionQuery: ctx.sessionQuery, agents: ctx.agents, attachments: ctx.attachments })
  installMemory(ctx, { plugin: memoryPlugin, sources: [createNotificationsSource(config, { resolveSessionImage: (id, scope, signal) => adapter.readSessionImage(id, scope, signal), subscribe: listener => ctx.on('mnemon-workspace/activity', listener) })] }, { effectiveDigest: memoryConfigurationDigest(config) })
  if (config.captureTurns) {
    const stop = installAgentHooks(ctx, { async event(agent, event) {
      if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
      ctx.emit('mnemon-workspace/activity', { eventKey: `${agent.id}/turn/${event.seq}`, sourceInstanceKey: name, scope: agentMemoryScope(agent), kind: 'conversation-completed', title: 'Conversation completed', summary: `Session ${agent.id} completed a response.`, level: 'info' })
    } })
    ctx.effect(() => stop)
  }
}
