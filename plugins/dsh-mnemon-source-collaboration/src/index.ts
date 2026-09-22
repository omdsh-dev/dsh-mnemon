import type { Context } from '@deepseek-ai/cordis'
import type { SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { join } from 'node:path'
import z from 'schemastery'
import type { MemoryJsonValue, MemorySourceDefinition, MemoryOperationScope } from 'dsh-mnemon/contracts'
import {
  createMemoryMutationReceipt,
  defineMemoryPlugin,
  installMemory,
  memoryConfigurationDigest,
  memoryInputRecord,
} from 'dsh-mnemon/extension-sdk'
import { AssetStore, createRecordSource, digest, json, RecordStore, reviseRecord, sourceRecordDirectory, visibleRecord, type RecordValue, type AssetInput, type AssetReference } from 'dsh-mnemon/source-sdk'
import { DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'
import { Coordination, type CoordinationConfig, type CoordinationPort } from './lifecycle.ts'
import { addressed, declareResource, localProjectFile, releaseOwnedResources, type ProjectFile } from './resources.ts'
import { projectFile, subscribeCoordination } from './dsh.ts'
import {
  actor,
  changeMembership,
  members,
  prepareMessage,
  reserveFile,
  roomFor,
  validateCollaborationRecord,
} from './rooms.ts'
export const name = 'dsh-mnemon-source-collaboration'
export const inject = ['mnemonMemory', 'agentPresets', 'sessionQuery', 'agents', 'workspaceRegistry', 'fs', 'attachments']
export interface Config extends CoordinationConfig {
  dataDir?: string
  attachmentRoots?: string[]
  attachmentUrlOrigins?: string[]
}
export const Config = z.object({ dataDir: z.string(), attachmentRoots: z.array(z.string()).default([]), attachmentUrlOrigins: z.array(z.string()).default([]),
  writeConflictPolicy: z.union(['off', 'warn', 'deny']).default('warn'), captureWrites: z.boolean().default(true), notifyPresence: z.boolean().default(true),
}) as z<Config>
export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Collaboration', 'zh-CN': '会话协作' },
  description: {
    en: 'Project rooms, directed messages and shared file reservations.',
    'zh-CN': '项目协作空间、定向消息与共享文件预约。',
  },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.collaboration' }],
})
export interface CollaborationPort extends CoordinationPort {
  validate(id: string, scope: MemoryOperationScope, signal?: AbortSignal): Promise<void>
  deliver(id: string, text: string, scope: MemoryOperationScope, wake: boolean, signal?: AbortSignal, images?: readonly SaveImageAttachment[]): Promise<void>
  list(scope: MemoryOperationScope, signal?: AbortSignal): Promise<Array<{ id: string; status: string; live: boolean }>>
  resolveFile?(filename: string, scope: MemoryOperationScope, signal?: AbortSignal): Promise<ProjectFile>
  resolveSessionImage?(id: string | undefined, scope: MemoryOperationScope, signal?: AbortSignal): Promise<{ data: Uint8Array; name: string }>
}
const idSchema: MemoryJsonValue = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
  additionalProperties: false,
}
const reservationSchema: MemoryJsonValue = {
  type: 'object',
  required: ['id', 'filename'],
  properties: {
    id: { type: 'string' },
    filename: { type: 'string' },
    minutes: { type: 'integer', minimum: 1, maximum: 120 },
  },
  additionalProperties: false,
}
const messageSchema: MemoryJsonValue = {
  type: 'object',
  required: ['id', 'recipients', 'message'],
  properties: {
    id: { type: 'string' },
    recipients: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    message: { type: 'string', maxLength: 10000 },
    attachments: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' }, base64: { type: 'string' }, name: { type: 'string' }, sessionAttachmentId: { type: 'string' }, latestSessionImage: { type: 'boolean' } }, additionalProperties: false }] }, maxItems: 8 },
    wake: { type: 'boolean' },
  },
  additionalProperties: false,
}
async function changeReservation(
  operation: string,
  records: RecordValue[],
  input: Record<string, MemoryJsonValue>,
  scope: MemoryOperationScope,
  port: CollaborationPort,
) {
  if (operation === 'reserve-file') {
    const room = roomFor(records, input.id, scope)
    if (!members(room).includes(actor(scope))) throw new Error('Join the room before reserving files')
    const target = await (port.resolveFile ?? localProjectFile)(String(input.filename ?? ''), scope)
    reserveFile(records, target.path, scope, Number(input.minutes ?? 30), target.key, room.id)
    return
  }
  const record = records.find(
    (record) =>
      record.id === input.id &&
      record.kind === 'reservation' &&
      record.state === 'active' &&
      visibleRecord(record, scope),
  )
  if (!record || record.data.owner !== actor(scope)) throw new Error('Only the reservation owner can release it')
  reviseRecord(record, 'release')
  record.state = 'archived'
}
export function createCollaborationSource(config: Config, port: CollaborationPort): MemorySourceDefinition {
  const base = createRecordSource(
    { context: {"mode":"routed","weight":1} satisfies import('dsh-mnemon/contracts').MemoryContextProfile,
      typeId: 'collaboration',
      role: 'collaboration',
      label: 'Collaboration',
      description: 'Rooms, addressed messages and reservations within a project.',
      kinds: ['room', 'message', 'reservation', 'resource', 'presence'],
      scopes: ['project'],
      defaultScope: 'project',
      prepare(record, scope) {
        if (record.kind !== 'room') throw new Error('Use the messaging or reservation controls')
        record.data = {
          creator: actor(scope),
          members: [actor(scope)],
          openJoin: record.data.openJoin ?? false,
          status: 'open',
        }
      },
      validate: validateCollaborationRecord,
      visible(record, scope) {
        return (
          record.kind !== 'message' ||
          record.data.sender === scope.sessionId ||
          (record.data.recipients as string[]).includes(scope.sessionId ?? '')
        )
      },
      project(records, scope) {
        return (
          records
            .filter((record) => record.kind === 'room')
            .map(
              (record) =>
                `${record.id}: ${record.title}; ${String(record.data.status)}; ${members(record).includes(scope.sessionId ?? '') ? 'member' : 'not joined'}`,
            )
            .join('\n') +
          '\nShared resources: ' + records.filter(record => record.kind === 'resource').map(record => record.title + ' (' + record.data.resourceType + ') ' + record.data.resource + ' — ' + record.data.owner).join('; ') +
          '\nUnread messages: ' +
          records.filter(
            (record) => record.kind === 'message' && !(record.data.readBy as string[]).includes(scope.sessionId ?? ''),
          ).length
        )
      },
      modelActions: [
        { operation: {"effects":["coordinate"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics,
          id: 'reserve-file',
          description: 'Reserve an existing or future project file for this session, or renew its lease.',
          capability: 'write',
          inputSchema: reservationSchema,
        },
        { operation: {"effects":["coordinate"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics,
          id: 'release-file',
          description: 'Release a file reservation owned by this session.',
          capability: 'write',
          inputSchema: idSchema,
        },
        { operation: {"effects":["coordinate"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'leave-room', description: 'Leave a collaboration room.', capability: 'write', inputSchema: idSchema },
        { operation: {"effects":["coordinate"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'declare-resource', description: 'Declare a shared project file, service URL or named note; update your own declaration.', capability: 'write', inputSchema: { type: 'object', required: ['id', 'resourceType', 'resource'], properties: { id: { type: 'string' }, resourceType: { type: 'string', enum: ['file', 'service', 'note'] }, resource: { type: 'string' }, label: { type: 'string' }, notes: { type: 'string' } }, additionalProperties: false } },
        { operation: {"effects":["remove"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'remove-resource', description: 'Archive your resource declaration.', capability: 'write', inputSchema: idSchema },
        { operation: {"effects":["coordinate"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics,
          id: 'join-room',
          description: 'Join a room that permits open membership.',
          capability: 'write',
          inputSchema: idSchema,
        },
        { operation: {"effects":["update"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics,
          id: 'mark-read',
          description: 'Mark an addressed message as read.',
          capability: 'write',
          inputSchema: idSchema,
        },
      ],
      async mutate(operation, input, { records, scope }) {
        if (operation === 'reserve-file' || operation === 'release-file') {
          await changeReservation(operation, records, input, scope, port)
          return
        }
        if (operation === 'declare-resource') {
          const file = input.resourceType === 'file' ? await (port.resolveFile ?? localProjectFile)(String(input.resource ?? ''), scope) : undefined
          declareResource(records, input, scope, file); return
        }
        if (operation === 'remove-resource') {
          const record = records.find(record => record.id === input.id && record.kind === 'resource' && record.state === 'active' && visibleRecord(record, scope))
          if (!record || record.data.owner !== actor(scope)) throw new Error('Only the resource owner can remove it')
          reviseRecord(record, operation); record.state = 'archived'; return
        }
        if (operation === 'mark-read') {
          const record = records.find(
            (record) => record.id === input.id && record.kind === 'message' && visibleRecord(record, scope),
          )
          if (!record || !(record.data.recipients as string[]).includes(actor(scope)))
            throw new Error('Message is not addressed to this session')
          reviseRecord(record, 'mark-read')
          record.data.readBy = [...new Set([...(record.data.readBy as string[]), actor(scope)])]
          return
        }
        changeMembership(operation, records, input, scope)
        if (operation === 'leave-room') releaseOwnedResources(records, scope, String(input.id))
      },
    },
    config,
  )
  const manifest = {
    ...base.manifest,
    actions: [
      ...(base.manifest.actions ?? []),
      { operation: {"effects":["deliver"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics,
        id: 'send-message',
        description:
          'Send the displayed message and attachment references to selected room members. Wake only when explicitly requested.',
        capability: 'write' as const,
        authority: 'session-message',
        inputSchema: messageSchema,
      },
    ],
  }
  return {
    ...base,
    manifest,
    create(context) {
      const runtime = base.create(context), directory = sourceRecordDirectory('collaboration', context, config),
        store = new RecordStore(directory), assets = new AssetStore(join(directory, 'assets')),
        coordination = new Coordination(store, config, port, context.sourceInstanceKey)
      async function send(
        input: Record<string, MemoryJsonValue>,
        scope: MemoryOperationScope,
        revision?: string,
        signal?: AbortSignal,
      ) {
        const attachmentInput: Array<AssetInput | string> = Array.isArray(input.attachments)
          ? input.attachments as unknown as Array<AssetInput | string>
          : String(input.attachments ?? '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
        if (attachmentInput.length > 8) throw new Error('At most eight attachments')
        if (input.attachmentUrl) attachmentInput.push({ url: String(input.attachmentUrl) })
        if (input.latestSessionImage === true) attachmentInput.push({ latestSessionImage: true })
        if (attachmentInput.length > 8) throw new Error('At most eight attachments')
        const before = await store.read(signal)
        if (revision !== undefined && revision !== before.revision) throw new Error('Collection changed; refresh before sending')
        prepareMessage(before.records, input, scope, [])
        const references: AssetReference[] = []
        for (const value of attachmentInput) {
          const attachment = typeof value === 'string' ? { path: value } : value
          if (!attachment || Object.keys(attachment).some(key => !['path', 'url', 'base64', 'name', 'sessionAttachmentId', 'latestSessionImage'].includes(key))) throw new Error('Invalid attachment input')
          references.push(await assets.ingest(attachment, { roots: config.attachmentRoots ?? [], workspace: scope.workspaceId!, urlOrigins: config.attachmentUrlOrigins ?? [],
            ...(port.resolveSessionImage ? { resolveSessionImage: (id, signal) => port.resolveSessionImage!(id, scope, signal) } : {}) }, signal))
          if (references.reduce((total, value) => total + value.bytes, 0) > 20 * 1024 * 1024) throw new Error('Attachments exceed 20 MiB')
        }
        const attachments = [...new Set(references.map(reference => reference.name))]
        const images: SaveImageAttachment[] = []
        for (const reference of references) if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(reference.mediaType))
          images.push({ data: await assets.read(reference, signal), mediaType: reference.mediaType as SaveImageAttachment['mediaType'], name: reference.name })
        let message: RecordValue | undefined
        await store.change(
          revision,
          async (records) => {
            message = prepareMessage(records, input, scope, attachments)
            message.data.assets = json(references)
            for (const id of message.data.recipients as string[]) await port.validate(id, scope, signal)
            records.push(message)
          },
          signal,
        )
        const deliveries: Record<string, string> = {}
        for (const id of message!.data.recipients as string[]) {
          try {
            signal?.throwIfAborted()
            const current = (await store.read(signal)).records
            const room = roomFor(current, message!.data.roomId, scope)
            if (!members(room).includes(id) || !members(room).includes(actor(scope)))
              throw new Error('Room membership changed before delivery')
            await port.deliver(
              id,
              `Collaboration · ${message!.title}\nFrom session ${actor(scope)}\nMessage ${message!.id}\n\n${message!.content}${attachments.length ? '\n\nRegistered attachments (open Collaboration to preview):\n' + references.map(value => value.name + ' · ' + value.id).join('\n') : ''}`,
              scope,
              input.wake === true,
              signal,
              images,
            )
            deliveries[id] = 'delivered'
          } catch (error) {
            deliveries[id] = 'failed: ' + String(error).slice(0, 1000)
          }
          await store.change(undefined, (records) => {
            const record = records.find((record) => record.id === message!.id)!
            reviseRecord(record, 'delivery')
            record.data.deliveries = json(deliveries)
            record.data.status =
              Object.keys(deliveries).length < (message!.data.recipients as string[]).length
                ? 'delivering'
                : Object.values(deliveries).every((value) => value === 'delivered')
                  ? 'delivered'
                  : 'partial'
          })
        }
        return {
          messageId: message!.id,
          deliveries,
          completion: Object.values(deliveries).every((value) => value === 'delivered')
            ? ('committed' as const)
            : ('partial' as const),
        }
      }
      return {
        ...runtime,
        async facts(request, signal) {
          const value = await runtime.facts(request, signal)
          return { ...value, actionIds: [...value.actionIds, 'send-message'] }
        },
        async manage(request) {
          const input = memoryInputRecord(request.input ?? {}, 'collaboration operation')
          if (request.mode === 'read' && request.operation === 'coordination-status') return { revision: (await store.read()).revision, value: { writeConflictPolicy: config.writeConflictPolicy ?? 'warn', captureWrites: config.captureWrites !== false, error: coordination.lastError } }
          if (request.mode === 'read' && request.operation === 'resources') {
            const snapshot = await store.read(request.signal), query = String(input.query ?? '').toLocaleLowerCase(), offset = Math.max(0, Math.min(10000, Math.floor(Number(input.offset) || 0)))
            const scoped = snapshot.records.filter(record => visibleRecord(record, request.scope) && record.state === 'active')
            const rows = scoped.filter(record => record.kind === 'resource' && (!input.resourceType || record.data.resourceType === input.resourceType)
              && (!query || (record.title + '\n' + record.content + '\n' + record.data.resource + '\n' + record.data.owner).toLocaleLowerCase().includes(query)))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
            const presence = [...new Map(scoped.filter(record => record.kind === 'presence').map(record => [record.data.owner, { owner: record.data.owner, status: record.data.status, at: record.updatedAt }])).values()]
            return { revision: snapshot.revision, value: json({ items: rows.slice(offset, offset + 25), total: rows.length, presence, writeConflictPolicy: config.writeConflictPolicy ?? 'warn', captureWrites: config.captureWrites !== false, error: coordination.lastError }) }
          }
          if (request.mode === 'read' && request.operation === 'asset') {
            const snapshot = await store.read(request.signal), record = snapshot.records.find(record => record.id === input.id && record.kind === 'message' && record.state !== 'deleted' && addressed(record, request.scope))
            const reference = (record?.data.assets as unknown as AssetReference[] | undefined)?.find(value => value.id === input.assetId)
            if (!reference) throw new Error('Attachment is not addressed to this session')
            return { revision: snapshot.revision, value: { reference: json(reference), base64: (await assets.read(reference, request.signal)).toString('base64') } }
          }
          if (request.mode === 'read' && request.operation === 'room-history') {
            const snapshot = await store.read(request.signal),
              room = snapshot.records.find(
                (record) => record.id === input.id && record.kind === 'room' && visibleRecord(record, request.scope),
              )
            if (!room || !members(room).includes(actor(request.scope)))
              throw new Error('Join this room to read addressed history')
            const query = String(input.query ?? '').toLocaleLowerCase(), offset = Math.max(0, Math.min(10000, Math.floor(Number(input.offset) || 0)))
            const rows = snapshot.records
              .filter(
                (record) =>
                  record.kind === 'message' &&
                  record.state === (input.archived === true ? 'archived' : 'active') &&
                  record.data.roomId === room.id &&
                  (record.data.sender === actor(request.scope) ||
                    (record.data.recipients as string[]).includes(actor(request.scope))),
              )
              .filter(record => (!query || (record.content + '\n' + record.data.sender).toLocaleLowerCase().includes(query)) && (input.unread !== true || !(record.data.readBy as string[]).includes(actor(request.scope))))
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
            return {
              revision: snapshot.revision,
              value: {
                total: rows.length,
                items: rows.slice(offset, offset + 25).map((record) => ({
                  id: record.id,
                  record: json(record),
                  text: `${String(record.data.sender)} → ${(record.data.recipients as string[]).join(', ')}\n${record.createdAt} · ${String(record.data.status)}\n${record.content}\n${(record.data.attachments as string[]).join('\n')}`,
                  unread: !(record.data.readBy as string[]).includes(actor(request.scope)),
                })),
              },
            }
          }
          if (request.mode === 'read' && request.operation === 'presence')
            return {
              revision: (await store.read()).revision,
              value: json(await port.list(request.scope, request.signal)),
            }
          if (request.mode === 'mutate') {
            if (!request.confirmed || request.expectedRevision === undefined)
              throw new Error('Confirm the current collaboration operation')
            if (request.operation === 'send-message') {
              const result = await send(input, request.scope, request.expectedRevision, request.signal)
              return { revision: (await store.read()).revision, value: json(result) }
            }
            if (['archive-message', 'restore-message', 'delete-message'].includes(request.operation)) {
              const result = await store.change(request.expectedRevision, records => {
                const record = records.find(record => record.id === input.id && record.kind === 'message' && addressed(record, request.scope))
                if (!record || record.data.sender !== actor(request.scope)) throw new Error('Only the sender can archive or remove a sent message')
                if (record.data.status === 'queued' || record.data.status === 'delivering') throw new Error('Message delivery is still in progress')
                reviseRecord(record, request.operation); record.state = request.operation === 'archive-message' ? 'archived' : request.operation === 'restore-message' ? 'active' : 'deleted'
              }, request.signal)
              return { revision: result.revision, value: { saved: true } }
            }
            if (request.operation === 'prune-assets') {
              let removed = 0
              const result = await store.change(request.expectedRevision, async records => {
                const cutoff = new Date(Date.now() - 30 * 86400000)
                const referenced = new Set(records.filter(record => record.state !== 'deleted' || Date.parse(record.updatedAt) >= cutoff.getTime()).flatMap(record => (record.data.assets as unknown as AssetReference[] | undefined ?? []).map(asset => asset.id)))
                removed = await assets.prune(referenced, cutoff, request.signal)
              }, request.signal)
              return { revision: result.revision, value: { removed } }
            }
            if (
              [
                'invite-member',
                'remove-member',
                'join-room',
                'leave-room',
                'close-room',
                'reserve-file',
                'release-file',
              ].includes(request.operation)
            ) {
              await store.change(
                request.expectedRevision,
                async (records) => {
                  if (request.operation === 'invite-member')
                    await port.validate(String(input.memberId ?? ''), request.scope, request.signal)
                  if (request.operation === 'reserve-file' || request.operation === 'release-file') {
                    await changeReservation(request.operation, records, input, request.scope, port)
                    return
                  }
                  changeMembership(request.operation, records, input, request.scope)
                  if (request.operation === 'leave-room') releaseOwnedResources(records, request.scope, String(input.id))
                  if (request.operation === 'remove-member') releaseOwnedResources(records, { ...request.scope, sessionId: String(input.memberId) }, String(input.id))
                  if (request.operation === 'close-room') for (const member of members(records.find(record => record.id === input.id)!)) releaseOwnedResources(records, { ...request.scope, sessionId: member }, String(input.id))
                },
                request.signal,
              )
              return runtime.manage!({ ...request, mode: 'read', operation: 'snapshot', input: {} })
            }
            if (request.operation === 'restore') {
              await store.change(
                request.expectedRevision,
                (records) => {
                  const room = records.find(
                    (record) =>
                      record.id === input.id && record.kind === 'room' && visibleRecord(record, request.scope),
                  )
                  if (
                    !room ||
                    room.data.creator !== actor(request.scope) ||
                    !['archived', 'deleted', 'rejected'].includes(room.state)
                  )
                    throw new Error('Only the creator can reopen an archived room')
                  if (input.version !== undefined && input.version !== room.version)
                    throw new Error('Room version changed')
                  reviseRecord(room, 'reopen-room')
                  room.state = 'active'
                  room.data.status = 'open'
                },
                request.signal,
              )
              return runtime.manage!({ ...request, mode: 'read', operation: 'snapshot', input: {} })
            }
            if (['update', 'approve', 'reject', 'archive', 'delete', 'restore'].includes(request.operation)) {
              const record = (await store.read(request.signal)).records.find(
                (record) => record.id === input.id && visibleRecord(record, request.scope),
              )
              if (record?.kind !== 'room') throw new Error('Messages and reservations use their dedicated controls')
              if (record.data.creator !== actor(request.scope)) throw new Error('Only the room creator can change it')
              if (input.data !== undefined) {
                const data = memoryInputRecord(input.data, 'room settings')
                for (const [key, value] of Object.entries(data))
                  if (key !== 'openJoin' && digest(value) !== digest(record.data[key]))
                    throw new Error('Use membership controls to change room members')
                input.data = { ...record.data, ...data }
              }
            }
          }
          const result = await runtime.manage!({ ...request, input })
          if (request.mode === 'read' && ['snapshot', 'export'].includes(request.operation) && result.value && typeof result.value === 'object' && !Array.isArray(result.value) && Array.isArray(result.value.records))
            return { ...result, value: { ...result.value, records: result.value.records.filter(record => addressed(record as unknown as RecordValue, request.scope)) } }
          return result
        },
        async mutate(request) {
          if (request.offer.sourceActionId !== 'send-message') return runtime.mutate!(request)
          if (request.offer.authority !== 'session-message')
            throw new Error('Session delivery requires explicit authority')
          const result = await send(
            memoryInputRecord(request.input, 'message'),
            request.view.scope,
            undefined,
            request.signal,
          )
          return createMemoryMutationReceipt(
            request.view.id,
            request.offer.id,
            context.sourceInstanceKey,
            (await store.read()).revision,
            json(result),
            result.completion,
          )
        },
        async dispose() { await coordination.dispose(); await runtime.dispose?.() },
      }
    },
  }
}
export function apply(ctx: Context, config: Config = {}) {
  const adapter = new DshWorkspaceAdapter({ agentPresets: ctx.agentPresets,
    sessionQuery: ctx.sessionQuery,
    agents: ctx.agents,
    workspaceRegistry: ctx.workspaceRegistry,
    attachments: ctx.attachments,
  })
  installMemory(
    ctx,
    {
      plugin: memoryPlugin,
      sources: [
        createCollaborationSource(config, {
          async validate(id, scope, signal) {
            const observation = await adapter.observe(id, scope, signal)
            observation[Symbol.dispose]()
          },
          async deliver(id, text, scope, wake, signal, images) {
            await adapter.deliver(id, text, scope, { plugin: name, wake, ...(signal ? { signal } : {}), ...(images ? { images } : {}) })
          },
          list: (scope, signal) => adapter.list(scope, signal),
          resolveFile: (filename, scope, signal) => projectFile(ctx, filename, scope, signal),
          resolveSessionImage: (id, scope, signal) => adapter.readSessionImage(id, scope, signal),
          subscribe: hooks => subscribeCoordination(ctx, hooks),
          warning: async (scope, text, signal) => { await adapter.deliver(scope.sessionId!, text, scope, { plugin: name, wake: false, ...(signal ? { signal } : {}) }) },
          activity: event => ctx.emit('mnemon-workspace/activity', event),
        }),
      ],
    },
    { effectiveDigest: memoryConfigurationDigest(config) },
  )
}
