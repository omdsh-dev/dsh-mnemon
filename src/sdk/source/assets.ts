import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, realpath, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import { withMemoryStorageLock } from '../index.ts'
import { allowedDirectories, readBoundedFile } from './filesystem.ts'

export interface AssetInput {
  path?: string
  url?: string
  base64?: string
  sessionAttachmentId?: string
  latestSessionImage?: boolean
  name?: string
}
export interface AssetReference { id: string; name: string; mediaType: string; bytes: number }
export interface AssetPolicy {
  roots?: readonly string[]
  workspace?: string
  urlOrigins?: readonly string[]
  maxBytes?: number
  resolveSessionImage?(id: string | undefined, signal?: AbortSignal): Promise<{ data: Uint8Array; name: string }>
}
const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const safeName = (name: string): string => basename(name).replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').slice(0, 200) || 'attachment'
export function detectAssetType(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  const first = data.subarray(0, 12).toString('latin1')
  if (/^GIF8[79]a/.test(first)) return 'image/gif'
  if (first.startsWith('RIFF') && first.slice(8) === 'WEBP') return 'image/webp'
  if (first.startsWith('RIFF') && first.slice(8) === 'WAVE') return 'audio/wav'
  if (first.startsWith('ID3') || data[0] === 255 && (data[1]! & 0xe0) === 0xe0) return 'audio/mpeg'
  if (first.startsWith('OggS')) return 'audio/ogg'
  if (first.slice(4, 8) === 'ftyp') return 'video/mp4'
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm'
  if (first.startsWith('%PDF-')) return 'application/pdf'
  if (!data.includes(0) && Buffer.from(data.toString('utf8')).equals(data)) return 'text/plain'
  return 'application/octet-stream'
}

/** Bounded downloads never follow a redirect to a destination outside the explicit origin list. */
export async function readAssetUrl(value: string, origins: readonly string[], maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  let url = new URL(value)
  const allowed = new Set(origins.map(origin => new URL(origin).origin))
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Attachment download timed out')), 15000)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !allowed.has(url.origin)) throw new Error('Attachment URL origin is not configured')
      const response = await fetch(url, { redirect: 'manual', signal: combined })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects === 3) throw new Error('Attachment redirect limit exceeded')
        url = new URL(location, url); continue
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Attachment download failed: HTTP ' + response.status) }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('Attachment exceeds the configured size limit') }
      const chunks: Uint8Array[] = [], reader = response.body.getReader()
      let size = 0
      try {
        while (true) {
          combined.throwIfAborted()
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > maxBytes) throw new Error('Attachment exceeds the configured size limit')
          chunks.push(next.value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      return Buffer.concat(chunks)
    }
    throw new Error('Attachment redirect limit exceeded')
  } finally { clearTimeout(timer) }
}

/** Reusable storage mechanics only. Each Source owns authorization and its reference ledger. */
export class AssetStore {
  readonly directory: string
  constructor(directory: string, readonly maxStoredBytes = 256 * 1024 * 1024) { this.directory = resolve(directory) }
  async ingest(input: AssetInput, policy: AssetPolicy, signal?: AbortSignal): Promise<AssetReference> {
    signal?.throwIfAborted()
    const fields = ['path', 'url', 'base64', 'sessionAttachmentId', 'latestSessionImage'] as const
    if (fields.filter(key => input[key] !== undefined && input[key] !== false).length !== 1) throw new Error('Choose exactly one attachment source')
    const maxBytes = policy.maxBytes ?? 5 * 1024 * 1024
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new Error('Invalid attachment size limit')
    let data: Buffer, name = input.name || 'attachment'
    if (input.path !== undefined) {
      data = await readBoundedFile(await allowedDirectories(policy.roots ?? [], policy.workspace), input.path, maxBytes, signal)
      name = input.name || basename(input.path)
    } else if (input.url !== undefined) {
      data = await readAssetUrl(input.url, policy.urlOrigins ?? [], maxBytes, signal)
      name = input.name || basename(new URL(input.url).pathname)
    } else if (input.base64 !== undefined) {
      if (input.base64.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) throw new Error('Invalid or oversized base64 attachment')
      data = Buffer.from(input.base64, 'base64')
    } else {
      if (!policy.resolveSessionImage) throw new Error('Session image reading is unavailable')
      const image = await policy.resolveSessionImage(input.sessionAttachmentId, signal)
      data = Buffer.from(image.data); name = input.name || image.name
    }
    if (!data.length || data.length > maxBytes) throw new Error('Attachment is empty or exceeds the configured size limit')
    const reference = { id: hash(data), name: safeName(name), bytes: data.length, mediaType: detectAssetType(data) }
    await withMemoryStorageLock(this.directory, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      let compromised: Error | undefined
      const release = await lock(this.directory, { lockfilePath: join(this.directory, 'assets.lock'), stale: 10000, update: 2000,
        retries: { retries: 20, minTimeout: 50, maxTimeout: 500 }, onCompromised(error) { compromised = error },
      })
      const target = join(this.directory, reference.id), temporary = join(this.directory, randomUUID() + '.tmp')
      try {
        try { const existing = await this.read(reference, signal); if (hash(existing) === reference.id) { const now = new Date(); await utimes(target, now, now); return } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        let size = 0
        for (const entry of await readdir(this.directory)) if (/^[a-f0-9]{64}$/.test(entry)) size += (await stat(join(this.directory, entry))).size
        if (size + data.length > this.maxStoredBytes) throw new Error('Attachment storage is full; remove unused registered assets first')
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
        signal?.throwIfAborted(); if (compromised) throw compromised
        await rename(temporary, target)
      } finally { await rm(temporary, { force: true }); await release() }
    })
    return reference
  }
  async read(reference: AssetReference, signal?: AbortSignal): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(reference.id) || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 32 * 1024 * 1024) throw new Error('Invalid registered attachment')
    const data = await readBoundedFile([await realpath(this.directory)], join(this.directory, reference.id), reference.bytes, signal)
    if (data.length !== reference.bytes || hash(data) !== reference.id || detectAssetType(data) !== reference.mediaType) throw new Error('Registered attachment changed or is damaged')
    return data
  }
  /** Caller supplies its complete live reference ledger; freshly unreferenced files retain a grace period. */
  async prune(referenced: ReadonlySet<string>, olderThan: Date, signal?: AbortSignal): Promise<number> {
    if (!Number.isFinite(olderThan.getTime()) || olderThan.getTime() > Date.now() - 86400000) throw new Error('Unused attachments retain at least a 24 hour grace period')
    return withMemoryStorageLock(this.directory, async () => {
      let entries: string[]
      try { entries = await readdir(this.directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
      let compromised: Error | undefined
      const release = await lock(this.directory, { lockfilePath: join(this.directory, 'assets.lock'), stale: 10000, update: 2000, retries: { retries: 20, minTimeout: 50, maxTimeout: 500 }, onCompromised(error) { compromised = error } })
      let removed = 0
      try {
        for (const id of entries) {
          signal?.throwIfAborted(); if (compromised) throw compromised
          if (/^[a-f0-9]{64}$/.test(id) && !referenced.has(id) && (await stat(join(this.directory, id))).mtime < olderThan) { await rm(join(this.directory, id)); removed++ }
        }
        return removed
      } finally { await release() }
    })
  }
}
