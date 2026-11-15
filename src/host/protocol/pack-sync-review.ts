import type { StorageScopeKind } from './config.ts'

export type MnemonPackComponent = 'runtime' | 'documents' | 'memory-spaces'
/** The Sources that keep their data in Mnemon's data directory, in the order a backup lists them. */
export const MNEMON_PACK_COMPONENTS = ['runtime', 'documents', 'memory-spaces'] as const satisfies readonly MnemonPackComponent[]
export type MnemonPackScope = 'full' | MnemonPackComponent
export type MnemonPackImportMode = 'merge' | 'replace'

export interface MnemonPackComponentSummary {
  component: MnemonPackComponent
  files: number
  bytes: number
  items: number
}

export interface MnemonPackManifest {
  format: 'mnemonpack'
  version: 1
  scope: MnemonPackScope
  exportedAt: string
  source: { plugin: 'dsh-mnemon'; pluginVersion: string }
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
}

/** Where memory lives now, and where the global scope keeps it when no directory is chosen. */
export interface MnemonPackTarget {
  root: string
  scope: StorageScopeKind
  defaultRoot: string
  /** Optional on older Hosts; only a native DSH backend can open an OS chooser. */
  nativeDirectoryPicker?: boolean
}

export interface MnemonPackExport {
  fileName: string
  mimeType: 'application/zip'
  bytes: number
  base64: string
  targetRoot: string
  manifest: MnemonPackManifest
}

export interface MnemonPackPreview {
  fileName?: string
  archiveBytes: number
  expandedBytes: number
  targetRoot: string
  targetScope: StorageScopeKind
  manifest: MnemonPackManifest
  occupied: Record<MnemonPackComponent, boolean>
}

/**
 * What a merge did to the runtime entries, stated as counts rather than as a file.
 * A page that reports "added" without this number is guessing, and a merge that
 * leaves an entry out because a tombstone still hides it has to say how many.
 */
export interface MnemonRuntimeMergeReport {
  /** Incoming entries this merge admitted to hot runtime memory. */
  added: number
  /** Incoming entries a tombstone still hides, so the merge left them out. */
  held: number
  /** Exact MEMORY records newly saved in the local import-overflow archive. */
  archived?: number
}

export interface MnemonPackImportResult {
  imported: true
  mode: MnemonPackImportMode
  targetRoot: string
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
  /** Present when this import merged runtime entries. */
  runtime?: MnemonRuntimeMergeReport
}

/**
 * The identity one installation signs its entries with. It stays in the data
 * directory's state area, which no Pack component carries, and travels only
 * over the sync channel, never inside a Pack.
 */
export interface MnemonMachineIdentity {
  id: string
  label: string
  createdAt: string
}

/**
 * Where an installation's name comes from: the host name of the computer it runs on,
 * which the name then follows, or a name a person typed, which stays as given.
 */
export type MnemonMachineLabelSource = 'hostname' | 'custom'

/** Which machine wrote one runtime entry, so a merge can tell two installations apart. */
export interface MnemonEntryOrigin {
  machine: string
  label: string
  at: string
}

/** One entry one machine removed, so the removal survives a merge instead of resurrecting. */
export interface MnemonTombstone {
  target: 'memory' | 'user'
  contentHash: string
  deletedAt: string
  machine?: string
}

export interface MnemonTombstoneFile {
  version: 1
  tombstones: MnemonTombstone[]
}

/** What one memory reconciliation proposes, and why. Nothing here is applied until a reviewer accepts it. */
export type MnemonReconcileOperation =
  | { kind: 'runtime-add'; target: 'memory' | 'user'; content: string; importance: 'critical' | 'normal' | 'low'; branches?: string[]; reason: string }
  | { kind: 'runtime-replace'; target: 'memory' | 'user'; oldText: string; content: string; importance?: 'critical' | 'normal' | 'low'; branches?: string[]; reason: string }
  | { kind: 'runtime-remove'; target: 'memory' | 'user'; oldText: string; reason: string }
  | { kind: 'document-archive'; documentId: string; reason: string }

export type MnemonReviewStatus = 'pending' | 'accepted' | 'rejected'

/** One reviewer's opinion on a proposal. Accepting or rejecting never replaces writing what one thinks. */
export interface MnemonReviewOpinion {
  id: string
  author: 'user' | 'agent'
  text: string
  createdAt: string
}

export interface MnemonReviewEntry {
  id: string
  createdAt: string
  updatedAt: string
  status: MnemonReviewStatus
  title: string
  summary: string
  /** The installation that produced the proposal. */
  machine: { id: string; label: string }
  /** Other installations whose entries the proposal touches, so a reviewer sees whose memory is at stake. */
  foreignMachines: string[]
  operations: MnemonReconcileOperation[]
  opinions: MnemonReviewOpinion[]
  decidedAt?: string
  appliedAt?: string
  /**
   * The positions in `operations` that have already run. Applying a plan is repeatable
   * because a reviewer can keep only part of it: a position written here is never offered
   * again, and a plan whose every operation ran is history rather than work.
   */
  appliedOperations?: number[]
  failure?: string
}

export interface MnemonReviewLedgerView {
  path: string
  entries: MnemonReviewEntry[]
  pending: number
  /**
   * The newest proposal, and only it, carried with the list so a caller can read what
   * the last run proposed without a second round trip. Its operations are withheld
   * here: the list is a summary, and one plan can hold `MAX_RECONCILE_OPERATIONS` changes.
   */
  latest?: MnemonReviewEntry
}

export interface MnemonReviewApplyResult {
  entry: MnemonReviewEntry
  applied: number
  failures: string[]
}

/** What a reconciliation run is told beyond the memory it reads. */
export interface MnemonReconcileOptions {
  /**
   * The reviewer's own words: what the plan should accomplish. It shapes the plan and
   * never widens it - the host still decides what an operation may contain.
   */
  guidance?: string
}

/** What one reconciliation run produced. A run with no findings creates no review. */
export interface MnemonReconcileResult {
  /** One line a reviewer scans in the ledger list. */
  title: string
  summary: string
  action: 'planned' | 'none' | 'failed'
  /** How many operations the proposal holds; the review entry carries the details. */
  operations: number
  foreignMachines: string[]
  /** How many entries the branch held that this installation had not merged, when it could be read. */
  remoteEntries?: number
  /** Whether the plan was given the reviewer's own words to follow. */
  guided?: boolean
  entry?: MnemonReviewEntry
  provider: string
  runId: string
}

/**
 * Git repository sync: the Mnemon Pack payload published as readable files on one
 * branch, so a second machine can pull it back. Push and pull are confirmed
 * actions, and the token is read per operation and never leaves the Host.
 */
export interface MnemonSyncConfigView {
  /**
   * Whether this profile syncs at all. It lives in the profile rather than in the
   * data directory so the settings page can draw the block without asking the Host
   * anything - a disabled block must not run a single Git command to render.
   */
  enabled: boolean
  repoUrl?: string
  branch: string
  subdir: string
  /** Whether a credential is available; its value is never part of an answer. */
  hasToken: boolean
  /** Where the credential the channel would authenticate with comes from. */
  credentialSource: MnemonSyncCredentialSource
  /** The GitHub account the stored grant belongs to, when that is the source. */
  credentialLogin?: string
  authorName: string
  authorEmail: string
  /** Minutes between automatic backups; zero means the channel runs only when asked. */
  autoBackupMinutes: number
}

/**
 * The credential the next Git operation authenticates with. The environment
 * wins over the stored token, and the GitHub sign-in is what a user reaches for
 * when neither is set: the order here is the order of resolution.
 */
export type MnemonSyncCredentialSource = 'environment' | 'token' | 'github' | 'none'

export interface MnemonSyncGitHubFlow {
  userCode: string
  verificationUri: string
  /** When the code stops being accepted, as an ISO timestamp. */
  expiresAt: string
  /** The cadence the Host polls at, so the page can match it. */
  intervalMs: number
}

/** The sign-in surface: whether it is possible, and how far it has come. */
export interface MnemonSyncGitHubStatus {
  /** Whether this Host exposes a credentials store the grant can live in. */
  available: boolean
  signedIn: boolean
  /** Whether the store accepts writes, which a read-only source denies. */
  writable: boolean
  login?: string
  scopes?: string[]
  flow?: MnemonSyncGitHubFlow
}

export interface MnemonSyncGitHubPoll {
  status: 'pending' | 'success' | 'expired' | 'denied' | 'error'
  /** The cadence to wait for before asking again. */
  intervalMs?: number
  login?: string
  /** Why the sign-in ended without a grant, when it did. */
  message?: string
}

export interface MnemonSyncGitHubRepository {
  name: string
  fullName: string
  /** The HTTPS address Git clones, which is what the channel stores. */
  url: string
  private: boolean
  defaultBranch: string
  owner: string
  /** Whether the account may push here; a repository it cannot is shown disabled. */
  push: boolean
}

export interface MnemonSyncGitHubRepositoryList {
  login: string
  repositories: MnemonSyncGitHubRepository[]
}

export interface MnemonSyncGitStatus {
  available: boolean
  required: string
  version?: string
  /** Why Git cannot serve the channel, when it cannot. */
  issue?: string
}

/**
 * Why a remote could not be read, as a code the settings page names in its own
 * language: credentials missing or refused, an address that leads nowhere, a
 * network that does not reach the host, or a host that did not answer in time.
 */
export type MnemonSyncRemoteIssue = 'auth' | 'not-found' | 'network' | 'timeout' | 'unknown'

/**
 * Why a sync operation did not run or did not finish. The message beside it is
 * Git's or the Host's own words; the reason is what a page can translate and act
 * on, so an operator reads "sign in or add a token" rather than a Git trace.
 */
export type MnemonSyncFailureReason =
  | 'busy'
  | 'no-repository'
  | 'git-missing'
  | 'remote-empty'
  | 'remote-auth'
  | 'remote-not-found'
  | 'remote-network'
  | 'remote-timeout'
  | 'push-rejected'
  | 'github-unauthorized'

export interface MnemonSyncRemoteStatus {
  reachable: boolean
  branchExists: boolean
  commit?: string
  error?: string
  /** What kind of failure `error` is, when the remote could not be read. */
  issue?: MnemonSyncRemoteIssue
}

/**
 * The last sync this installation finished, kept on disk so a restart still
 * says when memory last travelled. `sync` merged the branch and published the
 * result; `merge` only merged the branch here.
 */
export interface MnemonSyncLastRun {
  at: string
  kind: 'sync' | 'merge'
  commit: string
  /** Whether the commit reached the remote; a merge never publishes. */
  pushed: boolean
  /** Remote runtime entries the merge wrote here. */
  added?: number
}

export interface MnemonSyncCommit {
  id: string
  message: string
  committedAt: string
}

export interface MnemonSyncStatus {
  /** Whether this profile syncs at all; when false nothing else here was checked. */
  enabled: boolean
  configured: boolean
  config: MnemonSyncConfigView
  configPath: string
  /** The disposable Git work tree the channel commits in. */
  mirrorPath: string
  git: MnemonSyncGitStatus
  remote: MnemonSyncRemoteStatus
  /**
   * This installation's identity, which its entries and its commits carry. Absent
   * while sync is switched off: the identity is only ever minted for a channel that
   * runs, and a disabled block writes nothing.
   */
  machine?: MnemonMachineIdentity
  /**
   * How `machine.label` is chosen, with the host name a host-name label follows.
   * Present with `machine`; it describes this computer and is never published.
   */
  machineLabel?: { source: MnemonMachineLabelSource; hostname: string }
  lastCommit?: MnemonSyncCommit
  /** The last sync or merge this installation finished. */
  lastRun?: MnemonSyncLastRun
  /** The background cadence this Host keeps; absent when no timer runs for this runtime. */
  autoBackup?: MnemonSyncAutoBackup
}

/**
 * The background cadence one runtime keeps. The timer never writes memory: it
 * repeats the same confirmed push the button runs, and the merge a push
 * performs is the only thing that brings remote entries in.
 */
export interface MnemonSyncAutoBackup {
  /** Whether this Host runs a background backup at all. */
  available: boolean
  /** When the last automatic run finished, as an ISO timestamp. */
  lastAt?: string
  /** When the next automatic run is due, as an ISO timestamp. */
  nextAt?: string
  /** Why the last automatic run failed, when it did. */
  lastError?: string
  /** The kind of failure `lastError` is, when the Host could tell. */
  lastFailure?: MnemonSyncFailureReason
  /** The commit the last automatic run recorded. */
  lastCommit?: string
  /** Whether the last automatic run reached the branch. */
  lastPushed?: boolean
}

/**
 * What folding the mirror's loose objects into one pack recovered. Git keeps
 * every payload as new blobs until a repack runs, so a mirror that is never
 * repacked grows with every push while the pack is what a clone downloads.
 */
export interface MnemonSyncCompaction {
  /** Loose objects before the repack. */
  loose: number
  /** What those loose objects weighed, in bytes; zero when none were loose. */
  bytes: number
  /** Objects the pack holds afterwards. */
  packed: number
  /**
   * What a clone downloads, in bytes: the pack after the repack, or - when the
   * push wrote nothing new - the pack that was already there.
   */
  packedBytes: number
  /** Why the mirror was left alone, when it was; the push itself still succeeded. */
  warning?: string
}

export interface MnemonSyncPushResult {
  repoUrl: string
  branch: string
  subdir: string
  /** The commit holding this payload in the mirror. */
  commit: string
  /** Whether this run recorded a new commit; a repeat of the same payload does not. */
  committed: boolean
  message: string
  files: number
  bytes: number
  summary: MnemonPackComponentSummary[]
  pushed: boolean
  /**
   * What a push folded in from the branch before publishing. A push never
   * overwrites a remote payload: the remote is merged into this machine first,
   * and the merged result is what the new commit holds.
   */
  merged?: {
    commit: string
    machine?: { id: string; label: string }
    components: MnemonPackComponent[]
    summary: MnemonPackComponentSummary[]
    /** Entries the merge dropped because a tombstone removed them. */
    tombstones: number
    /** What the merge wrote into this machine's runtime memory. */
    runtime?: MnemonRuntimeMergeReport
  }
  /** Why the branch was not published, when it was not. */
  reason?: string
  /** The kind of failure `reason` describes, when the Host could tell. */
  failure?: MnemonSyncFailureReason
  /** What folding the mirror's loose objects into a pack recovered, when it ran. */
  compaction?: MnemonSyncCompaction
}

export interface MnemonSyncComponentDelta extends MnemonPackComponentSummary {
  /** Whether the remote payload differs from this machine's for the component. */
  changed: boolean
}

export interface MnemonSyncFileDelta {
  total: number
  changed: number
  added: number
  removed: number
}

export interface MnemonSyncPreview {
  repoUrl: string
  branch: string
  subdir: string
  commit: string
  pushedAt?: string
  manifest: MnemonPackManifest
  archiveBytes: number
  expandedBytes: number
  targetRoot: string
  targetScope: StorageScopeKind
  occupied: Record<MnemonPackComponent, boolean>
  components: MnemonSyncComponentDelta[]
  files: MnemonSyncFileDelta
  /** When this machine's payload was collected for the comparison. */
  localExportAt: string
}

export interface MnemonSyncPullResult {
  imported: true
  mode: MnemonPackImportMode
  repoUrl: string
  branch: string
  subdir: string
  commit: string
  pushedAt?: string
  manifest: MnemonPackManifest
  targetRoot: string
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
  /** Present when this pull merged runtime entries. */
  runtime?: MnemonRuntimeMergeReport
}

/**
 * One commit on the sync branch that carries a Mnemon payload. The manifest inside
 * the commit is what says which installation published it and what it held; the
 * commit itself only says when and with which message.
 */
export interface MnemonSyncBackup {
  commit: string
  message: string
  committedAt: string
  /** The installation that published this backup, when the manifest names one. */
  machine?: MnemonMachineIdentity
  pushedAt?: string
  components: MnemonPackComponentSummary[]
}

export interface MnemonSyncBackupList {
  repoUrl: string
  branch: string
  subdir: string
  commits: MnemonSyncBackup[]
  /** Whether commits older than the requested window exist on the branch. */
  truncated: boolean
}

/** One runtime entry, as a difference between this machine and the branch shows it. */
export interface MnemonSyncDiffEntry {
  target: 'memory' | 'user'
  content: string
  importance: 'critical' | 'normal' | 'low'
  /** Which installation wrote it, when that is not this machine. */
  origin?: MnemonEntryOrigin
}

/**
 * One memory this machine holds and the branch holds a different wording of: the same
 * subject written twice, so the two texts cannot both stand. Entries that merely exist
 * on one side are additions, not conflicts, and never appear here.
 */
export interface MnemonSyncDiffConflict {
  target: 'memory' | 'user'
  /** What this machine holds. */
  local: MnemonSyncDiffEntry
  /** What the branch holds, with the installation that wrote it. */
  remote: MnemonSyncDiffEntry
  /** How alike the two texts are, from 0 to 1, after normalization. */
  similarity: number
}

export interface MnemonSyncDiffSide {
  /** The manifest identity of the side: this machine's export, or the commit. */
  exportedAt: string
  entries: number
  machine?: MnemonMachineIdentity
}

/**
 * What this machine holds and the branch tip holds, stated as entries rather than
 * as bytes: which memories are only here, which are only there, and which removals
 * the branch recorded that this machine has not applied.
 */
export interface MnemonSyncDiff {
  repoUrl: string
  branch: string
  subdir: string
  commit: string
  pushedAt?: string
  localExportAt: string
  local: MnemonSyncDiffSide
  remote: MnemonSyncDiffSide
  localOnly: MnemonSyncDiffEntry[]
  remoteOnly: MnemonSyncDiffEntry[]
  /**
   * The same subject recorded differently on both sides. Only these need reconciling;
   * anything that exists on one side alone can simply be added.
   */
  conflicts: MnemonSyncDiffConflict[]
  /** How many entries both sides hold, compared by target and content. */
  shared: number
  /** Whether a side held more differences than this response lists. */
  truncated: boolean
  /**
   * How many of the entries the branch holds and this machine does not are held
   * back by this machine's own tombstones: a merge would leave every one of them
   * out, so a page that offers to add them has to say what that offer would do.
   */
  heldBack: number
  remoteTombstones: MnemonTombstone[]
}
