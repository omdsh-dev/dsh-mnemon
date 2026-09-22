import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { MemoryJsonValue, MemoryOperationScope } from 'dsh-mnemon/contracts'
import { newRecord, reviseRecord, visibleRecord, withinRoot, type RecordValue } from 'dsh-mnemon/source-sdk'
import { actor, members, roomFor } from './rooms.ts'

export interface ProjectFile { path: string; key: string }
/** Metadata only; the nearest existing ancestor also fences future files and symlinks. */
export async function localProjectFile(filename: string, scope: MemoryOperationScope): Promise<ProjectFile> {
  if (!scope.workspaceId || !filename.trim() || filename.includes('\0')) throw new Error('Select a project file')
  const root = await realpath(scope.workspaceId), suffix: string[] = []
  let candidate = resolve(root, filename)
  while (true) {
    try { candidate = await realpath(candidate); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(candidate) === candidate) throw error
      suffix.unshift(basename(candidate)); candidate = dirname(candidate)
    }
  }
  if (suffix.length && !(await stat(candidate)).isDirectory()) throw new Error('File parent is not a directory')
  const target = join(candidate, ...suffix)
  if (!withinRoot(root, target) || target === root) throw new Error('File is outside this project')
  return { path: target, key: target }
}
export function addressed(record: RecordValue, scope: MemoryOperationScope): boolean {
  return visibleRecord(record, scope) && (record.kind !== 'message' || record.data.sender === scope.sessionId || (record.data.recipients as string[]).includes(scope.sessionId ?? ''))
}
export function writeConflicts(records: RecordValue[], file: ProjectFile, scope: MemoryOperationScope, now = Date.now()): RecordValue[] {
  return records.filter(record => visibleRecord(record, scope) && record.state === 'active' && record.data.owner !== actor(scope)
    && (record.data.targetKey === file.key || record.data.path === file.path)
    && (record.kind === 'reservation' && Date.parse(String(record.data.expiresAt)) > now
      || record.kind === 'resource' && record.data.resourceType === 'file'))
}
export function declareResource(records: RecordValue[], input: Record<string, MemoryJsonValue>, scope: MemoryOperationScope, file?: ProjectFile, automatic = false): RecordValue {
  const room = roomFor(records, input.id, scope), owner = actor(scope)
  if (!members(room).includes(owner)) throw new Error('Join the room before declaring resources')
  const type = String(input.resourceType ?? 'file'), label = String(input.label ?? '').trim()
  if (!['file', 'service', 'note'].includes(type)) throw new Error('Choose a file, service or note')
  let key = file?.key ?? String(input.resource ?? '').trim(), resource = file?.path ?? key
  if (type === 'file' && !file) throw new Error('Resolve the project file first')
  if (type === 'service') {
    const url = new URL(key)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP service address without credentials')
    key = resource = url.href
  }
  if (type === 'note') key = label
  const content = String(input.notes ?? '').trim()
  if (!key || key.length > 4096 || label.length > 300 || content.length > 10000) throw new Error('Invalid resource name or notes')
  const data = { roomId: room.id, owner, resourceType: type, resource, resourceKey: key, ...(file ? { path: file.path, targetKey: file.key } : {}), automatic }
  const current = records.find(record => record.kind === 'resource' && record.state === 'active' && visibleRecord(record, scope) && record.data.roomId === room.id && record.data.owner === owner && record.data.resourceKey === key)
  if (current) {
    reviseRecord(current, automatic ? 'file-written' : 'update-resource')
    if (!automatic) { current.title = label || basename(resource) || resource; current.content = content; current.data = data }
    current.data.lastActivityAt = new Date().toISOString()
    return current
  }
  const record = newRecord('resource', label || basename(resource) || resource, content, 'project', scope, { ...data, lastActivityAt: new Date().toISOString() })
  records.push(record); return record
}
export function releaseOwnedResources(records: RecordValue[], scope: MemoryOperationScope, roomId?: string): void {
  for (const record of records) if (visibleRecord(record, scope) && record.state === 'active' && record.data.owner === scope.sessionId
    && (!roomId || record.data.roomId === roomId) && (record.kind === 'reservation' || record.kind === 'resource' && record.data.resourceType === 'file')) {
    reviseRecord(record, 'owner-released'); record.state = 'archived'
  }
}
