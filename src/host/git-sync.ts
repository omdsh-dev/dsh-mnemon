import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { removeDisposableDirectory } from './disposable-directory.ts'
import { writeAtomicJsonSync } from './fs-atomic.ts'
import { join, relative, resolve, sep } from 'node:path'
import { zipSync, unzipSync, type Unzipped } from 'fflate'
import type { ResolvedConfig } from './config.ts'
import { runProcess, type ProcessRunner } from './process.ts'
import {
  DOCUMENTS_INDEX_PATH, MnemonPackManager, MNEMON_PACK_MAX_EXPANDED_BYTES, RUNTIME_MEMORIES_PATH,
  documentVersions, entryKey, parseMachineIdentity, parseManifest as parseManifestJson, parseRuntime, parseTombstones,
  payloadPrefix, tombstoneCovers, tombstoneKey,
  type RuntimeFile, type StoredRuntimeEntry,
} from './pack.ts'
import type {
  MnemonPackComponent, MnemonPackImportMode, MnemonPackManifest, MnemonSyncBackup, MnemonSyncBackupList,
  MnemonSyncComponentDelta, MnemonSyncConfigView, MnemonSyncCredentialSource, MnemonSyncDiff, MnemonSyncDiffConflict,
  MnemonSyncDiffEntry,
  MnemonSyncAutoBackup, MnemonSyncCompaction, MnemonSyncFailureReason, MnemonSyncFileDelta, MnemonSyncGitStatus,
  MnemonSyncLastRun, MnemonSyncPreview, MnemonSyncPullResult, MnemonSyncPushResult, MnemonSyncRemoteIssue,
  MnemonMachineIdentity, MnemonSyncRemoteStatus, MnemonSyncStatus, MnemonTombstone,
} from './protocol.ts'
import { RUNTIME_MEMORY_LIMITS, type RuntimeMemoryLimits } from 'dsh-mnemon-source-runtime/contracts'
import { MNEMON_PACK_COMPONENTS, MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL, MNEMON_SYNC_DEFAULT_AUTHOR_NAME, MNEMON_SYNC_TOKEN_ENV } from './protocol.ts'
import { MnemonGitHubAuth } from './github-auth.ts'
import { MnemonSyncError } from './sync-error.ts'
import { MnemonMachineStore, defaultMachineLabel, machineLabel } from './machine-identity.ts'
import type { StorageRoot } from './storage-root.ts'
import { MnemonSyncSettingsStore, type MnemonSyncSettings } from './sync-config.ts'

export { MnemonSyncError }

export const MNEMON_SYNC_MINIMUM_GIT = '2.20'
export const MNEMON_SYNC_GIT_TIMEOUT_MS = 120_000
export const MNEMON_SYNC_STATUS_TIMEOUT_MS = 20_000
const PUSH_ATTEMPTS = 2
const STALE_LOCK_MS = 60 * 60_000
const LOCK_OWNER = 'owner.json'
const OWNERLESS_LOCK_MS = 15 * 60_000
const ORIGIN_KEY = 'mnemon.origin'
const LAST_RUN_FILE = 'last-run.json'
const BASE_FILE = 'base.json'
const AGREED_COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u

const GIT_LABEL = 'git'
const MANIFEST = 'manifest.json'
const CHECKSUMS = 'checksums.json'
const SYNC_EXTENSION = 'sync'
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024
const MAX_FILE_BYTES = 128 * 1024 * 1024
const LOCK_TIMEOUT_MS = 30_000
const MAX_BACKUPS = 100
const DEFAULT_BACKUP_LIMIT = 20
const BACKUP_WALK_LIMIT = 200
const MAX_DIFF_ENTRIES = 200
const SAFE_CHECKOUT_FLAGS = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=false']
const GIT_LOCATION_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_QUARANTINE_PATH',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
])

export function gitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || GIT_LOCATION_ENV.has(name.toUpperCase())) continue
    sanitized[name] = value
  }
  sanitized.GIT_TERMINAL_PROMPT = '0'
  sanitized.GCM_INTERACTIVE = 'never'
  return sanitized
}

function tokenHost(repoUrl: string | undefined): string | undefined {
  if (repoUrl === undefined) return undefined
  try {
    const url = new URL(repoUrl)
    return url.protocol === 'https:' ? url.host.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

export function isGitHubHttps(repoUrl: string): boolean {
  try {
    const url = new URL(repoUrl)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}

const DEFAULT_TOKEN_USER = 'x-access-token'
const TOKEN_USER_BY_HOST: ReadonlyMap<string, string> = new Map([['gitee.com', 'oauth2']])
const GIT_LAST_USERNAME_WINS_VERSION = '2.26'

export function credentialTarget(url: string): { user: string; name: string; named: boolean; host: string; address: string } {
  const [, written, host = '', rest = ''] = /^https:\/\/(?:([^/@]*)@)?([^/]*)(.*)$/u.exec(url) ?? []
  let hostname = ''
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/u, '')
  } catch {
  }
  const user = written ?? TOKEN_USER_BY_HOST.get(hostname) ?? DEFAULT_TOKEN_USER
  let name = user
  try {
    name = decodeURIComponent(user)
  } catch {
  }
  return { user, name, named: written !== undefined, host, address: 'https://' + host + rest }
}

const TIMEOUT_ERROR_PATTERN = /did not respond within|timed out|timeout was reached/u
const AUTH_ERROR_PATTERN = /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied|invalid username or password|bad credentials|returned error: 40[13]|host key verification failed|access denied|denied to /u
const NOT_FOUND_ERROR_PATTERN = /repository not found|not found|does not appear to be a git repository|no such file or directory|does not exist|returned error: 404/u
const NETWORK_ERROR_PATTERN = /could not resolve|failed to connect|couldn't connect|connection (refused|reset|closed|timed out)|network is unreachable|no route to host|unable to access|ssl|tls|proxy|empty reply/u

export function remoteIssueOf(message: string): MnemonSyncRemoteIssue {
  const text = message.toLowerCase()
  if (TIMEOUT_ERROR_PATTERN.test(text)) return 'timeout'
  if (AUTH_ERROR_PATTERN.test(text)) return 'auth'
  if (NOT_FOUND_ERROR_PATTERN.test(text)) return 'not-found'
  if (NETWORK_ERROR_PATTERN.test(text)) return 'network'
  return 'unknown'
}

const REMOTE_FAILURE: Record<MnemonSyncRemoteIssue, MnemonSyncFailureReason | undefined> = {
  auth: 'remote-auth',
  'not-found': 'remote-not-found',
  network: 'remote-network',
  timeout: 'remote-timeout',
  unknown: undefined,
}

function remoteFailure(message: string): Error {
  const reason = REMOTE_FAILURE[remoteIssueOf(message)]
  return reason === undefined ? new Error(message) : new MnemonSyncError(reason, message)
}

function rejectedPush(output: string): boolean {
  return /\[rejected\]|fetch first|non-fast-forward/iu.test(output)
}

interface GitOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
  env?: NodeJS.ProcessEnv | undefined
  token?: string | undefined
  authenticated?: boolean | undefined
  maxOutputBytes?: number | undefined
  timeoutMs?: number | undefined
}

interface MnemonSyncRemoteExtension {
  channel: 'git'
  branch: string
  subdir: string
  pushedAt: string
  machine?: MnemonMachineIdentity
  tombstones?: MnemonTombstone[]
}

interface SyncCredential {
  source: MnemonSyncCredentialSource
  token?: string
  login?: string
}

interface RemotePayload {
  commit: string
  manifest: MnemonPackManifest
  pushedAt?: string
  machine?: MnemonMachineIdentity
  tombstones: MnemonTombstone[]
  files: Record<string, Uint8Array>
  archive: Uint8Array
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function tail(output: string): string {
  const text = output.trim().replace(/\s+/gu, ' ')
  return text.length > 300 ? '...' + text.slice(-300) : text
}

function versionAtLeast(version: string, minimum: string): boolean {
  const left = version.split('.').map(part => Number.parseInt(part, 10) || 0)
  const right = minimum.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

function gitBoolean(value: string): boolean {
  const text = value.trim().toLowerCase()
  return text === 'true' || text === 'yes' || text === 'on' || (/^[-+]?\d+$/u.test(text) && Number(text) !== 0)
}

function extensionTombstones(extension: Record<string, unknown> | undefined): MnemonTombstone[] {
  if (extension?.tombstones === undefined) return []
  try {
    return parseTombstones({ version: 1, tombstones: extension.tombstones }).tombstones
  } catch {
    return []
  }
}

function extensionMachine(extension: Record<string, unknown> | undefined): MnemonMachineIdentity | undefined {
  try {
    return parseMachineIdentity(extension?.machine)
  } catch {
    return undefined
  }
}

function componentChanged(before: Record<string, Uint8Array>, after: Record<string, Uint8Array>, component: MnemonPackComponent): boolean {
  const prefix = payloadPrefix(component)
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!path.startsWith(prefix)) continue
    const published = before[path]
    const mine = after[path]
    if (published === undefined || mine === undefined || sha256Hex(published) !== sha256Hex(mine)) return true
  }
  return false
}

const TIMESTAMP_FIELDS = new Set(['exportedAt', 'pushedAt'])

function withoutTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimestamps)
  const parsed = record(value)
  if (parsed === undefined) return value
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([key]) => !TIMESTAMP_FIELDS.has(key))
      .map(([key, item]) => [key, withoutTimestamps(item)]),
  )
}

function manifestIdentity(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
  return record(value) === undefined ? undefined : JSON.stringify(withoutTimestamps(value))
}

function holdsPayload(published: Record<string, Uint8Array>, entries: Unzipped): boolean {
  const identity = manifestIdentity(entries[MANIFEST])
  if (identity === undefined || manifestIdentity(published[MANIFEST]) !== identity) return false
  for (const path of new Set([...Object.keys(published), ...Object.keys(entries)])) {
    if (path === MANIFEST) continue
    const remote = published[path]
    const mine = entries[path]
    if (remote === undefined || mine === undefined || sha256Hex(remote) !== sha256Hex(mine)) return false
  }
  return true
}

function commitMessage(value: unknown, at: Date): string {
  const raw = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (raw === '') return 'Mnemon sync ' + at.toISOString().replace(/\.\d{3}Z$/u, 'Z')
  return raw.length > 200 ? raw.slice(0, 200) : raw
}

function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 120)
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function emptyRuntime(): RuntimeFile {
  return { version: 1, entries: [] }
}

function showText(stdout: string): Uint8Array {
  return new TextEncoder().encode(stdout)
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error(label + ' is not valid JSON')
  }
}

interface ObjectCount {
  loose: number
  bytes: number
  packed: number
  packedBytes: number
}

function objectCount(output: string): ObjectCount | undefined {
  const loose = /^count:\s*(\d+)$/mu.exec(output)
  const bytes = /^size:\s*(\d+)$/mu.exec(output)
  const packed = /^in-pack:\s*(\d+)$/mu.exec(output)
  const packedBytes = /^size-pack:\s*(\d+)$/mu.exec(output)
  if (loose === null || bytes === null || packed === null || packedBytes === null) return undefined
  return { loose: Number(loose[1]), bytes: Number(bytes[1]) * 1024, packed: Number(packed[1]), packedBytes: Number(packedBytes[1]) * 1024 }
}

function backupLimit(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_BACKUP_LIMIT
  return Math.min(Math.max(requested, 1), MAX_BACKUPS)
}

interface CommitRow {
  commit: string
  committedAt: string
  message: string
}

function diffEntry(entry: StoredRuntimeEntry): MnemonSyncDiffEntry {
  return {
    target: entry.target,
    content: entry.content,
    importance: entry.importance,
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
  }
}

const CONFLICT_SIMILARITY = 0.6
const MAX_DIFF_CONFLICTS = 40

function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function bigramsOf(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 0; index + 1 < value.length; index += 1) {
    const gram = value.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

function similarityOf(left: string, right: string): number {
  const first = normalizeForSimilarity(left)
  const second = normalizeForSimilarity(right)
  if (first === second) return 1
  if (first.length < 2 || second.length < 2) return 0
  const mine = bigramsOf(first)
  const theirs = bigramsOf(second)
  let mineSize = 0
  let theirsSize = 0
  let overlap = 0
  for (const count of mine.values()) mineSize += count
  for (const count of theirs.values()) theirsSize += count
  for (const [gram, count] of mine) overlap += Math.min(count, theirs.get(gram) ?? 0)
  return (2 * overlap) / (mineSize + theirsSize)
}

function conflictsOf(local: readonly MnemonSyncDiffEntry[], remote: readonly MnemonSyncDiffEntry[]): MnemonSyncDiffConflict[] {
  const conflicts: MnemonSyncDiffConflict[] = []
  for (const mine of local) {
    let best: { entry: MnemonSyncDiffEntry; similarity: number } | undefined
    for (const theirs of remote) {
      if (theirs.target !== mine.target) continue
      const similarity = similarityOf(mine.content, theirs.content)
      if (similarity < CONFLICT_SIMILARITY) continue
      if (best === undefined || similarity > best.similarity) best = { entry: theirs, similarity }
    }
    if (best !== undefined) conflicts.push({ target: mine.target, local: mine, remote: best.entry, similarity: best.similarity })
  }
  return conflicts
}

function runtimeOf(files: Record<string, Uint8Array>, limits: RuntimeMemoryLimits, label: string): RuntimeFile {
  const bytes = files[RUNTIME_MEMORIES_PATH]
  if (bytes === undefined) return emptyRuntime()
  try {
    return parseRuntime(parseJson(bytes, label + ' runtime memories.json'), limits)
  } catch (error) {
    throw new Error(label + ' runtime memories.json is invalid: ' + (error instanceof Error ? error.message : String(error)))
  }
}

function unappliedRemovals(
  local: Record<string, Uint8Array>,
  mine: MnemonTombstone[],
  theirs: MnemonTombstone[],
): MnemonTombstone[] {
  const held = new Set(mine.map(tombstoneKey))
  const entries = runtimeOf(local, RUNTIME_MEMORY_LIMITS, 'the local').entries
  return theirs.filter(tombstone =>
    !held.has(tombstoneKey(tombstone)) && entries.some(entry => tombstoneCovers(tombstone, entry)),
  )
}

function readFiles(root: string, limit = MAX_PAYLOAD_BYTES): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  let total = 0
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), path)
        continue
      }
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('the Mnemon payload holds a non-file entry: ' + path)
      const bytes = readFileSync(join(directory, entry.name))
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('the Mnemon payload holds an oversized file: ' + path)
      total += bytes.byteLength
      if (total > limit) throw new Error('the Mnemon payload exceeds the expanded safety limit')
      files[path] = bytes
    }
  }
  if (existsSync(root)) walk(root, '')
  return files
}

export function unpack(archive: Uint8Array): Unzipped {
  let entries: Unzipped
  try {
    if (archive.byteLength > MNEMON_PACK_MAX_EXPANDED_BYTES) throw new Error('compressed archive exceeds safety limit')
    let expandedBytes = 0
    let fileCount = 0
    entries = unzipSync(archive, { filter(info) {
      const path = info.name
      const normalized = path.endsWith('/') ? path.slice(0, -1) : path
      if (path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\0')
        || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('unsafe archive path')
      }
      if (path.endsWith('/')) return false
      if (info.compression === 0 && info.size !== info.originalSize) throw new Error('invalid stored archive entry size')
      expandedBytes += info.originalSize
      fileCount += 1
      if (!Number.isSafeInteger(info.originalSize) || info.originalSize < 0 || info.originalSize > 128 * 1024 * 1024
        || expandedBytes > MNEMON_PACK_MAX_EXPANDED_BYTES || fileCount > 4096) throw new Error('expanded archive exceeds safety limit')
      return true
    } })
  } catch {
    throw new Error('the Mnemon payload is not a readable archive')
  }
  let total = 0
  for (const [path, bytes] of Object.entries(entries)) {
    total += bytes.byteLength
    if (total > MNEMON_PACK_MAX_EXPANDED_BYTES) throw new Error('the Mnemon payload exceeds the expanded safety limit')
    if (path.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..')) {
      throw new Error('the Mnemon payload holds an unsafe entry path: ' + JSON.stringify(path))
    }
  }
  return entries
}

export class MnemonGitSync {
  private readonly root: string
  private readonly store: MnemonSyncSettingsStore
  private readonly machine: MnemonMachineStore
  private sequence = 0
  private gitVersion: string | undefined
  private auth: MnemonGitHubAuth | undefined
  private autoBackupView: (() => MnemonSyncAutoBackup | undefined) | undefined

  constructor(
    runner: StorageRoot,
    private readonly config: Pick<ResolvedConfig, 'storageScope' | 'runtimeMemory' | 'syncEnabled'>,
    private readonly packs: MnemonPackManager,
    private readonly run: ProcessRunner = runProcess,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(runner.effectiveDataDir())
    this.store = new MnemonSyncSettingsStore(runner)
    this.machine = new MnemonMachineStore(runner)
  }

  settings(): MnemonSyncSettingsStore {
    return this.store
  }

  useGitHubAuth(auth: MnemonGitHubAuth | undefined): void {
    this.auth = auth
  }

  github(): MnemonGitHubAuth | undefined {
    return this.auth
  }

  useAutoBackup(view: (() => MnemonSyncAutoBackup | undefined) | undefined): void {
    this.autoBackupView = view
  }

  private async credential(settings: MnemonSyncSettings): Promise<SyncCredential> {
    const token = this.store.token(settings)
    if (token !== undefined && token !== '') {
      return { source: (process.env[MNEMON_SYNC_TOKEN_ENV]?.trim() ?? '') === '' ? 'token' : 'environment', token }
    }
    const grant = await this.auth?.grant()
    if (grant === undefined) return { source: 'none' }
    if (settings.repoUrl !== undefined && !isGitHubHttps(settings.repoUrl)) return { source: 'none' }
    return { source: 'github', token: grant.accessToken, ...(grant.login === undefined ? {} : { login: grant.login }) }
  }

  private async credentialView(settings: MnemonSyncSettings): Promise<MnemonSyncConfigView> {
    const credential = await this.credential(settings)
    return {
      ...this.store.view(settings, this.config.syncEnabled),
      hasToken: credential.token !== undefined,
      credentialSource: credential.source,
      ...(credential.login === undefined ? {} : { credentialLogin: credential.login }),
    }
  }

  async status(signal?: AbortSignal): Promise<MnemonSyncStatus> {
    const settings = this.store.read()
    const repoUrl = settings.repoUrl
    if (!this.config.syncEnabled) {
      return {
        enabled: false,
        configured: repoUrl !== undefined,
        config: await this.credentialView(settings),
        configPath: this.store.path(),
        mirrorPath: this.store.mirror(),
        git: { available: false, required: MNEMON_SYNC_MINIMUM_GIT },
        remote: { reachable: false, branchExists: false },
      }
    }
    const git = await this.gitStatus(signal)
    const remote = repoUrl === undefined
      ? { reachable: false, branchExists: false }
      : git.available
        ? await this.remoteStatus({ ...settings, repoUrl }, signal)
        : { reachable: false, branchExists: false, error: git.issue ?? 'Git is not available on this Host' }
    const commit = existsSync(this.store.mirror()) && git.available ? await this.lastCommit(signal) : undefined
    const autoBackup = this.autoBackupView?.()
    const lastRun = repoUrl === undefined ? undefined : this.lastRun()
    const machine = this.machine.current()
    return {
      enabled: true,
      configured: repoUrl !== undefined,
      config: await this.credentialView(settings),
      configPath: this.store.path(),
      mirrorPath: this.store.mirror(),
      git,
      remote,
      machine: machine.identity,
      machineLabel: { source: machine.source, hostname: defaultMachineLabel() },
      ...(commit === undefined ? {} : { lastCommit: commit }),
      ...(lastRun === undefined ? {} : { lastRun }),
      ...(autoBackup === undefined ? {} : { autoBackup }),
    }
  }

  async configure(patch: unknown): Promise<MnemonSyncConfigView> {
    const fields = record(patch)
    const { machineLabel: name, ...settings }: Record<string, unknown> = fields ?? {}
    const naming = fields !== undefined && 'machineLabel' in fields
    if (naming && name !== null && name !== '') machineLabel(name)
    this.store.patch(fields === undefined ? patch : settings)
    const next = await this.lock(() => {
      const previous = this.store.read()
      const updated = this.store.patch(fields === undefined ? patch : settings)
      if (updated.token !== undefined && previous.repoUrl !== undefined && fields !== undefined && !('token' in fields)
        && tokenHost(previous.repoUrl) !== tokenHost(updated.repoUrl)) delete updated.token
      this.store.write(updated)
      if (naming) this.machine.rename(name)
      if (previous.repoUrl !== updated.repoUrl || previous.branch !== updated.branch || previous.subdir !== updated.subdir) rmSync(this.lastRunPath(), { force: true })
      return updated
    })
    return this.credentialView(next)
  }

  async push(input: { message?: unknown; signal?: AbortSignal } = {}): Promise<MnemonSyncPushResult> {
    this.requireRepository()
    await this.requireGit(input.signal)
    const message = commitMessage(input.message, this.now())
    return this.lock(async () => {
      const settings = this.requireRepository()
      let result = await this.pushOnce(settings, message, input.signal)
      let added = result.merged?.runtime?.added ?? 0
      let held = result.merged?.runtime?.held ?? 0
      let archived = result.merged?.runtime?.archived ?? 0
      for (let attempt = 1; attempt < PUSH_ATTEMPTS && result.failure === 'push-rejected'; attempt += 1) {
        result = await this.pushOnce(settings, message, input.signal)
        added += result.merged?.runtime?.added ?? 0
        held = result.merged?.runtime?.held ?? held
        archived += result.merged?.runtime?.archived ?? 0
      }
      if (result.merged !== undefined && (added > 0 || result.merged.runtime !== undefined)) {
        result = { ...result, merged: { ...result.merged, runtime: { added, held, ...(archived > 0 ? { archived } : {}) } } }
      }
      if (result.pushed || !result.committed) {
        this.recordRun({
          kind: 'sync', commit: result.commit, pushed: result.pushed,
          ...(result.merged?.runtime === undefined ? {} : { added: result.merged.runtime.added }),
        })
      }
      return result
    })
  }

  private async pushOnce(settings: MnemonSyncSettings & { repoUrl: string }, message: string, signal?: AbortSignal): Promise<MnemonSyncPushResult> {
    const prepared = await this.ensureMirror(settings, signal)
    await this.packs.recordDeletions()
    const remote = await this.readPrepared(settings, prepared)
    let merged: MnemonSyncPushResult['merged']
    if (remote !== undefined) {
      const base = await this.agreedDocuments(settings, remote.commit, signal)
      const imported = await this.packs.importPack(
        Buffer.from(remote.archive).toString('base64'),
        { mode: 'merge', tombstones: { version: 1, tombstones: remote.tombstones }, ...(base === undefined ? {} : { documentsBase: base }) },
      )
      if (imported.components.includes('documents')) this.agree(settings, remote.files, remote.commit)
      merged = {
        commit: remote.commit,
        ...(remote.machine === undefined ? {} : { machine: { id: remote.machine.id, label: remote.machine.label } }),
        components: imported.components, summary: imported.summary,
        tombstones: remote.tombstones.length,
        ...(imported.runtime === undefined ? {} : { runtime: imported.runtime }),
      }
    }
    const exported = await this.packs.exportPack('full', { stamp: true })
    const entries = unpack(Buffer.from(exported.base64, 'base64'))
    const extension: MnemonSyncRemoteExtension = {
      channel: 'git', branch: settings.branch, subdir: settings.subdir, pushedAt: exported.manifest.exportedAt,
      machine: this.machine.read(), tombstones: this.packs.tombstones().tombstones,
    }
    entries[MANIFEST] = new TextEncoder().encode(JSON.stringify({ ...exported.manifest, [SYNC_EXTENSION]: extension }, null, 2) + '\n')
    const before = readFiles(this.payloadRoot(settings.subdir))
    if (prepared.tip === undefined || !holdsPayload(before, entries)) this.writePayload(settings.subdir, entries)
    const staged = await this.git(['add', '--all', '--force', '--', settings.subdir], { cwd: this.store.mirror(), signal })
    if (staged.exitCode !== 0) throw new Error('git add failed: ' + tail(staged.stderr || staged.stdout))
    const changed = await this.git(['status', '--porcelain', '--', settings.subdir], { cwd: this.store.mirror(), signal })
    const committed = changed.stdout.trim() !== ''
    if (committed) {
      const identity = await this.commitIdentity(settings, signal)
      const result = await this.git(
        [...identity.args, 'commit', '--quiet', '-m', message, '--', settings.subdir],
        { cwd: this.store.mirror(), signal, env: identity.env },
      )
      if (result.exitCode !== 0) throw new Error('git commit failed: ' + tail(result.stderr || result.stdout))
    }
    const head = await this.head(signal)
    const published: { pushed: boolean; reason?: string; failure?: MnemonSyncFailureReason } = committed
      ? await this.publish(settings, await this.credential(settings), signal)
      : { pushed: false, reason: prepared.tip === undefined ? 'nothing to publish' : 'the branch already holds this payload' }
    if (published.pushed || (!committed && prepared.tip !== undefined)) this.agree(settings, entries, head)
    const compaction = await this.compact(signal)
    const summary = exported.manifest.summary.map(entry => ({ ...entry, changed: componentChanged(before, entries, entry.component) }))
    return {
      repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
      commit: head, committed, message,
      files: Object.keys(entries).length,
      bytes: Object.values(entries).reduce((total, bytes) => total + bytes.byteLength, 0),
      summary, pushed: published.pushed,
      ...(merged === undefined ? {} : { merged }),
      ...(published.reason === undefined ? {} : { reason: published.reason }),
      ...(published.failure === undefined ? {} : { failure: published.failure }),
      ...(compaction === undefined ? {} : { compaction }),
    }
  }

  private async commitIdentity(settings: MnemonSyncSettings, signal?: AbortSignal): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
    const defaults = settings.authorName === MNEMON_SYNC_DEFAULT_AUTHOR_NAME && settings.authorEmail === MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL
    const authorName = defaults ? '' : settings.authorName
    const authorEmail = defaults ? '' : settings.authorEmail
    const name = authorName !== '' ? authorName : await this.configured('user.name', signal) ?? MNEMON_SYNC_DEFAULT_AUTHOR_NAME
    const email = authorEmail !== '' ? authorEmail : await this.configured('user.email', signal) ?? MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL
    const env: NodeJS.ProcessEnv = {}
    if (authorName !== '') { env.GIT_AUTHOR_NAME = authorName; env.GIT_COMMITTER_NAME = authorName }
    if (authorEmail !== '') { env.GIT_AUTHOR_EMAIL = authorEmail; env.GIT_COMMITTER_EMAIL = authorEmail }
    return { args: ['-c', 'user.name=' + name, '-c', 'user.email=' + email], env }
  }

  private async configured(key: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.git(['config', '--get', key], { cwd: this.store.mirror(), signal })
    const value = result.exitCode === 0 ? result.stdout.trim() : ''
    return value === '' ? undefined : value
  }

  private lastRun(): MnemonSyncLastRun | undefined {
    try {
      const value = record(JSON.parse(readFileSync(this.lastRunPath(), 'utf8')) as unknown)
      if (value === undefined || typeof value.at !== 'string' || typeof value.commit !== 'string') return undefined
      if (value.kind !== 'sync' && value.kind !== 'merge') return undefined
      return {
        at: value.at, kind: value.kind, commit: value.commit, pushed: value.pushed === true,
        ...(typeof value.added === 'number' && Number.isInteger(value.added) && value.added >= 0 ? { added: value.added } : {}),
      }
    } catch {
      return undefined
    }
  }

  private lastRunPath(): string {
    return join(this.store.directory(), 'sync', LAST_RUN_FILE)
  }

  private basePath(): string {
    return join(this.store.directory(), 'sync', BASE_FILE)
  }

  private agreementScope(settings: MnemonSyncSettings & { repoUrl: string }): string {
    return sha256Hex(new TextEncoder().encode(JSON.stringify([settings.repoUrl, settings.branch, settings.subdir])))
  }

  private async agreedDocuments(settings: MnemonSyncSettings & { repoUrl: string }, tip: string, signal?: AbortSignal): Promise<Record<string, string> | undefined> {
    let value: Record<string, unknown> | undefined
    try {
      value = record(JSON.parse(readFileSync(this.basePath(), 'utf8')) as unknown)
    } catch {
      value = undefined
    }
    if (value === undefined) return this.lastRunDocuments(settings, tip, signal)
    if (value.version !== 1 || value.scope !== this.agreementScope(settings)) return undefined
    const documents = record(value.documents)
    if (typeof value.commit !== 'string' || !AGREED_COMMIT.test(value.commit) || documents === undefined) return undefined
    const ancestry = await this.git(['merge-base', '--is-ancestor', value.commit, tip], { cwd: this.store.mirror(), signal })
    if (ancestry.exitCode !== 0) return undefined
    return Object.fromEntries(Object.entries(documents).filter(([, version]) => typeof version === 'string' && /^[a-f0-9]{64}$/u.test(version))) as Record<string, string>
  }

  private async lastRunDocuments(settings: MnemonSyncSettings & { repoUrl: string }, tip: string, signal?: AbortSignal): Promise<Record<string, string> | undefined> {
    const last = this.lastRun()
    if (last === undefined || !AGREED_COMMIT.test(last.commit)) return undefined
    try {
      const ancestry = await this.git(['merge-base', '--is-ancestor', last.commit, tip], { cwd: this.store.mirror(), signal })
      if (ancestry.exitCode !== 0) return undefined
      const index = await this.showUtf8(last.commit, settings.subdir + DOCUMENTS_INDEX_PATH, signal)
      return index === undefined ? undefined : documentVersions({ [DOCUMENTS_INDEX_PATH]: index })
    } catch (error) {
      signal?.throwIfAborted()
      return undefined
    }
  }

  private agree(settings: MnemonSyncSettings & { repoUrl: string }, files: Record<string, Uint8Array>, commit: string): void {
    const path = this.basePath()
    try {
      const documents = documentVersions(files)
      if (documents === undefined || !AGREED_COMMIT.test(commit)) {
        rmSync(path, { force: true })
        return
      }
      writeAtomicJsonSync(path, { version: 1, scope: this.agreementScope(settings), commit, documents })
    } catch {
    }
  }

  private recordRun(run: Omit<MnemonSyncLastRun, 'at'>): void {
    const path = this.lastRunPath()
    try {
      writeAtomicJsonSync(path, { at: this.now().toISOString(), ...run })
    } catch {
    }
  }

  async preview(signal?: AbortSignal): Promise<MnemonSyncPreview> {
    this.requireRepository()
    await this.requireGit(signal)
    const exported = await this.packs.exportPack('full')
    return this.lock(async () => {
      const settings = this.requireRepository()
      const remote = await this.readRemote(settings, signal)
      if (remote === undefined) throw this.absentPayload(settings)
      const local = unpack(Buffer.from(exported.base64, 'base64'))
      const components = MNEMON_PACK_COMPONENTS.map((component): MnemonSyncComponentDelta => {
        const published = remote.manifest.summary.find(entry => entry.component === component)
        return {
          component,
          files: published?.files ?? 0, bytes: published?.bytes ?? 0, items: published?.items ?? 0,
          changed: componentChanged(remote.files, local, component),
        }
      })
      const pack = this.packs.inspectPack(Buffer.from(remote.archive).toString('base64'), MANIFEST)
      return {
        repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
        commit: remote.commit, ...(remote.pushedAt === undefined ? {} : { pushedAt: remote.pushedAt }),
        manifest: remote.manifest, archiveBytes: remote.archive.byteLength, expandedBytes: pack.expandedBytes,
        targetRoot: pack.targetRoot, targetScope: pack.targetScope, occupied: pack.occupied,
        components, files: compareFiles(remote.files, local), localExportAt: exported.manifest.exportedAt,
      }
    })
  }

  async backups(input: { limit?: number } = {}, signal?: AbortSignal): Promise<MnemonSyncBackupList> {
    this.requireRepository()
    await this.requireGit(signal)
    const limit = backupLimit(input.limit)
    return this.lock(async () => {
      const settings = this.requireRepository()
      const prepared = await this.ensureMirror(settings, signal)
      const commits: MnemonSyncBackup[] = []
      let truncated = false
      if (prepared.tip !== undefined) {
        const rows = await this.log(settings.subdir, limit + 1, signal)
        truncated = rows.length > limit
        for (const row of rows.slice(0, limit)) {
          const backup = await this.backup(row, settings.subdir, signal)
          if (backup !== undefined) commits.push(backup)
        }
      }
      return { repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir, commits, truncated }
    })
  }

  async diff(signal?: AbortSignal): Promise<MnemonSyncDiff> {
    this.requireRepository()
    await this.requireGit(signal)
    const exported = await this.packs.exportPack('full')
    return this.lock(async () => {
      const settings = this.requireRepository()
      const remote = await this.readRemote(settings, signal)
      if (remote === undefined) throw this.absentPayload(settings)
      const local = unpack(Buffer.from(exported.base64, 'base64'))
      const limits = this.runtimeLimits()
      const mine = runtimeOf(local, limits, 'the local')
      const theirs = runtimeOf(remote.files, limits, 'the remote')
      const mineKeys = new Set(mine.entries.map(entry => entryKey(entry)))
      const theirsKeys = new Set(theirs.entries.map(entry => entryKey(entry)))
      const localOnly: MnemonSyncDiffEntry[] = []
      const remoteOnly: MnemonSyncDiffEntry[] = []
      let shared = 0
      for (const entry of mine.entries) {
        if (theirsKeys.has(entryKey(entry))) shared += 1
        else if (localOnly.length < MAX_DIFF_ENTRIES) localOnly.push(diffEntry(entry))
      }
      for (const entry of theirs.entries) {
        if (!mineKeys.has(entryKey(entry)) && remoteOnly.length < MAX_DIFF_ENTRIES) remoteOnly.push(diffEntry(entry))
      }
      const found = conflictsOf(localOnly, remoteOnly).sort((left, right) => right.similarity - left.similarity)
      const conflicts = found.slice(0, MAX_DIFF_CONFLICTS)
      const mineTombstones = this.packs.tombstones().tombstones
      const heldBack = theirs.entries.filter(entry =>
        !mineKeys.has(entryKey(entry)) && mineTombstones.some(tombstone => tombstoneCovers(tombstone, entry)),
      ).length
      return {
        repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
        commit: remote.commit, ...(remote.pushedAt === undefined ? {} : { pushedAt: remote.pushedAt }),
        localExportAt: exported.manifest.exportedAt,
        local: { exportedAt: exported.manifest.exportedAt, entries: mine.entries.length, machine: this.machine.read() },
        remote: {
          exportedAt: remote.manifest.exportedAt, entries: theirs.entries.length,
          ...(remote.machine === undefined ? {} : { machine: remote.machine }),
        },
        localOnly, remoteOnly, conflicts, shared,
        truncated: mine.entries.length - shared > localOnly.length
          || theirs.entries.length - shared > remoteOnly.length
          || found.length > conflicts.length,
        heldBack,
        remoteTombstones: unappliedRemovals(local, mineTombstones, remote.tombstones),
      }
    })
  }

  async readRemoteForEvidence(signal?: AbortSignal): Promise<MnemonSyncDiff | undefined> {
    try {
      return await this.diff(signal)
    } catch (error) {
      if (signal?.aborted === true) throw error
      return undefined
    }
  }

  async pull(input: { mode?: MnemonPackImportMode; components?: MnemonPackComponent[]; revive?: boolean; signal?: AbortSignal } = {}): Promise<MnemonSyncPullResult> {
    this.requireRepository()
    await this.requireGit(input.signal)
    const mode = input.mode ?? 'merge'
    const options: { mode: MnemonPackImportMode; components?: MnemonPackComponent[]; revive?: boolean } = {
      mode,
      ...(input.components === undefined ? {} : { components: input.components }),
      ...(input.revive === true ? { revive: true } : {}),
    }
    return this.lock(async () => {
      const settings = this.requireRepository()
      const remote = await this.readRemote(settings, input.signal)
      if (remote === undefined) throw this.absentPayload(settings)
      const base = input.components === undefined || input.components.includes('documents')
        ? await this.agreedDocuments(settings, remote.commit, input.signal) : undefined
      const imported = await this.packs.importPack(
        Buffer.from(remote.archive).toString('base64'),
        { ...options, tombstones: { version: 1, tombstones: remote.tombstones }, ...(base === undefined ? {} : { documentsBase: base }) },
      )
      if (imported.components.includes('documents')) this.agree(settings, remote.files, remote.commit)
      this.recordRun({
        kind: 'merge', commit: remote.commit, pushed: false,
        ...(imported.runtime === undefined ? {} : { added: imported.runtime.added }),
      })
      return {
        imported: true, mode: imported.mode,
        repoUrl: settings.repoUrl, branch: settings.branch, subdir: settings.subdir,
        commit: remote.commit, ...(remote.pushedAt === undefined ? {} : { pushedAt: remote.pushedAt }),
        manifest: remote.manifest, targetRoot: imported.targetRoot,
        components: imported.components, summary: imported.summary,
        ...(imported.runtime === undefined ? {} : { runtime: imported.runtime }),
      }
    })
  }

  private absentPayload(settings: MnemonSyncSettings & { repoUrl: string }): Error {
    return new MnemonSyncError('remote-empty', 'the branch ' + settings.branch + ' holds no Mnemon payload at ' + settings.subdir + ' yet; push one first')
  }

  private requireRepository(): MnemonSyncSettings & { repoUrl: string } {
    const settings = this.store.read()
    if (settings.repoUrl === undefined) {
      throw new MnemonSyncError('no-repository', 'no sync repository is configured; set repoUrl in ' + this.store.path() + ' first')
    }
    return { ...settings, repoUrl: settings.repoUrl }
  }

  private async gitStatus(signal?: AbortSignal): Promise<MnemonSyncGitStatus> {
    const required = MNEMON_SYNC_MINIMUM_GIT
    let version: string | undefined
    try {
      const result = await this.git(['--version'], { signal })
      version = /(\d+\.\d+(?:\.\d+)?)/u.exec(result.stdout)?.[1]
    } catch (error) {
      this.gitVersion = undefined
      return { available: false, required, issue: error instanceof Error ? error.message : String(error) }
    }
    this.gitVersion = version
    if (version === undefined) return { available: false, required, issue: 'git --version did not report a version' }
    if (!versionAtLeast(version, required)) {
      return { available: false, required, version, issue: 'Git ' + version + ' is older than ' + required + ', which this channel needs' }
    }
    return { available: true, required, version }
  }

  private async requireGit(signal?: AbortSignal): Promise<void> {
    const status = await this.gitStatus(signal)
    if (!status.available) throw new MnemonSyncError('git-missing', 'Git is not available on this Host: ' + (status.issue ?? 'unknown reason'))
  }

  private async remoteStatus(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<MnemonSyncRemoteStatus> {
    const credential = await this.credential(settings)
    try {
      const tip = await this.lsRemote(settings, credential, signal, MNEMON_SYNC_STATUS_TIMEOUT_MS)
      return tip === undefined ? { reachable: true, branchExists: false } : { reachable: true, branchExists: true, commit: tip }
    } catch (error) {
      const message = this.mask(error instanceof Error ? error.message : String(error), credential)
      return { reachable: false, branchExists: false, error: message, issue: remoteIssueOf(message) }
    }
  }

  private async lsRemote(settings: MnemonSyncSettings & { repoUrl: string }, credential: SyncCredential, signal?: AbortSignal, timeoutMs?: number): Promise<string | undefined> {
    const reference = 'refs/heads/' + settings.branch
    let result: { stdout: string; stderr: string; exitCode: number | null }
    try {
      result = await this.git(['ls-remote', '--heads', settings.repoUrl, reference], {
        signal, token: credential.token, authenticated: true, ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw remoteFailure(this.mask(error instanceof Error ? error.message : String(error), credential))
    }
    if (result.exitCode !== 0) throw remoteFailure(this.mask(tail(result.stderr || result.stdout) || 'git ls-remote failed', credential))
    for (const line of result.stdout.split('\n')) {
      const [commit, name] = line.trim().split(/\s+/u)
      if (name === reference && commit !== undefined) return commit
    }
    return undefined
  }

  private async lastCommit(signal?: AbortSignal): Promise<{ id: string; message: string; committedAt: string } | undefined> {
    const result = await this.git(['log', '-1', '--format=%H%x1f%cI%x1f%s'], { cwd: this.store.mirror(), signal })
    if (result.exitCode !== 0) return undefined
    const [id, committedAt, message] = result.stdout.trim().split('\u001f')
    if (id === undefined || id === '') return undefined
    return { id, message: message ?? '', committedAt: committedAt ?? '' }
  }

  private async head(signal?: AbortSignal): Promise<string> {
    const result = await this.git(['rev-parse', 'HEAD'], { cwd: this.store.mirror(), signal })
    if (result.exitCode !== 0) throw new Error('the sync mirror has no commit yet: ' + tail(result.stderr || result.stdout))
    return result.stdout.trim()
  }

  private async log(subdir: string, count: number, signal?: AbortSignal): Promise<CommitRow[]> {
    const result = await this.git(
      ['log', '--max-count=' + String(Math.min(count, BACKUP_WALK_LIMIT)), '--format=%H%x1f%cI%x1f%s', '--', subdir],
      { cwd: this.store.mirror(), signal },
    )
    if (result.exitCode !== 0) throw new Error('git log failed: ' + tail(result.stderr || result.stdout))
    const rows: CommitRow[] = []
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue
      const [commit, committedAt, message] = line.split('\u001f')
      if (commit === undefined || commit === '') continue
      rows.push({ commit, committedAt: committedAt ?? '', message: message ?? '' })
    }
    return rows
  }

  private async showUtf8(commit: string, path: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    if (/\.(?:db|sqlite|sqlite3|zip|pack|gz)$/iu.test(path)) {
      throw new Error('binary git object reads are unsupported through UTF-8 git show: ' + path)
    }
    const result = await this.git(['show', commit + ':' + path], {
      cwd: this.store.mirror(), signal, maxOutputBytes: MAX_FILE_BYTES,
    })
    if (result.exitCode !== 0) return undefined
    return showText(result.stdout)
  }

  private async backup(row: CommitRow, subdir: string, signal?: AbortSignal): Promise<MnemonSyncBackup | undefined> {
    const bytes = await this.showUtf8(row.commit, subdir + MANIFEST, signal)
    if (bytes === undefined) return undefined
    let manifest: MnemonPackManifest
    let machine: MnemonMachineIdentity | undefined
    let pushedAt: string | undefined
    try {
      const raw = record(parseJson(bytes, 'the backup manifest'))
      if (raw === undefined) return undefined
      const extension = record(raw[SYNC_EXTENSION])
      pushedAt = typeof extension?.pushedAt === 'string' ? extension.pushedAt : undefined
      machine = extensionMachine(extension)
      manifest = parseManifestJson(raw)
    } catch {
      return undefined
    }
    return {
      commit: row.commit, message: row.message, committedAt: row.committedAt,
      ...(machine === undefined ? {} : { machine }),
      ...(pushedAt === undefined ? {} : { pushedAt }),
      components: manifest.summary,
    }
  }

  private runtimeLimits(): RuntimeMemoryLimits {
    return { memory: this.config.runtimeMemory.memoryLimitBytes, user: this.config.runtimeMemory.userLimitBytes }
  }

  private async ensureMirror(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<{ tip?: string }> {
    const credential = await this.credential(settings)
    const mirror = this.store.mirror()
    mkdirSync(this.store.directory(), { recursive: true, mode: 0o700 })
    if (existsSync(join(mirror, '.git'))) {
      const origin = await this.git(['config', '--get', ORIGIN_KEY], { cwd: mirror, signal })
      if (origin.exitCode !== 0 || origin.stdout.trim() !== settings.repoUrl) removeDisposableDirectory(mirror)
    }
    if (!existsSync(join(mirror, '.git'))) {
      removeDisposableDirectory(mirror)
      const initialized = await this.git(['init', '--quiet', mirror], { signal })
      if (initialized.exitCode !== 0) throw new Error('git init failed: ' + tail(initialized.stderr || initialized.stdout))
      const marked = await this.git(['config', ORIGIN_KEY, settings.repoUrl], { cwd: mirror, signal })
      if (marked.exitCode !== 0) throw new Error('git config failed: ' + tail(marked.stderr || marked.stdout))
    }
    const current = await this.git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: mirror, signal })
    if (current.exitCode !== 0 || current.stdout.trim() !== 'refs/heads/' + settings.branch) {
      const renamed = await this.git(['symbolic-ref', 'HEAD', 'refs/heads/' + settings.branch], { cwd: mirror, signal })
      if (renamed.exitCode !== 0) throw new Error('git symbolic-ref failed: ' + tail(renamed.stderr || renamed.stdout))
    }
    const tip = await this.lsRemote(settings, credential, signal)
    if (tip === undefined) {
      await this.startHistory(settings.branch, signal)
      return {}
    }
    const fetched = await this.git(
      ['fetch', '--no-tags', '--quiet', settings.repoUrl, 'refs/heads/' + settings.branch],
      { cwd: mirror, signal, token: credential.token, authenticated: true },
    )
    if (fetched.exitCode !== 0) throw remoteFailure('git fetch failed: ' + this.mask(tail(fetched.stderr || fetched.stdout), credential))
    const reset = await this.git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], { cwd: mirror, signal })
    if (reset.exitCode !== 0) throw new Error('git reset failed: ' + tail(reset.stderr || reset.stdout))
    const cleaned = await this.git(['clean', '-fdxq', '--', ':(literal)' + settings.subdir], { cwd: mirror, signal })
    if (cleaned.exitCode !== 0) throw new Error('git clean failed: ' + tail(cleaned.stderr || cleaned.stdout))
    return { tip: await this.head(signal) }
  }

  private async startHistory(branch: string, signal?: AbortSignal): Promise<void> {
    const mirror = this.store.mirror()
    await this.git(['update-ref', '-d', 'refs/heads/' + branch], { cwd: mirror, signal })
    const emptied = await this.git(['read-tree', '--empty'], { cwd: mirror, signal })
    if (emptied.exitCode !== 0) throw new Error('git read-tree failed: ' + tail(emptied.stderr || emptied.stdout))
    const cleaned = await this.git(['clean', '-fdxq'], { cwd: mirror, signal })
    if (cleaned.exitCode !== 0) throw new Error('git clean failed: ' + tail(cleaned.stderr || cleaned.stdout))
  }

  private payloadRoot(subdir: string): string {
    const mirror = resolve(this.store.mirror())
    const root = resolve(mirror, subdir)
    let current = mirror
    for (const part of relative(mirror, root).split(sep).filter(part => part !== '')) {
      current = join(current, part)
      let linked: boolean
      try {
        linked = lstatSync(current).isSymbolicLink()
      } catch {
        break
      }
      if (linked) throw new Error('the sync directory crosses a symbolic link in the mirror: ' + relative(mirror, current))
    }
    return root
  }

  private writePayload(subdir: string, entries: Record<string, Uint8Array>): void {
    const root = this.payloadRoot(subdir)
    const mirror = resolve(this.store.mirror())
    if (root === mirror || !root.startsWith(mirror + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error('sync directory escapes the mirror')
    }
    removeDisposableDirectory(root)
    for (const [path, bytes] of Object.entries(entries)) {
      const file = resolve(root, path)
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(file, bytes, { mode: 0o600 })
    }
  }

  private async publish(settings: MnemonSyncSettings & { repoUrl: string }, credential: SyncCredential, signal?: AbortSignal): Promise<{ pushed: boolean; reason?: string; failure?: MnemonSyncFailureReason }> {
    const reference = 'refs/heads/' + settings.branch + ':refs/heads/' + settings.branch
    let result: { stdout: string; stderr: string; exitCode: number | null }
    try {
      result = await this.git(['push', '--porcelain', settings.repoUrl, reference], { cwd: this.store.mirror(), signal, token: credential.token, authenticated: true })
    } catch (error) {
      if (signal?.aborted === true) throw error
      const reason = this.mask(error instanceof Error ? error.message : String(error), credential)
      const failure = REMOTE_FAILURE[remoteIssueOf(reason)]
      return { pushed: false, reason, ...(failure === undefined ? {} : { failure }) }
    }
    if (result.exitCode === 0) return { pushed: true }
    const output = this.mask(result.stdout + '\n' + result.stderr, credential)
    const reason = this.mask(tail(result.stderr || result.stdout), credential) || 'git push failed'
    const failure = rejectedPush(output) ? 'push-rejected' : REMOTE_FAILURE[remoteIssueOf(output)]
    const remoteRejected = /\[remote rejected\]/iu.test(output)
    return {
      pushed: false,
      reason: remoteRejected
        ? 'the remote rejected this push; check its policy and the commit author in Sync > Advanced, then sync again: ' + reason
        : credential.token === undefined && failure !== 'push-rejected' ? 'the commit stays local because no token is available: ' + reason : reason,
      ...(failure === undefined ? {} : { failure }),
    }
  }

  private async compact(signal?: AbortSignal): Promise<MnemonSyncCompaction | undefined> {
    let before: ObjectCount | undefined
    try {
      const counted = await this.git(['count-objects', '-v'], { cwd: this.store.mirror(), signal })
      if (counted.exitCode !== 0) return undefined
      before = objectCount(counted.stdout)
    } catch { return undefined }
    if (before === undefined) return undefined
    if (before.loose === 0) return { loose: 0, bytes: 0, packed: before.packed, packedBytes: before.packedBytes }
    try {
      const repacked = await this.git(['repack', '-adf', '--window=250', '--depth=50'], { cwd: this.store.mirror(), signal })
      const counted = await this.git(['count-objects', '-v'], { cwd: this.store.mirror(), signal })
      const after = counted.exitCode === 0 ? objectCount(counted.stdout) : undefined
      if (repacked.exitCode !== 0 || after === undefined) {
        return {
          loose: before.loose, bytes: before.bytes, packed: before.packed, packedBytes: before.packedBytes,
          warning: tail(repacked.stderr || repacked.stdout) || 'git repack failed',
        }
      }
      return { loose: before.loose, bytes: before.bytes, packed: after.packed, packedBytes: after.packedBytes }
    } catch (error) {
      return {
        loose: before.loose, bytes: before.bytes, packed: before.packed, packedBytes: before.packedBytes,
        warning: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async readRemote(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<RemotePayload | undefined> {
    return this.readPrepared(settings, await this.ensureMirror(settings, signal))
  }

  private async readPrepared(settings: MnemonSyncSettings & { repoUrl: string }, prepared: { tip?: string }): Promise<RemotePayload | undefined> {
    if (prepared.tip === undefined) return undefined
    const files = readFiles(this.payloadRoot(settings.subdir))
    const manifestBytes = files[MANIFEST]
    const checksumBytes = files[CHECKSUMS]
    if (manifestBytes === undefined || checksumBytes === undefined) return undefined
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('the remote Mnemon manifest exceeds the safety limit')
    for (const path of Object.keys(files)) {
      if (path !== MANIFEST && path !== CHECKSUMS && !path.startsWith('payload/')) {
        throw new Error('the remote Mnemon payload holds an unexpected file: ' + path)
      }
    }
    const parsed = record(parseJson(manifestBytes, 'the remote Mnemon manifest'))
    if (parsed === undefined) throw new Error('the remote Mnemon manifest is not a JSON object')
    if (parsed.format !== 'mnemonpack' || parsed.version !== 1) throw new Error('the remote Mnemon manifest is not a supported Mnemon Pack')
    const checksums = record(parseJson(checksumBytes, 'the remote Mnemon checksum inventory'))
    const inventory = record(checksums?.files)
    if (checksums?.algorithm !== 'sha256' || inventory === undefined) throw new Error('the remote Mnemon checksum inventory is invalid')
    for (const [path, bytes] of Object.entries(files)) {
      if (path === MANIFEST || path === CHECKSUMS) continue
      const expected = inventory[path]
      if (typeof expected !== 'string') throw new Error('the remote Mnemon payload holds an unchecksummed file: ' + path)
      if (expected !== sha256Hex(bytes)) throw new Error('the remote Mnemon payload failed its checksum: ' + path)
    }
    for (const path of Object.keys(inventory)) {
      if (files[path] === undefined) throw new Error('the remote Mnemon payload is missing a checksummed file: ' + path)
    }
    const extension = record(parsed[SYNC_EXTENSION])
    const pushedAt = typeof extension?.pushedAt === 'string' ? extension.pushedAt : undefined
    const machine = extensionMachine(extension)
    const archive = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) })
    return {
      commit: prepared.tip, manifest: parsed as unknown as MnemonPackManifest,
      ...(pushedAt === undefined ? {} : { pushedAt }),
      ...(machine === undefined ? {} : { machine }),
      tombstones: extensionTombstones(extension),
      files, archive,
    }
  }

  private mask(text: string, credential: SyncCredential): string {
    const token = credential.token
    if (token === undefined || token === '') return text
    return text.replaceAll(token, '***')
  }

  private lock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    mkdirSync(this.store.directory(), { recursive: true, mode: 0o700 })
    return withDirectoryLock(join(this.store.directory(), '.sync.lock'), () => {
      this.sweepCredentials()
      return operation()
    })
  }

  private sweepCredentials(): void {
    let names: string[]
    try {
      names = readdirSync(this.store.directory())
    } catch {
      return
    }
    for (const name of names) {
      const match = /^\.credentials\.(\d+)\.\d+\.tmp$/u.exec(name)
      if (match === null) continue
      const pid = Number(match[1])
      if (pid === process.pid || processAlive(pid)) continue
      rmSync(join(this.store.directory(), name), { force: true })
    }
  }

  private async git(args: string[], options: GitOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const prepared = await this.credentials(args, options)
    try {
      const result = await this.run(GIT_LABEL, prepared.args, {
        timeoutMs: options.timeoutMs ?? MNEMON_SYNC_GIT_TIMEOUT_MS,
        env: gitEnvironment({ ...process.env, ...options.env }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        label: GIT_LABEL,
      })
      return result
    } finally {
      prepared.cleanup()
    }
  }

  private async credentials(args: string[], options: GitOptions): Promise<{ args: string[]; cleanup: () => void }> {
    const token = options.token
    if (token === undefined || token === '' || options.authenticated !== true) return { args: [...SAFE_CHECKOUT_FLAGS, ...args], cleanup: () => {} }
    const index = args.findIndex(argument => argument.startsWith('https://'))
    if (index === -1) return { args: [...SAFE_CHECKOUT_FLAGS, ...args], cleanup: () => {} }
    const url = args[index]!
    const target = credentialTarget(url)
    const command = [...args]
    const lookup: string[] = []
    if (this.gitVersion !== undefined && versionAtLeast(this.gitVersion, GIT_LAST_USERNAME_WINS_VERSION)) {
      lookup.push('-c', 'credential.useHttpPath=false', '-c', 'credential.username=' + target.name)
      command[index] = target.address
    } else {
      const configured = await this.configuredLookup(url, options)
      if (configured.path) lookup.push('-c', 'credential.useHttpPath=false')
      if (configured.user !== undefined && configured.user !== target.name && !target.named) command[index] = 'https://' + target.user + '@' + target.address.slice('https://'.length)
    }
    this.sequence += 1
    const path = join(this.store.directory(), '.credentials.' + branchSlug(String(process.pid)) + '.' + String(this.sequence) + '.tmp')
    writeFileSync(path, 'https://' + target.user + ':' + encodeURIComponent(token) + '@' + target.host + '\n', { encoding: 'utf8', mode: 0o600 })
    return {
      args: [...SAFE_CHECKOUT_FLAGS, '-c', 'credential.helper=', '-c', 'credential.helper=store --file=' + shellQuote(path), ...lookup, ...command],
      cleanup: () => { rmSync(path, { force: true }) },
    }
  }

  private async configuredLookup(url: string, options: GitOptions): Promise<{ user: string | undefined; path: boolean }> {
    let result: { stdout: string; exitCode: number | null }
    try {
      result = await this.run(GIT_LABEL, ['config', '--get-urlmatch', 'credential', url], {
        timeoutMs: options.timeoutMs ?? MNEMON_SYNC_GIT_TIMEOUT_MS,
        env: gitEnvironment(),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        label: GIT_LABEL,
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      return { user: undefined, path: false }
    }
    const settings = new Map<string, string>()
    if (result.exitCode === 0) {
      for (const line of result.stdout.split(/\r?\n/u)) {
        const space = line.indexOf(' ')
        if (space > 0) settings.set(line.slice(0, space).toLowerCase(), line.slice(space + 1))
      }
    }
    const path = settings.get('credential.usehttppath')
    return { user: settings.get('credential.username'), path: path !== undefined && gitBoolean(path) }
  }
}

function compareFiles(published: Record<string, Uint8Array>, local: Record<string, Uint8Array>): MnemonSyncFileDelta {
  let changed = 0
  let added = 0
  let removed = 0
  const paths = new Set([...Object.keys(published), ...Object.keys(local)].filter(path => path !== MANIFEST && path !== CHECKSUMS))
  for (const path of paths) {
    const remote = published[path]
    const mine = local[path]
    if (remote === undefined) added += 1
    else if (mine === undefined) removed += 1
    else if (sha256Hex(remote) !== sha256Hex(mine)) changed += 1
  }
  return { total: paths.size, changed, added, removed }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function abandoned(path: string, now: number): boolean {
  let age: number
  try {
    age = now - statSync(path).mtimeMs
  } catch {
    return false
  }
  if (age > STALE_LOCK_MS) return true
  try {
    const owner = record(JSON.parse(readFileSync(join(path, LOCK_OWNER), 'utf8')) as unknown)
    const pid = owner?.pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid)
  } catch {
    return age > OWNERLESS_LOCK_MS
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<T>).then === 'function'
}

function tryAcquireDirectoryLock(path: string): boolean {
  try {
    mkdirSync(path, { recursive: false, mode: 0o700 })
    return true
  } catch {
    if (abandoned(path, Date.now())) {
      const aside = path + '.abandoned.' + String(process.pid) + '.' + String(Date.now())
      try {
        if (abandoned(path, Date.now())) renameSync(path, aside)
        rmSync(aside, { recursive: true, force: true })
        mkdirSync(path, { recursive: false, mode: 0o700 })
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

function runHoldingDirectoryLock<T>(path: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    writeFileSync(join(path, LOCK_OWNER), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
  } catch {
  }
  let outcome: T | Promise<T>
  try {
    outcome = operation()
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  if (!isPromiseLike(outcome)) {
    rmSync(path, { recursive: true, force: true })
    return Promise.resolve(outcome)
  }
  return Promise.resolve(outcome).finally(() => {
    rmSync(path, { recursive: true, force: true })
  })
}

function withDirectoryLock<T>(path: string, operation: () => T | Promise<T>): Promise<T> {
  if (tryAcquireDirectoryLock(path)) {
    return runHoldingDirectoryLock(path, operation)
  }
  return (async () => {
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let held = false
    while (!held && Date.now() < deadline) {
      await new Promise<void>(resolveReady => setTimeout(resolveReady, 25))
      held = tryAcquireDirectoryLock(path)
    }
    if (!held) throw new MnemonSyncError('busy', 'another Mnemon sync operation is still running')
    return runHoldingDirectoryLock(path, operation)
  })()
}
