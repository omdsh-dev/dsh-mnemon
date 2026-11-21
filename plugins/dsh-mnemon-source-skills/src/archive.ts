import { gunzipSync, inflateRawSync } from 'node:zlib'

export interface ArchiveFile {
  path: string
  data: Buffer
}

export interface ArchiveLimits {
  files: number
  bytes: number
}

function insidePath(raw: string): string | undefined {
  const path = raw.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) return undefined
  const parts = path.split('/')
  if (parts.some(part => part === '..' || part === '.' || part === '')) return undefined
  return path
}

function isJunk(path: string): boolean {
  return path.startsWith('__MACOSX/') || path.split('/').at(-1) === '.DS_Store'
}

class Collector {
  readonly files: ArchiveFile[] = []
  private total = 0
  constructor(private readonly limits: ArchiveLimits) {}

  add(rawPath: string, data: Buffer): void {
    const path = insidePath(rawPath)
    if (path === undefined) throw new Error(`the archive holds a path outside the skill: ${rawPath.slice(0, 200)}`)
    if (isJunk(path)) return
    this.total += data.byteLength
    if (this.files.length >= this.limits.files) throw new Error(`the archive has more than ${this.limits.files} files`)
    if (this.total > this.limits.bytes) throw new Error(`the archive unpacks to more than ${this.limits.bytes} bytes`)
    this.files.push({ path, data })
  }
}

function text(buffer: Buffer, start: number, length: number): string {
  const field = buffer.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.toString('utf8', 0, end === -1 ? field.length : end)
}

function octal(buffer: Buffer, start: number, length: number): number {
  if ((buffer[start]! & 0x80) !== 0) throw new Error('the archive holds a file too large to install')
  const value = text(buffer, start, length).trim()
  if (value === '') return 0
  if (!/^[0-7]+$/u.test(value)) throw new Error('the archive has a corrupt header')
  return Number.parseInt(value, 8)
}

function paxPath(body: Buffer): string | undefined {
  let offset = 0
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(body.toString('ascii', offset, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = body.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals !== -1 && record.slice(0, equals) === 'path') return record.slice(equals + 1)
    offset += length
  }
  return undefined
}

function readTar(buffer: Buffer, limits: ArchiveLimits): ArchiveFile[] {
  const collector = new Collector(limits)
  let offset = 0
  let longName: string | undefined
  let extended: string | undefined
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156]!)
    const start = offset + 512
    if (start + size > buffer.length) throw new Error('the archive is truncated')
    const body = buffer.subarray(start, start + size)
    offset = start + Math.ceil(size / 512) * 512
    if (type === 'x') { extended = paxPath(body); continue }
    if (type === 'g') continue
    if (type === 'L') { longName = text(body, 0, body.length); continue }
    const prefix = header.toString('ascii', 257, 262) === 'ustar' ? text(header, 345, 155) : ''
    const name = extended ?? longName ?? (prefix === '' ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`)
    extended = undefined
    longName = undefined
    if (type === '5') continue
    if (type !== '0' && type !== '\0' && type !== '7') throw new Error(`the archive holds a link or special file: ${name.slice(0, 200)}`)
    collector.add(name, Buffer.from(body))
  }
  return collector.files
}

const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_END = 0x06054b50

function readZip(buffer: Buffer, limits: ArchiveLimits): ArchiveFile[] {
  let end = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 22 - 0xffff); index--) {
    if (buffer.readUInt32LE(index) === ZIP_END) { end = index; break }
  }
  if (end === -1) throw new Error('the zip archive has no central directory')
  const count = buffer.readUInt16LE(end + 10)
  let pointer = buffer.readUInt32LE(end + 16)
  if (count === 0xffff || pointer === 0xffffffff) throw new Error('zip64 archives are not supported')
  const collector = new Collector(limits)
  for (let index = 0; index < count; index++) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== ZIP_CENTRAL) throw new Error('the zip archive is corrupt')
    const flags = buffer.readUInt16LE(pointer + 8)
    const method = buffer.readUInt16LE(pointer + 10)
    const compressed = buffer.readUInt32LE(pointer + 20)
    const size = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const mode = buffer.readUInt32LE(pointer + 38) >>> 16
    const local = buffer.readUInt32LE(pointer + 42)
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)
    pointer += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if ((flags & 1) !== 0) throw new Error('encrypted zip archives are not supported')
    if ((mode & 0o170000) === 0o120000) throw new Error(`the archive holds a link: ${name.slice(0, 200)}`)
    if (compressed === 0xffffffff || size === 0xffffffff) throw new Error('zip64 archives are not supported')
    if (size > limits.bytes) throw new Error(`the archive unpacks to more than ${limits.bytes} bytes`)
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== ZIP_LOCAL) throw new Error('the zip archive is corrupt')
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    if (start + compressed > buffer.length) throw new Error('the zip archive is truncated')
    const raw = buffer.subarray(start, start + compressed)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: limits.bytes }) : undefined
    if (data === undefined) throw new Error(`the zip archive uses an unsupported compression method (${method})`)
    if (data.byteLength !== size) throw new Error('the zip archive is corrupt')
    collector.add(name, data)
  }
  return collector.files
}

export function readArchive(data: Buffer, limits: ArchiveLimits): ArchiveFile[] {
  let files: ArchiveFile[]
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    let tar: Buffer
    try { tar = gunzipSync(data, { maxOutputLength: limits.bytes + limits.files * 1024 + 4096 }) } catch (error) {
      throw new Error(error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? `the archive unpacks to more than ${limits.bytes} bytes` : 'the archive is not a valid .tar.gz')
    }
    files = readTar(tar, limits)
  } else if (data.length >= 4 && data.readUInt32LE(0) === ZIP_LOCAL) files = readZip(data, limits)
  else throw new Error('a skill archive is a .tar.gz or a .zip')
  if (files.some(file => file.path === 'SKILL.md')) return files
  const tops = new Set(files.map(file => file.path.split('/')[0]))
  const [top] = tops
  if (tops.size === 1 && top !== undefined && files.some(file => file.path === `${top}/SKILL.md`)) return files.map(file => ({ path: file.path.slice(top.length + 1), data: file.data }))
  throw new Error('the archive has no SKILL.md at its top level')
}
