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

export type SyncTransport = 'https' | 'ssh' | 'local'

export function transportOf(url: string): SyncTransport {
  const value = url.trim()
  if (/^https:\/\//iu.test(value)) return 'https'
  if (/^ssh:\/\//iu.test(value) || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/u.test(value)) return 'ssh'
  return 'local'
}

export function onGitHub(url: string): boolean {
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}

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

export type RepositoryProblem = MnemonSyncRepositoryProblem

export function repositoryProblem(url: string): RepositoryProblem | undefined {
  const value = url.trim()
  return value === '' ? undefined : syncRepositoryProblem(value, portableAbsolutePath)
}

export function branchValid(value: string): boolean {
  return syncBranchValid(value.trim())
}

export function directoryValid(value: string): boolean {
  return syncDirectoryParts(value) !== undefined
}

export function emailValid(value: string): boolean {
  return syncEmailValid(value.trim())
}

export function machineNameValid(value: string): boolean {
  return machineLabelValid(value.trim())
}

export function repositoryNameValid(value: string): boolean {
  return githubRepositoryNameValid(value.trim())
}

export type AuthorMode = 'default' | 'machine' | 'custom'

export function authorModeOf(name: string, email: string): AuthorMode {
  if (name === MNEMON_SYNC_DEFAULT_AUTHOR_NAME && email === MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL) return 'default'
  if (name === '' && email === '') return 'machine'
  return 'custom'
}

export const DEFAULT_AUTHOR = MNEMON_SYNC_DEFAULT_AUTHOR_NAME + ' <' + MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL + '>'

export const AUTO_SYNC_CHOICES: readonly number[] = [0, 60, 180, 360, 720, 1_440, 4_320, 10_080]

export function intervalLabel(t: MnemonTranslate, minutes: number): string {
  if (minutes <= 0) return t('config.syncAutoOff')
  if (minutes === 60) return t('config.syncAutoHour')
  if (minutes === 1_440) return t('config.syncAutoDay')
  if (minutes % 1_440 === 0) return t('config.syncAutoDays', { days: minutes / 1_440 })
  return t('config.syncAutoHours', { hours: minutes / 60 })
}

export function when(value: string | undefined, now: Date = new Date()): string {
  if (value === undefined) return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function issueText(t: MnemonTranslate, issue: MnemonSyncRemoteIssue | undefined, url: string, error?: string, credential: MnemonSyncCredentialSource = 'none'): string {
  const transport = transportOf(url)
  switch (issue) {
    case 'auth':
      if (transport === 'https' && credential !== 'none') return rejectedText(t, url, credential)
      if (transport === 'https') return onGitHub(url) ? t('config.syncIssueAuthHttps') : t('config.syncIssueAuthToken')
      return transport === 'ssh' ? t('config.syncIssueAuthSsh') : t('config.syncIssueAuth')
    case 'not-found':
      return onGitHub(url) ? t('config.syncIssueNotFoundGitHub') : t('config.syncIssueNotFound')
    case 'network': return t('config.syncIssueNetwork')
    case 'timeout': return t('config.syncIssueTimeout')
    default: return t('config.syncIssueUnknown', { error: error ?? '' })
  }
}

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

export function reasonOf(error: unknown): string | undefined {
  const reason = error instanceof Error ? (error as { reason?: unknown }).reason : undefined
  return typeof reason === 'string' ? reason : undefined
}

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

export function runtimeArchiveNotice(t: MnemonTranslate, archived: number | undefined): string {
  return archived === undefined || archived <= 0 ? '' : ` ${t('config.runtimeMergeArchived', { count: archived })}`
}
