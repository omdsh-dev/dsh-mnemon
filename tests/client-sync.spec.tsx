// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MnemonChangeSignal } from '../src/client/change-signal.ts'
import { MnemonReviewSection } from '../src/client/MnemonReviewSection.tsx'
import { MnemonSettingsCard } from '../src/client/MnemonSettingsCard.tsx'
import { MnemonSyncSection } from '../src/client/MnemonSyncSection.tsx'
import { failureText, machineNameValid, repositoryProblem, transportOf } from '../src/client/sync-view.ts'
import { translateEn, translateZh, type MnemonTranslate } from '../src/client/locales.ts'
import type { ClientConnectionHandle } from '../src/host/dsh.ts'
import type {
  MnemonSyncConfigView, MnemonSyncDiff, MnemonSyncGitHubRepository, MnemonSyncGitHubStatus, MnemonSyncPreview,
  MnemonReviewEntry, MnemonSyncPushResult, MnemonSyncStatus,
} from '../src/host/protocol.ts'
import { MNEMON_PACK_CHANNEL, MNEMON_REVIEW_CHANNEL, MNEMON_SYNC_CHANNEL } from '../src/host/protocol.ts'
import { settingsScope } from './helpers/settings-scope.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'

interface FakeHostOptions {
  repoUrl?: string
  credentialSource?: MnemonSyncConfigView['credentialSource']
  remote?: MnemonSyncStatus['remote']
  autoBackup?: MnemonSyncStatus['autoBackup']
  autoBackupMinutes?: number
  github?: Partial<MnemonSyncGitHubStatus>
  repositories?: MnemonSyncGitHubRepository[] | 'unauthorized'
  push?: Partial<MnemonSyncPushResult> | { reason: string; message: string }
  diff?: Partial<MnemonSyncDiff>
  /** The branch holds no backup yet, so reading it fails with that reason. */
  emptyRemote?: boolean
  /** A saved author an older version wrote, possibly with a single field. */
  author?: { name: string; email: string }
  /** Disconnecting fails, as a locked settings file would make it. */
  disconnectFails?: boolean
  /** The branch holds more versions than the first page. */
  historyTruncated?: boolean
  /** A name a person already gave this computer. */
  machineName?: string
  /** Merging here fails, as it does when this computer cannot write its memory directory. */
  pullFails?: string
}

/** The host name the fake computer runs under. */
const HOSTNAME = 'macbook-air.local'

/** A Host that answers the sync channel from a little state the calls change. */
function fakeHost(options: FakeHostOptions = {}) {
  const config: MnemonSyncConfigView = {
    enabled: true, branch: 'mnemon-sync', subdir: 'mnemon/', hasToken: false,
    credentialSource: options.credentialSource ?? 'none',
    authorName: options.author?.name ?? 'dsh-mnemon sync', authorEmail: options.author?.email ?? 'mnemon@localhost', autoBackupMinutes: options.autoBackupMinutes ?? 0,
    ...(options.repoUrl === undefined ? {} : { repoUrl: options.repoUrl }),
  }
  let github: MnemonSyncGitHubStatus = { available: false, signedIn: false, writable: false, ...options.github }
  const machine = { id: 'machine-a', label: options.machineName ?? HOSTNAME, createdAt: '2026-08-01T00:00:00.000Z' }
  let machineSource: 'hostname' | 'custom' = options.machineName === undefined ? 'hostname' : 'custom'
  const status = (): MnemonSyncStatus => ({
    enabled: true, configured: config.repoUrl !== undefined, config: { ...config },
    configPath: '/data/state/sync-git.json', mirrorPath: '/data/state/sync/git',
    machine: { ...machine }, machineLabel: { source: machineSource, hostname: HOSTNAME },
    git: { available: true, required: '2.20', version: '2.50.1' },
    remote: options.remote ?? (config.repoUrl === undefined ? { reachable: false, branchExists: false } : { reachable: true, branchExists: true, commit: COMMIT }),
    ...(options.autoBackup === undefined ? {} : { autoBackup: options.autoBackup }),
  })
  const preview: MnemonSyncPreview = {
    repoUrl: config.repoUrl ?? '', branch: 'mnemon-sync', subdir: 'mnemon/', commit: COMMIT, pushedAt: '2026-08-14T12:00:00.000Z',
    manifest: { format: 'mnemonpack', version: 1, scope: 'full', exportedAt: '2026-08-14T12:00:00.000Z', source: { plugin: 'dsh-mnemon', pluginVersion: '0.5.27' }, components: ['runtime', 'documents', 'memory-spaces'], summary: [] },
    archiveBytes: 10, expandedBytes: 20, targetRoot: '/data', targetScope: 'global', occupied: { runtime: true, documents: false, 'memory-spaces': false },
    components: [
      { component: 'runtime', files: 3, bytes: 10, items: 2, changed: true },
      { component: 'documents', files: 0, bytes: 0, items: 0, changed: false },
      { component: 'memory-spaces', files: 0, bytes: 0, items: 0, changed: true },
    ],
    files: { total: 3, changed: 1, added: 0, removed: 0 }, localExportAt: '2026-08-14T12:00:00.000Z',
  }
  const diff: MnemonSyncDiff = {
    repoUrl: config.repoUrl ?? '', branch: 'mnemon-sync', subdir: 'mnemon/', commit: COMMIT, localExportAt: '2026-08-14T12:00:00.000Z',
    local: { exportedAt: '2026-08-14T12:00:00.000Z', entries: 2 },
    remote: { exportedAt: '2026-08-14T12:00:00.000Z', entries: 3, machine: { id: 'machine-b', label: 'Laptop B', createdAt: '2026-08-01T00:00:00.000Z' } },
    localOnly: [{ target: 'memory', content: 'Prefers short answers in Chinese', importance: 'normal' }],
    remoteOnly: [
      { target: 'memory', content: 'Prefers short answers, in Chinese', importance: 'normal' },
      { target: 'memory', content: 'The project uses pnpm', importance: 'normal' },
    ],
    conflicts: [{
      target: 'memory', similarity: 0.9,
      local: { target: 'memory', content: 'Prefers short answers in Chinese', importance: 'normal' },
      remote: { target: 'memory', content: 'Prefers short answers, in Chinese', importance: 'normal' },
    }],
    shared: 1, truncated: false, heldBack: 0, remoteTombstones: [],
    ...options.diff,
  }
  const call = vi.fn(async (_channel: string, endpoint: string, payload: Record<string, unknown> = {}) => {
    switch (endpoint) {
      case 'status': return { ok: true as const, value: status() }
      case 'github-status': return { ok: true as const, value: github }
      case 'configure': {
        if (options.disconnectFails === true && payload.repoUrl === null) return { ok: false as const, error: { code: 'internal', message: 'sync configuration could not be written' } }
        if ('repoUrl' in payload) {
          if (payload.repoUrl === null) delete config.repoUrl
          else config.repoUrl = String(payload.repoUrl)
        }
        for (const key of ['branch', 'subdir', 'authorName', 'authorEmail'] as const) if (key in payload) config[key] = String(payload[key])
        if ('autoBackupMinutes' in payload) config.autoBackupMinutes = Number(payload.autoBackupMinutes)
        if ('token' in payload) config.credentialSource = payload.token === null ? 'none' : 'token'
        if ('machineLabel' in payload) {
          machineSource = payload.machineLabel === null ? 'hostname' : 'custom'
          machine.label = payload.machineLabel === null ? HOSTNAME : String(payload.machineLabel)
        }
        return { ok: true as const, value: { ...config } }
      }
      case 'push': {
        const push = options.push
        if (push !== undefined && 'message' in push && typeof push.message === 'string' && 'reason' in push && !('commit' in push)) {
          return { ok: false as const, error: { code: 'internal', message: push.message, details: { reason: push.reason } } }
        }
        return { ok: true as const, value: { repoUrl: config.repoUrl, branch: 'mnemon-sync', subdir: 'mnemon/', commit: COMMIT, committed: true, message: 'Mnemon sync', files: 7, bytes: 1_500, summary: [], pushed: true, ...push } }
      }
      case 'preview':
      case 'diff':
        if (options.emptyRemote === true) return { ok: false as const, error: { code: 'internal', message: 'the branch mnemon-sync holds no Mnemon payload at mnemon/ yet; push one first', details: { reason: 'remote-empty' } } }
        return { ok: true as const, value: endpoint === 'preview' ? preview : diff }
      case 'pull':
        if (options.pullFails !== undefined) return { ok: false as const, error: { code: 'internal', message: options.pullFails } }
        return { ok: true as const, value: { imported: true, mode: 'merge', repoUrl: config.repoUrl, branch: 'mnemon-sync', subdir: 'mnemon/', commit: COMMIT, manifest: preview.manifest, targetRoot: '/data', components: ['runtime'], summary: [], runtime: { added: 1, held: 0 } } }
      case 'backups': return { ok: true as const, value: { repoUrl: config.repoUrl, branch: 'mnemon-sync', subdir: 'mnemon/', truncated: options.historyTruncated === true, commits: [
        { commit: COMMIT, message: 'Mnemon sync 2026-08-14T12:00:00Z', committedAt: '2026-08-14T12:00:00.000Z', machine: { id: 'machine-b', label: 'Laptop B', createdAt: '2026-08-01T00:00:00.000Z' }, components: [{ component: 'runtime', files: 3, bytes: 10, items: 4 }] },
        { commit: '1234567890abcdef1234567890abcdef12345678', message: 'Before the trip', committedAt: '2026-08-13T09:00:00.000Z', components: [] },
      ] } }
      case 'github-start':
        github = { ...github, flow: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: '2026-08-14T13:00:00.000Z', intervalMs: 1_000 } }
        return { ok: true as const, value: github }
      case 'github-poll':
        github = { available: true, signedIn: true, writable: true, login: 'octocat' }
        return { ok: true as const, value: { status: 'success', login: 'octocat' } }
      case 'github-cancel': {
        const { flow: _flow, ...rest } = github
        github = rest
        return { ok: true as const, value: github }
      }
      case 'github-signout':
        github = { available: true, signedIn: false, writable: true }
        return { ok: true as const, value: github }
      case 'github-repositories':
        if (options.repositories === 'unauthorized') return { ok: false as const, error: { code: 'internal', message: 'listing GitHub repositories failed: Bad credentials', details: { reason: 'github-unauthorized' } } }
        return { ok: true as const, value: { login: 'octocat', repositories: options.repositories ?? [] } }
      case 'github-create':
        return { ok: true as const, value: { name: String(payload.name), fullName: 'octocat/' + String(payload.name), url: 'https://github.com/octocat/' + String(payload.name) + '.git', private: true, defaultBranch: 'main', owner: 'octocat', push: true } }
      default: throw new Error('unexpected endpoint ' + endpoint)
    }
  })
  const connection = { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle
  const calls = (endpoint: string) => call.mock.calls.filter(([, name]) => name === endpoint).map(([, , payload]) => payload)
  return { connection, call, calls, config }
}

function section(connection: ClientConnectionHandle, options: { enabled?: boolean; disabled?: boolean; t?: MnemonTranslate; onMerged?: () => void } = {}) {
  return render(<MnemonSyncSection connection={connection} enabled={options.enabled ?? true} disabled={options.disabled ?? false} onEnabled={() => {}}
    {...(options.onMerged === undefined ? {} : { onMerged: options.onMerged })} t={options.t ?? translateZh} />)
}

const repository = (fullName: string, isPrivate: boolean, push = true): MnemonSyncGitHubRepository => ({
  name: fullName.split('/')[1]!, fullName, url: 'https://github.com/' + fullName + '.git', private: isPrivate, defaultBranch: 'main', owner: fullName.split('/')[0]!, push,
})

describe('Git sync section', () => {
  it('asks the Host nothing while it is switched off', () => {
    const host = fakeHost()
    section(host.connection, { enabled: false })
    expect(host.call).not.toHaveBeenCalled()
    expect(screen.queryByText('仓库')).toBeNull()
  })

  it('checks a typed address before sending it, and keeps no token for a local repository', async () => {
    const host = fakeHost()
    section(host.connection)
    const address = await screen.findByLabelText('仓库地址') as HTMLInputElement
    const connect = screen.getByRole('button', { name: '连接' }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)

    fireEvent.change(address, { target: { value: 'github.com/owner/repo' } })
    expect(screen.getByText('地址需要是 https://、ssh://、git@主机:路径 或本机绝对路径')).toBeTruthy()
    expect(connect.disabled).toBe(true)
    fireEvent.change(address, { target: { value: 'https://ghp_secret@github.com/owner/repo.git' } })
    expect(screen.getByText('地址里只能写用户名，令牌请填在“访问令牌”里')).toBeTruthy()
    expect(host.calls('configure')).toEqual([])

    fireEvent.change(address, { target: { value: '/srv/memory.git' } })
    expect(screen.queryByLabelText('访问令牌')).toBeNull()
    fireEvent.click(connect)
    await waitFor(() => expect(host.calls('configure')).toEqual([{ repoUrl: '/srv/memory.git', token: null }]))
    // The state line is the answer to a connection, not a notice claiming one.
    expect(await screen.findByText('已连接')).toBeTruthy()
    expect(screen.getByRole('button', { name: '立即同步' })).toBeTruthy()
  })

  it('takes a user name in an HTTPS address, with the token beside it, and refuses a password there (#408)', async () => {
    const host = fakeHost()
    section(host.connection)
    const address = await screen.findByLabelText('仓库地址')
    fireEvent.change(address, { target: { value: 'https://alice:secret@bitbucket.org/team/memory.git' } })
    expect(screen.getByText('地址里只能写用户名，令牌请填在“访问令牌”里')).toBeTruthy()
    expect((screen.getByRole('button', { name: '连接' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(address, { target: { value: 'https://x-token-auth@bitbucket.org/team/memory.git' } })
    expect(screen.queryByText('地址里只能写用户名，令牌请填在“访问令牌”里')).toBeNull()
    fireEvent.change(screen.getByLabelText('访问令牌'), { target: { value: 'token-value' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => expect(host.calls('configure')).toEqual([{ repoUrl: 'https://x-token-auth@bitbucket.org/team/memory.git', token: 'token-value' }]))
  })

  it('asks for a token only for an HTTPS address', async () => {
    const host = fakeHost()
    section(host.connection)
    fireEvent.change(await screen.findByLabelText('仓库地址'), { target: { value: 'https://git.example.com/me/memory.git' } })
    fireEvent.change(screen.getByLabelText('访问令牌'), { target: { value: 'token-value' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => expect(host.calls('configure')).toEqual([{ repoUrl: 'https://git.example.com/me/memory.git', token: 'token-value' }]))
  })

  it('syncs in one step and says what the merge brought in', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', push: { merged: { commit: COMMIT, components: ['runtime'], summary: [], tombstones: 0, runtime: { added: 2, held: 0 } } } })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    expect(await screen.findByText('已同步：合并了 2 条远端记忆，推送了 abcdef12。')).toBeTruthy()
    expect(host.calls('push')).toEqual([{ confirmed: true }])
  })

  it('reports preserved overflow separately from memories admitted to the hot prompt (#468)', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', push: { merged: { commit: COMMIT, components: ['runtime'], summary: [], tombstones: 0, runtime: { added: 1, held: 0, archived: 2 } } } })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    expect(await screen.findByText(/合并了 1 条远端记忆.*2 条超限工作记忆已完整保存在本机 runtime\/archived\/import-overflow/u)).toBeTruthy()
  })

  it('states a refused push and a named failure in the page language', async () => {
    const rejected = fakeHost({ repoUrl: '/srv/memory.git', push: { pushed: false, committed: true, reason: '! [rejected] (fetch first)', failure: 'push-rejected' } })
    section(rejected.connection)
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    expect(await screen.findByText('已在本机提交，但推送没有完成：同步时仓库又被其他设备更新了，请再同步一次')).toBeTruthy()
    cleanup()

    const refused = fakeHost({ repoUrl: 'https://github.com/octocat/memory.git', push: { reason: 'remote-auth', message: "fatal: could not read Username for 'https://github.com'" } })
    section(refused.connection)
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    expect(await screen.findByText('同步失败：需要凭据，请用 GitHub 登录或填写访问令牌')).toBeTruthy()
  })

  it('compares with the remote without writing, and merges only when asked', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '检查远端' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('远端独有 1 条 · 本机独有 0 条 · 1 处写法不同')).toBeTruthy()
    expect(within(dialog).getByText('远端版本来自 Laptop B · ' + new Date('2026-08-14T12:00:00.000Z').toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))).toBeTruthy()
    expect(within(dialog).getAllByText('有差异')).toHaveLength(1)
    expect(host.calls('pull')).toEqual([])
    expect(host.calls('push')).toEqual([])

    fireEvent.click(within(dialog).getByRole('button', { name: '查看' }))
    expect(within(dialog).getByText('Prefers short answers, in Chinese')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '只合并到本机' }))
    expect(await within(dialog).findByText('已合并 1 条远端记忆。')).toBeTruthy()
    expect(host.calls('pull')).toEqual([{ confirmed: true }])
    expect(host.calls('push')).toEqual([])
  })

  it('offers the first sync from Check remote when the branch holds no backup yet', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', emptyRemote: true })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '检查远端' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('仓库里还没有备份，先同步一次')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: '只合并到本机' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '立即同步' }))
    await waitFor(() => expect(host.calls('push')).toEqual([{ confirmed: true }]))
  })

  it('lists backups by time and computer, keeping only messages a person wrote', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '查看' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('来自 Laptop B')).toBeTruthy()
    expect(within(dialog).getByText('运行时记忆 4 条')).toBeTruthy()
    expect(within(dialog).getByText('Before the trip')).toBeTruthy()
    expect(within(dialog).queryByText('Mnemon sync 2026-08-14T12:00:00Z')).toBeNull()
    expect(within(dialog).getByText('来自 未标注设备')).toBeTruthy()
  })

  it('signs in with GitHub in one click, then connects a private repository without a stored token', async () => {
    const opened = { opener: window } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(opened)
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const host = fakeHost({ github: { available: true, writable: true }, repositories: [repository('octocat/memory', true), repository('octocat/site', false), repository('team/shared', true, false)] })
    section(host.connection)
    const signIn = await screen.findByRole('button', { name: '使用 GitHub 登录' })
    expect((within(screen.getByRole('radiogroup', { name: '连接方式' })).getByRole('radio', { name: 'GitHub 账号' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(signIn)
    expect(await screen.findByText('ABCD-1234')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '复制并打开 GitHub' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://github.com/login/device', '_blank'))
    expect(await screen.findByText('已复制，在打开的页面中粘贴即可；完成后会自动继续')).toBeTruthy()
    // The opened page keeps no handle on this one, and nothing claims the browser blocked it.
    expect(opened.opener).toBeNull()
    expect(writeText).toHaveBeenCalledWith('ABCD-1234')
    expect(screen.queryByText(/浏览器没有打开新页面/u)).toBeNull()

    expect(await screen.findByText('已登录 @octocat', undefined, { timeout: 4_000 })).toBeTruthy()
    const list = await screen.findByRole('list', { name: '仓库' })
    expect((within(list).getByRole('button', { name: /team\/shared/u }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(list).getByRole('button', { name: /octocat\/memory/u }))
    await waitFor(() => expect(host.calls('configure')).toEqual([{ repoUrl: 'https://github.com/octocat/memory.git', token: null }]))
  })

  it('asks before using a public repository', async () => {
    const host = fakeHost({ github: { available: true, writable: true, signedIn: true, login: 'octocat' }, repositories: [repository('octocat/site', false)] })
    section(host.connection)
    const list = await screen.findByRole('list', { name: '仓库' })
    fireEvent.click(within(list).getByRole('button', { name: /octocat\/site/u }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('octocat/site 是公开仓库：同步后任何人都能看到这些记忆。')).toBeTruthy()
    expect(host.calls('configure')).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: '仍然使用' }))
    await waitFor(() => expect(host.calls('configure')).toEqual([{ repoUrl: 'https://github.com/octocat/site.git', token: null }]))
  })

  it('creates a private repository from a name that matches none', async () => {
    const host = fakeHost({ github: { available: true, writable: true, signedIn: true, login: 'octocat' }, repositories: [repository('octocat/memory', true)] })
    section(host.connection)
    const search = await screen.findByPlaceholderText('搜索仓库，或输入新仓库名')
    fireEvent.change(search, { target: { value: 'memory-backup' } })
    fireEvent.click(await screen.findByRole('button', { name: /新建私有仓库 octocat\/memory-backup/u }))
    await waitFor(() => expect(host.calls('github-create')).toEqual([{ name: 'memory-backup', private: true }]))
    await waitFor(() => expect(host.calls('configure')).toEqual([{ repoUrl: 'https://github.com/octocat/memory-backup.git', token: null }]))
    fireEvent.change(search, { target: { value: 'bad name!' } })
  })

  it('offers a new sign-in when GitHub no longer honours the grant', async () => {
    const host = fakeHost({ github: { available: true, writable: true, signedIn: true, login: 'octocat' }, repositories: 'unauthorized' })
    section(host.connection)
    expect(await screen.findByText('GitHub 授权已失效，请重新登录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    await waitFor(() => expect(host.calls('github-signout')).toHaveLength(1))
    await waitFor(() => expect(host.calls('github-start')).toHaveLength(1))
  })

  it('names why the repository cannot be read and opens the way to fix it', async () => {
    const host = fakeHost({
      repoUrl: 'https://github.com/octocat/memory.git', github: { available: true, writable: true },
      remote: { reachable: false, branchExists: false, issue: 'auth', error: "fatal: could not read Username for 'https://github.com'" },
    })
    section(host.connection)
    expect(await screen.findByText('需要凭据，请用 GitHub 登录或填写访问令牌')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '设置凭据' }))
    expect(await screen.findByRole('button', { name: '使用 GitHub 登录' })).toBeTruthy()
    // Cancelling leaves the saved connection as it was.
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(await screen.findByRole('button', { name: '更改' })).toBeTruthy()
  })

  it('warns that pushing an HTTPS repository needs credentials before the first push fails', async () => {
    const host = fakeHost({ repoUrl: 'https://git.example.com/me/memory.git' })
    section(host.connection)
    // Another host takes a token; only github.com takes the sign-in.
    expect(await screen.findByText('已连接 · 推送需要访问令牌')).toBeTruthy()
    cleanup()
    const github = fakeHost({ repoUrl: 'https://github.com/octocat/memory.git' })
    section(github.connection)
    expect(await screen.findByText('已连接 · 推送需要 GitHub 登录或访问令牌')).toBeTruthy()
  })

  it('disconnects after a confirmation that says nothing is deleted', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '断开' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('之后不再同步到 /srv/memory.git，自动同步也会关闭。本机记忆和仓库里的内容都不会删除；保存的访问令牌会一并移除。')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '断开' }))
    await waitFor(() => expect(host.calls('configure')).toEqual([{ repoUrl: null, token: null, autoBackupMinutes: 0 }]))
    expect(await screen.findByText('已断开仓库。')).toBeTruthy()
    expect(screen.getByLabelText('仓库地址')).toBeTruthy()
  })

  it('saves the advanced choices explicitly, the author included', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: /^高级设置/u }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('分支'), { target: { value: 'memory-backup' } })
    expect(screen.getByText('保存后，下次同步写到新的分支或目录')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '提交者' })).getByRole('radio', { name: '自定义' }))
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: 'Octo Cat' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'not-an-email' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'octo@example.com' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(host.calls('configure')).toEqual([{ branch: 'memory-backup', subdir: 'mnemon/', authorName: 'Octo Cat', authorEmail: 'octo@example.com' }]))

    fireEvent.click(await screen.findByRole('radio', { name: '本机 Git' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(host.calls('configure').at(-1)).toEqual({ branch: 'memory-backup', subdir: 'mnemon/', authorName: '', authorEmail: '' }))
  })

  it('reports an automatic sync failure in words', async () => {
    const host = fakeHost({
      repoUrl: '/srv/memory.git', autoBackupMinutes: 360,
      autoBackup: { available: true, lastError: 'fatal: unable to access', lastFailure: 'remote-network' },
    })
    section(host.connection)
    expect(await screen.findByText('上次自动同步失败：无法连接到仓库，请检查网络或代理')).toBeTruthy()
  })

  it('speaks English as well', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    section(host.connection, { t: translateEn })
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check remote' })).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
  })
})

describe('Git sync section after review', () => {
  it('never removes a saved token when its caption is clicked', async () => {
    const host = fakeHost({ repoUrl: 'https://git.example.com/me/memory.git', credentialSource: 'token' })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '更改' }))
    const caption = await screen.findByText('访问令牌', { selector: 'label' })
    fireEvent.click(caption)
    expect(host.calls('configure')).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    await waitFor(() => expect(host.calls('configure')).toEqual([{ token: null }]))
  })

  it('counts each entry once, in the kind a merge treats it as', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', diff: {
      localOnly: [], conflicts: [], heldBack: 1,
      remoteOnly: [{ target: 'memory', content: 'Deleted here earlier', importance: 'normal' }],
    } })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '检查远端' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('远端有 1 条记忆是本机以前删掉的，同步不会把它们加回。')).toBeTruthy()
    // Documents are the same and memory spaces differ in the fake preview, so a merge still has work.
    expect(within(dialog).getAllByText('一致').length).toBeGreaterThan(0)
    expect(within(dialog).queryByText(/远端独有 1 条/u)).toBeNull()
  })

  it('says inside the comparison why a sync started there did not finish', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', push: { pushed: false, committed: true, reason: '! [rejected]', failure: 'push-rejected' } })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '检查远端' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('远端独有 1 条 · 本机独有 0 条 · 1 处写法不同')
    fireEvent.click(within(dialog).getByRole('button', { name: '立即同步' }))
    expect(await within(dialog).findByText('已在本机提交，但推送没有完成：同步时仓库又被其他设备更新了，请再同步一次')).toBeTruthy()
  })

  it('says inside the comparison why a merge did not finish', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', pullFails: "EACCES: permission denied, open '/data/runtime/.memories.lock'" })
    section(host.connection)
    await screen.findByRole('button', { name: '立即同步' })
    fireEvent.click(screen.getByRole('button', { name: '检查远端' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('远端独有 1 条 · 本机独有 0 条 · 1 处写法不同')
    const statusReads = host.calls('status').length
    fireEvent.click(within(dialog).getByRole('button', { name: '只合并到本机' }))
    // The comparison is read again after the merge, and the failure is still said.
    await waitFor(() => expect(host.calls('diff')).toHaveLength(2))
    expect(await within(dialog).findByText("EACCES: permission denied, open '/data/runtime/.memories.lock'")).toBeTruthy()
    expect(within(dialog).queryByText(/已合并/u)).toBeNull()
    // A merge can fail after it wrote, so the state line is read again as well.
    await waitFor(() => expect(host.calls('status').length).toBeGreaterThan(statusReads))
  })

  it('says inside the dialog when a disconnect fails', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', disconnectFails: true })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '断开' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '断开' }))
    expect(await within(dialog).findByText('sync configuration could not be written')).toBeTruthy()
  })

  it('says the host refused a credential it was offered, and asks for one only when none was (#408)', async () => {
    const remote = { reachable: false, branchExists: false, issue: 'auth' as const, error: 'remote: Invalid user name or token fatal: Authentication failed' }
    const token = fakeHost({ repoUrl: 'https://git.example.com/me/memory.git', credentialSource: 'token', remote })
    section(token.connection)
    expect(await screen.findByText('仓库主机拒绝了保存的访问令牌，请更换令牌，或在地址中写上它要求的用户名')).toBeTruthy()
    // The way to another credential stays open beside it.
    expect(screen.getByRole('button', { name: '设置凭据' })).toBeTruthy()
    cleanup()
    const signedIn = fakeHost({ repoUrl: 'https://github.com/octocat/memory.git', credentialSource: 'github', remote })
    section(signedIn.connection, { t: translateEn })
    expect(await screen.findByText('GitHub rejected the sign-in; sign in again or check its access to this repository')).toBeTruthy()
    cleanup()
    const none = fakeHost({ repoUrl: 'https://git.example.com/me/memory.git', remote })
    section(none.connection, { t: translateEn })
    expect(await screen.findByText('Needs credentials; add an access token')).toBeTruthy()
    cleanup()
    // A sync that fails the same way says so too.
    const refused = fakeHost({ repoUrl: 'https://git.example.com/me/memory.git', credentialSource: 'environment', push: { reason: 'remote-auth', message: 'git fetch failed: remote: Invalid user name or token' } })
    section(refused.connection, { t: translateEn })
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }))
    expect(await screen.findByText('Sync failed: The host rejected the token in MNEMON_SYNC_GIT_TOKEN; replace it')).toBeTruthy()
  })

  it('asks for another token, not another sign-in, when github.com refuses a token or the variable (#408)', async () => {
    // A saved token and the environment variable come before the sign-in, so signing in again changes nothing.
    const remote = { reachable: false, branchExists: false, issue: 'auth' as const, error: 'remote: Invalid username or token. fatal: Authentication failed' }
    const token = fakeHost({ repoUrl: 'https://github.com/octocat/memory.git', credentialSource: 'token', github: { available: true, writable: true, signedIn: true, login: 'octocat' }, remote })
    section(token.connection)
    expect(await screen.findByText('GitHub 拒绝了保存的访问令牌，请更换令牌')).toBeTruthy()
    expect(screen.getByRole('button', { name: '设置凭据' })).toBeTruthy()
    cleanup()
    const variable = fakeHost({ repoUrl: 'https://github.com/octocat/memory.git', credentialSource: 'environment', remote })
    section(variable.connection, { t: translateEn })
    expect(await screen.findByText('GitHub rejected the token in MNEMON_SYNC_GIT_TOKEN; replace it')).toBeTruthy()
    cleanup()
    // A sync on github.com that the variable fails says so in the same words.
    const refused = fakeHost({ repoUrl: 'https://github.com/octocat/memory.git', credentialSource: 'environment', push: { reason: 'remote-auth', message: 'git fetch failed: remote: Invalid username or token' } })
    section(refused.connection)
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    expect(await screen.findByText('同步失败：GitHub 拒绝了 MNEMON_SYNC_GIT_TOKEN 中的令牌，请更换它')).toBeTruthy()
  })

  it('asks a host other than GitHub for a token, not a GitHub sign-in', async () => {
    const host = fakeHost({ repoUrl: 'https://git.example.com/me/memory.git', remote: { reachable: false, branchExists: false, issue: 'auth', error: 'Authentication failed' } })
    section(host.connection)
    expect(await screen.findByText('需要凭据，请填写访问令牌')).toBeTruthy()
    expect(screen.getByRole('button', { name: '设置凭据' })).toBeTruthy()
  })

  it('creates a repository whose name only another owner uses', async () => {
    const host = fakeHost({ github: { available: true, writable: true, signedIn: true, login: 'octocat' }, repositories: [repository('team/memory', true)] })
    section(host.connection)
    fireEvent.change(await screen.findByPlaceholderText('搜索仓库，或输入新仓库名'), { target: { value: 'memory' } })
    expect(await screen.findByRole('button', { name: /新建私有仓库 octocat\/memory/u })).toBeTruthy()
  })

  it('stops offering earlier versions once the Host has no more to give', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', historyTruncated: true })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: '查看' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: '读取更早的版本' }))
    expect(await within(dialog).findByText('这里只列出最近的 2 个版本')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '读取更早的版本' })).toBeNull()
  })

  it('keeps an author an older version saved with one field from blocking other changes', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', author: { name: '', email: 'me@example.com' } })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: /^高级设置/u }))
    fireEvent.change(screen.getByLabelText('分支'), { target: { value: 'memory-backup' } })
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(host.calls('configure')).toEqual([{ branch: 'memory-backup', subdir: 'mnemon/', authorName: '', authorEmail: 'me@example.com' }]))
  })
})

describe('This computer\'s name', () => {
  it('names this computer in the advanced settings, or goes back to its host name', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    section(host.connection)
    // The summary names the computer before anything opens.
    const disclosure = await screen.findByRole('button', { name: /^高级设置/u })
    expect(disclosure.textContent).toContain(HOSTNAME)
    fireEvent.click(disclosure)
    const naming = screen.getByRole('radiogroup', { name: '这台电脑的名称' })
    expect((within(naming).getByRole('radio', { name: '主机名' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('使用主机名，备份历史里显示为“来自 ' + HOSTNAME + '”')).toBeTruthy()
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement

    fireEvent.click(within(naming).getByRole('radio', { name: '自定义' }))
    // An empty name is not a name, and one past the limit is refused as it is typed.
    expect(save.disabled).toBe(true)
    const field = screen.getByRole('textbox', { name: '这台电脑的名称' })
    fireEvent.change(field, { target: { value: 'x'.repeat(121) } })
    expect(screen.getByText('名称最多 120 个字符，且只能占一行')).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'Studio' } })
    expect(screen.getByText('备份历史里显示为“来自 Studio”')).toBeTruthy()
    expect(screen.getByText('保存后，之后的同步使用新名称；已有的版本保留原来的名称')).toBeTruthy()
    fireEvent.click(save)
    await waitFor(() => expect(host.calls('configure')).toEqual([{ branch: 'mnemon-sync', subdir: 'mnemon/', authorName: 'dsh-mnemon sync', authorEmail: 'mnemon@localhost', machineLabel: 'Studio' }]))
    // Once the Host reports the name, the summary follows it.
    await waitFor(() => expect(screen.getByRole('button', { name: /^高级设置/u }).textContent).toContain('Studio'))

    fireEvent.click(within(screen.getByRole('radiogroup', { name: '这台电脑的名称' })).getByRole('radio', { name: '主机名' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(host.calls('configure').at(-1)).toMatchObject({ machineLabel: null }))
  })

  it('opens on a name a person already chose and saves nothing until it changes', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git', machineName: 'Studio' })
    section(host.connection)
    fireEvent.click(await screen.findByRole('button', { name: /^高级设置/u }))
    expect((within(screen.getByRole('radiogroup', { name: '这台电脑的名称' })).getByRole('radio', { name: '自定义' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('textbox', { name: '这台电脑的名称' }) as HTMLInputElement).value).toBe('Studio')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    // Changing only the branch sends no name: the one saved stays as it is.
    fireEvent.change(screen.getByLabelText('分支'), { target: { value: 'memory-backup' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(host.calls('configure')).toEqual([{ branch: 'memory-backup', subdir: 'mnemon/', authorName: 'dsh-mnemon sync', authorEmail: 'mnemon@localhost' }]))
  })
})

/** A Host's review channel holding one plan, which the calls move from pending to applied. */
function reviewHost(apply: 'ok' | 'stops' = 'ok') {
  let entry: MnemonReviewEntry = {
    id: 'plan-1', createdAt: '2026-08-14T12:00:00.000Z', updatedAt: '2026-08-14T12:00:00.000Z', status: 'pending',
    title: 'Merge two notes', summary: 'Two notes say the same thing.', machine: { id: 'machine-a', label: HOSTNAME }, foreignMachines: [],
    operations: [
      { kind: 'runtime-add', target: 'memory', content: 'The project uses pnpm', importance: 'normal', reason: 'Only the branch held it.' },
      { kind: 'runtime-remove', target: 'memory', oldText: 'The project uses npm', reason: 'The branch replaced it.' },
    ],
    opinions: [],
  }
  return vi.fn(async (_channel: string, endpoint: string) => {
    switch (endpoint) {
      case 'view': return { ok: true as const, value: { path: '/data/state/review.json', entries: [entry], pending: entry.status === 'pending' ? 1 : 0 } }
      case 'decide': entry = { ...entry, status: 'accepted' }; return { ok: true as const, value: entry }
      case 'apply':
        // The Host runs the operations in order and keeps the ones that ran when one fails.
        if (apply === 'stops') {
          entry = { ...entry, appliedOperations: [0], failure: 'operation 2: the old text was not found' }
          return { ok: false as const, error: { code: 'internal', message: 'operation 2: the old text was not found' } }
        }
        entry = { ...entry, appliedAt: '2026-08-14T12:05:00.000Z', appliedOperations: [0, 1] }
        return { ok: true as const, value: { entry, applied: 2, failures: [] } }
      default: throw new Error('unexpected endpoint ' + endpoint)
    }
  })
}

describe('Memory this page changed', () => {
  it('tells the memory views after a sync and after a merge, never after a comparison alone', async () => {
    const onMerged = vi.fn()
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    section(host.connection, { onMerged })
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: '检查远端' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('远端独有 1 条 · 本机独有 0 条 · 1 处写法不同')
    // Reading what a sync would change writes nothing here.
    expect(onMerged).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: '只合并到本机' }))
    expect(await within(dialog).findByText('已合并 1 条远端记忆。')).toBeTruthy()
    expect(onMerged).toHaveBeenCalledTimes(2)
  })

  it('tells them after a sync that did not finish, since the branch was folded in first', async () => {
    const onMerged = vi.fn()
    const host = fakeHost({ repoUrl: '/srv/memory.git', push: { pushed: false, committed: true, reason: '! [rejected] (fetch first)', failure: 'push-rejected' } })
    section(host.connection, { onMerged })
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    expect(await screen.findByText('已在本机提交，但推送没有完成：同步时仓库又被其他设备更新了，请再同步一次')).toBeTruthy()
    expect(onMerged).toHaveBeenCalledTimes(1)
  })

  it('tells them after a reviewed plan ran, not when it is only accepted', async () => {
    const onApplied = vi.fn()
    render(<MnemonReviewSection connection={{ rpc: { call: reviewHost() }, isLoopback: true } as unknown as ClientConnectionHandle} disabled={false} onApplied={onApplied} t={translateZh} />)
    fireEvent.click(await screen.findByRole('button', { name: '接受' }))
    fireEvent.click(await screen.findByRole('button', { name: '执行' }))
    expect(await screen.findByText('已执行 2 条改动。')).toBeTruthy()
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('tells them when a plan stops partway, since the operations before the failure ran', async () => {
    const onApplied = vi.fn()
    render(<MnemonReviewSection connection={{ rpc: { call: reviewHost('stops') }, isLoopback: true } as unknown as ClientConnectionHandle} disabled={false} onApplied={onApplied} t={translateZh} />)
    fireEvent.click(await screen.findByRole('button', { name: '接受' }))
    fireEvent.click(await screen.findByRole('button', { name: '执行' }))
    expect(await screen.findByText(/operation 2: the old text was not found/u)).toBeTruthy()
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('tells them after a sync that failed, and once for a sync started in the comparison', async () => {
    const onMerged = vi.fn()
    const refused = fakeHost({ repoUrl: 'https://github.com/octocat/memory.git', push: { reason: 'remote-auth', message: "fatal: could not read Username for 'https://github.com'" } })
    section(refused.connection, { onMerged })
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    expect(await screen.findByText('同步失败：需要凭据，请用 GitHub 登录或填写访问令牌')).toBeTruthy()
    expect(onMerged).toHaveBeenCalledTimes(1)
    cleanup()

    onMerged.mockClear()
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    section(host.connection, { onMerged })
    fireEvent.click(await screen.findByRole('button', { name: '检查远端' }))
    const comparison = await screen.findByRole('dialog')
    await within(comparison).findByText('远端独有 1 条 · 本机独有 0 条 · 1 处写法不同')
    fireEvent.click(within(comparison).getByRole('button', { name: '立即同步' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(host.calls('push')).toEqual([{ confirmed: true }])
    expect(onMerged).toHaveBeenCalledTimes(1)
  })

  it('reaches the memory views from the configuration page itself', async () => {
    const host = fakeHost({ repoUrl: '/srv/memory.git' })
    const review = reviewHost()
    const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown> = {}) => {
      if (channel === MNEMON_SYNC_CHANNEL) return host.call(channel, endpoint, payload)
      if (channel === MNEMON_REVIEW_CHANNEL) return review(channel, endpoint)
      if (channel === MNEMON_PACK_CHANNEL && endpoint === 'target') return { ok: true as const, value: { root: '/data', scope: 'global' } }
      // The composition and its status are other reads this page makes; they are not part of this check.
      throw new Error(`unexpected endpoint ${channel} ${endpoint}`)
    })
    const scope = settingsScope({ status: 'ready' as const, value: { storageScope: 'global' as const, syncEnabled: true }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const })
    const changes = new MnemonChangeSignal(0)
    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle} componentChanges={changes} />)
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }))
    await waitFor(() => expect(changes.getSnapshot()).toBe(1))
    // The line that says what the sync did stays while the page reads its own data again.
    expect(await screen.findByText('已同步，推送了 abcdef12。')).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: '接受' }))
    fireEvent.click(await screen.findByRole('button', { name: '执行' }))
    await waitFor(() => expect(changes.getSnapshot()).toBe(2))
  })
})

describe('Git sync view helpers', () => {
  it('tells the transports apart and checks addresses as the Host does', () => {
    expect(transportOf('https://github.com/o/r.git')).toBe('https')
    expect(transportOf('git@github.com:o/r.git')).toBe('ssh')
    expect(transportOf('ssh://git@host/o/r.git')).toBe('ssh')
    expect(transportOf('/srv/memory.git')).toBe('local')
    expect(repositoryProblem('C:\\memory\\repo.git')).toBeUndefined()
    expect(repositoryProblem('relative/path')).toBe('format')
    expect(repositoryProblem('ftp://host/repo')).toBe('format')
    expect(machineNameValid('Studio')).toBe(true)
    expect(machineNameValid('  ')).toBe(false)
    expect(machineNameValid('two\nlines')).toBe(false)
    expect(machineNameValid('x'.repeat(120))).toBe(true)
    expect(machineNameValid('x'.repeat(121))).toBe(false)
  })

  it('keeps a failure it cannot name in its own words', () => {
    expect(failureText(translateZh, undefined, 'fatal: something else', '/srv/memory.git')).toBe('fatal: something else')
    expect(failureText(translateZh, 'remote-not-found', 'not found', 'https://github.com/o/r.git')).toBe('找不到这个仓库，请检查地址；私有仓库需要先登录或填写令牌')
    expect(failureText(translateZh, 'busy', 'another Mnemon sync operation is still running', '')).toBe('另一个同步操作还在进行，请稍后再试')
    // A refusal is said to be one only where a credential was offered over HTTPS, in words for where it came from (#408).
    const refused = (url: string, credential?: 'environment' | 'token' | 'github' | 'none') => failureText(translateEn, 'remote-auth', 'Authentication failed', url, credential)
    expect(refused('https://git.example.com/me/memory.git', 'token')).toBe('The host rejected the saved token; replace it, or name the user it expects in the address')
    expect(refused('https://git.example.com/me/memory.git', 'environment')).toBe('The host rejected the token in MNEMON_SYNC_GIT_TOKEN; replace it')
    expect(refused('https://github.com/o/r.git', 'github')).toBe('GitHub rejected the sign-in; sign in again or check its access to this repository')
    expect(refused('https://github.com/o/r.git', 'token')).toBe('GitHub rejected the saved access token; replace it')
    expect(refused('https://github.com/o/r.git', 'environment')).toBe('GitHub rejected the token in MNEMON_SYNC_GIT_TOKEN; replace it')
    expect(refused('https://git.example.com/me/memory.git')).toBe('Needs credentials; add an access token')
    expect(refused('https://github.com/o/r.git', 'none')).toBe('Needs credentials; sign in with GitHub or add an access token')
    expect(failureText(translateEn, 'remote-auth', 'Permission denied (publickey)', 'git@github.com:o/r.git', 'environment')).toBe('SSH authentication failed; check this computer\'s SSH key')
    expect(failureText(translateEn, 'remote-not-found', 'not found', 'https://github.com/o/r.git', 'token')).toBe('Repository not found; check the address, as a private repository needs a sign-in or a token')
  })

  it('polls syncStatus settle with exponential backoff (250ms -> 500ms -> 1000ms) instead of tight 250ms loops', async () => {
    vi.useFakeTimers()
    try {
      let statusReads = 0
      const call = vi.fn(async (_channel: string, endpoint: string) => {
        if (endpoint === 'github-status') return { ok: true as const, value: { available: false, signedIn: false, writable: false } }
        statusReads += 1
        const ready = statusReads >= 4
        return {
          ok: true as const,
          value: {
            enabled: ready,
            configured: false,
            config: { enabled: ready, branch: 'mnemon-sync', subdir: 'mnemon/', hasToken: false, credentialSource: 'none' as const, authorName: 'sync', authorEmail: 'sync@localhost', autoBackupMinutes: 0 },
            configPath: '/data/state/sync-git.json',
            mirrorPath: '/data/state/sync/git',
            machine: { id: 'm1', label: 'host', createdAt: '2026-08-01T00:00:00.000Z' },
            machineLabel: { source: 'hostname' as const, hostname: 'host' },
            git: { available: true, required: '2.20', version: '2.50.1' },
            remote: { reachable: false, branchExists: false },
          },
        }
      })
      render(<MnemonSyncSection connection={{ rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle} enabled onEnabled={vi.fn()} disabled={false} t={translateEn} />)

      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(statusReads).toBe(1)

      // 250ms first retry
      await act(async () => { await vi.advanceTimersByTimeAsync(249) })
      expect(statusReads).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(statusReads).toBe(2)

      // 500ms second retry (not 250ms)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(statusReads).toBe(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(statusReads).toBe(3)

      // 1000ms third retry
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(statusReads).toBe(3)
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(statusReads).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
