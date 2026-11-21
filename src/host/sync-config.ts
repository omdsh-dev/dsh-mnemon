import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { StorageRoot } from './config/index.ts'
import { removeDisposableDirectory } from './disposable-directory.ts'
import { writeAtomicJsonSync } from './fs-atomic.ts'
import {
  MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL, MNEMON_SYNC_DEFAULT_AUTHOR_NAME,
  MNEMON_SYNC_DEFAULT_BRANCH, MNEMON_SYNC_DEFAULT_SUBDIR,
  MNEMON_SYNC_TOKEN_ENV, syncBranchValid, syncDirectoryParts, syncEmailValid, syncRepositoryProblem, type MnemonSyncConfigView,
} from './protocol.ts'

export {
  MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL, MNEMON_SYNC_DEFAULT_AUTHOR_NAME,
  MNEMON_SYNC_DEFAULT_BRANCH, MNEMON_SYNC_DEFAULT_SUBDIR, MNEMON_SYNC_TOKEN_ENV,
}
export const MNEMON_SYNC_CONFIG_FILE = 'sync-git.json'
export const MNEMON_SYNC_MAX_AUTO_BACKUP_MINUTES = 10_080

const STATE_DIRECTORY = 'state'
const SETTING_KEYS = ['repoUrl', 'branch', 'subdir', 'token', 'authorName', 'authorEmail', 'autoBackupMinutes'] as const
const REPOSITORY_HINT = 'sync repository must be an https:// or ssh:// URL, a git@host:path address, or an absolute local path'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function known(key: string): boolean {
  return (SETTING_KEYS as readonly string[]).includes(key)
}

export function syncBranch(value: unknown): string {
  const name = String(value ?? '').trim()
  if (!syncBranchValid(name)) throw new Error('sync branch must be a Git branch name')
  return name
}

export function syncSubdirectory(value: unknown): string {
  const text = String(value ?? '')
  const parts = text.includes('\0') ? undefined : syncDirectoryParts(text)
  if (parts === undefined) throw new Error('sync directory must be a relative path inside the branch')
  return parts.join('/') + '/'
}

export function syncRepositoryUrl(value: unknown): string {
  const url = String(value ?? '').trim()
  const problem = url.includes('\0') ? 'format' : syncRepositoryProblem(url, isAbsolute)
  if (problem === 'credentials') throw new Error('sync repository must not embed credentials; set the token instead')
  if (problem !== undefined) throw new Error(REPOSITORY_HINT)
  return url
}

export function syncToken(value: unknown): string {
  const token = String(value ?? '').trim()
  if (token === '' || token.length > 1000 || /[\r\n\0]/u.test(token)) throw new Error('sync token must be a single-line value')
  return token
}

export function syncAuthorName(value: unknown): string {
  const name = String(value ?? '').trim()
  if (name === '') return ''
  if (name.length > 200 || /[\r\n\0<>]/u.test(name)) throw new Error('sync author name must be one line without angle brackets')
  return name
}

export function syncAuthorEmail(value: unknown): string {
  const email = String(value ?? '').trim()
  if (email === '') return ''
  if (!syncEmailValid(email)) throw new Error('sync author email must be an email address')
  return email
}

export function syncAutoBackupMinutes(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const minutes = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MNEMON_SYNC_MAX_AUTO_BACKUP_MINUTES) {
    throw new Error('auto backup interval must be a whole number of minutes between 0 and ' + String(MNEMON_SYNC_MAX_AUTO_BACKUP_MINUTES))
  }
  return minutes
}

export interface MnemonSyncSettings {
  repoUrl?: string
  branch: string
  subdir: string
  token?: string
  authorName: string
  authorEmail: string
  autoBackupMinutes: number
}

export class MnemonSyncSettingsStore {
  private readonly root: string

  constructor(runner: StorageRoot) {
    this.root = resolve(runner.effectiveDataDir())
  }

  directory(): string {
    return join(this.root, STATE_DIRECTORY)
  }

  path(): string {
    return join(this.directory(), MNEMON_SYNC_CONFIG_FILE)
  }

  mirror(): string {
    return join(this.directory(), 'sync', 'git')
  }

  defaults(): MnemonSyncSettings {
    return {
      branch: MNEMON_SYNC_DEFAULT_BRANCH,
      subdir: MNEMON_SYNC_DEFAULT_SUBDIR,
      authorName: MNEMON_SYNC_DEFAULT_AUTHOR_NAME,
      authorEmail: MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL,
      autoBackupMinutes: 0,
    }
  }

  read(): MnemonSyncSettings {
    const path = this.path()
    if (!existsSync(path)) return this.defaults()
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch {
      throw new Error('sync configuration is not valid JSON')
    }
    const stored = record(parsed)
    if (stored === undefined) throw new Error('sync configuration is not a JSON object')
    for (const key of Object.keys(stored)) if (!known(key)) throw new Error('sync configuration has an unknown field: ' + key)
    const settings = this.defaults()
    if (stored.repoUrl !== undefined) settings.repoUrl = syncRepositoryUrl(stored.repoUrl)
    if (stored.branch !== undefined) settings.branch = syncBranch(stored.branch)
    if (stored.subdir !== undefined) settings.subdir = syncSubdirectory(stored.subdir)
    if (stored.token !== undefined) settings.token = syncToken(stored.token)
    if (stored.authorName !== undefined) settings.authorName = syncAuthorName(stored.authorName)
    if (stored.authorEmail !== undefined) settings.authorEmail = syncAuthorEmail(stored.authorEmail)
    if (stored.autoBackupMinutes !== undefined) settings.autoBackupMinutes = syncAutoBackupMinutes(stored.autoBackupMinutes)
    return settings
  }

  write(settings: MnemonSyncSettings): void {
    const file: Record<string, string | number> = {
      branch: settings.branch,
      subdir: settings.subdir,
      authorName: settings.authorName,
      authorEmail: settings.authorEmail,
      autoBackupMinutes: settings.autoBackupMinutes,
    }
    if (settings.repoUrl !== undefined) file.repoUrl = settings.repoUrl
    if (settings.token !== undefined) file.token = settings.token
    writeAtomicJsonSync(this.path(), file)
  }

  patch(patch: unknown): MnemonSyncSettings {
    const fields = record(patch)
    if (fields === undefined) throw new Error('sync configuration must be an object')
    for (const key of Object.keys(fields)) if (!known(key)) throw new Error('unknown sync setting: ' + key)
    const next: MnemonSyncSettings = { ...this.read() }
    if ('repoUrl' in fields) {
      if (fields.repoUrl === null || fields.repoUrl === '') delete next.repoUrl
      else next.repoUrl = syncRepositoryUrl(fields.repoUrl)
    }
    if ('branch' in fields) next.branch = fields.branch === null || fields.branch === '' ? MNEMON_SYNC_DEFAULT_BRANCH : syncBranch(fields.branch)
    if ('subdir' in fields) next.subdir = fields.subdir === null || fields.subdir === '' ? MNEMON_SYNC_DEFAULT_SUBDIR : syncSubdirectory(fields.subdir)
    if ('token' in fields) {
      if (fields.token === null || fields.token === '') delete next.token
      else next.token = syncToken(fields.token)
    }
    if ('authorName' in fields) next.authorName = syncAuthorName(fields.authorName)
    if ('authorEmail' in fields) next.authorEmail = syncAuthorEmail(fields.authorEmail)
    if ('autoBackupMinutes' in fields) next.autoBackupMinutes = syncAutoBackupMinutes(fields.autoBackupMinutes)
    return next
  }

  token(settings: MnemonSyncSettings): string | undefined {
    const fromEnvironment = process.env[MNEMON_SYNC_TOKEN_ENV]?.trim()
    if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
    return settings.token
  }

  view(settings: MnemonSyncSettings, enabled: boolean): MnemonSyncConfigView {
    const token = this.token(settings)
    const present = token !== undefined && token !== ''
    return {
      enabled,
      ...(settings.repoUrl === undefined ? {} : { repoUrl: settings.repoUrl }),
      branch: settings.branch,
      subdir: settings.subdir,
      hasToken: present,
      credentialSource: present
        ? (process.env[MNEMON_SYNC_TOKEN_ENV]?.trim() ?? '') === '' ? 'token' : 'environment'
        : 'none',
      authorName: settings.authorName,
      authorEmail: settings.authorEmail,
      autoBackupMinutes: settings.autoBackupMinutes,
    }
  }

  clearMirror(): void {
    removeDisposableDirectory(this.mirror())
  }
}
