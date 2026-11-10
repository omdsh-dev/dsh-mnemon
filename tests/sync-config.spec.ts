import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import { createStorageRoot } from '../src/host/storage-root.ts'
import {
  MnemonSyncSettingsStore, MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL, MNEMON_SYNC_DEFAULT_AUTHOR_NAME,
  MNEMON_SYNC_DEFAULT_BRANCH, MNEMON_SYNC_DEFAULT_SUBDIR, MNEMON_SYNC_MAX_AUTO_BACKUP_MINUTES, MNEMON_SYNC_TOKEN_ENV,
  syncAutoBackupMinutes, syncBranch, syncRepositoryUrl, syncSubdirectory,
} from '../src/host/sync-config.ts'

const directories: string[] = []

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-sync-config-'))
  directories.push(directory)
  return directory
}

function store(root = temporary()): { root: string; settings: MnemonSyncSettingsStore } {
  const config = resolveConfig({ storageScope: 'custom', dataDir: root, cliPath: '/fake/mnemon' })
  return { root, settings: new MnemonSyncSettingsStore(createStorageRoot(config)) }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon sync configuration', () => {
  it('clears a read-only disposable mirror without removing stored settings', () => {
    const { settings } = store()
    settings.write(settings.read())
    const before = settings.read()
    const directory = join(settings.mirror(), '.git', 'objects', 'pack')
    mkdirSync(directory, { recursive: true })
    const pack = join(directory, 'synthetic.pack')
    writeFileSync(pack, 'pack')
    chmodSync(pack, 0o444)
    settings.clearMirror()
    expect(existsSync(settings.mirror())).toBe(false)
    expect(settings.read()).toEqual(before)
  })
  it('defaults to the mnemon-sync branch and the mnemon directory', () => {
    const { root, settings } = store()
    expect(settings.read()).toEqual({
      branch: MNEMON_SYNC_DEFAULT_BRANCH, subdir: MNEMON_SYNC_DEFAULT_SUBDIR,
      authorName: MNEMON_SYNC_DEFAULT_AUTHOR_NAME, authorEmail: MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL,
      // A channel nobody configured is a manual one, not a channel with a cadence.
      autoBackupMinutes: 0,
    })
    expect(settings.path()).toBe(join(root, 'state', 'sync-git.json'))
    expect(settings.mirror()).toBe(join(root, 'state', 'sync', 'git'))
  })

  it('writes the file whole at mode 0600 and reads it back', () => {
    const { root, settings } = store()
    const next = settings.patch({ repoUrl: 'https://github.com/example/memory.git', token: 'ghp_secret' })
    settings.write(next)
    const path = join(root, 'state', 'sync-git.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ repoUrl: 'https://github.com/example/memory.git', token: 'ghp_secret' })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(settings.read()).toMatchObject({ repoUrl: 'https://github.com/example/memory.git', token: 'ghp_secret' })
  })

  it('never returns the token, only whether one is available', () => {
    const { settings } = store()
    settings.write(settings.patch({ repoUrl: '/srv/memory.git', token: 'ghp_secret' }))
    const view = settings.view(settings.read(), true)
    expect(view).toEqual({ enabled: true, repoUrl: '/srv/memory.git', branch: MNEMON_SYNC_DEFAULT_BRANCH, subdir: MNEMON_SYNC_DEFAULT_SUBDIR, hasToken: true, credentialSource: 'token', authorName: MNEMON_SYNC_DEFAULT_AUTHOR_NAME, authorEmail: MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL, autoBackupMinutes: 0 })
    // The switch is not a stored setting: it comes from the profile and is
    // carried in by the caller, so a stored file can never turn sync on.
    expect(settings.view(settings.read(), false).enabled).toBe(false)
    expect(JSON.stringify(settings.read())).not.toContain('enabled')
    expect(JSON.stringify(view)).not.toContain('ghp_secret')
  })

  it('lets the environment token win over the stored one and report availability', () => {
    const { settings } = store()
    const stored = settings.patch({ repoUrl: '/srv/memory.git', token: 'stored' })
    expect(settings.token(stored)).toBe('stored')
    vi.stubEnv(MNEMON_SYNC_TOKEN_ENV, 'from-environment')
    expect(settings.token(stored)).toBe('from-environment')
    expect(settings.view(stored, true).hasToken).toBe(true)
    vi.stubEnv(MNEMON_SYNC_TOKEN_ENV, '   ')
    expect(settings.token(stored)).toBe('stored')
  })

  it('clears a field with a null or empty value and keeps the rest', () => {
    const { settings } = store()
    settings.write(settings.patch({ repoUrl: 'git@github.com:example/memory.git', token: 'ghp_secret', authorName: 'Memory Bot' }))
    const cleared = settings.patch({ repoUrl: null, token: '' })
    expect(cleared.repoUrl).toBeUndefined()
    expect(cleared.token).toBeUndefined()
    expect(cleared.authorName).toBe('Memory Bot')
  })

  it('falls back to the defaults and to the machine identity for an empty value', () => {
    const { settings } = store()
    settings.write(settings.patch({ branch: 'user/mnemon-sync', subdir: 'nested/memory/', authorName: 'Memory Bot', authorEmail: 'bot@localhost' }))
    const reset = settings.patch({ branch: '', subdir: '' })
    expect(reset.branch).toBe(MNEMON_SYNC_DEFAULT_BRANCH)
    expect(reset.subdir).toBe(MNEMON_SYNC_DEFAULT_SUBDIR)
    // A blank author is a choice rather than a missing value: the commit falls
    // back to the Git identity this machine already has.
    const identity = settings.patch({ authorName: '', authorEmail: '' })
    expect(identity.authorName).toBe('')
    expect(identity.authorEmail).toBe('')
    // Only the fields a patch names move; the branch on disk stays where the
    // earlier patch left it.
    expect(identity.branch).toBe('user/mnemon-sync')
  })

  it('keeps the automatic backup interval and clears it with an empty value', () => {
    const { settings } = store()
    expect(settings.patch({ autoBackupMinutes: 120 }).autoBackupMinutes).toBe(120)
    settings.write(settings.patch({ autoBackupMinutes: 120, repoUrl: '/srv/memory.git' }))
    // The interval is part of the file, so a Host that restarts keeps the cadence.
    expect(JSON.parse(readFileSync(settings.path(), 'utf8'))).toMatchObject({ autoBackupMinutes: 120 })
    expect(settings.read().autoBackupMinutes).toBe(120)
    expect(settings.view(settings.read(), true).autoBackupMinutes).toBe(120)
    // The field's own hint says an empty value turns the automatic backup off.
    expect(settings.patch({ autoBackupMinutes: null }).autoBackupMinutes).toBe(0)
    expect(settings.patch({ autoBackupMinutes: '' }).autoBackupMinutes).toBe(0)
  })

  it('refuses an interval that is not whole minutes inside the offered range', () => {
    expect(syncAutoBackupMinutes(60)).toBe(60)
    expect(syncAutoBackupMinutes(MNEMON_SYNC_MAX_AUTO_BACKUP_MINUTES)).toBe(MNEMON_SYNC_MAX_AUTO_BACKUP_MINUTES)
    for (const value of [-1, 1.5, 10_081, 'often', {}]) {
      expect(() => syncAutoBackupMinutes(value)).toThrow('auto backup interval must be a whole number of minutes')
    }
  })

  it('rejects an unknown field, a malformed file and an unsafe directory', () => {
    const { root, settings } = store()
    expect(() => settings.patch({ components: ['runtime'] })).toThrow('unknown sync setting: components')
    const directory = join(root, 'state')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'sync-git.json'), 'not json', { encoding: 'utf8', mode: 0o600 })
    expect(() => settings.read()).toThrow('sync configuration is not valid JSON')
    writeFileSync(join(directory, 'sync-git.json'), JSON.stringify({ branch: 'main', extra: true }), { encoding: 'utf8', mode: 0o600 })
    expect(() => settings.read()).toThrow('sync configuration has an unknown field: extra')
    writeFileSync(join(directory, 'sync-git.json'), JSON.stringify({ subdir: '../escape' }), { encoding: 'utf8', mode: 0o600 })
    expect(() => settings.read()).toThrow('sync directory must be a relative path inside the branch')
  })

  it('accepts the remote forms the channel supports and refuses credentials in the URL', () => {
    expect(syncRepositoryUrl('https://github.com/example/memory.git')).toBe('https://github.com/example/memory.git')
    expect(syncRepositoryUrl('ssh://git@github.com/example/memory.git')).toBe('ssh://git@github.com/example/memory.git')
    expect(syncRepositoryUrl('git@github.com:example/memory.git')).toBe('git@github.com:example/memory.git')
    expect(syncRepositoryUrl('/srv/memory.git')).toBe('/srv/memory.git')
    expect(() => syncRepositoryUrl('https://user:secret@github.com/example/memory.git')).toThrow('must not embed credentials')
    // A host's user name may come with the address, as Bitbucket's clone addresses carry one; a token never does.
    expect(syncRepositoryUrl('https://x-token-auth@bitbucket.org/team/memory.git')).toBe('https://x-token-auth@bitbucket.org/team/memory.git')
    expect(() => syncRepositoryUrl('https://ghp_0123456789abcdefABCDEF0123456789abcd@github.com/example/memory.git')).toThrow('must not embed credentials')
    // An escaped colon is a password once Git decodes it.
    expect(() => syncRepositoryUrl('https://alice%3Ahunter2@git.example.com/memory.git')).toThrow('must not embed credentials')
    expect(() => syncRepositoryUrl('github.com/example/memory')).toThrow('sync repository must be')
    expect(() => syncRepositoryUrl('file:///srv/memory.git')).toThrow('sync repository must be')
    expect(() => syncRepositoryUrl('https://github.com/example/memory.git extra')).toThrow('sync repository must be')
  })

  it('normalizes the remote directory and validates the branch name', () => {
    expect(syncSubdirectory('mnemon')).toBe('mnemon/')
    expect(syncSubdirectory('mnemon/')).toBe('mnemon/')
    expect(syncSubdirectory('/nested/memory/')).toBe('nested/memory/')
    expect(() => syncSubdirectory('..')).toThrow('sync directory must be')
    expect(() => syncSubdirectory('/')).toThrow('sync directory must be')
    expect(syncBranch('mnemon-sync')).toBe('mnemon-sync')
    expect(syncBranch('user/mnemon-sync')).toBe('user/mnemon-sync')
    for (const branch of ['', '..', 'main..next', 'main//next', '/main', 'main/', 'main.', 'main.lock', 'main@{1}']) {
      expect(() => syncBranch(branch)).toThrow('sync branch must be a Git branch name')
    }
  })

  it('keeps the mirror inside the storage root so the root is never a work tree', () => {
    const { root, settings } = store()
    expect(settings.mirror().startsWith(join(root, 'state'))).toBe(true)
    expect(settings.mirror()).not.toBe(root)
    expect(settings.directory()).toBe(join(root, 'state'))
  })
})
