import type { MemoryJsonValue, MemoryOperationScope } from 'dsh-mnemon/contracts'
import { newRecord, reviseRecord, visibleRecord, type RecordValue } from 'dsh-mnemon/source-sdk'
export function actor(scope: MemoryOperationScope): string {
  if (!scope.sessionId || !scope.workspaceId) throw new Error('Select a project session')
  return scope.sessionId
}
export function roomFor(
  records: RecordValue[],
  id: unknown,
  scope: MemoryOperationScope,
  creator = false,
): RecordValue {
  const room = records.find(
    (record) =>
      record.id === id &&
      record.kind === 'room' &&
      visibleRecord(record, scope) &&
      record.state === 'active' &&
      record.data.status === 'open',
  )
  if (!room) throw new Error('The room is not open in this project')
  if (creator && room.data.creator !== actor(scope))
    throw new Error('Only the room creator can manage membership or close the room')
  return room
}
export const members = (room: RecordValue): string[] => room.data.members as string[]
export function changeMembership(
  operation: string,
  records: RecordValue[],
  input: Record<string, MemoryJsonValue>,
  scope: MemoryOperationScope,
): void {
  const room = roomFor(records, input.id, scope, ['invite-member', 'remove-member', 'close-room'].includes(operation)),
    sessionId = actor(scope)
  if (operation === 'close-room') {
    reviseRecord(room, 'close-room')
    room.data.status = 'closed'
    room.state = 'archived'
    return
  }
  const memberId = ['join-room', 'leave-room'].includes(operation) ? sessionId : String(input.memberId ?? '').trim()
  if (!memberId) throw new Error('A member session id is required')
  if (operation === 'join-room' && room.data.openJoin !== true && !members(room).includes(sessionId))
    throw new Error('This room requires an invitation from its creator')
  if (['leave-room', 'remove-member'].includes(operation) && memberId === room.data.creator)
    throw new Error('The creator must close the room instead of leaving')
  if (!['join-room', 'leave-room', 'invite-member', 'remove-member'].includes(operation))
    throw new Error('Unsupported membership operation')
  const current = members(room)
  reviseRecord(room, operation)
  if (['join-room', 'invite-member'].includes(operation)) {
    if (current.length >= 32 && !current.includes(memberId)) throw new Error('Room member limit reached')
    room.data.members = [...new Set([...current, memberId])]
  } else room.data.members = current.filter((id) => id !== memberId)
}
export function prepareMessage(
  records: RecordValue[],
  input: Record<string, MemoryJsonValue>,
  scope: MemoryOperationScope,
  attachments: string[],
): RecordValue {
  const room = roomFor(records, input.id ?? input.roomId, scope),
    sender = actor(scope)
  if (!members(room).includes(sender)) throw new Error('Join the room before sending messages')
  const requested = Array.isArray(input.recipients)
    ? input.recipients.map(String)
    : String(input.recipients ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
  const recipients = [...new Set(requested.length ? requested : members(room).filter((id) => id !== sender))]
  if (
    !recipients.length ||
    recipients.length > 8 ||
    recipients.some((id) => id === sender || !members(room).includes(id))
  )
    throw new Error('Choose one to eight other current room members')
  const text = String(input.message ?? '').trim()
  if (!text || text.length > 10_000) throw new Error('Messages must contain 1–10000 characters')
  return newRecord('message', room.title, text, 'project', scope, {
    roomId: room.id,
    sender,
    recipients,
    attachments,
    wake: input.wake === true,
    readBy: [sender],
    deliveries: {},
    status: 'queued',
    roomVersion: room.version,
  })
}
export function reserveFile(
  records: RecordValue[],
  filename: string,
  scope: MemoryOperationScope,
  minutes: number,
  targetKey = filename,
  roomId?: string,
): RecordValue {
  const owner = actor(scope),
    now = Date.now()
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('Reservations last 1–120 minutes')
  for (const record of records)
    if (
      record.kind === 'reservation' &&
      visibleRecord(record, scope) &&
      (record.data.targetKey === targetKey || record.data.path === filename) &&
      record.state === 'active'
    ) {
      if (Date.parse(String(record.data.expiresAt)) > now && record.data.owner !== owner)
        throw new Error('File is reserved by another session: ' + String(record.data.owner))
      if (record.data.owner === owner) {
        reviseRecord(record, 'renew-reservation')
        record.data.expiresAt = new Date(now + minutes * 60_000).toISOString()
        return record
      }
      reviseRecord(record, 'expire-reservation')
      record.state = 'archived'
    }
  const record = newRecord('reservation', filename.split('/').at(-1) || filename, '', 'project', scope, {
    path: filename,
    targetKey,
    ...(roomId ? { roomId } : {}),
    owner,
    expiresAt: new Date(now + minutes * 60_000).toISOString(),
  })
  records.push(record)
  return record
}

/** Imported snapshots use the same schema as live collaboration records. */
export function validateCollaborationRecord(record: RecordValue): void {
  const strings = (value: unknown, maximum: number): value is string[] =>
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 4096) &&
    new Set(value).size === value.length
  const data = record.data
  if (record.kind === 'room') {
    if (
      !strings(data.members, 32) ||
      typeof data.creator !== 'string' ||
      !data.members.includes(data.creator) ||
      typeof data.openJoin !== 'boolean' ||
      !['open', 'closed'].includes(String(data.status))
    )
      throw new Error('Invalid room membership')
  } else if (record.kind === 'message') {
    if (data.assets !== undefined) {
      if (!Array.isArray(data.assets) || data.assets.length > 8 || data.assets.some(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return true
        return typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.name !== 'string' || value.name.length > 200
          || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > 5 * 1024 * 1024 || typeof value.mediaType !== 'string'
      })) throw new Error('Invalid message attachment')
    }
    if (
      typeof data.sender !== 'string' ||
      !data.sender ||
      !strings(data.recipients, 8) ||
      !data.recipients.length ||
      data.recipients.includes(data.sender) ||
      typeof data.roomId !== 'string' ||
      !data.roomId ||
      !strings(data.readBy, 9) ||
      data.readBy.some((id) => id !== data.sender && !(data.recipients as string[]).includes(id)) ||
      !strings(data.attachments, 8) ||
      record.content.length > 10000 ||
      !['queued', 'delivering', 'delivered', 'partial'].includes(String(data.status))
    )
      throw new Error('Invalid directed message')
  } else if (record.kind === 'reservation') {
    if (
      typeof data.owner !== 'string' ||
      !data.owner ||
      typeof data.path !== 'string' ||
      !data.path.startsWith('/') ||
      typeof data.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(data.expiresAt))
    )
      throw new Error('Invalid file reservation')
  } else if (record.kind === 'resource') {
    if (!['file', 'service', 'note'].includes(String(data.resourceType)) || typeof data.roomId !== 'string' || typeof data.owner !== 'string'
      || typeof data.resourceKey !== 'string' || !data.resourceKey || data.resourceKey.length > 4096 || typeof data.resource !== 'string' || record.content.length > 10000)
      throw new Error('Invalid resource declaration')
  } else if (record.kind === 'presence') {
    if (typeof data.roomId !== 'string' || typeof data.owner !== 'string' || !['idle', 'running', 'closed'].includes(String(data.status))) throw new Error('Invalid member presence')
  }
}
