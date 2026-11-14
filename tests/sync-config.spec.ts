import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { branchValid, directoryValid, emailValid, machineNameValid, repositoryNameValid, repositoryProblem } from '../src/client/sync-view.ts'
import { MnemonAutoBackupScheduler } from '../src/host/auto-backup.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { HostRpcHandler } from '../src/host/dsh.ts'
import { gitEnvironment } from '../src/host/git-sync.ts'
import { MNEMON_GITHUB_DEFAULT_CLIENT_ID, MnemonGitHubAuth, type MnemonGitHubCredentialPort, type MnemonGitHubGrant } from '../src/host/github-auth.ts'
import { machineLabel } from '../src/host/machine-identity.ts'
import { runProcess } from '../src/host/process.ts'
import { MNEMON_MACHINE_LABEL_MAX, portableAbsolutePath, syncRepositoryProblem } from '../src/host/protocol.ts'
import { createSyncHandler } from '../src/host/rpc.ts'
import type { LiveMnemonRuntime } from '../src/host/runtime.ts'
import { createStorageRoot } from '../src/host/storage-root.ts'
import {
  MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL,
  MNEMON_SYNC_DEFAULT_AUTHOR_NAME,
  MNEMON_SYNC_DEFAULT_BRANCH,
  MNEMON_SYNC_DEFAULT_SUBDIR,
  MNEMON_SYNC_MAX_AUTO_BACKUP_MINUTES,
  MNEMON_SYNC_TOKEN_ENV,
  MnemonSyncSettingsStore,
  syncAuthorEmail,
  syncAutoBackupMinutes,
  syncBranch,
  syncRepositoryUrl,
  syncSubdirectory,
} from '../src/host/sync-config.ts'
import { compositionFixture } from './fixtures/composition.ts'

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await runProcess('git', args, { timeoutMs: 60_000, env: gitEnvironment(), ...(cwd === undefined ? {} : { cwd }), label: 'git' })
  if (result.exitCode !== 0) throw new Error('git ' + args.join(' ') + ': ' + result.stderr)
  return result.stdout
}

const gitAvailable = await git(['--version']).then(() => true, () => false)

describe('Mnemon sync configuration', () => {
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

describe('sync setting rules shared by the form and the Host', () => {
  /** Whether a Host check takes a value, which it refuses by throwing. */
  function takes(check: (value: unknown) => unknown, value: string): boolean {
    try {
      check(value)
      return true
    } catch {
      return false
    }
  }

  const BRANCHES = ['mnemon-sync', 'user/mnemon-sync', 'v1.2', 'a', ' padded ', '', ' ', '-x', '.x', 'x.', 'x.lock', 'x/', '/x', 'a//b', 'a..b', 'a@{1}', '@', 'a\\b', 'a b', 'ä', 'x'.repeat(200), 'x'.repeat(201)]
  const DIRECTORIES = ['mnemon', 'mnemon/', '/nested/memory/', 'a\\b', ' a ', '', '/', '.', '..', 'a/../b', 'a/./b', 'C:/x', 'c:x', 'a:b', 'x'.repeat(400), 'x'.repeat(401)]
  const ADDRESSES = ['me@example.com', ' me@example.com ', 'a@b', 'me', '@example.com', 'me@', 'me@@example.com', 'me @example.com', '<me>@example.com', 'x'.repeat(310) + '@example.com']

  it('take the same branch names, directories and author addresses on both sides', () => {
    for (const name of BRANCHES) expect(branchValid(name), name).toBe(takes(syncBranch, name))
    expect(BRANCHES.filter(branchValid)).toEqual(['mnemon-sync', 'user/mnemon-sync', 'v1.2', 'a', ' padded ', 'x'.repeat(200)])
    for (const directory of DIRECTORIES) expect(directoryValid(directory), directory).toBe(takes(syncSubdirectory, directory))
    expect(DIRECTORIES.filter(directoryValid)).toEqual(['mnemon', 'mnemon/', '/nested/memory/', 'a\\b', ' a ', 'x'.repeat(400)])
    // An empty author address means this machine's own Git identity, which the form offers as a choice of its own.
    for (const address of ADDRESSES) expect(emailValid(address), address).toBe(takes(syncAuthorEmail, address))
    expect(syncAuthorEmail('')).toBe('')
  })

  it('check a repository address alike, except a local path, which only the Host can check by its platform', () => {
    const remote = {
      'https://github.com/example/memory.git': undefined, 'ssh://git@github.com:22/example/memory.git': undefined, 'git@github.com:example/memory.git': undefined,
      'https://user:secret@github.com/example/memory.git': 'credentials', 'https://user:@github.com/example/memory.git': 'credentials',
      // A user name the host wants a token under may stay in the address (#408); a password or a token may not.
      'https://x-token-auth@bitbucket.org/team/memory.git': undefined, 'https://alice@git.example.com:8443/memory.git': undefined,
      'https://gitlab+deploy-token-7@gitlab.com/team/memory.git': undefined, 'https://al!ce@github.com/example/memory.git': undefined,
      'https://alice%2Dsmith@git.example.com/memory.git': undefined,
      // A long Azure DevOps organization name, 50 letters and digits, the most it allows.
      ['https://' + 'contoso'.repeat(7) + 'w@dev.azure.com/contoso/memory/_git/memory']: undefined,
      ['https://' + 'z'.repeat(51) + '@git.example.com/memory.git']: undefined,
      'https://ghp_0123456789abcdefABCDEF0123456789abcd@github.com/example/memory.git': 'credentials',
      'https://github_pat_11ABCDEFG0123456789_abcdefghij@github.com/example/memory.git': 'credentials',
      'https://glpat-abcdefghij0123456789@gitlab.com/team/memory.git': 'credentials',
      'https://gldt-abcdefghij0123456789@gitlab.com/team/memory.git': 'credentials',
      'https://glcbt-abcdefghij0123456789@gitlab.com/team/memory.git': 'credentials',
      'https://hf_abcdefghijklmnopqrstuvwxyz0123456@huggingface.co/team/memory': 'credentials',
      'https://0123456789abcdef0123456789abcdef@gitee.com/team/memory.git': 'credentials',
      ['https://' + 'z'.repeat(52) + '@git.example.com/memory.git']: 'credentials',
      'https://@github.com/example/memory.git': 'credentials', 'https://a@b@github.com/example/memory.git': 'credentials',
      ['https://' + 'a-'.repeat(51) + '@github.com/example/memory.git']: 'credentials', 'https://al#ce@github.com/example/memory.git': 'credentials',
      // Escapes are read as Git reads them: an escaped colon is a password, an escaped prefix a token.
      'https://alice%3Ahunter2@git.example.com/memory.git': 'credentials', 'https://alice%40example.com@git.example.com/memory.git': 'credentials',
      'https://%67hp_0123456789abcdefABCDEF0123456789abcd@github.com/example/memory.git': 'credentials',
      'https://alice%0A@git.example.com/memory.git': 'credentials', 'https://alice%0D@git.example.com/memory.git': 'credentials',
      'https://alice%20smith@git.example.com/memory.git': 'credentials', 'https://alice%zz@git.example.com/memory.git': 'credentials',
      'https://%C3@git.example.com/memory.git': 'credentials',
      'ssh://user@github.com/example/memory.git': undefined, 'ftp://host/repo': 'format', 'file:///srv/memory.git': 'format',
      'https://github.com': 'format', 'github.com/example/memory': 'format', 'https://github.com/example/memory.git extra': 'format', ['https://x/' + 'y'.repeat(2000)]: 'format',
    } as const
    for (const [address, problem] of Object.entries(remote)) {
      expect(repositoryProblem(address), address).toBe(problem)
      expect(syncRepositoryProblem(address, posix.isAbsolute), address).toBe(problem)
      expect(syncRepositoryProblem(address, win32.isAbsolute), address).toBe(problem)
    }
    // The form takes a path that is absolute on either platform; the Host takes one by its own.
    const local = [
      ['/srv/memory.git', true, true, true], ['C:\\memory\\repo.git', true, false, true], ['C:/memory/repo.git', true, false, true],
      ['\\\\server\\share\\repo.git', true, false, true], ['//server/share/repo.git', true, true, true],
      // A Windows path from the root of the current drive: absolute to Node on Windows, not to the form.
      ['\\memory\\repo.git', false, false, true], ['C:repo.git', false, false, false], ['relative/path', false, false, false], ['~/memory.git', false, false, false],
    ] as const
    for (const [path, form, onPosix, onWindows] of local) {
      expect(portableAbsolutePath(path), path).toBe(form)
      expect(repositoryProblem(path), path).toBe(form ? undefined : 'format')
      expect(syncRepositoryProblem(path, posix.isAbsolute), path).toBe(onPosix ? undefined : 'format')
      expect(syncRepositoryProblem(path, win32.isAbsolute), path).toBe(onWindows ? undefined : 'format')
    }
    // An empty address clears the repository in the form; the Host never stores one.
    expect(repositoryProblem('  ')).toBeUndefined()
    expect(() => syncRepositoryUrl('  ')).toThrow('sync repository must be an https:// or ssh:// URL')
  })

  it('leave refusing a NUL byte to the Host, with the messages it gives', () => {
    expect(repositoryProblem('/srv/memory\0.git')).toBeUndefined()
    expect(() => syncRepositoryUrl('/srv/memory\0.git')).toThrow('sync repository must be an https:// or ssh:// URL, a git@host:path address, or an absolute local path')
    expect(() => syncRepositoryUrl('https://user@github.com/memory\0.git')).toThrow('sync repository must be an https:// or ssh:// URL')
    expect(directoryValid('mnemon\0')).toBe(true)
    expect(() => syncSubdirectory('mnemon\0')).toThrow('sync directory must be a relative path inside the branch')
  })

  it('name a machine and a GitHub repository by one rule on both sides', async () => {
    const names = ['Studio', '  Studio  ', '', '   ', 'two\nlines', 'tab\tbed', 'line\u2028separated', 'x'.repeat(MNEMON_MACHINE_LABEL_MAX), 'x'.repeat(MNEMON_MACHINE_LABEL_MAX + 1)]
    for (const name of names) expect(machineNameValid(name), name).toBe(takes(machineLabel, name))
    expect(names.filter(machineNameValid)).toEqual(['Studio', '  Studio  ', 'x'.repeat(MNEMON_MACHINE_LABEL_MAX)])
    // GitHub sign-in checks the name before it asks GitHub, which answers here with a created repository.
    const grant = { version: 1 as const, accessToken: 'gho_rules', savedAt: 'now' }
    const port = { available: () => true, describe: async () => ({ configured: true, writable: true }), read: async () => grant, write: async () => {}, clear: async () => {} }
    const created = { name: 'memory', full_name: 'octocat/memory', clone_url: 'https://github.com/octocat/memory.git', private: true, default_branch: 'main', owner: { login: 'octocat' }, permissions: { push: true } }
    const request = (async () => new Response(JSON.stringify(created), { status: 201, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const github = new MnemonGitHubAuth(port, MNEMON_GITHUB_DEFAULT_CLIENT_ID, () => 0, request)
    const repositories = ['mnemon-memory', ' memory ', 'a.b_c-d', '.', '..', '...', 'a/b', 'has space', '', 'x'.repeat(100), 'x'.repeat(101)]
    for (const name of repositories) {
      const accepted = await github.create(name, true).then(() => true, (error: Error) => {
        expect(error.message).toBe('a GitHub repository name holds letters, digits, dots, dashes and underscores')
        return false
      })
      expect(repositoryNameValid(name), name).toBe(accepted)
    }
    expect(repositories.filter(repositoryNameValid)).toEqual(['mnemon-memory', ' memory ', 'a.b_c-d', '...', 'x'.repeat(100)])
  })
})

describe('automatic Git backup', () => {
  /** One minute in the units the scheduler works in. */
  const MINUTE = 60_000

  interface Harness {
    minutes: number
    repoUrl?: string
    writeEnabled: boolean
    syncEnabled: boolean
    pushes: number
    failure?: Error
    pushed: boolean
    committed: boolean
  }

  function runtimeFor(state: Harness): LiveMnemonRuntime {
    return {
      config: {
        get writeEnabled(): boolean { return state.writeEnabled },
        get syncEnabled(): boolean { return state.syncEnabled },
      },
      sync: {
        settings: () => ({ read: () => ({ ...(state.repoUrl === undefined ? {} : { repoUrl: state.repoUrl }), autoBackupMinutes: state.minutes }) }),
        push: async () => {
          state.pushes += 1
          if (state.failure !== undefined) throw state.failure
          return { commit: 'abcdef1234567890', committed: state.committed, pushed: state.pushed }
        },
      },
    } as unknown as LiveMnemonRuntime
  }

  function clock(start = '2026-08-14T12:00:00.000Z'): { now: () => Date; set: (at: string) => void } {
    let at = start
    return { now: () => new Date(at), set: next => { at = next } }
  }

  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('arms nothing while the interval is off', async () => {
    const state: Harness = { minutes: 0, syncEnabled: true, writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    expect(scheduler.snapshot()).toEqual({ available: false })
    await vi.advanceTimersByTimeAsync(12 * 60 * MINUTE)
    expect(state.pushes).toBe(0)
    stop()
  })

  it('arms nothing while Git sync itself is switched off, whatever the interval says', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', writeEnabled: true, syncEnabled: false, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    expect(scheduler.snapshot()).toEqual({ available: false })
    await vi.advanceTimersByTimeAsync(12 * 60 * MINUTE)
    expect(state.pushes).toBe(0)

    state.syncEnabled = true
    scheduler.refresh()
    expect(scheduler.snapshot()).toMatchObject({ available: true, nextAt: '2026-08-14T13:00:00.000Z' })
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(1)

    state.syncEnabled = false
    scheduler.refresh()
    expect(scheduler.snapshot()).toEqual({ available: false, lastAt: '2026-08-14T12:00:00.000Z', lastCommit: 'abcdef1234567890', lastPushed: true })
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    expect(state.pushes).toBe(1)
    stop()
  })

  it('pushes once per interval and moves the next run forward', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', syncEnabled: true, writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const time = clock()
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), time.now)
    const stop = scheduler.start()

    expect(scheduler.snapshot()).toEqual({ available: true, nextAt: '2026-08-14T13:00:00.000Z' })
    await vi.advanceTimersByTimeAsync(59 * MINUTE)
    expect(state.pushes).toBe(0)
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(state.pushes).toBe(1)
    expect(scheduler.snapshot()).toMatchObject({ available: true, lastAt: '2026-08-14T12:00:00.000Z', lastCommit: 'abcdef1234567890', lastPushed: true })

    time.set('2026-08-14T13:00:00.000Z')
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(2)
    expect(scheduler.snapshot().lastAt).toBe('2026-08-14T13:00:00.000Z')
    stop()
  })

  it('takes a saved change to the interval without a restart', async () => {
    const state: Harness = { minutes: 0, repoUrl: '/srv/memory.git', syncEnabled: true, writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()
    expect(scheduler.snapshot().available).toBe(false)

    state.minutes = 30
    scheduler.refresh()
    expect(scheduler.snapshot()).toMatchObject({ available: true, nextAt: '2026-08-14T12:30:00.000Z' })
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(state.pushes).toBe(1)

    state.minutes = 0
    scheduler.refresh()
    expect(scheduler.snapshot().available).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    expect(state.pushes).toBe(1)
    stop()
  })

  it('keeps the timer running when there is no repository yet', async () => {
    const state: Harness = { minutes: 60, syncEnabled: true, writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(0)
    expect(scheduler.snapshot().lastError).toBeUndefined()
    expect(scheduler.snapshot().available).toBe(true)

    state.repoUrl = '/srv/memory.git'
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(1)
    stop()
  })

  it('reports a read-only Host instead of pushing, and pushes once it is writable', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', syncEnabled: true, writeEnabled: false, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(0)
    expect(scheduler.snapshot().lastError).toBe('dsh-mnemon is configured read-only')
    expect(scheduler.snapshot().available).toBe(true)

    state.writeEnabled = true
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(1)
    expect(scheduler.snapshot().lastError).toBeUndefined()
    stop()
  })

  it('reports a failed push and says nothing about the lock it is meant to lose to', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', syncEnabled: true, writeEnabled: true, pushes: 0, pushed: true, committed: true, failure: new Error('authentication failed') }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()

    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(scheduler.snapshot().lastError).toBe('authentication failed')
    expect(warn).toHaveBeenCalledWith('dsh-mnemon: automatic Git backup failed', expect.anything())
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(state.pushes).toBe(2)

    warn.mockClear()
    state.failure = new Error('another Mnemon sync operation is still running')
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(scheduler.snapshot().lastError).toBe('authentication failed')
    expect(warn).not.toHaveBeenCalled()
    stop()
  })

  it('stops with the runtime it reads', async () => {
    const state: Harness = { minutes: 60, repoUrl: '/srv/memory.git', syncEnabled: true, writeEnabled: true, pushes: 0, pushed: true, committed: true }
    const scheduler = new MnemonAutoBackupScheduler(runtimeFor(state), clock().now)
    const stop = scheduler.start()
    stop()

    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    expect(state.pushes).toBe(0)
    expect(scheduler.snapshot().available).toBe(false)
    scheduler.refresh()
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    expect(state.pushes).toBe(0)
  })
})

describe.skipIf(!gitAvailable)('Mnemon Git sync over RPC', { timeout: 90_000 }, () => {
  const directories: string[] = []
  const releases: Array<() => Promise<void>> = []
  const TOKEN = 'ghp_secret_token_value'
  const COMPONENTS = ['runtime', 'documents', 'memory-spaces']
  const DEVICE_CODE = { device_code: 'device-1', user_code: '2654-9D74', verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5 }
  const REPOSITORY = { name: 'memory', full_name: 'octocat/memory', clone_url: 'https://github.com/octocat/memory.git', private: true, default_branch: 'main', owner: { login: 'octocat' }, permissions: { push: true } }
  let clock = 0

  /** A signed-in account with no store behind it: the channel only needs the seam. */
  function gitHubAuth(): MnemonGitHubAuth {
    const answers: Array<{ status: number; body: unknown }> = [
      { status: 200, body: DEVICE_CODE },
      { status: 200, body: { access_token: 'gho_rpc_token', scope: 'repo' } },
      { status: 200, body: { login: 'octocat' } },
      { status: 200, body: [REPOSITORY] },
      { status: 200, body: { login: 'octocat' } },
      { status: 201, body: { ...REPOSITORY, name: 'mnemon-memory', full_name: 'octocat/mnemon-memory', clone_url: 'https://github.com/octocat/mnemon-memory.git' } },
    ]
    let grant: MnemonGitHubGrant | undefined
    const port: MnemonGitHubCredentialPort = {
      available: () => true,
      describe: async () => ({ configured: grant !== undefined, writable: true }),
      read: async () => grant,
      write: async next => { grant = next },
      clear: async () => { grant = undefined },
    }
    const request = (async () => {
      const answer = answers.shift()
      if (answer === undefined) throw new Error('unexpected GitHub request')
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch
    return new MnemonGitHubAuth(port, MNEMON_GITHUB_DEFAULT_CLIENT_ID, () => clock, request)
  }

  function temporary(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-' + label + '-'))
    directories.push(directory)
    return directory
  }

  /** One machine: the real runtime graph plus the sync channel registered over it. */
  async function machine() {
    // Git sync is opt-in; this suite drives the channel the profile switched on.
    const fixture = await compositionFixture({ syncEnabled: true })
    releases.push(fixture.dispose)
    return { fixture, sync: createSyncHandler(fixture.live) as HostRpcHandler, data: join(fixture.root, 'data') }
  }

  async function origin(label: string): Promise<string> {
    const directory = join(temporary(label), 'sync.git')
    await git(['init', '--bare', '--quiet', directory])
    return directory
  }

  afterEach(async () => {
    for (const release of releases.splice(0)) await release()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('pushes the whole pack and imports it on a second machine through the channel', async () => {
    const remote = await origin('sync-rpc-roundtrip')
    const first = await machine()

    const before = await first.sync('status', {})
    expect(before).toMatchObject({ ok: true, value: { configured: false, git: { available: true }, remote: { reachable: false, branchExists: false } } })

    const configured = await first.sync('configure', { repoUrl: remote, token: TOKEN })
    expect(configured).toMatchObject({
      ok: true,
      value: { repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/', hasToken: true, authorName: 'dsh-mnemon sync', authorEmail: 'mnemon@localhost' },
    })
    expect(JSON.stringify(configured)).not.toContain(TOKEN)

    await first.fixture.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'RPC push payload' })
    const pushed = await first.sync('push', { message: 'Sync from RPC', confirmed: true })
    expect(pushed).toMatchObject({ ok: true, value: { repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/', committed: true, pushed: true, message: 'Sync from RPC' } })
    const push = (pushed as { value: { commit: string; summary: Array<{ component: string }>; files: number; bytes: number } }).value
    expect(push.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(push.summary.map(entry => entry.component)).toEqual(COMPONENTS)
    expect(push.files).toBeGreaterThan(0)
    expect(push.bytes).toBeGreaterThan(0)
    expect(JSON.stringify(pushed)).not.toContain(TOKEN)
    expect(await git(['show', 'mnemon-sync:mnemon/payload/runtime/MEMORY.md'], remote)).toContain('RPC push payload')

    const second = await machine()
    const localMemory = join(second.data, 'runtime', 'MEMORY.md')
    expect(await second.sync('configure', { repoUrl: remote })).toMatchObject({ ok: true, value: { hasToken: false } })

    const preview = await second.sync('preview', {})
    expect(preview).toMatchObject({ ok: true, value: { repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/', commit: push.commit } })
    const inspected = (preview as { value: { components: Array<{ component: string }>; files: { total: number }; manifest: { format: string; version: number; scope: string }; pushedAt: string } }).value
    expect(inspected.components.map(entry => entry.component)).toEqual(COMPONENTS)
    expect(inspected.files.total).toBeGreaterThan(0)
    expect(inspected.manifest).toMatchObject({ format: 'mnemonpack', version: 1, scope: 'full' })
    expect(inspected.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(existsSync(localMemory) ? readFileSync(localMemory, 'utf8') : '').not.toContain('RPC push payload')

    const history = await second.sync('backups', {})
    expect(history).toMatchObject({ ok: true, value: { repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/', truncated: false } })
    const backups = (history as { value: { commits: Array<{ commit: string; message: string; machine: { id: string; label: string }; components: Array<{ component: string }> }> } }).value.commits
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatchObject({ commit: push.commit, message: 'Sync from RPC' })
    expect(backups[0]!.components.map(entry => entry.component)).toEqual(COMPONENTS)
    expect(JSON.stringify(history)).not.toContain(TOKEN)
    const refusedLimit = { ok: false, error: { message: 'limit must be a positive integer' } }
    expect(await second.sync('backups', { limit: 0 })).toMatchObject(refusedLimit)
    expect(await second.sync('backups', { limit: 'many' })).toMatchObject(refusedLimit)

    const difference = await second.sync('diff', {})
    expect(difference).toMatchObject({ ok: true, value: { repoUrl: remote, branch: 'mnemon-sync', commit: push.commit, shared: 0 } })
    const apart = (difference as { value: { localOnly: Array<{ content: string }>; remoteOnly: Array<{ content: string; origin?: { machine: string } }> } }).value
    expect(apart.remoteOnly.map(entry => entry.content)).toEqual(['RPC push payload'])
    expect(apart.remoteOnly[0]!.origin?.machine).toMatch(/^[0-9a-f-]{36}$/u)
    expect(apart.localOnly).toEqual([])
    expect(existsSync(localMemory) ? readFileSync(localMemory, 'utf8') : '').not.toContain('RPC push payload')

    const pulled = await second.sync('pull', { confirmed: true })
    expect(pulled).toMatchObject({ ok: true, value: { imported: true, mode: 'merge', repoUrl: remote, commit: push.commit, components: COMPONENTS, targetRoot: second.data } })
    expect(readFileSync(localMemory, 'utf8')).toContain('RPC push payload')
  })

  it('refuses to publish or import without confirmation and never echoes the token', async () => {
    const remote = await origin('sync-rpc-guards')
    const host = await machine()

    expect(await host.sync('push', {})).toMatchObject({ ok: false, error: { message: 'Publishing the sync branch requires confirmation' } })
    expect(await host.sync('pull', {})).toMatchObject({ ok: false, error: { message: 'Importing the remote Mnemon payload requires confirmation' } })
    expect(await host.sync('push', { confirmed: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining('no sync repository is configured'), details: { reason: 'no-repository' } } })
    expect(await host.sync('preview', {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('no sync repository is configured') } })

    expect(await host.sync('configure', { repoUrl: remote, token: TOKEN })).toMatchObject({ ok: true })
    const status = await host.sync('status', {})
    expect(status).toMatchObject({ ok: true, value: { configured: true, config: { hasToken: true }, remote: { reachable: true, branchExists: false } } })
    expect(JSON.stringify(status)).not.toContain(TOKEN)

    const unreachable = await machine()
    expect(await unreachable.sync('configure', { repoUrl: 'https://127.0.0.1:1/owner/repo.git', token: TOKEN })).toMatchObject({ ok: true })
    const offline = await unreachable.sync('status', {})
    expect(offline).toMatchObject({ ok: true, value: { configured: true, config: { hasToken: true }, remote: { reachable: false, branchExists: false, issue: 'network' } } })
    expect(typeof (offline as { value: { remote: { error?: string } } }).value.remote.error).toBe('string')
    expect(JSON.stringify(offline)).not.toContain(TOKEN)
    const refused = await unreachable.sync('push', { confirmed: true })
    expect(refused).toMatchObject({ ok: false, error: { code: 'internal', details: { reason: 'remote-network' } } })
    expect(JSON.stringify(refused)).not.toContain(TOKEN)

    expect(await host.sync('nope', {})).toMatchObject({ ok: false, error: { code: 'bad-request', message: 'unknown sync endpoint: nope' } })
  })

  it('accepts the scope keys the page sends and keeps them out of the stored configuration', async () => {
    const remote = await origin('sync-rpc-scope')
    const host = await machine()

    const configured = await host.sync('configure', { repoUrl: remote, token: TOKEN, sessionId: 'session-1' })
    expect(configured).toMatchObject({ ok: true, value: { repoUrl: remote, hasToken: true } })

    const stored = JSON.parse(readFileSync(join(host.data, 'state', 'sync-git.json'), 'utf8')) as Record<string, unknown>
    expect(stored).toMatchObject({ repoUrl: remote, branch: 'mnemon-sync', subdir: 'mnemon/' })
    expect(Object.keys(stored)).not.toContain('sessionId')
    expect(Object.keys(stored)).not.toContain('workspaceId')

    expect(await host.sync('configure', { repoUrl: remote, components: ['runtime'] }))
      .toMatchObject({ ok: false, error: { message: 'unknown sync setting: components' } })
  })

  it('keeps reads available and every write gated while the Host is read-only', async () => {
    const host = await compositionFixture({ writeEnabled: false })
    releases.push(host.dispose)
    const sync = createSyncHandler(host.live)
    const readOnly = { ok: false, error: { message: expect.stringContaining('read-only') } }

    expect(await sync('configure', { repoUrl: 'https://example.test/owner/repo.git' })).toMatchObject(readOnly)
    expect(await sync('push', { confirmed: true })).toMatchObject(readOnly)
    expect(await sync('pull', { confirmed: true })).toMatchObject(readOnly)
    expect(await sync('status', {})).toMatchObject({ ok: true, value: { configured: false } })
  })

  it('drives GitHub sign-in through the channel and keeps the token out of every answer', async () => {
    const host = await compositionFixture({}, { githubAuth: gitHubAuth() })
    releases.push(host.dispose)
    const sync = createSyncHandler(host.live)

    const start = await sync('github-start', {})
    const flow = (start as { value: { flow: { userCode: string; verificationUri: string; intervalMs: number } } }).value.flow
    expect(flow.userCode).toBe('2654-9D74')
    expect(flow.verificationUri).toBe('https://github.com/login/device')
    expect(flow.intervalMs).toBe(5_000)

    const waiting = await sync('github-status', {})
    expect(waiting).toMatchObject({ ok: true, value: { available: true, signedIn: false, writable: true, flow: { userCode: '2654-9D74' } } })

    clock = 5_000
    expect(await sync('github-poll', {})).toMatchObject({ ok: true, value: { status: 'success', login: 'octocat' } })
    const signedIn = await sync('github-status', {})
    expect(signedIn).toMatchObject({ ok: true, value: { available: true, signedIn: true, writable: true, login: 'octocat' } })
    expect(JSON.stringify(signedIn)).not.toContain('gho_rpc_token')

    const configured = await sync('configure', { repoUrl: 'https://github.com/octocat/memory.git' })
    expect(configured).toMatchObject({ ok: true, value: { hasToken: true, credentialSource: 'github', credentialLogin: 'octocat' } })
    expect(JSON.stringify(configured)).not.toContain('gho_rpc_token')

    expect(await sync('github-repositories', {})).toMatchObject({ ok: true, value: { login: 'octocat', repositories: [{ fullName: 'octocat/memory' }] } })
    expect(await sync('github-create', { name: 'mnemon-memory', private: true }))
      .toMatchObject({ ok: true, value: { fullName: 'octocat/mnemon-memory' } })

    const readOnly = await compositionFixture({ writeEnabled: false }, { githubAuth: gitHubAuth() })
    releases.push(readOnly.dispose)
    const gated = createSyncHandler(readOnly.live)
    for (const endpoint of ['github-start', 'github-poll', 'github-cancel', 'github-signout', 'github-create']) {
      expect(await gated(endpoint, {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    }
    expect(await gated('github-status', {})).toMatchObject({ ok: true, value: { available: true, signedIn: false } })
    expect(await gated('github-repositories', {})).toMatchObject({ ok: false, error: { message: 'sign in to GitHub before choosing a repository' } })
  })

  it('reports the login as unavailable on a Host that mounts no credentials store', async () => {
    const fixture = await compositionFixture({}, { githubAuth: new MnemonGitHubAuth(undefined) })
    releases.push(fixture.dispose)
    const sync = createSyncHandler(fixture.live)
    expect(await sync('github-status', {})).toMatchObject({ ok: true, value: { available: false, signedIn: false, writable: false } })
    expect(await sync('github-start', {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('no credentials store') } })
    expect(await sync('github-poll', {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('no credentials store') } })
    expect(await sync('github-repositories', {})).toMatchObject({ ok: false, error: { message: 'sign in to GitHub before choosing a repository' } })
  })
})
