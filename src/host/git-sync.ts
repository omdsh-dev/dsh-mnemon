import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  MnemonMachineIdentity, MnemonSyncRemoteStatus, MnemonSyncStatus, MnemonTombstone, MnemonTombstoneFile,
} from './protocol.ts'
import { RUNTIME_MEMORY_LIMITS, type RuntimeMemoryLimits } from 'dsh-mnemon-source-runtime/contracts'
import { MNEMON_PACK_COMPONENTS, MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL, MNEMON_SYNC_DEFAULT_AUTHOR_NAME, MNEMON_SYNC_TOKEN_ENV } from './protocol.ts'
import { MnemonGitHubAuth } from './github-auth.ts'
import { MnemonSyncError } from './sync-error.ts'
import { MnemonMachineStore, defaultMachineLabel, machineLabel } from './machine-identity.ts'
import type { StorageRoot } from './storage-root.ts'
import { MnemonSyncSettingsStore, type MnemonSyncSettings } from './sync-config.ts'

export { MnemonSyncError }

/** The oldest Git the channel drives: `archive`, `ls-remote`, `-C`, and `credential` all predate it. */
export const MNEMON_SYNC_MINIMUM_GIT = '2.20'
export const MNEMON_SYNC_GIT_TIMEOUT_MS = 120_000
/**
 * How long the settings page waits to learn whether the remote answers. A page
 * that opens should not hang on a host that drops packets, and anything slower
 * than this is reported as a timeout rather than awaited.
 */
export const MNEMON_SYNC_STATUS_TIMEOUT_MS = 20_000
/** A push Git refused because the branch moved is folded in and tried once more. */
const PUSH_ATTEMPTS = 2
/**
 * No sync runs this long, so a lock older than this is abandoned whoever holds it.
 * It also covers a process id that a restart handed to an unrelated process.
 */
const STALE_LOCK_MS = 60 * 60_000
const LOCK_OWNER = 'owner.json'
/**
 * A lock without an owner record was taken by a version that kept none, and may
 * still be in use by it; it is taken over only once no such run could still last.
 */
const OWNERLESS_LOCK_MS = 15 * 60_000
/** The mirror's own Git config names the repository it was filled from. */
const ORIGIN_KEY = 'mnemon.origin'
const LAST_RUN_FILE = 'last-run.json'
/** What this machine and the branch last agreed on: each document's version, by id, and the commit it was agreed at. */
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
/** One log page stays well under the process output cap, and the reader sees the newest first. */
const MAX_BACKUPS = 100
const DEFAULT_BACKUP_LIMIT = 20
/** How many older commits a page says it withheld before it stops paying for the walk. */
const BACKUP_WALK_LIMIT = 200
const MAX_DIFF_ENTRIES = 200
/**
 * Git on Windows would otherwise rewrite line endings and break every checksum. A
 * branch may also hold a symbolic link; checked out as a plain file it can never lead
 * a later read or write out of the mirror.
 */
const NO_REWRITE = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=false']
/**
 * Git reads where the repository is from the environment, so a launcher that
 * exports `GIT_DIR` for its own reasons hijacks every command below: the shell
 * shims shipped with the harness set it to the directory holding a bundled Git
 * binary, which Git then treats as the repository. Each invocation therefore
 * gets a copy of the environment with those variables removed.
 */
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
  // How paths are read: GIT_LITERAL_PATHSPECS would turn the literal sync directory into
  // a path named `:(literal)…`, and the clean below would quietly remove nothing.
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
])

/**
 * Windows environment variables are case-insensitive, so the comparison is
 * upper-cased rather than trusting the spelling a launcher happened to use.
 */
export function gitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || GIT_LOCATION_ENV.has(name.toUpperCase())) continue
    sanitized[name] = value
  }
  // The Host has no terminal a person watches, so Git and its credential manager must
  // fail instead of waiting for a password or a sign-in window nobody will answer.
  sanitized.GIT_TERMINAL_PROMPT = '0'
  sanitized.GCM_INTERACTIVE = 'never'
  return sanitized
}

/** The host an HTTPS address hands a token to; any other address takes none. */
function tokenHost(repoUrl: string | undefined): string | undefined {
  if (repoUrl === undefined) return undefined
  try {
    const url = new URL(repoUrl)
    return url.protocol === 'https:' ? url.host.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** Whether a repository address is HTTPS on github.com, the only host a GitHub grant is for. */
export function isGitHubHttps(repoUrl: string): boolean {
  try {
    const url = new URL(repoUrl)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}

/**
 * The user name a token goes to Git under: the one GitHub documents for its tokens and its sign-in's
 * grant, which every host has been offered, and which stays for every host not known to refuse it.
 */
const TOKEN_USER = 'x-access-token'
/**
 * The hosts known to refuse `x-access-token` with a token, and the name each takes instead: Gitee
 * answers it with HTTP 403 and takes `oauth2` or the account name (#408). Any other host that wants
 * a name of its own, a self-hosted Gitee included, is given it in the address.
 */
const TOKEN_USER_BY_HOST: ReadonlyMap<string, string> = new Map([['gitee.com', 'oauth2']])
/**
 * From this version on, the last `credential.username` Git reads wins, which is the command line's.
 * Before it, the first one configured did, and only a name in the address came before that.
 */
const LAST_USERNAME_WINS_GIT = '2.26'

/**
 * Who Git is to look the token up as for one HTTPS address, and for which host: the user name the
 * address names, else the one its host takes a token under; the host exactly as the address writes
 * it, since Git compares a stored credential's host as text, its case and port included; and the
 * address without its user name. `user` is written as an address writes it, `name` as Git reads it.
 */
export function credentialTarget(url: string): { user: string; name: string; named: boolean; host: string; address: string } {
  const [, written, host = '', rest = ''] = /^https:\/\/(?:([^/@]*)@)?([^/]*)(.*)$/u.exec(url) ?? []
  let hostname = ''
  try {
    // `gitee.com.` is the same host, written as a fully qualified name.
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/u, '')
  } catch {
    // An address that does not parse keeps the name every host is offered.
  }
  const user = written ?? TOKEN_USER_BY_HOST.get(hostname) ?? TOKEN_USER
  let name = user
  try {
    name = decodeURIComponent(user)
  } catch {
    // The settings refuse an address whose user name does not decode; Git would read it as written.
  }
  return { user, name, named: written !== undefined, host, address: 'https://' + host + rest }
}

/**
 * What kind of failure one Git error describes. Git words these differently per
 * transport and per host, so the patterns are the phrases each transport uses:
 * a refused or missing credential, an address that leads nowhere (GitHub answers
 * "not found" for a private repository it will not show without credentials), a
 * network that does not reach the host, and a host that never answered.
 */
export function remoteIssueOf(message: string): MnemonSyncRemoteIssue {
  const text = message.toLowerCase()
  if (/did not respond within|timed out|timeout was reached/u.test(text)) return 'timeout'
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied|invalid username or password|bad credentials|returned error: 40[13]|host key verification failed|access denied|denied to /u.test(text)) return 'auth'
  if (/repository not found|not found|does not appear to be a git repository|no such file or directory|does not exist|returned error: 404/u.test(text)) return 'not-found'
  if (/could not resolve|failed to connect|couldn't connect|connection (refused|reset|closed|timed out)|network is unreachable|no route to host|unable to access|ssl|tls|proxy|empty reply/u.test(text)) return 'network'
  return 'unknown'
}

const REMOTE_FAILURE: Record<MnemonSyncRemoteIssue, MnemonSyncFailureReason | undefined> = {
  auth: 'remote-auth',
  'not-found': 'remote-not-found',
  network: 'remote-network',
  timeout: 'remote-timeout',
  unknown: undefined,
}

/** One failed remote command as the error a caller reports: named when it can be. */
function remoteFailure(message: string): Error {
  const reason = REMOTE_FAILURE[remoteIssueOf(message)]
  return reason === undefined ? new Error(message) : new MnemonSyncError(reason, message)
}

/** Whether Git refused a push because the branch moved on since this run read it. */
function rejectedPush(output: string): boolean {
  return /\[rejected\]|fetch first|non-fast-forward/iu.test(output)
}

interface GitOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
  /** Per-command identity overrides; never written into the mirror's Git configuration. */
  env?: NodeJS.ProcessEnv | undefined
  token?: string | undefined
  authenticated?: boolean | undefined
  /** Raised for the one command that legitimately prints a whole payload file back out of a commit. */
  maxOutputBytes?: number | undefined
  /** Shortened for the status probe, which a page waits on. */
  timeoutMs?: number | undefined
}

/**
 * What a sync branch records beside a plain Mnemon Pack. Everything here describes
 * *this* machine rather than the memories: which installation pushed the payload and
 * which removals it had recorded when it did. A Pack never carries either, so an older
 * plugin can still open one, and only the channel that moves payloads between machines
 * reads them back.
 */
interface MnemonSyncRemoteExtension {
  channel: 'git'
  branch: string
  subdir: string
  pushedAt: string
  machine?: MnemonMachineIdentity
  tombstones?: MnemonTombstone[]
}

/** The credential one operation resolved, and where it came from. */
interface SyncCredential {
  source: MnemonSyncCredentialSource
  token?: string
  login?: string
}

interface RemotePayload {
  commit: string
  manifest: MnemonPackManifest
  pushedAt?: string
  /** The installation that pushed the tip, when the branch recorded one. */
  machine?: MnemonMachineIdentity
  /** Every removal the branch has recorded; a branch without the extension recorded none. */
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

/**
 * A boolean as Git reads one: `true`, `yes`, `on` or a number other than 0 is true, and
 * `false`, `no`, `off`, 0 or an empty value is false.
 */
function gitBoolean(value: string): boolean {
  const text = value.trim().toLowerCase()
  return text === 'true' || text === 'yes' || text === 'on' || (/^[-+]?\d+$/u.test(text) && Number(text) !== 0)
}

/**
 * The deletions one side of the channel recorded. They live in the sync extension, never
 * in the payload, so a Pack stays readable by any version; a branch that predates the
 * extension recorded none, and an unreadable list is treated the same way rather than
 * failing a push over bookkeeping.
 */
function extensionTombstones(extension: Record<string, unknown> | undefined): MnemonTombstone[] {
  if (extension?.tombstones === undefined) return []
  try {
    return parseTombstones({ version: 1, tombstones: extension.tombstones }).tombstones
  } catch {
    return []
  }
}

/** The installation a payload was pushed from, read off the same extension. */
function extensionMachine(extension: Record<string, unknown> | undefined): MnemonMachineIdentity | undefined {
  try {
    return parseMachineIdentity(extension?.machine)
  } catch {
    return undefined
  }
}

/** Whether the payload of one component differs between two sets of files. */
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

/** Manifest fields that record when a payload was written, not what it holds. */
const TIMESTAMP_FIELDS = new Set(['exportedAt', 'pushedAt'])

/** The same manifest without its timestamps describes the same payload. */
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

/** The identity of a manifest: everything except the two timestamps. */
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

/**
 * Whether the mirror already holds exactly this payload. Every push re-exports
 * the pack, so `exportedAt` and `sync.pushedAt` always differ; the rest of the
 * payload has to match byte for byte, or the branch does not hold it yet.
 */
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

/** A commit message stays one line, and never grows without bound. */
function commitMessage(value: unknown, at: Date): string {
  const raw = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (raw === '') return 'Mnemon sync ' + at.toISOString().replace(/\.\d{3}Z$/u, 'Z')
  return raw.length > 200 ? raw.slice(0, 200) : raw
}

/** The path of one branch inside the mirror, which is flattened the way `git check-ref-format --branch` flattens it. */
function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 120)
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/** The empty projection the runtime contract publishes when one side carries no entries. */
function emptyRuntime(): RuntimeFile {
  return { version: 1, entries: [] }
}

function emptyTombstones(): MnemonTombstoneFile {
  return { version: 1, tombstones: [] }
}

/**
 * The runtime payload one commit holds. The mirror is already at the branch tip,
 * so reading a file out of a commit never moves the work tree, the index, or
 * `HEAD` — which is what keeps `git status --porcelain` empty for the next push.
 * `git show` on a path the commit does not hold fails, so the payload's own
 * absence is the empty projection rather than an error.
 */
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

/** The four numbers `git count-objects -v` reports about this mirror, the sizes in bytes. */
interface ObjectCount {
  loose: number
  bytes: number
  packed: number
  packedBytes: number
}

/**
 * Read the loose and packed object counts out of `git count-objects -v`. An
 * unrecognised shape returns undefined rather than a guess: the caller only
 * needs to know whether it measured the mirror at all.
 */
function objectCount(output: string): ObjectCount | undefined {
  const loose = /^count:\s*(\d+)$/mu.exec(output)
  const bytes = /^size:\s*(\d+)$/mu.exec(output)
  const packed = /^in-pack:\s*(\d+)$/mu.exec(output)
  const packedBytes = /^size-pack:\s*(\d+)$/mu.exec(output)
  if (loose === null || bytes === null || packed === null || packedBytes === null) return undefined
  // Git states both sizes in KiB.
  return { loose: Number(loose[1]), bytes: Number(bytes[1]) * 1024, packed: Number(packed[1]), packedBytes: Number(packedBytes[1]) * 1024 }
}

/** How many commits one page asks for: the caller's window, clamped to what one listing should carry. */
function backupLimit(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_BACKUP_LIMIT
  return Math.min(Math.max(requested, 1), MAX_BACKUPS)
}

/** One `git log` row: the commit, when it was made, and the message its author chose. */
interface CommitRow {
  commit: string
  committedAt: string
  message: string
}

/** One entry as a difference shows it: its text and the installation that wrote it, never its bookkeeping. */
function diffEntry(entry: StoredRuntimeEntry): MnemonSyncDiffEntry {
  return {
    target: entry.target,
    content: entry.content,
    importance: entry.importance,
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
  }
}

/** How alike two texts must read before they count as the same subject written twice. */
const CONFLICT_SIMILARITY = 0.6
/** How many conflicts one difference lists; a page past this says it was cut short. */
const MAX_DIFF_CONFLICTS = 40

/** Case, spacing, and punctuation carry no meaning when two memories are compared. */
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

/**
 * How alike two memories read, from 0 to 1, as the Sørensen–Dice coefficient of their
 * character bigrams. Comparing characters rather than words is what lets a reworded
 * sentence score high in any language, including the ones written without spaces.
 */
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

/**
 * The subjects both sides wrote down differently. A pair counts only when the two texts
 * talk about the same thing — the same target, and alike enough that keeping both would
 * record one answer twice. Every other entry on one side alone is an addition, which
 * needs no reconciling at all.
 */
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

/**
 * The runtime projection one side of a diff carries, read through the same parser
 * an import uses. A side without the file holds nothing; a side whose file does not
 * parse is a failure the caller names, because "no entries" and "unreadable entries"
 * must never look alike in a merge decision.
 */
function runtimeOf(files: Record<string, Uint8Array>, limits: RuntimeMemoryLimits, label: string): RuntimeFile {
  const bytes = files[RUNTIME_MEMORIES_PATH]
  if (bytes === undefined) return emptyRuntime()
  try {
    return parseRuntime(parseJson(bytes, label + ' runtime memories.json'), limits)
  } catch (error) {
    throw new Error(label + ' runtime memories.json is invalid: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * The removals this machine has not applied yet. The branch carries every removal both
 * sides ever recorded — tombstones only grow — so the list the branch holds is not the
 * answer to "what does the branch know that I do not". A removal this machine already
 * applied is not outstanding, and one this machine has since written over no longer hides
 * anything. What remains is what the branch recorded and this machine has not carried out.
 */
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

/** Read every file below one directory as forward-slash keyed bytes. */
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

function unpack(archive: Uint8Array): Unzipped {
  let entries: Unzipped
  try {
    entries = unzipSync(archive)
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

/**
 * Publish the Mnemon Pack payload to one branch of a Git repository the user
 * owns, and read it back on another machine.
 *
 * The payload is exactly the pack the ZIP path produces: the same collector,
 * the same manifest, the same checksums, and the same importer. Git only moves
 * the bytes, so any reader still sees a valid Mnemon Pack, and a pull validates
 * what an Import ZIP validates.
 */
export class MnemonGitSync {
  private readonly root: string
  private readonly store: MnemonSyncSettingsStore
  private readonly machine: MnemonMachineStore
  private sequence = 0
  /** The Git version the last check found, which decides how a token's user name is given to Git. */
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

  /** Where the channel keeps its configuration and its disposable mirror. */
  settings(): MnemonSyncSettingsStore {
    return this.store
  }

  /**
   * Hand the channel the Host's GitHub sign-in. Every runtime generation shares
   * one instance, so a grant stored from the settings page reaches the graphs
   * an Agent executes in as well.
   */
  useGitHubAuth(auth: MnemonGitHubAuth | undefined): void {
    this.auth = auth
  }

  /** The sign-in surface, or undefined on a Host that provides no store. */
  github(): MnemonGitHubAuth | undefined {
    return this.auth
  }

  /**
   * Report the background cadence the Host keeps for this channel. The timer
   * lives beside the runtime instead of inside it, because a settings write
   * builds a throwaway graph to validate itself and that graph must never own a
   * timer; the view is how the one timer reaches whichever graph is current.
   */
  useAutoBackup(view: (() => MnemonSyncAutoBackup | undefined) | undefined): void {
    this.autoBackupView = view
  }

  /**
   * The credential one operation authenticates with, and where it came from.
   * The environment wins over the stored token, and the GitHub grant is the
   * fallback a user reaches for when neither is set.
   */
  private async credential(settings: MnemonSyncSettings): Promise<SyncCredential> {
    const token = this.store.token(settings)
    if (token !== undefined && token !== '') {
      return { source: (process.env[MNEMON_SYNC_TOKEN_ENV]?.trim() ?? '') === '' ? 'token' : 'environment', token }
    }
    const grant = await this.auth?.grant()
    if (grant === undefined) return { source: 'none' }
    // The grant opens every repository the account can reach, so it is offered to
    // github.com and nowhere else; a repository elsewhere authenticates on its own.
    if (settings.repoUrl !== undefined && !isGitHubHttps(settings.repoUrl)) return { source: 'none' }
    return { source: 'github', token: grant.accessToken, ...(grant.login === undefined ? {} : { login: grant.login }) }
  }

  /** The saved view, with the source the channel would actually authenticate with. */
  private async credentialView(settings: MnemonSyncSettings): Promise<MnemonSyncConfigView> {
    const credential = await this.credential(settings)
    return {
      ...this.store.view(settings, this.config.syncEnabled),
      hasToken: credential.token !== undefined,
      credentialSource: credential.source,
      ...(credential.login === undefined ? {} : { credentialLogin: credential.login }),
    }
  }

  /**
   * What the settings page reads. A profile that switched sync off gets the saved
   * configuration and nothing else: no Git is probed, no mirror is walked, and no
   * machine identity is minted, so drawing a disabled block stays free and a
   * disabled channel cannot leave a trace on disk.
   */
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
    const previous = this.store.read()
    const fields = record(patch)
    // This machine's name belongs to its identity, not to the channel settings, so it is
    // taken out of the patch and checked before anything is written.
    const { machineLabel: name, ...settings }: Record<string, unknown> = fields ?? {}
    const naming = fields !== undefined && 'machineLabel' in fields
    if (naming && name !== null && name !== '') machineLabel(name)
    const next = this.store.patch(fields === undefined ? patch : settings)
    // A saved token authenticates the host it was saved for. Moving the repository to
    // another host forgets it unless a new token comes with the move, so a token never
    // reaches a host it was not meant for.
    if (next.token !== undefined && previous.repoUrl !== undefined && fields !== undefined && !('token' in fields)
      && tokenHost(previous.repoUrl) !== tokenHost(next.repoUrl)) delete next.token
    this.store.write(next)
    if (naming) this.machine.rename(name)
    // When memory last travelled is a fact about one repository, branch and directory; another
    // one starts with none, as the documents there are no agreement with this machine (#385).
    // What the documents last agreed on stays: it names its repository, branch and commit, so
    // another repository never uses it, and reconnecting to this one picks it up again.
    if (previous.repoUrl !== next.repoUrl || previous.branch !== next.branch || previous.subdir !== next.subdir) rmSync(this.lastRunPath(), { force: true })
    return this.credentialView(next)
  }

  /**
   * Fold the branch into this machine, then collect the full pack, write it into
   * the mirror when it changed, and publish the difference. A push therefore never
   * overwrites what another machine published: the remote payload is merged first,
   * and the merged result is what the new commit holds.
   */
  async push(input: { message?: unknown; signal?: AbortSignal } = {}): Promise<MnemonSyncPushResult> {
    const settings = this.requireRepository()
    await this.requireGit(input.signal)
    const message = commitMessage(input.message, this.now())
    return this.lock(async () => {
      // Another machine can publish between this run's fetch and its push, and Git then
      // refuses the push. Folding the branch in again is exactly what the first attempt
      // did, so it is repeated once before the refusal is reported.
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
      // What this sync brought in is what every attempt merged, not only the last one.
      if (result.merged !== undefined && (added > 0 || result.merged.runtime !== undefined)) {
        result = { ...result, merged: { ...result.merged, runtime: { added, held, ...(archived > 0 ? { archived } : {}) } } }
      }
      // A branch that already held this payload is in sync as much as a published one.
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
    // The deletions this machine made since its last export have to be recorded before
    // the branch is folded in: the merge would otherwise restore an entry this machine
    // deleted, and the export that follows would report no removal at all.
    await this.packs.recordDeletions()
    const remote = await this.readPrepared(settings, prepared)
    let merged: MnemonSyncPushResult['merged']
    if (remote !== undefined) {
      // The branch's own removals are what make the fold-in a merge rather than an
      // import: an entry another machine deleted stays deleted here, and the ledger
      // that says so travels in the extension rather than in the payload. What both
      // last agreed on tells an older document from one both sides changed.
      const base = await this.agreedDocuments(settings, remote.commit, signal)
      const imported = await this.packs.importPack(
        Buffer.from(remote.archive).toString('base64'),
        { mode: 'merge', tombstones: { version: 1, tombstones: remote.tombstones }, ...(base === undefined ? {} : { documentsBase: base }) },
      )
      // This machine has now seen every document the branch holds, whether or not the
      // publish below succeeds: a retry, or the next sync, compares against these.
      if (imported.components.includes('documents')) this.agree(settings, remote.files, remote.commit)
      merged = {
        commit: remote.commit,
        ...(remote.machine === undefined ? {} : { machine: { id: remote.machine.id, label: remote.machine.label } }),
        components: imported.components, summary: imported.summary,
        tombstones: remote.tombstones.length,
        ...(imported.runtime === undefined ? {} : { runtime: imported.runtime }),
      }
    }
    // Stamping records which entries this machine wrote, and advances its own ledger
    // of what it deleted. Neither belongs in the payload, so the archive stays exactly
    // what the ZIP path produces and any version can still open it.
    const exported = await this.packs.exportPack('full', { stamp: true })
    const entries = unpack(Buffer.from(exported.base64, 'base64'))
    const extension: MnemonSyncRemoteExtension = {
      channel: 'git', branch: settings.branch, subdir: settings.subdir, pushedAt: exported.manifest.exportedAt,
      machine: this.machine.read(), tombstones: this.packs.tombstones().tombstones,
    }
    entries[MANIFEST] = new TextEncoder().encode(JSON.stringify({ ...exported.manifest, [SYNC_EXTENSION]: extension }, null, 2) + '\n')
    const before = readFiles(this.payloadRoot(settings.subdir))
    // A payload the branch already holds is left untouched: the work tree
    // stays clean, so Git records no second commit for the same bytes.
    if (prepared.tip === undefined || !holdsPayload(before, entries)) this.writePayload(settings.subdir, entries)
    // Every file of the payload is published, whatever ignore rules this machine or the branch
    // has, such as a global `*.db`: the sync directory holds the branch's payload and what was
    // just written there, nothing else, and a file the checksums list must reach the branch.
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
    // The branch now holds what this machine holds, so both agree on every document in it.
    if (published.pushed || (!committed && prepared.tip !== undefined)) this.agree(settings, entries, head)
    // Collecting the loose objects the new commit just wrote happens after the
    // branch has been updated, so a slow repack can never hold a publish back.
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

  /**
   * The saved default pair also appears in older settings that never selected an
   * author. Like blank fields, it defers to Git in the mirror's directory; only a
   * machine without a configured identity uses the channel's placeholder. Any
   * other pair keeps its explicit fields, even when one matches a default value.
   */
  private async commitIdentity(settings: MnemonSyncSettings, signal?: AbortSignal): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
    const defaults = settings.authorName === MNEMON_SYNC_DEFAULT_AUTHOR_NAME && settings.authorEmail === MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL
    const authorName = defaults ? '' : settings.authorName
    const authorEmail = defaults ? '' : settings.authorEmail
    const name = authorName !== '' ? authorName : await this.configured('user.name', signal) ?? MNEMON_SYNC_DEFAULT_AUTHOR_NAME
    const email = authorEmail !== '' ? authorEmail : await this.configured('user.email', signal) ?? MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL
    // Git's author/committer environment wins over -c user.*. An explicit sync
    // identity must win over the launching process too, for this commit alone.
    const env: NodeJS.ProcessEnv = {}
    if (authorName !== '') { env.GIT_AUTHOR_NAME = authorName; env.GIT_COMMITTER_NAME = authorName }
    if (authorEmail !== '') { env.GIT_AUTHOR_EMAIL = authorEmail; env.GIT_COMMITTER_EMAIL = authorEmail }
    return { args: ['-c', 'user.name=' + name, '-c', 'user.email=' + email], env }
  }

  /** One Git setting as this machine resolves it, or nothing when no config sets it. */
  private async configured(key: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.git(['config', '--get', key], { cwd: this.store.mirror(), signal })
    const value = result.exitCode === 0 ? result.stdout.trim() : ''
    return value === '' ? undefined : value
  }

  /** When memory last travelled through this channel, or nothing when it never did. */
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

  /** The repository, branch and directory one agreement belongs to. */
  private agreementScope(settings: MnemonSyncSettings & { repoUrl: string }): string {
    return sha256Hex(new TextEncoder().encode(JSON.stringify([settings.repoUrl, settings.branch, settings.subdir])))
  }

  /**
   * Each document's version as this machine and the branch last agreed on it, after the last
   * merge or publish, when that still describes the branch at `tip`: the same repository,
   * branch and directory, agreed at a commit `tip` descends from. A branch deleted and published
   * again from another history has none, nor has the first sync, and a merge then keeps a copy
   * of every document that differs, as before.
   */
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

  /**
   * Without an agreement on record, as after an update from dsh-mnemon 0.5.28, which remembered
   * only when it last synced: that run's commit holds the documents as the branch held them,
   * which this machine had just published or merged in. Read from there while the branch
   * descends from it, they keep the first sync after the update from taking a document this
   * machine edited since for a new one (#385). The record is dropped when the repository,
   * branch or directory changes, and every version read here is in the branch's own history;
   * one this machine never held is caught by the merge, which keeps a copy then.
   */
  private async lastRunDocuments(settings: MnemonSyncSettings & { repoUrl: string }, tip: string, signal?: AbortSignal): Promise<Record<string, string> | undefined> {
    const last = this.lastRun()
    if (last === undefined || !AGREED_COMMIT.test(last.commit)) return undefined
    try {
      const ancestry = await this.git(['merge-base', '--is-ancestor', last.commit, tip], { cwd: this.store.mirror(), signal })
      if (ancestry.exitCode !== 0) return undefined
      const index = await this.show(last.commit, settings.subdir + DOCUMENTS_INDEX_PATH, signal)
      return index === undefined ? undefined : documentVersions({ [DOCUMENTS_INDEX_PATH]: index })
    } catch (error) {
      // An old index that cannot be read is no agreement; the merge keeps copies, as without one.
      signal?.throwIfAborted()
      return undefined
    }
  }

  /** Remember what this machine and the branch at `commit` now agree on. Bookkeeping never fails the run it follows. */
  private agree(settings: MnemonSyncSettings & { repoUrl: string }, files: Record<string, Uint8Array>, commit: string): void {
    const path = this.basePath()
    const temporary = path + '.' + String(process.pid) + '.tmp'
    try {
      const documents = documentVersions(files)
      if (documents === undefined || !AGREED_COMMIT.test(commit)) {
        rmSync(path, { force: true })
        return
      }
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify({ version: 1, scope: this.agreementScope(settings), commit, documents }, null, 2) + '\n', { mode: 0o600 })
      renameSync(temporary, path)
    } catch {
      rmSync(temporary, { force: true })
    }
  }

  /** Remember one finished run. Bookkeeping never fails the run it describes. */
  private recordRun(run: Omit<MnemonSyncLastRun, 'at'>): void {
    const path = this.lastRunPath()
    const temporary = path + '.' + String(process.pid) + '.tmp'
    try {
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify({ at: this.now().toISOString(), ...run }, null, 2) + '\n', { mode: 0o600 })
      renameSync(temporary, path)
    } catch {
      rmSync(temporary, { force: true })
    }
  }

  /** Read the remote payload and report what it would change, without importing anything. */
  async preview(signal?: AbortSignal): Promise<MnemonSyncPreview> {
    const settings = this.requireRepository()
    await this.requireGit(signal)
    const exported = await this.packs.exportPack('full')
    return this.lock(async () => {
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

  /**
   * The commits on the branch that carry a Mnemon payload, newest first. The commit
   * message is whatever its author typed, so the manifest inside the commit is what
   * names the installation and says what the backup held. A commit whose manifest is
   * missing or unreadable is not a backup and is skipped rather than reported empty.
   */
  async backups(input: { limit?: number } = {}, signal?: AbortSignal): Promise<MnemonSyncBackupList> {
    const settings = this.requireRepository()
    await this.requireGit(signal)
    const limit = backupLimit(input.limit)
    return this.lock(async () => {
      // A branch with no payload yet is an empty history, not a failure: the reader
      // is asking what exists, and nothing existing is a valid answer.
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

  /**
   * What this machine holds and the branch tip holds, stated as entries. The byte-level
   * difference already lives in the preview; this answers the question a person asks
   * before merging — which memories are only here, which are only there, which subjects
   * both sides wrote down differently, and which removals the branch recorded that this
   * machine has not applied.
   */
  async diff(signal?: AbortSignal): Promise<MnemonSyncDiff> {
    const settings = this.requireRepository()
    await this.requireGit(signal)
    const exported = await this.packs.exportPack('full')
    return this.lock(async () => {
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
      // The same subject written twice is the only thing a person must decide about;
      // a memory that exists on one side alone is simply missing on the other.
      const found = conflictsOf(localOnly, remoteOnly).sort((left, right) => right.similarity - left.similarity)
      const conflicts = found.slice(0, MAX_DIFF_CONFLICTS)
      // An entry the branch holds and this machine once deleted stays out of every merge
      // until the reader says that deletion was wrong. Counting them here is what lets a
      // page that offers to add the branch's memories say how many the offer would skip.
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
        // A page that stopped early must say so: a reader who cannot tell a complete
        // difference from a cut-off one will merge on evidence that was never shown.
        truncated: mine.entries.length - shared > localOnly.length
          || theirs.entries.length - shared > remoteOnly.length
          || found.length > conflicts.length,
        heldBack,
        remoteTombstones: unappliedRemovals(local, mineTombstones, remote.tombstones),
      }
    })
  }

  /**
   * The branch side of the difference, for a planner that reads it as evidence rather
   * than as an answer. Every reason the difference cannot be read — no repository, no
   * git, an unpublished branch, an unreadable payload — means the same thing here: the
   * plan is local, exactly as it was before the branch could be read at all. Cancelling
   * the run is the one failure that still propagates.
   */
  async readRemoteForEvidence(signal?: AbortSignal): Promise<MnemonSyncDiff | undefined> {
    try {
      return await this.diff(signal)
    } catch (error) {
      if (signal?.aborted === true) throw error
      return undefined
    }
  }

  /** Preview the remote payload, then merge it through the importer Import ZIP uses. */
  async pull(input: { mode?: MnemonPackImportMode; components?: MnemonPackComponent[]; revive?: boolean; signal?: AbortSignal } = {}): Promise<MnemonSyncPullResult> {
    const settings = this.requireRepository()
    await this.requireGit(input.signal)
    const mode = input.mode ?? 'merge'
    const options: { mode: MnemonPackImportMode; components?: MnemonPackComponent[]; revive?: boolean } = {
      mode,
      ...(input.components === undefined ? {} : { components: input.components }),
      // Reviving is the reader overruling their own deletion; a plain merge keeps it.
      ...(input.revive === true ? { revive: true } : {}),
    }
    return this.lock(async () => {
      const remote = await this.readRemote(settings, input.signal)
      if (remote === undefined) throw this.absentPayload(settings)
      const base = input.components === undefined || input.components.includes('documents')
        ? await this.agreedDocuments(settings, remote.commit, input.signal) : undefined
      const imported = await this.packs.importPack(
        Buffer.from(remote.archive).toString('base64'),
        { ...options, tombstones: { version: 1, tombstones: remote.tombstones }, ...(base === undefined ? {} : { documentsBase: base }) },
      )
      // This machine has now seen every document the branch holds.
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

  /**
   * The branch tip the remote holds, or nothing when it holds no such branch. A
   * remote that cannot be read fails with the kind of failure it was, the token
   * masked, so the page can say "sign in" rather than print Git's trace.
   */
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

  /**
   * The commits that touched the payload directory, newest first, as raw log rows.
   * Path filtering is what makes this the backup history rather than the branch's
   * whole history: a commit that never touched the payload is not a backup.
   */
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

  /**
   * One file out of one commit, or nothing when that commit does not hold it.
   * Reading through the object store is what keeps the work tree, the index, and
   * `HEAD` untouched, so the next push still sees a clean tree.
   */
  private async show(commit: string, path: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const result = await this.git(['show', commit + ':' + path], {
      cwd: this.store.mirror(), signal, maxOutputBytes: MAX_FILE_BYTES,
    })
    if (result.exitCode !== 0) return undefined
    return showText(result.stdout)
  }

  /** One commit as a backup, or nothing when it does not actually carry a readable manifest. */
  private async backup(row: CommitRow, subdir: string, signal?: AbortSignal): Promise<MnemonSyncBackup | undefined> {
    const bytes = await this.show(row.commit, subdir + MANIFEST, signal)
    if (bytes === undefined) return undefined
    let manifest: MnemonPackManifest
    let machine: MnemonMachineIdentity | undefined
    let pushedAt: string | undefined
    try {
      const raw = record(parseJson(bytes, 'the backup manifest'))
      if (raw === undefined) return undefined
      // The manifest parser rebuilds its result and drops unknown top-level fields,
      // so the sync extension is read off the raw object, exactly as the tip is.
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

  /** The runtime byte budgets this installation enforces, so a remote payload is read by the same rules. */
  private runtimeLimits(): RuntimeMemoryLimits {
    return { memory: this.config.runtimeMemory.memoryLimitBytes, user: this.config.runtimeMemory.userLimitBytes }
  }

  /** Create or refresh the disposable mirror, and return the remote tip when the branch exists. */
  private async ensureMirror(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<{ tip?: string }> {
    const credential = await this.credential(settings)
    const mirror = this.store.mirror()
    mkdirSync(this.store.directory(), { recursive: true, mode: 0o700 })
    // A mirror belongs to the repository it was filled from. One filled from another
    // address still holds that repository's history, which a first push to an empty
    // branch would publish there, so it is rebuilt rather than reused.
    if (existsSync(join(mirror, '.git'))) {
      const origin = await this.git(['config', '--get', ORIGIN_KEY], { cwd: mirror, signal })
      if (origin.exitCode !== 0 || origin.stdout.trim() !== settings.repoUrl) rmSync(mirror, { recursive: true, force: true })
    }
    if (!existsSync(join(mirror, '.git'))) {
      rmSync(mirror, { recursive: true, force: true })
      // `--initial-branch` needs Git 2.28; HEAD is pointed at the branch just below instead.
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
    // The branch is the source of truth, so an unreachable remote fails here rather than at push time.
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
    // A reset keeps the files Git does not track, and the payload is read from the work tree:
    // the -wal and -shm SQLite leaves beside a database something opened in place failed every
    // sync as unchecksummed payload until someone deleted them (#396). The sync directory holds
    // the branch's payload and nothing else; the rest of the mirror is left as it is.
    const cleaned = await this.git(['clean', '-fdxq', '--', ':(literal)' + settings.subdir], { cwd: mirror, signal })
    if (cleaned.exitCode !== 0) throw new Error('git clean failed: ' + tail(cleaned.stderr || cleaned.stdout))
    // The payload read next is the one fetched, which another machine can have moved on since
    // `ls-remote` answered, so the commit reported for it is the one now checked out.
    return { tip: await this.head(signal) }
  }

  /**
   * Point the mirror at a branch the remote does not hold. The next commit starts a
   * history of its own: continuing the one this mirror kept, from a branch the remote
   * has since deleted, would publish every earlier payload all over again.
   */
  private async startHistory(branch: string, signal?: AbortSignal): Promise<void> {
    const mirror = this.store.mirror()
    // Deleting a branch the mirror never had is not a failure worth reporting.
    await this.git(['update-ref', '-d', 'refs/heads/' + branch], { cwd: mirror, signal })
    const emptied = await this.git(['read-tree', '--empty'], { cwd: mirror, signal })
    if (emptied.exitCode !== 0) throw new Error('git read-tree failed: ' + tail(emptied.stderr || emptied.stdout))
    const cleaned = await this.git(['clean', '-fdxq'], { cwd: mirror, signal })
    if (cleaned.exitCode !== 0) throw new Error('git clean failed: ' + tail(cleaned.stderr || cleaned.stdout))
  }

  /**
   * The payload directory inside the mirror. A link where that directory or one of
   * its parents should be would lead every read, removal and write out of the mirror,
   * so a path that crosses one is refused before anything touches it.
   */
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

  /** Replace the payload directory with exactly these entries. */
  private writePayload(subdir: string, entries: Record<string, Uint8Array>): void {
    const root = this.payloadRoot(subdir)
    const mirror = resolve(this.store.mirror())
    if (root === mirror || !root.startsWith(mirror + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error('sync directory escapes the mirror')
    }
    rmSync(root, { recursive: true, force: true })
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
    // The porcelain report of a refused ref is on stdout; Git's summary of it is on stderr.
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

  /**
   * Fold the mirror's loose objects into one pack and report what that recovered.
   *
   * Git stores every pushed payload as brand-new blobs, and a payload is the
   * whole pack, so the mirror accumulates a complete copy of each generation
   * until something repacks it. The pack is also the only thing a clone ever
   * downloads, so collecting it is what keeps both this mirror and a fresh
   * clone small. The mirror is disposable — a later fetch can always rebuild it
   * — so the aggressive window and depth cost nothing that matters.
   *
   * Compaction never fails a push: a mirror that cannot be repacked is still a
   * mirror that just published, so the reason travels back as a warning.
   */
  private async compact(signal?: AbortSignal): Promise<MnemonSyncCompaction | undefined> {
    let before: ObjectCount | undefined
    try {
      const counted = await this.git(['count-objects', '-v'], { cwd: this.store.mirror(), signal })
      if (counted.exitCode !== 0) return undefined
      before = objectCount(counted.stdout)
    } catch { return undefined }
    if (before === undefined) return undefined
    // Nothing loose means the last push published bytes the branch already had,
    // so repacking would rewrite the pack on every idle push for no gain. The
    // loose figure stays honest and the pack is reported as what a clone fetches.
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

  /** Refresh the mirror, then read the payload the branch holds. */
  private async readRemote(settings: MnemonSyncSettings & { repoUrl: string }, signal?: AbortSignal): Promise<RemotePayload | undefined> {
    return this.readPrepared(settings, await this.ensureMirror(settings, signal))
  }

  /** Validate the payload a refreshed mirror holds and rebuild the exact pack archive the ZIP path would have produced. */
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
    // The pin keeps the rebuilt archive byte-stable across timezones.
    const archive = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) })
    return {
      commit: prepared.tip, manifest: parsed as unknown as MnemonPackManifest,
      ...(pushedAt === undefined ? {} : { pushedAt }),
      ...(machine === undefined ? {} : { machine }),
      tombstones: extensionTombstones(extension),
      files, archive,
    }
  }

  /** Remove the credential from anything a user will read. */
  private mask(text: string, credential: SyncCredential): string {
    const token = credential.token
    if (token === undefined || token === '') return text
    return text.replaceAll(token, '***')
  }

  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    mkdirSync(this.store.directory(), { recursive: true, mode: 0o700 })
    return withDirectoryLock(join(this.store.directory(), '.sync.lock'), async () => {
      this.sweepCredentials()
      return operation()
    })
  }

  /**
   * Remove the one-command credential files a Host that stopped mid-command left
   * behind. Each holds a token, so one whose process is gone is deleted rather
   * than kept until the next restart of that process id.
   */
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

  /**
   * Hand the token to Git through a `0600` credential store that lives for one
   * command. The token never reaches an argument, a URL, a log, or the mirror,
   * and it is removed before the caller sees the result.
   *
   * Git must look the token up under the name the store holds, not under one this
   * machine configures, as Git Credential Manager setups do, nor by a path the store
   * does not hold (#408). Git 2.26 and later are told so on the command line, which
   * they read last and let win, and are given the address without a user name, as
   * Git offers a name it finds there once without the token. An older Git kept the
   * first name it read, and only a name in the address comes before that: the name
   * goes there only where this machine's configuration names another, and the path
   * leaves the lookup only where it puts the path in, so every other command, one
   * that configures the store's own name included, stays the one that has always run.
   */
  private async credentials(args: string[], options: GitOptions): Promise<{ args: string[]; cleanup: () => void }> {
    const token = options.token
    if (token === undefined || token === '' || options.authenticated !== true) return { args: [...NO_REWRITE, ...args], cleanup: () => {} }
    const index = args.findIndex(argument => argument.startsWith('https://'))
    if (index === -1) return { args: [...NO_REWRITE, ...args], cleanup: () => {} }
    const url = args[index]!
    const target = credentialTarget(url)
    const command = [...args]
    const lookup: string[] = []
    if (this.gitVersion !== undefined && versionAtLeast(this.gitVersion, LAST_USERNAME_WINS_GIT)) {
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
      args: [...NO_REWRITE, '-c', 'credential.helper=', '-c', 'credential.helper=store --file=' + shellQuote(path), ...lookup, ...command],
      cleanup: () => { rmSync(path, { force: true }) },
    }
  }

  /**
   * The user name this machine's configuration gives an address, if any, and whether
   * it adds the address's path to the lookup, read in the environment and directory
   * the command runs in. A configuration Git cannot read leaves the command as it
   * was, which fails on it the same way.
   */
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
      // One `key value` per line, the value as written. Git prints a key written without
      // a value alone, and refuses it in a credential section ("bad config variable"),
      // so the command fails on it whatever it is given.
      for (const line of result.stdout.split(/\r?\n/u)) {
        const space = line.indexOf(' ')
        if (space > 0) settings.set(line.slice(0, space).toLowerCase(), line.slice(space + 1))
      }
    }
    const path = settings.get('credential.usehttppath')
    return { user: settings.get('credential.username'), path: path !== undefined && gitBoolean(path) }
  }
}

/**
 * How the payload files differ. The manifest and the checksum inventory describe a
 * payload rather than hold memory, and the manifest's export time differs on every
 * read, so counting them would report a difference where every component agrees.
 */
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

/** Whether a process of this machine still runs; one the Host may not signal is assumed alive. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether a lock was left by an operation that can no longer release it: its owner
 * process is gone, or it is older than any sync takes. The age also covers a
 * process id that a restart handed to an unrelated process.
 */
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
    // The owner record is written right after the directory: a lock without one is
    // either still being taken or left by a version that kept no record.
    return age > OWNERLESS_LOCK_MS
  }
}

/**
 * A single-writer lock for one storage root's sync work; the pack locks cover the
 * shared data. The lock records its owner, so a Host that stopped mid-operation
 * does not leave every later sync refused until someone deletes the directory.
 */
async function withDirectoryLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let held = false
  while (!held && Date.now() < deadline) {
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 })
      held = true
    } catch {
      if (abandoned(path, Date.now())) {
        // Moving the lock aside is atomic, so of two waiters that found it abandoned only
        // one takes it over; the other finds it gone, or taken again, and keeps waiting.
        const aside = path + '.abandoned.' + String(process.pid) + '.' + String(Date.now())
        try {
          if (abandoned(path, Date.now())) renameSync(path, aside)
        } catch {
          continue
        }
        rmSync(aside, { recursive: true, force: true })
        continue
      }
      await new Promise<void>(resolveReady => setTimeout(resolveReady, 25))
    }
  }
  if (!held) throw new MnemonSyncError('busy', 'another Mnemon sync operation is still running')
  try {
    writeFileSync(join(path, LOCK_OWNER), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
  } catch {
    // The lock still holds without its record; only its recovery falls back to the age.
  }
  try {
    return await operation()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}
