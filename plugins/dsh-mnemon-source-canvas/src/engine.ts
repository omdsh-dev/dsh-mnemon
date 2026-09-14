import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { MemoryJsonValue, MemoryOperationScope } from 'dsh-mnemon/contracts'
import { memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { allowedDirectories, allowedFile, AssetStore, detectAssetType, digest, json, readBoundedFile, RecordStore, recordScope, reviseRecord, runBoundedProcess, validateRecord, visibleRecord, type AssetInput, type AssetReference, type RecordScope, type RecordValue } from 'dsh-mnemon/source-sdk'
export interface CanvasConfig { dataDir?: string; roots?: string[]; maxFileBytes?: number; openLocalFiles?: boolean }
export type CanvasView = 'session' | 'project' | 'all'
export interface Geometry { x: number; y: number; width: number; height: number }
export interface MaterialContent { name: string; mediaType: string; bytes: number; base64: string; sha256: string; path?: string }
export function geometry(value: Record<string, MemoryJsonValue>): Geometry {
  const output = { x: value.x ?? 0, y: value.y ?? 0, width: value.width ?? 320, height: value.height ?? 260 }
  for (const [key, number] of Object.entries(output)) {
    const size = key === 'width' || key === 'height'
    if (typeof number !== 'number' || !Number.isFinite(number) || number < (size ? 180 : -1000000) || number > (size ? 2400 : 1000000)) throw new Error('Invalid card position or size')
  }
  return output as Geometry
}
export function validateNode(record: RecordValue): void {
  validateRecord(record)
  if (!['note', 'file', 'asset'].includes(record.kind) || !['global', 'project', 'session'].includes(record.scope)) throw new Error('Unsupported material kind or scope')
  geometry(record.data)
  if (!['human', 'model'].includes(String(record.data.createdBy))) throw new Error('Missing material provenance')
  if (record.data.originWorkspace !== null && (typeof record.data.originWorkspace !== 'string' || !isAbsolute(record.data.originWorkspace))) throw new Error('Invalid origin workspace')
  if (record.kind === 'file' && (typeof record.data.path !== 'string' || !isAbsolute(record.data.path))) throw new Error('Invalid file reference')
  if (record.kind === 'asset') {
    const asset = memoryInputRecord(record.data.asset!, 'asset')
    if (typeof asset.id !== 'string' || !/^[a-f0-9]{64}$/.test(asset.id) || typeof asset.name !== 'string' || typeof asset.mediaType !== 'string' || typeof asset.bytes !== 'number') throw new Error('Invalid registered asset')
  }
}
export function materialIdentity(record: RecordValue): string { return digest([record.kind, record.data.path ?? null, record.data.asset ?? null, record.data.originWorkspace]) }
export function boardVisible(record: RecordValue, scope: MemoryOperationScope, view: unknown = 'session'): boolean {
  if (!['session', 'project', 'all'].includes(String(view))) throw new Error('Unsupported board view')
  return view === 'all' || visibleRecord(record, scope) || view === 'project' && !!scope.workspaceId && record.workspaceId === resolve(scope.workspaceId)
}
const privatePath = (value: string) => value.split(/[\\/]/).some(part => ['.config', '.codex', '.mnemon', '.dsh'].includes(part))
export class CanvasEngine {
  readonly store: RecordStore
  readonly assets: AssetStore
  readonly maxBytes: number
  constructor(directory: string, readonly config: CanvasConfig = {}) {
    this.store = new RecordStore(directory); this.assets = new AssetStore(join(directory, 'assets'))
    this.maxBytes = config.maxFileBytes ?? 5 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 32 * 1024 * 1024) throw new Error('Invalid file size limit')
  }
  async authorizedPath(value: string, workspace?: string): Promise<string> {
    if (privatePath(value)) throw new Error('Private configuration directories cannot be previewed')
    const target = await allowedFile(await allowedDirectories(this.config.roots ?? [], workspace), value)
    if (privatePath(target)) throw new Error('Private configuration directories cannot be previewed')
    return target
  }
  async read(record: RecordValue, signal?: AbortSignal): Promise<MaterialContent> {
    validateNode(record)
    let data: Buffer, name = record.title, path: string | undefined
    if (record.kind === 'note') data = Buffer.from(record.content)
    else if (record.kind === 'asset') {
      const asset = record.data.asset as unknown as AssetReference
      data = await this.assets.read(asset, signal); name = asset.name
    } else {
      const workspace = typeof record.data.originWorkspace === 'string' ? record.data.originWorkspace : undefined
      path = await this.authorizedPath(String(record.data.path), workspace)
      data = await readBoundedFile(await allowedDirectories(this.config.roots ?? [], workspace), path, this.maxBytes, signal); name = basename(path)
    }
    return { name, mediaType: detectAssetType(data), bytes: data.length, base64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'), ...(path ? { path } : {}) }
  }
  async change(operation: string, input: Record<string, MemoryJsonValue>, scope: MemoryOperationScope, revision?: string, signal?: AbortSignal, model = false) {
    if (model && operation !== 'add-note') throw new Error('Models can only add notes to the board')
    let newId: string | undefined
    const snapshot = await this.store.change(revision, async records => {
      if (['add-note', 'register-file', 'upload'].includes(operation)) {
        if (records.filter(record => record.state !== 'deleted').length >= 500) throw new Error('This board already has 500 retained cards; remove unused cards first')
        const placement = geometry(input), selectedScope = (input.scope ?? (scope.workspaceId ? 'project' : 'global')) as RecordScope
        if (!['global', 'project', 'session'].includes(selectedScope)) throw new Error('Unsupported material scope')
        const now = new Date().toISOString(), kind = operation === 'add-note' ? 'note' : operation === 'upload' ? 'asset' : 'file'
        const record: RecordValue = { id: randomUUID(), kind, title: memoryInputText(input.title, 'title', 300, false) ?? (kind === 'note' ? 'Untitled note' : basename(String(input.path ?? input.name ?? 'Attachment'))), content: memoryInputText(input.content, 'content', 100000, false) ?? '', ...recordScope(selectedScope, scope), state: 'active', data: { ...placement, createdBy: model ? 'model' : 'human', originWorkspace: scope.workspaceId ? resolve(scope.workspaceId) : null }, signals: 1, createdAt: now, updatedAt: now, version: 1, history: [] }
        if (kind === 'file') record.data.path = await this.authorizedPath(memoryInputText(input.path, 'path', 4000)!, scope.workspaceId)
        if (kind === 'asset') record.data.asset = json(await this.assets.ingest({ base64: memoryInputText(input.base64, 'base64', 45000000)!, name: memoryInputText(input.name, 'name', 200)! } as AssetInput, { maxBytes: this.maxBytes }, signal))
        validateNode(record); records.push(record); newId = record.id; return
      }
      if (operation === 'prune-assets') return
      const id = memoryInputText(input.id, 'id', 100)!, record = records.find(record => record.id === id && boardVisible(record, scope, input.view))
      if (!record || record.state === 'deleted') throw new Error('Material is not available in this view')
      if (input.version !== undefined && input.version !== record.version) throw new Error('Card changed; refresh before editing')
      if (operation === 'open-file') {
        if (!this.config.openLocalFiles || record.kind !== 'file') throw new Error('Opening files on the service host is disabled')
        const path = await this.authorizedPath(String(record.data.path), typeof record.data.originWorkspace === 'string' ? record.data.originWorkspace : undefined)
        if (!/\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|png|jpe?g|gif|webp|mp3|mp4|wav|ogg|webm)$/i.test(path)) throw new Error('This file type must be downloaded for manual inspection')
        const result = await runBoundedProcess(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [path], { ...(signal ? { signal } : {}), timeoutMs: 10000, maxBytes: 1000 })
        if (result.code !== 0) throw new Error('The service host could not open this file')
        return
      }
      if (!['edit', 'move', 'archive', 'restore', 'delete'].includes(operation)) throw new Error('Unsupported canvas operation')
      if (operation === 'restore' && record.state !== 'archived') throw new Error('Only archived cards can be restored')
      reviseRecord(record, operation)
      if (operation === 'edit') { record.title = memoryInputText(input.title, 'title', 300)!; if (record.kind === 'note') record.content = memoryInputText(input.content, 'content', 100000, false) ?? '' }
      if (operation === 'move') Object.assign(record.data, geometry({ ...record.data, ...input }))
      if (operation === 'archive' || operation === 'restore' || operation === 'delete') record.state = operation === 'restore' ? 'active' : operation === 'archive' ? 'archived' : 'deleted'
      validateNode(record)
    }, signal)
    if (operation === 'prune-assets') {
      const retained = new Set<string>()
      for (const record of snapshot.records) if (record.state !== 'deleted' || Date.now() - Date.parse(record.updatedAt) < 30 * 86400000) {
        for (const data of [record.data, ...record.history.map(entry => entry.data)]) if (data.asset && typeof data.asset === 'object' && !Array.isArray(data.asset) && typeof data.asset.id === 'string') retained.add(data.asset.id)
      }
      return { snapshot, value: json(await this.assets.prune(retained, new Date(Date.now() - 30 * 86400000), signal)) }
    }
    return { snapshot, value: json({ id: newId ?? input.id ?? null, completed: true }) }
  }
}
