import {
  githubRepositoryNameValid,
  machineLabelValid,
  MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL,
  MNEMON_SYNC_DEFAULT_AUTHOR_NAME,
  MNEMON_SYNC_TOKEN_ENV,
  portableAbsolutePath,
  syncBranchValid,
  syncDirectoryParts,
  syncEmailValid,
  syncRepositoryProblem,
  type MnemonSyncCredentialSource,
  type MnemonSyncFailureReason,
  type MnemonSyncRemoteIssue,
  type MnemonSyncRepositoryProblem,
  type MnemonSyncStatus,
} from '../host/protocol.ts'
import type { MnemonTranslate } from './locales.ts'

/** How Git reaches a repository, which decides what a credential means for it. */
export type SyncTransport = 'https' | 'ssh' | 'local'

/** The transport one repository address uses. */
export function transportOf(url: string): SyncTransport {
  const value = url.trim()
  if (/^https:\/\//iu.test(value)) return 'https'
  if (/^ssh:\/\//iu.test(value) || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/u.test(value)) return 'ssh'
  return 'local'
}

/** Whether an address is HTTPS on github.com, the only host a GitHub sign-in is offered to. */
export function onGitHub(url: string): boolean {
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}

/** A repository address as a reader recognizes it: host and path, without the scheme or `.git`. */
export function repositoryName(url: string): string {
  const value = url.trim()
  if (transportOf(value) !== 'https' && !/^ssh:\/\//iu.test(value)) return value
  try {
    const parsed = new URL(value)
    return (parsed.host + parsed.pathname).replace(/\.git$/u, '').replace(/\/$/u, '')
  } catch {
    return value
  }
}

/** What is wrong with a typed repository address, by the Host's rules; a local path is checked as the browser can. */
export type RepositoryProblem = MnemonSyncRepositoryProblem

export function repositoryProblem(url: string): RepositoryProblem | undefined {
  const value = url.trim()
  // An empty address clears the repository.
  return value === '' ? undefined : syncRepositoryProblem(value, portableAbsolutePath)
}

/** A Git branch name, as the Host checks it. */
export function branchValid(value: string): boolean {
  return syncBranchValid(value.trim())
}

/** A directory inside the branch, as the Host checks it. */
export function directoryValid(value: string): boolean {
  return syncDirectoryParts(value) !== undefined
}

export function emailValid(value: string): boolean {
  return syncEmailValid(value.trim())
}

/** A name for this computer, as the Host stores one: one line, at most the shared limit. */
export function machineNameValid(value: string): boolean {
  return machineLabelValid(value.trim())
}

/** A GitHub repository name, as GitHub accepts one. */
export function repositoryNameValid(value: string): boolean {
  return githubRepositoryNameValid(value.trim())
}

/** Default and blank settings follow Git; a custom pair supplies explicit fields. */
export type AuthorMode = 'default' | 'machine' | 'custom'

export function authorModeOf(name: string, email: string): AuthorMode {
  if (name === MNEMON_SYNC_DEFAULT_AUTHOR_NAME && email === MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL) return 'default'
  if (name === '' && email === '') return 'machine'
  return 'custom'
}

/** The channel identity as a commit shows it. */
export const DEFAULT_AUTHOR = MNEMON_SYNC_DEFAULT_AUTHOR_NAME + ' <' + MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL + '>'

/** The intervals automatic sync offers, in minutes; off first, then an hour up to a week. */
export const AUTO_SYNC_CHOICES: readonly number[] = [0, 60, 180, 360, 720, 1_440, 4_320, 10_080]

/** One interval as a reader reads it. */
export function intervalLabel(t: MnemonTranslate, minutes: number): string {
  if (minutes <= 0) return t('config.syncAutoOff')
  if (minutes === 60) return t('config.syncAutoHour')
  if (minutes === 1_440) return t('config.syncAutoDay')
  if (minutes % 1_440 === 0) return t('config.syncAutoDays', { days: minutes / 1_440 })
  return t('config.syncAutoHours', { hours: minutes / 60 })
}

/** A time as a short local stamp: the time alone today, the date beside it otherwise. */
export function when(value: string | undefined, now: Date = new Date()): string {
  if (value === undefined) return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Why a remote could not be read, said for the transport the repository uses and for the credential
 * the Host offered it, which `credential` names as the status does.
 */
export function issueText(t: MnemonTranslate, issue: MnemonSyncRemoteIssue | undefined, url: string, error?: string, credential: MnemonSyncCredentialSource = 'none'): string {
  const transport = transportOf(url)
  switch (issue) {
    case 'auth':
      // A credential the host refused is not fixed by adding one, so the page says it was refused.
      if (transport === 'https' && credential !== 'none') return rejectedText(t, url, credential)
      // A GitHub sign-in is offered to github.com alone; any other HTTPS host takes a token.
      if (transport === 'https') return onGitHub(url) ? t('config.syncIssueAuthHttps') : t('config.syncIssueAuthToken')
      return transport === 'ssh' ? t('config.syncIssueAuthSsh') : t('config.syncIssueAuth')
    case 'not-found':
      return onGitHub(url) ? t('config.syncIssueNotFoundGitHub') : t('config.syncIssueNotFound')
    case 'network': return t('config.syncIssueNetwork')
    case 'timeout': return t('config.syncIssueTimeout')
    default: return t('config.syncIssueUnknown', { error: error ?? '' })
  }
}

/**
 * A credential the host refused, said for where it came from: a saved token or the environment variable
 * comes before the GitHub sign-in, so only replacing that one changes what Git is given.
 */
function rejectedText(t: MnemonTranslate, url: string, credential: Exclude<MnemonSyncCredentialSource, 'none'>): string {
  const github = onGitHub(url)
  if (credential === 'environment') return t(github ? 'config.syncIssueRejectedGitHubEnvironment' : 'config.syncIssueRejectedEnvironment', { env: MNEMON_SYNC_TOKEN_ENV })
  if (credential === 'github') return t('config.syncIssueRejectedGitHub')
  return t(github ? 'config.syncIssueRejectedGitHubToken' : 'config.syncIssueRejected')
}

const REMOTE_ISSUE: Partial<Record<MnemonSyncFailureReason, MnemonSyncRemoteIssue>> = {
  'remote-auth': 'auth',
  'remote-not-found': 'not-found',
  'remote-network': 'network',
  'remote-timeout': 'timeout',
}

/** A failure the Host named, in this page's language; anything it could not name keeps its own words. */
export function failureText(t: MnemonTranslate, reason: string | undefined, message: string, url: string, credential: MnemonSyncCredentialSource = 'none'): string {
  const issue = reason === undefined ? undefined : REMOTE_ISSUE[reason as MnemonSyncFailureReason]
  if (issue !== undefined) return issueText(t, issue, url, message, credential)
  switch (reason) {
    case 'busy': return t('config.syncReasonBusy')
    case 'no-repository': return t('config.syncReasonNoRepository')
    case 'git-missing': return t('config.syncReasonGitMissing')
    case 'remote-empty': return t('config.syncReasonRemoteEmpty')
    case 'push-rejected': return t('config.syncReasonRejected')
    case 'github-unauthorized': return t('config.syncGitHubExpiredGrant')
    default: return message
  }
}

/** The reason a thrown failure carries, when the Host named one. */
export function reasonOf(error: unknown): string | undefined {
  const reason = error instanceof Error ? (error as { reason?: unknown }).reason : undefined
  return typeof reason === 'string' ? reason : undefined
}

/** How a connected repository is authenticated, said as briefly as the state line allows. */
export function credentialText(t: MnemonTranslate, status: MnemonSyncStatus): string | undefined {
  const url = status.config.repoUrl ?? ''
  const transport = transportOf(url)
  if (transport === 'ssh') return t('config.syncViaSsh')
  if (transport === 'local') return undefined
  switch (status.config.credentialSource) {
    case 'github': return status.config.credentialLogin === undefined ? t('config.syncViaGitHubAnonymous') : t('config.syncViaGitHub', { login: status.config.credentialLogin })
    case 'environment': return t('config.syncViaEnvironment', { env: MNEMON_SYNC_TOKEN_ENV })
    case 'token': return t('config.syncViaToken')
    default: return undefined
  }
}

/** A successful merge can keep excess MEMORY records outside the hot prompt. */
export function runtimeArchiveNotice(t: MnemonTranslate, archived: number | undefined): string {
  return archived === undefined || archived <= 0 ? '' : ` ${t('config.runtimeMergeArchived', { count: archived })}`
}
