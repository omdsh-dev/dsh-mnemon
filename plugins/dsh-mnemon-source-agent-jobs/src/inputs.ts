import { join } from 'node:path'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { AssetStore, json, type AssetInput, type AssetReference, type RecordValue } from 'dsh-mnemon/source-sdk'
import type { JobConfig } from './engine.ts'

export interface ContextCapture { sourceKey: string; label: string; track: string; revision: string; capturedAt: string; text: string }
export function contextCaptures(value: unknown): ContextCapture[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) throw new Error('Choose at most eight context snapshots')
  let size = 0
  for (const capture of value) {
    if (!capture || ['sourceKey', 'label', 'track', 'revision', 'capturedAt', 'text'].some(key => typeof capture[key] !== 'string') || !Number.isFinite(Date.parse(capture.capturedAt)) || capture.sourceKey.length > 300 || capture.label.length > 300 || capture.track.length > 100 || capture.revision.length > 300 || !capture.text.trim()) throw new Error('Invalid context snapshot')
    size += capture.text.length
  }
  if (size > 20_000) throw new Error('Selected context exceeds 20000 characters; choose fewer or smaller tracks')
  return value.map(({ sourceKey, label, track, revision, capturedAt, text }) => ({ sourceKey, label, track, revision, capturedAt, text }))
}
export function capturedContext(record: RecordValue): string {
  return contextCaptures(record.data.contextSnapshots).map(capture => `Source: ${capture.label} (${capture.sourceKey}), track: ${capture.track}, revision: ${capture.revision}, captured: ${capture.capturedAt}\n${capture.text}`).join('\n\n')
}
export class JobInputs {
  readonly assets: AssetStore
  constructor(directory: string, readonly config: JobConfig, readonly sessionImage?: (id: string | undefined, scope: MemoryOperationScope, signal?: AbortSignal) => Promise<{ data: Uint8Array; name: string }>) { this.assets = new AssetStore(join(directory, 'assets')) }
  async copy(raw: unknown, scope: MemoryOperationScope, signal?: AbortSignal): Promise<AssetReference[]> {
    if (!Array.isArray(raw) || raw.length > 8) throw new Error('Choose at most eight images')
    const references: AssetReference[] = []
    for (const input of raw) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid image input')
      const reference = await this.assets.ingest(input as AssetInput, { roots: this.config.attachmentRoots ?? [], ...(scope.workspaceId ? { workspace: scope.workspaceId } : {}), urlOrigins: this.config.attachmentUrlOrigins ?? [], maxBytes: 5 * 1024 * 1024,
        ...(this.sessionImage ? { resolveSessionImage: (id, signal) => this.sessionImage!(id, scope, signal) } : {}),
      }, signal)
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(reference.mediaType)) throw new Error('This job accepts supported raster images only')
      if (!references.some(value => value.id === reference.id)) references.push(reference)
      if (references.reduce((total, value) => total + value.bytes, 0) > 20 * 1024 * 1024) throw new Error('Image inputs exceed 20 MiB')
    }
    return references
  }
  references(record: RecordValue): AssetReference[] {
    const value = record.data.assets ?? []
    if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid retained job images')
    return value as unknown as AssetReference[]
  }
  async paths(record: RecordValue, signal?: AbortSignal): Promise<string[]> {
    const paths: string[] = []
    for (const reference of this.references(record)) { await this.assets.read(reference, signal); paths.push(join(this.assets.directory, reference.id)) }
    return paths
  }
  value(references: AssetReference[]) { return json(references) }
}
