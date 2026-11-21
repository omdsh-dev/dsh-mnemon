import type { StorageScopeKind } from './config.ts'

export type MnemonPackComponent = 'runtime' | 'documents' | 'memory-spaces'
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

export interface MnemonPackTarget {
  root: string
  scope: StorageScopeKind
  defaultRoot: string
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

export interface MnemonRuntimeMergeReport {
  added: number
  held: number
  archived?: number
}

export interface MnemonPackImportResult {
  imported: true
  mode: MnemonPackImportMode
  targetRoot: string
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
  runtime?: MnemonRuntimeMergeReport
}

export interface MnemonMachineIdentity {
  id: string
  label: string
  createdAt: string
}

export type MnemonMachineLabelSource = 'hostname' | 'custom'

export interface MnemonEntryOrigin {
  machine: string
  label: string
  at: string
}

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

export type MnemonReconcileOperation =
  | { kind: 'runtime-add'; target: 'memory' | 'user'; content: string; importance: 'critical' | 'normal' | 'low'; branches?: string[]; reason: string }
  | { kind: 'runtime-replace'; target: 'memory' | 'user'; oldText: string; content: string; importance?: 'critical' | 'normal' | 'low'; branches?: string[]; reason: string }
  | { kind: 'runtime-remove'; target: 'memory' | 'user'; oldText: string; reason: string }
  | { kind: 'document-archive'; documentId: string; reason: string }

export type MnemonReviewStatus = 'pending' | 'accepted' | 'rejected'

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
  machine: { id: string; label: string }
  foreignMachines: string[]
  operations: MnemonReconcileOperation[]
  opinions: MnemonReviewOpinion[]
  decidedAt?: string
  appliedAt?: string
  appliedOperations?: number[]
  failure?: string
}

export interface MnemonReviewLedgerView {
  path: string
  entries: MnemonReviewEntry[]
  pending: number
  latest?: MnemonReviewEntry
}

export interface MnemonReviewApplyResult {
  entry: MnemonReviewEntry
  applied: number
  failures: string[]
}

export interface MnemonReconcileOptions {
  guidance?: string
}

export interface MnemonReconcileResult {
  title: string
  summary: string
  action: 'planned' | 'none' | 'failed'
  operations: number
  foreignMachines: string[]
  remoteEntries?: number
  guided?: boolean
  entry?: MnemonReviewEntry
  provider: string
  runId: string
}

export interface MnemonSyncConfigView {
  enabled: boolean
  repoUrl?: string
  branch: string
  subdir: string
  hasToken: boolean
  credentialSource: MnemonSyncCredentialSource
  credentialLogin?: string
  authorName: string
  authorEmail: string
  autoBackupMinutes: number
}

export type MnemonSyncCredentialSource = 'environment' | 'token' | 'github' | 'none'

export interface MnemonSyncGitHubFlow {
  userCode: string
  verificationUri: string
  expiresAt: string
  intervalMs: number
}

export interface MnemonSyncGitHubStatus {
  available: boolean
  signedIn: boolean
  writable: boolean
  login?: string
  scopes?: string[]
  flow?: MnemonSyncGitHubFlow
}

export interface MnemonSyncGitHubPoll {
  status: 'pending' | 'success' | 'expired' | 'denied' | 'error'
  intervalMs?: number
  login?: string
  message?: string
}

export interface MnemonSyncGitHubRepository {
  name: string
  fullName: string
  url: string
  private: boolean
  defaultBranch: string
  owner: string
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
  issue?: string
}

export type MnemonSyncRemoteIssue = 'auth' | 'not-found' | 'network' | 'timeout' | 'unknown'

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
  issue?: MnemonSyncRemoteIssue
}

export interface MnemonSyncLastRun {
  at: string
  kind: 'sync' | 'merge'
  commit: string
  pushed: boolean
  added?: number
}

export interface MnemonSyncCommit {
  id: string
  message: string
  committedAt: string
}

export interface MnemonSyncStatus {
  enabled: boolean
  configured: boolean
  config: MnemonSyncConfigView
  configPath: string
  mirrorPath: string
  git: MnemonSyncGitStatus
  remote: MnemonSyncRemoteStatus
  machine?: MnemonMachineIdentity
  machineLabel?: { source: MnemonMachineLabelSource; hostname: string }
  lastCommit?: MnemonSyncCommit
  lastRun?: MnemonSyncLastRun
  autoBackup?: MnemonSyncAutoBackup
}

export interface MnemonSyncAutoBackup {
  available: boolean
  lastAt?: string
  nextAt?: string
  lastError?: string
  lastFailure?: MnemonSyncFailureReason
  lastCommit?: string
  lastPushed?: boolean
}

export interface MnemonSyncCompaction {
  loose: number
  bytes: number
  packed: number
  packedBytes: number
  warning?: string
}

export interface MnemonSyncPushResult {
  repoUrl: string
  branch: string
  subdir: string
  commit: string
  committed: boolean
  message: string
  files: number
  bytes: number
  summary: MnemonPackComponentSummary[]
  pushed: boolean
  merged?: {
    commit: string
    machine?: { id: string; label: string }
    components: MnemonPackComponent[]
    summary: MnemonPackComponentSummary[]
    tombstones: number
    runtime?: MnemonRuntimeMergeReport
  }
  reason?: string
  failure?: MnemonSyncFailureReason
  compaction?: MnemonSyncCompaction
}

export interface MnemonSyncComponentDelta extends MnemonPackComponentSummary {
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
  runtime?: MnemonRuntimeMergeReport
}

export interface MnemonSyncBackup {
  commit: string
  message: string
  committedAt: string
  machine?: MnemonMachineIdentity
  pushedAt?: string
  components: MnemonPackComponentSummary[]
}

export interface MnemonSyncBackupList {
  repoUrl: string
  branch: string
  subdir: string
  commits: MnemonSyncBackup[]
  truncated: boolean
}

export interface MnemonSyncDiffEntry {
  target: 'memory' | 'user'
  content: string
  importance: 'critical' | 'normal' | 'low'
  origin?: MnemonEntryOrigin
}

export interface MnemonSyncDiffConflict {
  target: 'memory' | 'user'
  local: MnemonSyncDiffEntry
  remote: MnemonSyncDiffEntry
  similarity: number
}

export interface MnemonSyncDiffSide {
  exportedAt: string
  entries: number
  machine?: MnemonMachineIdentity
}

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
  conflicts: MnemonSyncDiffConflict[]
  shared: number
  truncated: boolean
  heldBack: number
  remoteTombstones: MnemonTombstone[]
}
