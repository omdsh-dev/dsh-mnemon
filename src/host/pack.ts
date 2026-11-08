import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate'
import type { ResolvedConfig } from './config.ts'
import {
  DOCUMENTS_ACTIVE_LIMIT_BYTES, DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE, DOCUMENTS_LOCK_FILE, DOCUMENTS_LOCK_STALE_MS, DOCUMENT_FILENAME_PATTERN,
  parseDocumentIndex, type DocumentIndex, type DocumentRecord,
} from 'dsh-mnemon-source-documents/contracts'
import {
  MEMORY_SPACE_DATABASE_FILE, MEMORY_SPACE_ID_PATTERN, MEMORY_SPACE_NAME_MAX_LENGTH, MEMORY_SPACE_REGISTRY_FILE, MEMORY_SPACES_DIRECTORY, MNEMON_ACTIVE_STORE_FILE,
  parseMemorySpaceRegistry, type MemorySpaceRegistryEntry, type MemorySpaceRegistryFile,
} from 'dsh-mnemon-source-memory-spaces/contracts'
import { MemorySpaceIdentity } from 'dsh-mnemon-source-memory-spaces/space-identity'
import {
  RUNTIME_ARCHIVE_DIRECTORY, RUNTIME_DIRECTORY, RUNTIME_ENTRY_MAX_BYTES, RUNTIME_LOCK_FILE, RUNTIME_LOCK_STALE_MS, RUNTIME_MEMORIES_FILE,
  RUNTIME_MEMORY_LIMITS, RUNTIME_MEMORY_VERSION, RUNTIME_PROJECTION_FILES,
  parseRuntimeBranches, runtimeBytes, runtimeProjection, assertRuntimePinnedBudget, type RuntimeMemoryEntry, type RuntimeMemoryLimits, type RuntimeMemoryTarget,
} from 'dsh-mnemon-source-runtime/contracts'
import { createStorageRoot, type StorageRoot } from './storage-root.ts'
import { MNEMON_PACK_COMPONENTS, type MnemonEntryOrigin, type MnemonMachineIdentity, type MnemonPackComponent, type MnemonPackComponentSummary, type MnemonPackExport, type MnemonPackImportMode, type MnemonPackImportResult, type MnemonPackManifest, type MnemonPackPreview, type MnemonPackScope, type MnemonPackTarget, type MnemonRuntimeMergeReport, type MnemonTombstone, type MnemonTombstoneFile } from "./protocol.ts"
import { MnemonMachineStore } from './machine-identity.ts'
import { pluginPackageVersion } from './version-updates.ts'

export type { MnemonPackComponent, MnemonPackComponentSummary, MnemonPackExport, MnemonPackImportMode, MnemonPackImportResult, MnemonPackManifest, MnemonPackPreview, MnemonPackScope } from "./protocol.ts"

// The sync channel reads the same payload files out of a Git commit that an
// import would read out of an archive, so it validates them with the exact
// parsers an import uses instead of a second, drifting copy. The entry key is
// exported for the same reason: two sides agree on an entry's identity only
// while one definition decides it. A removal is judged by the same rule here
// and there, so what a tombstone covers is exported too.
export type { StoredRuntimeEntry, RuntimeFile, DocumentIndex }
export { entryKey, tombstoneCovers, tombstoneKey }

export const MNEMON_PACK_FORMAT = 'mnemonpack'
export const MNEMON_PACK_VERSION = 1
export const MNEMON_PACK_MIME = 'application/zip'
export const MNEMON_PACK_MAX_ARCHIVE_BYTES = 48 * 1024 * 1024
export const MNEMON_PACK_MAX_EXPANDED_BYTES = 256 * 1024 * 1024

const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_FILES = 4096
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 20
/**
 * Each component's directory under the data directory, as its Source names it. A Pack carries a
 * component's data files (memories and projections, the index and documents, the registry and
 * stores, never a lock, the local archive or a write-ahead log) under `payload/` at the paths they
 * have there, so these names and the Sources' file names spell the Pack's entries too;
 * tests/pack-compat-0.5.24.spec.ts pins them to the entries 0.5.24 accepts.
 */
const COMPONENT_DIRECTORIES = { runtime: RUNTIME_DIRECTORY, documents: DOCUMENTS_DIRECTORY, 'memory-spaces': MEMORY_SPACES_DIRECTORY } as const
export const RUNTIME_MEMORIES_PATH = `payload/${RUNTIME_DIRECTORY}/${RUNTIME_MEMORIES_FILE}`
const RUNTIME_PROJECTION_PATHS = {
  user: `payload/${RUNTIME_DIRECTORY}/${RUNTIME_PROJECTION_FILES.user}`,
  memory: `payload/${RUNTIME_DIRECTORY}/${RUNTIME_PROJECTION_FILES.memory}`,
} as const satisfies Record<RuntimeMemoryTarget, string>
export const DOCUMENTS_INDEX_PATH = `payload/${DOCUMENTS_DIRECTORY}/${DOCUMENTS_INDEX_FILE}`
const MEMORY_SPACE_REGISTRY_PATH = `payload/${MEMORY_SPACES_DIRECTORY}/${MEMORY_SPACE_REGISTRY_FILE}`
const STATE_TOMBSTONE_FILE = 'tombstones.json'
const STATE_RUNTIME_INDEX_FILE = 'runtime-index.json'
const COMPONENT_ORDER = MNEMON_PACK_COMPONENTS
/**
 * Every content hash this format writes is `sha256(...)` in hex, so one rule decides the shape.
 * The digest of a Runtime entry's text and the digest of a Document's body are the same kind of
 * value, and a second, drifting copy of the rule is how one of them ends up unchecked.
 */
const CONTENT_HASH = /^[a-f0-9]{64}$/u
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary')

interface ChecksumFile {
  algorithm: 'sha256'
  files: Record<string, string>
}

interface ParsedPack {
  archiveBytes: number
  expandedBytes: number
  files: Unzipped
  manifest: MnemonPackManifest
}

/**
 * A stored entry may carry fields this Host does not own: the machine that wrote it,
 * and whatever a newer version adds. They round-trip through the Pack untouched.
 */
type StoredRuntimeEntry = RuntimeMemoryEntry & { origin?: MnemonEntryOrigin }

interface RuntimeFile {
  version: 1
  entries: StoredRuntimeEntry[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function utf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
}

function json(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(utf8(bytes, label)) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`)
    throw error
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeArchivePath(path: string): void {
  if (path === '' || path.length > 512 || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new Error(`unsafe Pack entry path: ${JSON.stringify(path)}`)
  }
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(`unsafe Pack entry path: ${JSON.stringify(path)}`)
}

/** Where one component's files sit in a Pack; the sync channel compares a component's files by it. */
export function payloadPrefix(component: MnemonPackComponent): string {
  return `payload/${COMPONENT_DIRECTORIES[component]}/`
}

/** The path segments below a component's payload directory, or nothing for a path outside it. */
function payloadSegments(path: string, component: MnemonPackComponent): string[] | undefined {
  const prefix = payloadPrefix(component)
  return path.startsWith(prefix) ? path.slice(prefix.length).split('/') : undefined
}

function databasePayloadPath(id: string): string {
  return `${payloadPrefix('memory-spaces')}${id}/${MEMORY_SPACE_DATABASE_FILE}`
}

function payloadComponent(path: string): MnemonPackComponent | undefined {
  return COMPONENT_ORDER.find(component => path.startsWith(payloadPrefix(component)))
}

/**
 * The exact entry list a Pack may hold, kept deliberately identical to the list
 * version 0.5.24 accepts: a backup written here opens there, and one written
 * there opens here. A file this list does not name is not "extra data", it is a
 * Pack the other side refuses outright, so machine-local state (deletions, the
 * machine identity) travels over the sync channel instead of inside an archive.
 */
function allowedPayloadPath(path: string): boolean {
  if (path === RUNTIME_MEMORIES_PATH || path === RUNTIME_PROJECTION_PATHS.user || path === RUNTIME_PROJECTION_PATHS.memory) return true
  if (path === DOCUMENTS_INDEX_PATH) return true
  const document = payloadSegments(path, 'documents')
  if (document?.length === 2 && (document[0] === 'active' || document[0] === 'archived') && DOCUMENT_FILENAME_PATTERN.test(document[1]!)) return true
  if (path === MEMORY_SPACE_REGISTRY_PATH) return true
  const space = payloadSegments(path, 'memory-spaces')
  return space?.length === 2 && MEMORY_SPACE_ID_PATTERN.test(space[0]!) && space[1] === MEMORY_SPACE_DATABASE_FILE
}

function componentsForScope(scope: MnemonPackScope): MnemonPackComponent[] {
  if (scope === 'full') return [...COMPONENT_ORDER]
  if (!COMPONENT_ORDER.includes(scope)) throw new Error('Mnemon Pack scope must be full, runtime, documents, or memory-spaces')
  return [scope]
}

/** Exported so the sync channel can read the manifest a commit holds without unpacking the archive. */
export function parseManifest(value: unknown): MnemonPackManifest {
  const manifest = record(value)
  if (manifest?.format !== MNEMON_PACK_FORMAT || manifest.version !== MNEMON_PACK_VERSION) throw new Error('unsupported Mnemon Pack format or version')
  if (manifest.scope !== 'full' && !COMPONENT_ORDER.includes(manifest.scope as MnemonPackComponent)) throw new Error('Mnemon Pack scope is invalid')
  if (typeof manifest.exportedAt !== 'string') throw new Error('Mnemon Pack exportedAt is invalid')
  if (!Array.isArray(manifest.components)) throw new Error('Mnemon Pack components are invalid')
  const components = manifest.components.map(String) as MnemonPackComponent[]
  if (components.length === 0 || new Set(components).size !== components.length || components.some(component => !COMPONENT_ORDER.includes(component))) {
    throw new Error('Mnemon Pack components are invalid')
  }
  const expected = componentsForScope(manifest.scope as MnemonPackScope)
  if (components.length !== expected.length || expected.some(component => !components.includes(component))) throw new Error('Mnemon Pack scope does not match its components')
  const source = record(manifest.source)
  if (source?.plugin !== 'dsh-mnemon' || typeof source.pluginVersion !== 'string') throw new Error('Mnemon Pack source is invalid')
  if (!Array.isArray(manifest.summary)) throw new Error('Mnemon Pack summary is invalid')
  const summary = manifest.summary.map((entry): MnemonPackComponentSummary => {
    const item = record(entry)
    const component = item?.component as MnemonPackComponent
    if (!COMPONENT_ORDER.includes(component) || !Number.isSafeInteger(item?.files) || !Number.isSafeInteger(item?.bytes) || !Number.isSafeInteger(item?.items)
      || Number(item?.files) < 0 || Number(item?.bytes) < 0 || Number(item?.items) < 0) {
      throw new Error('Mnemon Pack summary entry is invalid')
    }
    return { component, files: Number(item!.files), bytes: Number(item!.bytes), items: Number(item!.items) }
  })
  // Anything else the writer put in the manifest (a newer field, a sync channel's
  // own extension) is ignored rather than rejected: a reader has to open a Pack
  // written by a version it has never seen.
  return {
    format: MNEMON_PACK_FORMAT,
    version: MNEMON_PACK_VERSION,
    scope: manifest.scope as MnemonPackScope,
    exportedAt: manifest.exportedAt,
    source: { plugin: 'dsh-mnemon', pluginVersion: source.pluginVersion },
    components,
    summary,
  }
}

/** The sync channel reads its machine identity with this parser; no Pack carries one. */
export function parseMachineIdentity(value: unknown): MnemonMachineIdentity | undefined {
  if (value === undefined || value === null) return undefined
  const machine = record(value)
  if (typeof machine?.id !== 'string' || machine.id.trim() === '' || typeof machine.label !== 'string' || typeof machine.createdAt !== 'string') {
    throw new Error('Mnemon Pack machine identity is invalid')
  }
  return { id: machine.id, label: machine.label, createdAt: machine.createdAt }
}

function parseEntryOrigin(value: unknown): MnemonEntryOrigin | undefined {
  if (value === undefined || value === null) return undefined
  const origin = record(value)
  if (typeof origin?.machine !== 'string' || typeof origin.label !== 'string' || typeof origin.at !== 'string') return undefined
  return { machine: origin.machine, label: origin.label, at: origin.at }
}

/**
 * Whole groups of four from the base64 alphabet, padded with at most two `=` at the end. The
 * length check and one character class keep this a flat loop at any size. A pattern that repeats
 * a four-character group keeps a backtracking entry per group, and V8 threw "Maximum call stack
 * size exceeded" once a payload passed about 4.5 MB (#368). The `u` flag stays off: under it,
 * V8 13 (Node 24) does the same for a class over a string holding a character above U+00FF.
 */
function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

function decodeArchive(base64: string): Buffer {
  if (typeof base64 !== 'string' || base64 === '' || base64.length > Math.ceil(MNEMON_PACK_MAX_ARCHIVE_BYTES / 3) * 4 + 4) throw new Error('Mnemon Pack archive is empty or too large')
  if (!isBase64(base64)) throw new Error('Mnemon Pack payload is not valid base64')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0 || bytes.length > MNEMON_PACK_MAX_ARCHIVE_BYTES) throw new Error('Mnemon Pack archive is empty or too large')
  return bytes
}

function parseArchive(base64: string, runtimeLimits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): ParsedPack {
  const archive = decodeArchive(base64)
  let count = 0
  let expandedBytes = 0
  const files = unzipSync(archive, {
    filter(info) {
      safeArchivePath(info.name)
      if (info.name.endsWith('/')) return false
      count += 1
      expandedBytes += info.originalSize
      if (count > MAX_FILES) throw new Error(`Mnemon Pack contains more than ${MAX_FILES} files`)
      if (info.originalSize > MAX_FILE_BYTES || expandedBytes > MNEMON_PACK_MAX_EXPANDED_BYTES) throw new Error('Mnemon Pack expanded data exceeds the safety limit')
      return true
    },
  })
  const names = Object.keys(files)
  if (!names.includes('manifest.json') || !names.includes('checksums.json')) throw new Error('Mnemon Pack is missing manifest.json or checksums.json')
  for (const path of names) {
    safeArchivePath(path)
    if (path !== 'manifest.json' && path !== 'checksums.json' && !allowedPayloadPath(path)) throw new Error(`unsupported Mnemon Pack entry: ${path}`)
  }
  const manifest = parseManifest(json(files['manifest.json']!, 'manifest.json'))
  const checksumValue = record(json(files['checksums.json']!, 'checksums.json'))
  const checksumFiles = record(checksumValue?.files)
  if (checksumValue?.algorithm !== 'sha256' || checksumFiles === undefined) throw new Error('Mnemon Pack checksums are invalid')
  const payloadNames = names.filter(path => path.startsWith('payload/')).sort()
  if (Object.keys(checksumFiles).length !== payloadNames.length) throw new Error('Mnemon Pack checksum inventory does not match the payload')
  for (const path of payloadNames) {
    const component = payloadComponent(path)
    if (component === undefined || !manifest.components.includes(component)) throw new Error(`Mnemon Pack payload is outside its declared components: ${path}`)
    const expected = checksumFiles[path]
    if (typeof expected !== 'string' || expected !== sha256(files[path]!)) throw new Error(`Mnemon Pack checksum mismatch: ${path}`)
  }
  validatePackPayload(files, manifest.components, runtimeLimits)
  const actualSummary = summaryFor(manifest.components, files, runtimeLimits)
  return { archiveBytes: archive.length, expandedBytes, files, manifest: { ...manifest, summary: actualSummary } }
}

export function parseRuntime(value: unknown, limits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): RuntimeFile {
  const source = record(value)
  if (source?.version !== RUNTIME_MEMORY_VERSION || !Array.isArray(source.entries)) throw new Error('runtime memories.json is invalid')
  const entries = source.entries.map((raw): RuntimeMemoryEntry => {
    const entry = record(raw)
    if (typeof entry?.content !== 'string' || (entry.target !== 'memory' && entry.target !== 'user') || !['critical', 'normal', 'low'].includes(String(entry.importance))) {
      throw new Error('runtime memories.json contains an invalid entry')
    }
    if (typeof entry.created_at !== 'string' || typeof entry.updated_at !== 'string') throw new Error('runtime memories.json contains invalid timestamps')
    if (entry.pinned !== undefined && typeof entry.pinned !== 'boolean') throw new Error('runtime memories.json contains invalid pin state')
    const content = entry.content.trim().replace(/\s+/gu, ' ')
    if (content === '' || content.includes('§') || Buffer.byteLength(content, 'utf8') > RUNTIME_ENTRY_MAX_BYTES) throw new Error('runtime memories.json contains invalid content')
    // A Pack carries provenance, not only text: the branch scope of a working-memory entry
    // and the machine that wrote it travel along. Each is read through its own rule, so a
    // malformed value from a damaged archive or another installation is dropped here instead
    // of reaching the runtime projection.
    const branches = entry.target === 'memory' ? parseRuntimeBranches(entry.branches) : undefined
    const origin = parseEntryOrigin(entry.origin)
    return {
      content, target: entry.target, importance: entry.importance as RuntimeMemoryEntry['importance'],
      created_at: entry.created_at, updated_at: entry.updated_at,
      ...(entry.pinned === undefined ? {} : { pinned: entry.pinned }),
      ...(branches === undefined ? {} : { branches }),
      ...(origin === undefined ? {} : { origin }),
    }
  })
  assertRuntimePinnedBudget(entries)
  for (const target of ['user', 'memory'] as const) {
    const used = runtimeBytes(entries, target)
    if (used > limits[target]) throw new Error(`runtime ${target} memory holds ${used} bytes and exceeds its ${limits[target]} byte limit`)
  }
  return { version: 1, entries }
}

function emptyTombstones(): MnemonTombstoneFile {
  return { version: 1, tombstones: [] }
}

export function parseTombstones(value: unknown): MnemonTombstoneFile {
  const source = record(value)
  if (source?.version !== 1 || !Array.isArray(source.tombstones)) throw new Error('runtime tombstones.json is invalid')
  const tombstones = source.tombstones.map((raw): MnemonTombstone => {
    const tombstone = record(raw)
    if (tombstone?.target !== 'memory' && tombstone?.target !== 'user') throw new Error('runtime tombstones.json contains an invalid entry')
    if (typeof tombstone.contentHash !== 'string' || !CONTENT_HASH.test(tombstone.contentHash) || typeof tombstone.deletedAt !== 'string') {
      throw new Error('runtime tombstones.json contains an invalid entry')
    }
    return {
      target: tombstone.target,
      contentHash: tombstone.contentHash,
      deletedAt: tombstone.deletedAt,
      ...(typeof tombstone.machine === 'string' ? { machine: tombstone.machine } : {}),
    }
  })
  return { version: 1, tombstones }
}

function validDatabase(bytes: Uint8Array, path: string): void {
  if (bytes.length < 100 || !Buffer.from(bytes.subarray(0, SQLITE_HEADER.length)).equals(SQLITE_HEADER)) throw new Error(`${path} is not a SQLite ${MEMORY_SPACE_DATABASE_FILE}`)
}

/**
 * One document's payload entry, judged against the index that describes it.
 *
 * A document's body lives in its own file while its digest lives in `index.json`, so the two can
 * disagree while neither looks malformed: an index a person edited, a write that stopped halfway,
 * or a store an older version repaired by hand. The import path and the publish path judge that
 * pair by this one rule, so a payload this machine would refuse from another machine is never one
 * this machine produces. Reading the index does not judge the digest's shape: a ZIP backup reads
 * the same index, and a store that needs repair still has to download as one.
 */
function assertDocumentPayload(document: DocumentRecord, bytes: Uint8Array): void {
  if (!CONTENT_HASH.test(document.contentHash)) throw new Error(`Documents index records a content hash that is not a sha256 digest for ${document.relativePath}`)
  if (bytes.length !== document.sizeBytes) throw new Error(`Documents payload size does not match ${document.relativePath}`)
  const markdown = utf8(bytes, `payload/${document.relativePath}`)
  const frontmatterEnd = markdown.startsWith('---\n') ? markdown.indexOf('\n---\n', 4) : -1
  if (frontmatterEnd < 0 || !markdown.slice(4, frontmatterEnd).split('\n').includes(`id: ${JSON.stringify(document.id)}`)) throw new Error(`Documents payload identity does not match ${document.relativePath}`)
  const body = markdown.slice(frontmatterEnd + 5).trim()
  if (sha256(body) !== document.contentHash) throw new Error(`Documents payload content hash does not match ${document.relativePath}`)
}

function validatePackPayload(files: Record<string, Uint8Array>, components: MnemonPackComponent[], runtimeLimits: RuntimeMemoryLimits): void {
  if (components.includes('runtime')) parseRuntime(json(files[RUNTIME_MEMORIES_PATH] ?? new Uint8Array(), RUNTIME_MEMORIES_PATH), runtimeLimits)
  if (components.includes('documents')) {
    const index = parseDocumentIndex(json(files[DOCUMENTS_INDEX_PATH] ?? new Uint8Array(), DOCUMENTS_INDEX_PATH))
    for (const document of index.documents) {
      const bytes = files[`payload/${document.relativePath}`]
      if (bytes === undefined) throw new Error(`Documents payload is missing ${document.relativePath}`)
      assertDocumentPayload(document, bytes)
    }
  }
  if (components.includes('memory-spaces')) {
    const registry = parseMemorySpaceRegistry(json(files[MEMORY_SPACE_REGISTRY_PATH] ?? new Uint8Array(), MEMORY_SPACE_REGISTRY_PATH))
    for (const body of registry.bodies) {
      const path = databasePayloadPath(body.id)
      const database = files[path]
      if (database === undefined) throw new Error(`Memory Space payload is missing ${body.id}/${MEMORY_SPACE_DATABASE_FILE}`)
      validDatabase(database, path)
    }
    const databases = Object.keys(files).filter(path => {
      const segments = payloadSegments(path, 'memory-spaces')
      return segments?.length === 2 && segments[0] !== '' && segments[1] === MEMORY_SPACE_DATABASE_FILE
    })
    if (databases.length !== registry.bodies.length) throw new Error('Memory Space registry does not match the database payload')
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/** `staleMs` is the owner's rule for an abandoned lock: a Source's lock is taken over only when that Source would take it over. */
function acquireLock(path: string, staleMs: number): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let descriptor: number | undefined
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try { if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true }) } catch {}
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Pack component lock: ${path}`)
      sleepSync(LOCK_RETRY_MS)
    }
  }
  // The lock is the lock file's existence, not its descriptor. Windows refuses
  // to rename a directory that holds an open handle, and an import replaces the
  // runtime and documents directories that carry these very lock files.
  const identity = fstatSync(descriptor)
  closeSync(descriptor)
  return () => {
    try {
      const current = lstatSync(path)
      if (current.dev === identity.dev && current.ino === identity.ino) rmSync(path, { force: true })
    } catch {}
  }
}

/**
 * The lock each Source's controller holds while it writes, so a copy never sees a component half
 * written, always in this order whatever order the components are listed in.
 */
function sourceLocks(root: string, components: readonly MnemonPackComponent[]): Array<{ path: string; staleMs: number }> {
  const locks: Array<{ path: string; staleMs: number }> = []
  if (components.includes('runtime')) locks.push({ path: join(root, RUNTIME_DIRECTORY, RUNTIME_LOCK_FILE), staleMs: RUNTIME_LOCK_STALE_MS })
  if (components.includes('documents')) locks.push({ path: join(root, DOCUMENTS_DIRECTORY, DOCUMENTS_LOCK_FILE), staleMs: DOCUMENTS_LOCK_STALE_MS })
  return locks
}

function withLocks<T>(root: string, components: MnemonPackComponent[], operation: () => T): T {
  const locks = [{ path: join(root, '.dsh-pack.lock'), staleMs: LOCK_STALE_MS }, ...sourceLocks(root, components)]
  const releases: Array<() => void> = []
  try {
    for (const lock of locks) releases.push(acquireLock(lock.path, lock.staleMs))
    return operation()
  } finally {
    for (const release of releases.reverse()) release()
  }
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pack source is not a regular file: ${path}`)
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Pack source file exceeds the safety limit: ${path}`)
}

function sourceBytes(path: string): Uint8Array {
  assertRegularFile(path)
  return readFileSync(path)
}

function emptyRuntime(): RuntimeFile {
  return { version: 1, entries: [] }
}

function readCurrentRuntime(root: string, limits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): RuntimeFile {
  const path = join(root, RUNTIME_DIRECTORY, RUNTIME_MEMORIES_FILE)
  return existsSync(path) ? parseRuntime(JSON.parse(readFileSync(path, 'utf8')) as unknown, limits) : emptyRuntime()
}

/**
 * A Pack carries no local archive: the one MEMORY.md wrote while no Memory Space
 * could take its entries holds their only copy, so an import keeps it (#336).
 * Its files and folders are carried; a link is neither carried nor followed.
 */
function keepRuntimeArchive(root: string, stagedRuntime: string): void {
  const copy = (from: string, to: string): void => {
    let stat
    try { stat = lstatSync(from) } catch { return }
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      copyFileSync(from, to)
      chmodSync(to, 0o600)
    } else if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 })
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name))
    }
  }
  copy(join(root, RUNTIME_DIRECTORY, RUNTIME_ARCHIVE_DIRECTORY), join(stagedRuntime, RUNTIME_ARCHIVE_DIRECTORY))
}

/** Keep exact overflow records locally; a stable filename makes retried merges idempotent. */
function archiveRuntimeOverflow(stagedRuntime: string, entries: RuntimeMemoryEntry[]): number {
  if (entries.length === 0) return 0
  const directory = join(stagedRuntime, RUNTIME_ARCHIVE_DIRECTORY, 'import-overflow')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let added = 0
  for (const entry of entries) {
    const content = `${canonicalJson({ version: 1, entries: [entry] })}\n`
    const path = join(directory, `${sha256(content)}.json`)
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') !== content) throw new Error('Runtime overflow archive content mismatch')
      continue
    }
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
    added += 1
  }
  return added
}

/** Retain the same hot set on both machines, without asking a model to rewrite evidence. */
function fitMergedRuntime(entries: RuntimeMemoryEntry[], limits: RuntimeMemoryLimits): { entries: RuntimeMemoryEntry[]; archived: RuntimeMemoryEntry[] } {
  if (runtimeBytes(entries.filter(entry => entry.pinned === true), 'memory') > limits.memory) throw new Error('Pinned runtime entries exceed the merge capacity. Unpin entries or increase the capacity; no data was changed.')
  if (runtimeBytes(entries, 'memory') <= limits.memory) return { entries, archived: [] }
  const importance = { critical: 2, normal: 1, low: 0 }
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  const ranked = entries.filter(entry => entry.target === 'memory').sort((left, right) =>
    Number(right.pinned === true) - Number(left.pinned === true) || importance[right.importance] - importance[left.importance] || compare(right.updated_at, left.updated_at) || compare(entryKey(left), entryKey(right)))
  const kept: RuntimeMemoryEntry[] = []
  const archived: RuntimeMemoryEntry[] = []
  for (const entry of ranked) {
    if (runtimeBytes([...kept, entry], 'memory') <= limits.memory) kept.push(entry)
    else archived.push(entry)
  }
  const selected = new Set(kept)
  return { entries: entries.filter(entry => entry.target === 'user' || selected.has(entry)), archived }
}

function writeRuntime(directory: string, file: RuntimeFile): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, RUNTIME_MEMORIES_FILE), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(directory, RUNTIME_PROJECTION_FILES.user), runtimeProjection(file.entries, 'user'), { mode: 0o600 })
  writeFileSync(join(directory, RUNTIME_PROJECTION_FILES.memory), runtimeProjection(file.entries, 'memory'), { mode: 0o600 })
}

function readCurrentDocuments(root: string): { index: DocumentIndex; files: Map<string, Uint8Array> } {
  const indexPath = join(root, DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE)
  const index = existsSync(indexPath) ? parseDocumentIndex(JSON.parse(readFileSync(indexPath, 'utf8')) as unknown) : { version: 1 as const, documents: [] }
  const files = new Map<string, Uint8Array>()
  for (const document of index.documents) {
    const path = join(root, document.relativePath)
    if (!existsSync(path)) throw new Error(`current Documents index is missing ${document.relativePath}`)
    files.set(document.id, sourceBytes(path))
  }
  return { index, files }
}

function writeDocuments(directory: string, index: DocumentIndex, files: Map<string, Uint8Array>): void {
  mkdirSync(join(directory, 'active'), { recursive: true, mode: 0o700 })
  mkdirSync(join(directory, 'archived'), { recursive: true, mode: 0o700 })
  for (const document of index.documents) {
    const bytes = files.get(document.id)
    if (bytes === undefined) throw new Error(`Documents staging is missing ${document.id}`)
    writeFileSync(join(directory, document.status, document.filename), bytes, { mode: 0o600 })
  }
  writeFileSync(join(directory, DOCUMENTS_INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
}

function archiveDocuments(pack: ParsedPack): { index: DocumentIndex; files: Map<string, Uint8Array> } {
  const index = parseDocumentIndex(json(pack.files[DOCUMENTS_INDEX_PATH]!, DOCUMENTS_INDEX_PATH))
  return { index, files: new Map(index.documents.map(document => [document.id, pack.files[`payload/${document.relativePath}`]!])) }
}

function remapDocument(document: DocumentRecord, bytes: Uint8Array, id: string): { document: DocumentRecord; bytes: Uint8Array } {
  const base = document.filename.replace(/\.md$/u, '').slice(0, 80) || 'document'
  const filename = `${base}-${id.slice(0, 8)}.md`
  const markdown = utf8(bytes, document.filename).replace(/^id:\s*.*$/mu, `id: ${JSON.stringify(id)}`)
  const output = strToU8(markdown)
  return {
    document: { ...document, id, filename, relativePath: `${DOCUMENTS_DIRECTORY}/${document.status}/${filename}`, sizeBytes: output.length },
    bytes: output,
  }
}

function readCurrentRegistry(root: string): { registry: MemorySpaceRegistryFile; databases: Map<string, Uint8Array> } {
  const data = join(root, MEMORY_SPACES_DIRECTORY)
  if (!existsSync(data)) return { registry: { version: 1, bodies: [] }, databases: new Map() }
  const discovered = readdirSync(data, { withFileTypes: true }).filter(entry => entry.isDirectory() && MEMORY_SPACE_ID_PATTERN.test(entry.name) && existsSync(join(data, entry.name, MEMORY_SPACE_DATABASE_FILE))).map(entry => entry.name)
  const registryPath = join(data, MEMORY_SPACE_REGISTRY_FILE)
  const existing = existsSync(registryPath) ? parseMemorySpaceRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown) : { version: 1 as const, bodies: [] }
  const byId = new Map(existing.bodies.map(body => [body.id, body]))
  const timestamp = new Date().toISOString()
  const bodies = discovered.map(id => byId.get(id) ?? { id, name: id, description: 'Existing Mnemon Store discovered on disk.', active: false, createdAt: timestamp, updatedAt: timestamp })
  const databases = new Map<string, Uint8Array>()
  for (const body of bodies) {
    const path = join(data, body.id, MEMORY_SPACE_DATABASE_FILE)
    const wal = `${path}-wal`
    if (existsSync(wal) && statSync(wal).size > 0) throw new Error(`Memory Space ${body.id} is busy (${MEMORY_SPACE_DATABASE_FILE}-wal is not checkpointed); retry after writes settle`)
    const bytes = sourceBytes(path)
    validDatabase(bytes, path)
    databases.set(body.id, bytes)
  }
  return { registry: { version: 1, bodies }, databases }
}

function archiveRegistry(pack: ParsedPack): { registry: MemorySpaceRegistryFile; databases: Map<string, Uint8Array> } {
  const registry = parseMemorySpaceRegistry(json(pack.files[MEMORY_SPACE_REGISTRY_PATH]!, MEMORY_SPACE_REGISTRY_PATH))
  return { registry, databases: new Map(registry.bodies.map(body => [body.id, pack.files[databasePayloadPath(body.id)]!])) }
}

function writeRegistry(directory: string, registry: MemorySpaceRegistryFile, databases: Map<string, Uint8Array>): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const body of registry.bodies) {
    const bytes = databases.get(body.id)
    if (bytes === undefined) throw new Error(`Memory Space staging is missing ${body.id}/${MEMORY_SPACE_DATABASE_FILE}`)
    const bodyDirectory = join(directory, body.id)
    mkdirSync(bodyDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(join(bodyDirectory, MEMORY_SPACE_DATABASE_FILE), bytes, { mode: 0o600 })
  }
  writeFileSync(join(directory, MEMORY_SPACE_REGISTRY_FILE), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
}

function componentItems(component: MnemonPackComponent, files: Record<string, Uint8Array>, runtimeLimits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): number {
  if (component === 'runtime') return parseRuntime(json(files[RUNTIME_MEMORIES_PATH]!, RUNTIME_MEMORIES_PATH), runtimeLimits).entries.length
  if (component === 'documents') return parseDocumentIndex(json(files[DOCUMENTS_INDEX_PATH]!, DOCUMENTS_INDEX_PATH)).documents.length
  return parseMemorySpaceRegistry(json(files[MEMORY_SPACE_REGISTRY_PATH]!, MEMORY_SPACE_REGISTRY_PATH)).bodies.length
}

function summaryFor(components: MnemonPackComponent[], files: Record<string, Uint8Array>, runtimeLimits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): MnemonPackComponentSummary[] {
  return components.map(component => {
    const prefix = payloadPrefix(component)
    const entries = Object.entries(files).filter(([path]) => path.startsWith(prefix))
    return { component, files: entries.length, bytes: entries.reduce((sum, [, value]) => sum + value.length, 0), items: componentItems(component, files, runtimeLimits) }
  })
}

/**
 * The payload of one Pack, and nothing else.
 *
 * A removal record and the identity that signs one are machine-local state: they
 * describe how two installations reconcile, not what a memory is, so they travel
 * over the sync channel and never appear here. An archive that carried them would
 * also stop opening in a version that does not know them.
 *
 * `stamp` is passed by the sync channel alone: signing entries with the writing
 * machine is what lets a later merge attribute an entry, and it advances the local
 * deletion ledger because publishing is what makes a removal visible.
 */
function collectExport(root: string, components: MnemonPackComponent[], runtimeLimits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS, stamp?: { machine: MnemonMachineIdentity; at: string }): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  if (components.includes('runtime')) {
    const runtime = readCurrentRuntime(root, runtimeLimits)
    const entries = stamp === undefined ? runtime.entries : stampedEntries(runtime.entries, stamp.machine)
    if (stamp !== undefined) advanceTombstones(root, runtime.entries, stamp.machine, stamp.at)
    files[RUNTIME_MEMORIES_PATH] = strToU8(`${JSON.stringify({ ...runtime, entries }, null, 2)}\n`)
    files[RUNTIME_PROJECTION_PATHS.user] = strToU8(runtimeProjection(entries, 'user'))
    files[RUNTIME_PROJECTION_PATHS.memory] = strToU8(runtimeProjection(entries, 'memory'))
  }
  if (components.includes('documents')) {
    const current = readCurrentDocuments(root)
    files[DOCUMENTS_INDEX_PATH] = strToU8(`${JSON.stringify(current.index, null, 2)}\n`)
    for (const document of current.index.documents) files[`payload/${document.relativePath}`] = current.files.get(document.id)!
  }
  if (components.includes('memory-spaces')) {
    const current = readCurrentRegistry(root)
    files[MEMORY_SPACE_REGISTRY_PATH] = strToU8(`${JSON.stringify(current.registry, null, 2)}\n`)
    for (const body of current.registry.bodies) files[databasePayloadPath(body.id)] = current.databases.get(body.id)!
  }
  return files
}

function readCurrentTombstones(root: string): MnemonTombstoneFile {
  const path = join(root, 'state', STATE_TOMBSTONE_FILE)
  return existsSync(path) ? parseTombstones(JSON.parse(readFileSync(path, 'utf8')) as unknown) : emptyTombstones()
}

function writeTombstones(directory: string, file: MnemonTombstoneFile): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, STATE_TOMBSTONE_FILE), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

/**
 * The entries the last export carried. A removal leaves no trace in the data itself,
 * so this index is what lets a later export notice one and publish it as a tombstone.
 */
interface RuntimeIndexFile {
  version: 1
  entries: Array<{ target: RuntimeMemoryTarget; contentHash: string }>
}

function emptyRuntimeIndex(): RuntimeIndexFile {
  return { version: 1, entries: [] }
}

/** A damaged index only costs forgotten deletions, so it degrades instead of failing an export. */
function parseRuntimeIndex(value: unknown): RuntimeIndexFile {
  const source = record(value)
  if (source?.version !== 1 || !Array.isArray(source.entries)) return emptyRuntimeIndex()
  const entries: RuntimeIndexFile['entries'] = []
  for (const raw of source.entries) {
    const entry = record(raw)
    if (entry?.target !== 'memory' && entry?.target !== 'user') continue
    if (typeof entry.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.contentHash)) continue
    entries.push({ target: entry.target, contentHash: entry.contentHash })
  }
  return { version: 1, entries }
}

function readRuntimeIndex(root: string): RuntimeIndexFile {
  const path = join(root, 'state', STATE_RUNTIME_INDEX_FILE)
  if (!existsSync(path)) return emptyRuntimeIndex()
  try {
    return parseRuntimeIndex(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return emptyRuntimeIndex()
  }
}

function writeRuntimeIndex(directory: string, file: RuntimeIndexFile): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, STATE_RUNTIME_INDEX_FILE), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Every entry the last export carried that the data directory no longer holds was deleted
 * here. Publishing that deletion as a tombstone is what stops another machine from writing
 * the entry back during the next merge.
 */
function deletedSince(root: string, entries: StoredRuntimeEntry[], machine: MnemonMachineIdentity, at: string): MnemonTombstone[] {
  const present = new Set(entries.map(entry => `${entry.target}\0${tombstoneHash(entry)}`))
  return readRuntimeIndex(root).entries
    .filter(entry => !present.has(`${entry.target}\0${entry.contentHash}`))
    .map(entry => ({ target: entry.target, contentHash: entry.contentHash, deletedAt: at, machine: machine.id }))
}

/** Record this export's entries and fold the deletions it revealed into the local tombstones. */
function advanceTombstones(root: string, entries: StoredRuntimeEntry[], machine: MnemonMachineIdentity, at: string): MnemonTombstoneFile {
  const file = mergeTombstoneFiles(readCurrentTombstones(root), { version: 1, tombstones: deletedSince(root, entries, machine, at) })
  writeTombstones(join(root, 'state'), file)
  writeRuntimeIndex(join(root, 'state'), { version: 1, entries: entries.map(entry => ({ target: entry.target, contentHash: tombstoneHash(entry) })) })
  return file
}

/** One entry's identity across machines: its target plus its exact text. */
function entryKey(entry: { target: RuntimeMemoryTarget; content: string }): string {
  return `${entry.target}\0${entry.content}`
}

/** A deletion is a tombstone over that same identity, so it travels as data instead of as a diff. */
function tombstoneHash(entry: { target: RuntimeMemoryTarget; content: string }): string {
  return sha256(`${entry.target}\0${entry.content}`)
}

/** One removal's identity: the same identity an entry key states, hashed. */
function tombstoneKey(tombstone: MnemonTombstone): string {
  return `${tombstone.target}\0${tombstone.contentHash}`
}

/** A tombstone hides an entry until that entry is written again later than the deletion. */
function tombstoneCovers(tombstone: MnemonTombstone, entry: StoredRuntimeEntry): boolean {
  if (tombstone.target !== entry.target || tombstone.contentHash !== tombstoneHash(entry)) return false
  const deletedAt = Date.parse(tombstone.deletedAt)
  const updatedAt = Date.parse(entry.updated_at)
  if (Number.isNaN(deletedAt) || Number.isNaN(updatedAt)) return tombstone.deletedAt >= entry.updated_at
  return deletedAt >= updatedAt
}

/**
 * Entries this machine writes carry no origin until they leave it; an export stamps them.
 * The stamp is the entry's own write time, never the moment of the export: a stamp taken from
 * the clock would rewrite the payload on every run, and a repeated push would then publish a
 * commit that carries nothing new.
 */
function stampedEntries(entries: StoredRuntimeEntry[], machine: MnemonMachineIdentity | undefined): StoredRuntimeEntry[] {
  if (machine === undefined) return entries
  return entries.map(entry => parseEntryOrigin(entry.origin) === undefined
    ? { ...entry, origin: { machine: machine.id, label: machine.label, at: entry.updated_at } }
    : entry)
}

/**
 * What one merge did to the runtime entries, stated as counts rather than as a file:
 * a page that reports "added" without this number is guessing, and a merge that drops
 * an entry because a tombstone hides it has to be able to say how many it dropped.
 */
type RuntimeMergeReport = MnemonRuntimeMergeReport

/**
 * Fold one Pack's runtime entries into this data directory.
 *
 * `tombstones` is the removal ledger of the other side, and only the sync channel has one:
 * a ZIP carries none, and a merge without a ledger adds what is missing and removes nothing.
 * That is the safe-import rule — an archive a person opens by hand must never delete a memory.
 *
 * With a ledger, a tombstone is this machine's own record that it deleted an entry, and it
 * normally wins over the branch: without that rule a deleted memory would come back on every
 * merge. `revive` is the one case where the reader says the deletion was wrong: the branch's
 * copy is written again, and the tombstone is dropped so the next merge keeps agreeing with
 * the branch instead of hiding the entry a second time.
 */
function mergeRuntime(root: string, pack: ParsedPack, runtimeLimits: RuntimeMemoryLimits, options: { revive?: boolean; tombstones?: MnemonTombstoneFile } = {}): { runtime: RuntimeFile; report: RuntimeMergeReport; revived: MnemonTombstone[]; archived: RuntimeMemoryEntry[] } {
  const current = readCurrentRuntime(root, runtimeLimits)
  const incoming = parseRuntime(json(pack.files[RUNTIME_MEMORIES_PATH]!, RUNTIME_MEMORIES_PATH), runtimeLimits)
  const tombstones = options.tombstones === undefined ? undefined : mergeTombstoneFiles(readCurrentTombstones(root), options.tombstones).tombstones
  const entries = tombstones === undefined ? [...current.entries] : current.entries.filter(entry => !tombstones.some(tombstone => tombstoneCovers(tombstone, entry)))
  // What is present is what survives this machine's own deletions. Keying the merge off the
  // stored file instead would count a deleted entry as already here, so reviving it would
  // report nothing added while the tombstone kept it hidden — an add that adds nothing.
  const keys = new Set(entries.map(entryKey))
  const report: RuntimeMergeReport = { added: 0, held: 0 }
  const incomingKeys = new Set<string>()
  const revived: MnemonTombstone[] = []
  for (const entry of incoming.entries) {
    const key = entryKey(entry)
    const hidden = tombstones === undefined ? [] : tombstones.filter(tombstone => tombstoneCovers(tombstone, entry))
    if (hidden.length > 0) {
      if (options.revive !== true) { report.held += 1; continue }
      // The reader overrules their own deletion: the entry comes back and the
      // tombstones that hid it go, or the next merge would hide it again.
      for (const tombstone of hidden) if (!revived.includes(tombstone)) revived.push(tombstone)
    }
    if (keys.has(key)) {
      const existing = entries.find(candidate => entryKey(candidate) === key)!
      if (entry.pinned !== undefined && (existing.pinned === undefined || entry.updated_at > existing.updated_at)) {
        existing.pinned = entry.pinned
        if (entry.updated_at > existing.updated_at) existing.updated_at = entry.updated_at
      }
      continue
    }
    keys.add(key)
    entries.push(entry)
    incomingKeys.add(key)
  }
  const fitted = fitMergedRuntime(entries, runtimeLimits)
  report.added = fitted.entries.filter(entry => incomingKeys.has(entryKey(entry))).length
  return {
    runtime: parseRuntime({ version: 1, entries: fitted.entries }, runtimeLimits),
    archived: fitted.archived,
    report,
    revived: mergeTombstoneFiles({ version: 1, tombstones: revived }, { version: 1, tombstones: [] }).tombstones,
  }
}

/** Tombstones only ever grow: the newest deletion of one entry wins, and neither side forgets one. */
function mergeTombstoneFiles(current: MnemonTombstoneFile, incoming: MnemonTombstoneFile): MnemonTombstoneFile {
  const byKey = new Map<string, MnemonTombstone>()
  for (const tombstone of [...current.tombstones, ...incoming.tombstones]) {
    const key = tombstoneKey(tombstone)
    const existing = byKey.get(key)
    if (existing === undefined || tombstone.deletedAt > existing.deletedAt) byKey.set(key, tombstone)
  }
  return { version: 1, tombstones: [...byKey.values()].sort((left, right) => left.deletedAt < right.deletedAt ? -1 : left.deletedAt > right.deletedAt ? 1 : 0) }
}

/**
 * One document's version as a sync agrees on it: every field but the time it was last read,
 * which a read moves without changing the document. A title, an archive or a link is as much
 * a part of it as the text.
 */
export function documentVersion(document: DocumentRecord): string {
  const { lastAccessedAt: _read, ...fields } = document
  return sha256(canonicalJson(fields))
}

/** JSON with every object's keys in order and unset ones left out, so the same record always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>
    return `{${Object.keys(fields).filter(key => fields[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Whether two records say the same thing to a reader: the text, the title, the description and the archive. */
function sameDocument(left: DocumentRecord, right: DocumentRecord): boolean {
  return left.contentHash === right.contentHash && left.title === right.title && left.description === right.description
    && left.status === right.status && (left.archiveSummary ?? '') === (right.archiveSummary ?? '')
}

/** Each document's version in one payload, by id, or nothing when the payload holds no valid Documents index. */
export function documentVersions(files: Readonly<Record<string, Uint8Array>>): Record<string, string> | undefined {
  const bytes = files[DOCUMENTS_INDEX_PATH]
  if (bytes === undefined) return undefined
  try {
    return Object.fromEntries(parseDocumentIndex(json(bytes, DOCUMENTS_INDEX_PATH)).documents.map(document => [document.id, documentVersion(document)]))
  } catch {
    return undefined
  }
}

/**
 * `base` is each document's version as this machine and the branch last agreed on it, which
 * only a sync channel knows, and it decides only for a document both hold. One the branch did
 * not change since then keeps this machine's version, edited or not. One only the branch
 * changed is the newer version of the same document and replaces the one here, unless its
 * revision is lower than this machine's, as an older dsh-mnemon can publish; that one is kept
 * beside it, as a merge without `base` keeps every document whose text differs.
 */
function mergeDocuments(root: string, pack: ParsedPack, base?: Readonly<Record<string, string>>): { index: DocumentIndex; files: Map<string, Uint8Array> } {
  const current = readCurrentDocuments(root)
  const incoming = archiveDocuments(pack)
  const ids = new Map(current.index.documents.map(document => [document.id, document]))
  const add = (document: DocumentRecord, bytes: Uint8Array): void => {
    current.index.documents.push(document)
    current.files.set(document.id, bytes)
    ids.set(document.id, document)
  }
  // A divergent document is kept beside the local one under a new id.
  const copy = (source: DocumentRecord): void => {
    const remapped = remapDocument(source, incoming.files.get(source.id)!, randomUUID())
    add(remapped.document, remapped.bytes)
  }
  for (const source of incoming.index.documents) {
    const existing = ids.get(source.id)
    const recorded = existing !== undefined && base !== undefined && Object.hasOwn(base, source.id) ? base[source.id] : undefined
    // A version this machine agreed on is one it held, so it is never above this machine's own
    // revision: one that is was never held here, and the merge goes on as without an agreement.
    const agreed = recorded !== undefined && documentVersion(source) === recorded && source.revision > existing!.revision ? undefined : recorded
    if (existing !== undefined && agreed !== undefined) {
      if (documentVersion(source) === agreed) continue
      const at = current.index.documents.indexOf(existing)
      if (documentVersion(existing) !== agreed) {
        // Both sides changed it. This machine's version keeps the id, at a revision above both, so
        // the other machine takes it as the newer one; the branch's version is kept beside it once,
        // even when only its title, description or archive differs.
        const kept = { ...existing, revision: Math.max(existing.revision, source.revision) + 1 }
        current.index.documents[at] = kept
        ids.set(source.id, kept)
        if (!current.index.documents.some(document => sameDocument(document, source))) copy(source)
        continue
      }
      if (source.revision >= existing.revision) {
        current.index.documents[at] = source
        current.files.set(source.id, incoming.files.get(source.id)!)
        ids.set(source.id, source)
        continue
      }
    }
    if (existing !== undefined && existing.contentHash === source.contentHash) continue
    // Merging the same pack again, as a retried sync does, finds that copy and does not make a second one.
    if (existing !== undefined && current.index.documents.some(document => document.contentHash === source.contentHash)) continue
    if (existing !== undefined) copy(source)
    else add(source, incoming.files.get(source.id)!)
  }
  const activeBytes = current.index.documents.filter(document => document.status === 'active').reduce((sum, document) => sum + document.sizeBytes, 0)
  if (activeBytes > DOCUMENTS_ACTIVE_LIMIT_BYTES) throw new Error(`merged Documents exceed the ${DOCUMENTS_ACTIVE_LIMIT_BYTES} byte active limit`)
  return current
}

/** Stable across repeated imports, bounded by the registry contract, and distinguishable in the UI. */
function conflictSpaceName(source: MemorySpaceRegistryEntry): string {
  const suffix = ` (import conflict ${createHash('sha256').update(source.id).digest('hex').slice(0, 8)})`
  return source.name.slice(0, MEMORY_SPACE_NAME_MAX_LENGTH - suffix.length) + suffix
}

function mergeRegistry(root: string, pack: ParsedPack): { registry: MemorySpaceRegistryFile; databases: Map<string, Uint8Array> } {
  const current = readCurrentRegistry(root)
  const incoming = archiveRegistry(pack)
  const ids = new Set(current.registry.bodies.map(body => body.id))
  // Spaces are compared by what they hold, not by their bytes: reading a space rewrites
  // its read counters, so the same space never has the same bytes on two machines (#370).
  const identity = new MemorySpaceIdentity(root)
  try {
    const covers = (outer: Uint8Array, inner: Uint8Array): boolean => identity.of(outer) === identity.of(inner) || identity.contains(outer, inner)
    // Whether a space held here that `accept` admits already holds every memory of `database`.
    const held = (database: Uint8Array, accept: (body: MemorySpaceRegistryEntry) => boolean): boolean =>
      current.registry.bodies.some(body => accept(body) && covers(current.databases.get(body.id)!, database))
    const add = (body: MemorySpaceRegistryEntry, database: Uint8Array): void => {
      ids.add(body.id)
      current.registry.bodies.push(body)
      current.databases.set(body.id, database)
    }
    for (const source of incoming.registry.bodies) {
      const sourceDb = incoming.databases.get(source.id)!
      if (ids.has(source.id)) {
        const localDb = current.databases.get(source.id)!
        // Read on both machines, or an older version of this machine's: nothing new arrives,
        // and this machine's copy stays, read counts included.
        if (covers(localDb, sourceDb)) continue
        // The memories only the other machine holds join this machine's, which keeps its own rows,
        // read counts and log: one space holding both, whichever side gained them.
        const merged = identity.merge(localDb, sourceDb)
        if (merged !== undefined) {
          current.databases.set(source.id, merged)
          continue
        }
        // A memory edited or forgotten on one side: the other version stays beside this one as a
        // copy, once. A space here already holding it, whatever its name, takes its place, and a
        // conflict copy it only added to moves on with it. Also recognize older same-name copies.
        if (held(sourceDb, body => body.id !== source.id)) continue
        const copy = current.registry.bodies.find(body => body.id !== source.id && (body.name === conflictSpaceName(source) || body.name === source.name)
          && identity.contains(sourceDb, current.databases.get(body.id)!))
        const advanced = copy === undefined ? undefined : identity.merge(current.databases.get(copy.id)!, sourceDb)
        if (copy !== undefined && advanced !== undefined) {
          current.databases.set(copy.id, advanced)
          continue
        }
        add({ ...source, id: randomUUID(), name: conflictSpaceName(source), active: false, updatedAt: new Date().toISOString() }, sourceDb)
      } else if (!held(sourceDb, body => body.name === source.name)) {
        // A space new here, unless one of the same name already holds every memory in it:
        // a copy an older version made, or the other machine's copy of a divergent space.
        add(source, sourceDb)
      }
    }
    return current
  } finally {
    identity.dispose()
  }
}

function persistedStore(root: string): string {
  try {
    const value = readFileSync(join(root, MNEMON_ACTIVE_STORE_FILE), 'utf8').trim()
    if (MEMORY_SPACE_ID_PATTERN.test(value)) return value
  } catch {}
  return 'default'
}

function reconcilePersistedStore(root: string): void {
  const current = readCurrentRegistry(root).registry.bodies
  const ids = new Set(current.map(body => body.id))
  const selected = persistedStore(root)
  if (ids.has(selected)) return
  const replacement = ids.has('default')
    ? 'default'
    : current.filter(body => body.active).map(body => body.id).sort()[0] ?? [...ids].sort()[0] ?? 'default'
  const temporary = join(root, `.active-${process.pid}-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${replacement}\n`, { mode: 0o600 })
    renameSync(temporary, join(root, MNEMON_ACTIVE_STORE_FILE))
  } finally {
    rmSync(temporary, { force: true })
  }
}

function stageImport(root: string, pack: ParsedPack, components: MnemonPackComponent[], mode: MnemonPackImportMode, runtimeLimits: RuntimeMemoryLimits, options: { revive?: boolean; tombstones?: MnemonTombstoneFile; documentsBase?: Readonly<Record<string, string>> } = {}): { staging: string; report: RuntimeMergeReport | undefined; revived: MnemonTombstone[] } {
  const staging = join(root, `.dsh-pack-stage-${randomUUID()}`)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    let report: RuntimeMergeReport | undefined
    let revived: MnemonTombstone[] = []
    if (components.includes('runtime')) {
      const merged = mode === 'merge' ? mergeRuntime(root, pack, runtimeLimits, options) : undefined
      const runtime = merged === undefined ? parseRuntime(json(pack.files[RUNTIME_MEMORIES_PATH]!, RUNTIME_MEMORIES_PATH), runtimeLimits) : merged.runtime
      writeRuntime(join(staging, RUNTIME_DIRECTORY), runtime)
      // A ZIP carries no removal ledger, and a safe import must not touch the one this
      // machine keeps: without a ledger there is nothing to write and nothing to swap.
      if (options.tombstones !== undefined) {
        const tombstones = mergeTombstoneFiles(readCurrentTombstones(root), options.tombstones)
        if (merged === undefined) {
          writeTombstones(join(staging, 'state'), tombstones)
        } else {
          report = merged.report
          revived = merged.revived
          // A revived entry stays revived only if the tombstones that hid it are gone
          // from the state this import commits, so they are dropped here rather than
          // after the commit has already put them back.
          const dropped = new Set(revived.map(tombstoneKey))
          writeTombstones(join(staging, 'state'), dropped.size === 0 ? tombstones : { version: 1, tombstones: tombstones.tombstones.filter(tombstone => !dropped.has(tombstoneKey(tombstone))) })
        }
      } else if (merged !== undefined) {
        report = merged.report
        revived = merged.revived
      }
      keepRuntimeArchive(root, join(staging, RUNTIME_DIRECTORY))
      if (merged !== undefined && merged.archived.length > 0) {
        const archived = archiveRuntimeOverflow(join(staging, RUNTIME_DIRECTORY), merged.archived)
        if (archived > 0) merged.report.archived = archived
        // Archival is not a user deletion. Remove only these keys from the previous
        // export index in the same transaction, preserving any real pending deletions.
        const archivedKeys = new Set(merged.archived.map(entry => `${entry.target}\0${tombstoneHash(entry)}`))
        writeRuntimeIndex(join(staging, 'state'), { version: 1, entries: readRuntimeIndex(root).entries.filter(entry => !archivedKeys.has(`${entry.target}\0${entry.contentHash}`)) })
      }
    }
    if (components.includes('documents')) {
      const documents = mode === 'merge' ? mergeDocuments(root, pack, options.documentsBase) : archiveDocuments(pack)
      writeDocuments(join(staging, DOCUMENTS_DIRECTORY), documents.index, documents.files)
    }
    if (components.includes('memory-spaces')) {
      const memory = mode === 'merge' ? mergeRegistry(root, pack) : archiveRegistry(pack)
      if (mode === 'replace' && readCurrentRegistry(root).registry.bodies.length > 0 && memory.registry.bodies.length === 0) {
        throw new Error('cannot replace the last Mnemon Store with an empty Memory Space set')
      }
      writeRegistry(join(staging, MEMORY_SPACES_DIRECTORY), memory.registry, memory.databases)
    }
    return { staging, report, revived }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

function commitStaging(root: string, staging: string, components: MnemonPackComponent[]): void {
  const backup = join(root, `.dsh-pack-backup-${randomUUID()}`)
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  const committed: Array<{ directory: string; hadPrevious: boolean }> = []
  // The Sources' locks are written into the staged directories, so the directories that replace
  // the current ones arrive already locked and no Source writes between the swap and the release.
  const replacementLocks = sourceLocks(staging, components).map(lock => lock.path)
  const activePath = join(root, MNEMON_ACTIVE_STORE_FILE)
  const previousActive = existsSync(activePath) ? readFileSync(activePath) : undefined
  const stateSwaps: Array<{ file: string; hadPrevious: boolean }> = []
  try {
    for (const lock of replacementLocks) writeFileSync(lock, 'pack-import\n', { mode: 0o600 })
    for (const component of components) {
      const directory = COMPONENT_DIRECTORIES[component]
      const target = join(root, directory)
      const previous = join(backup, directory)
      const hadPrevious = existsSync(target)
      if (hadPrevious) renameSync(target, previous)
      try {
        renameSync(join(staging, directory), target)
      } catch (error) {
        if (hadPrevious) renameSync(previous, target)
        throw error
      }
      committed.push({ directory, hadPrevious })
    }
    // Only staged machine-local records participate; unrelated state is preserved.
    for (const file of [STATE_TOMBSTONE_FILE, STATE_RUNTIME_INDEX_FILE]) {
      if (!components.includes('runtime') || !existsSync(join(staging, 'state', file))) continue
      const directory = join(root, 'state')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const target = join(directory, file)
      const previous = join(backup, file)
      const hadPrevious = existsSync(target)
      if (hadPrevious) renameSync(target, previous)
      // Record the move before installing the replacement, so even that rename can roll back.
      stateSwaps.push({ file, hadPrevious })
      renameSync(join(staging, 'state', file), target)
    }
    if (components.includes('memory-spaces')) reconcilePersistedStore(root)
    for (const lock of sourceLocks(root, components)) rmSync(lock.path, { force: true })
  } catch (error) {
    for (const entry of committed.reverse()) {
      const target = join(root, entry.directory)
      rmSync(target, { recursive: true, force: true })
      if (entry.hadPrevious) renameSync(join(backup, entry.directory), target)
    }
    for (const entry of stateSwaps.reverse()) {
      const target = join(root, 'state', entry.file)
      rmSync(target, { force: true })
      if (entry.hadPrevious) renameSync(join(backup, entry.file), target)
    }
    if (components.includes('memory-spaces')) {
      if (previousActive === undefined) rmSync(activePath, { force: true })
      else writeFileSync(activePath, previousActive, { mode: 0o600 })
    }
    throw error
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(backup, { recursive: true, force: true })
  }
}

function occupied(root: string, component: MnemonPackComponent): boolean {
  const directory = join(root, COMPONENT_DIRECTORIES[component])
  if (!existsSync(directory)) return false
  try { return readdirSync(directory).some(name => !name.startsWith('.')) } catch { return true }
}

function safeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const name = basename(value.trim()).replace(/[^a-zA-Z0-9._-]+/gu, '-')
  return name === '' ? undefined : name.slice(0, 160)
}

/** Native, checksummed import/export for the one currently effective Mnemon root. */
export class MnemonPackManager {
  private readonly root: string
  private readonly runtimeLimits: RuntimeMemoryLimits
  private readonly machine: MnemonMachineStore

  constructor(
    private readonly runner: StorageRoot,
    private readonly config: Pick<ResolvedConfig, 'storageScope' | 'runtimeMemory'>,
    private readonly afterImport: (components: MnemonPackComponent[]) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(runner.effectiveDataDir())
    this.machine = new MnemonMachineStore(runner)
    this.runtimeLimits = {
      memory: config.runtimeMemory.memoryLimitBytes,
      user: config.runtimeMemory.userLimitBytes,
    }
  }

  /** The identity this machine stamps onto what it publishes to a sync branch. */
  identity(): MnemonMachineIdentity {
    return this.machine.read()
  }

  /**
   * What this data directory deleted, as of its last export.
   *
   * The ZIP path never reads this: a removal record describes how two installations
   * reconcile, so it travels over the sync channel and stays out of the archive.
   */
  tombstones(): MnemonTombstoneFile {
    return readCurrentTombstones(this.root)
  }

  /**
   * Record the entries this data directory held at its last export and no longer holds.
   *
   * An export does this on its way out, which is too late for a channel that merges the
   * branch before it exports: the merge would write back the entry this machine just
   * deleted, and the export that follows would see it present and record no removal at
   * all. Recording the deletions first is what makes the merge honour them.
   */
  async recordDeletions(): Promise<void> {
    return this.runner.withExclusive(async () => {
      await new Promise<void>(resolveReady => setImmediate(resolveReady))
      withLocks(this.root, ['runtime'], () => {
        const runtime = readCurrentRuntime(this.root, this.runtimeLimits)
        advanceTombstones(this.root, runtime.entries, this.identity(), this.now().toISOString())
      })
    })
  }

  target(): MnemonPackTarget {
    return { root: this.root, scope: this.config.storageScope, defaultRoot: resolve(createStorageRoot({ storageScope: 'global' }).effectiveDataDir()) }
  }

  /**
   * `stamp` is what the sync channel asks for and the ZIP path never does: signing entries
   * with the writing machine is what lets a later merge attribute one, and it advances the
   * local deletion ledger because publishing is what makes a removal visible. A backup a
   * person downloads carries neither, so it stays readable by any version that knows the
   * format.
   */
  async exportPack(scope: MnemonPackScope, options: { stamp?: boolean } = {}): Promise<MnemonPackExport> {
    const components = componentsForScope(scope)
    return this.runner.withExclusive(async () => {
      await new Promise<void>(resolveReady => setImmediate(resolveReady))
      return withLocks(this.root, components, () => {
        const exportedAt = this.now().toISOString()
        const payload = collectExport(this.root, components, this.runtimeLimits, options.stamp === true ? { machine: this.identity(), at: exportedAt } : undefined)
        // Publishing is what makes a payload the branch's truth: `pushOnce` imports the branch's
        // own payload before it can publish anything else, so an archive another machine would
        // refuse must never leave this one. The ZIP path stays exempt on purpose: a person backing
        // up a store that needs repair still has to be able to download one.
        if (options.stamp === true) validatePackPayload(payload, components, this.runtimeLimits)
        const summary = summaryFor(components, payload, this.runtimeLimits)
        const manifest: MnemonPackManifest = {
          format: MNEMON_PACK_FORMAT, version: MNEMON_PACK_VERSION, scope, exportedAt,
          source: { plugin: 'dsh-mnemon', pluginVersion: pluginPackageVersion() }, components, summary,
        }
        const checksums: ChecksumFile = { algorithm: 'sha256', files: Object.fromEntries(Object.entries(payload).map(([path, bytes]) => [path, sha256(bytes)])) }
        const entries: Zippable = {
          'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
          'checksums.json': strToU8(`${JSON.stringify(checksums, null, 2)}\n`),
          ...payload,
        }
        // fflate writes ZIP timestamps using local date fields. Pin those fields
        // to keep the archive in range and byte-identical across timezones.
        const archive = zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1) })
        if (archive.length > MNEMON_PACK_MAX_ARCHIVE_BYTES) throw new Error('exported Mnemon Pack exceeds the transport safety limit')
        const stamp = exportedAt.replace(/[:.]/gu, '-').replace('T', '_').replace('Z', '')
        return {
          fileName: `mnemon-backup-${stamp}.zip`, mimeType: MNEMON_PACK_MIME, bytes: archive.length,
          base64: Buffer.from(archive).toString('base64'), targetRoot: this.root, manifest,
        }
      })
    })
  }

  inspectPack(base64: string, fileName?: string): MnemonPackPreview {
    const pack = parseArchive(base64, this.runtimeLimits)
    const sanitizedName = safeName(fileName)
    return {
      ...(sanitizedName === undefined ? {} : { fileName: sanitizedName }),
      archiveBytes: pack.archiveBytes, expandedBytes: pack.expandedBytes, targetRoot: this.root, targetScope: this.config.storageScope,
      manifest: pack.manifest,
      occupied: Object.fromEntries(COMPONENT_ORDER.map(component => [component, occupied(this.root, component)])) as Record<MnemonPackComponent, boolean>,
    }
  }

  /**
   * `documentsBase` is each document's version, by id, as a sync channel last agreed on it with
   * the branch; a merge uses it to tell an older version from a divergent one. A ZIP import has none.
   */
  async importPack(base64: string, options: { mode: MnemonPackImportMode; components?: MnemonPackComponent[]; revive?: boolean; tombstones?: MnemonTombstoneFile; documentsBase?: Readonly<Record<string, string>> }): Promise<MnemonPackImportResult> {
    const pack = parseArchive(base64, this.runtimeLimits)
    if (options.mode !== 'merge' && options.mode !== 'replace') throw new Error('Pack import mode must be merge or replace')
    // The ledger arrives over the sync channel, so it is checked the same way a Pack is: a
    // malformed removal record would otherwise merge silently and hide nothing.
    const tombstones = options.tombstones === undefined ? undefined : parseTombstones(options.tombstones)
    if (options.components !== undefined && (new Set(options.components).size !== options.components.length || options.components.some(component => !COMPONENT_ORDER.includes(component)))) {
      throw new Error('requested import components are invalid')
    }
    const components = options.components === undefined ? pack.manifest.components : COMPONENT_ORDER.filter(component => options.components!.includes(component))
    if (components.length === 0 || components.some(component => !pack.manifest.components.includes(component))) throw new Error('requested import components are not present in this Pack')
    return this.runner.withExclusive(async () => {
      await new Promise<void>(resolveReady => setImmediate(resolveReady))
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      return withLocks(this.root, components, (): MnemonPackImportResult => {
        const staged = stageImport(this.root, pack, components, options.mode, this.runtimeLimits, { ...options, ...(tombstones === undefined ? {} : { tombstones }) })
        commitStaging(this.root, staged.staging, components)
        this.afterImport(components)
        return {
          imported: true, mode: options.mode, targetRoot: this.root, components,
          summary: pack.manifest.summary.filter(summary => components.includes(summary.component)),
          ...(staged.report === undefined ? {} : { runtime: staged.report }),
        }
      })
    })
  }
}
