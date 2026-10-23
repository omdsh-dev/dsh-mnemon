// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MnemonSettingsCard } from '../src/client/MnemonSettingsCard.tsx'
import { MnemonChangeSignal } from '../src/client/change-signal.ts'
import { MnemonComponentListSeat } from '../src/client/component-list-seat.ts'
import { MemorySpacesSettings } from 'dsh-mnemon-source-memory-spaces/client'
import { createComponentHosts, type ComponentHosts } from '../src/client/component-host.ts'
import { MEMORY_SPACES_PACKAGE, RUNTIME_PACKAGE, RuntimeSettings, THREE_TIER_PACKAGE, ThreeTierSettings } from '../src/client/component-settings.tsx'
import { translateEn, translateZh, type MnemonTranslate } from '../src/client/locales.ts'
import type { ClientConnectionHandle, ClientSettingsScope } from "../src/host/dsh.ts"
import type { Config } from "../src/host/config.ts"
import type { MemoryCompositionStatus, MemoryPluginEntryView, MemoryViewConfigurationRequest, MemoryViewDashboard } from "../src/host/protocol.ts"
import { TEST_PROVIDERS as MEMORY_PROVIDER_CATALOG } from './fixtures/providers.ts'
import { liveSettingsScope, settingsScope } from './helpers/settings-scope.ts'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

const pattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** A DSH settings selector; its accessible name is the row title followed by the chosen value. */
function selector(title: string, root: HTMLElement = document.body): HTMLButtonElement {
  return within(root).getByRole('button', { name: new RegExp(`^${pattern(title)} `, 'u') }) as HTMLButtonElement
}

/** Open a selector and pick the option whose label starts with `option`. */
function choose(title: string, option: string, root: HTMLElement = document.body): void {
  fireEvent.click(selector(title, root))
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${pattern(option)}`, 'u') }))
}

const checked = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true'

/** A component page's props, as the configuration hands them to the settings a component contributed. */
function page(packageName: string, options: { enabled?: boolean; writable?: boolean; language?: string; sessionId?: string; workspaceId?: string; workspaceLabel?: string } = {}) {
  return {
    component: { packageName, label: packageName, enabled: options.enabled ?? true }, writable: options.writable ?? true, language: options.language ?? 'zh',
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.workspaceId === undefined ? {} : { workspace: { id: options.workspaceId, ...(options.workspaceLabel === undefined ? {} : { label: options.workspaceLabel }) } }),
  }
}
type PageOptions = Parameters<typeof page>[1]
/** What the configuration lends Memory Spaces' settings, one set per settings scope as the page keeps one. */
const lent = new WeakMap<object, ComponentHosts>()
function hostFor(scope: ClientSettingsScope<Config>, connection: ClientConnectionHandle | undefined, options: NonNullable<PageOptions>, componentChanges?: { bump: () => void }) {
  let hosts = lent.get(scope)
  if (hosts === undefined) {
    hosts = createComponentHosts({ scope, connection, componentChanges })
    lent.set(scope, hosts)
  }
  return hosts(MEMORY_SPACES_PACKAGE, options.sessionId, options.workspaceId)
}
/** Memory Spaces' own settings, as its registration renders them: its Providers and the Native embedding runtime. */
const spaces = (scope: ClientSettingsScope<Config>, connection?: ClientConnectionHandle, options: PageOptions = {}, t: MnemonTranslate = translateZh, componentChanges?: { bump: () => void }) =>
  <MemorySpacesSettings {...page(MEMORY_SPACES_PACKAGE, { ...options, language: t === translateEn ? 'en' : options.language ?? 'zh' })} host={hostFor(scope, connection, options, componentChanges)!} />
/** The Layered strategy's own settings: the background tasks it drives. */
/** What the Host reports for a page opened from a conversation on a model other than DSH's new-session one. */
const conversationDirectory = {
  effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
  defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
  session: { provider: 'ai', model: 'space-bunny' },
  inherited: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
  groups: [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
  ],
  failures: [],
}
const threeTier = (scope: ClientSettingsScope<Config>, connection?: ClientConnectionHandle, options: PageOptions = {}, t: MnemonTranslate = translateZh) =>
  <ThreeTierSettings scope={scope} {...(connection === undefined ? {} : { connection })} t={t} page={page(THREE_TIER_PACKAGE, options)} />
/** Runtime Memory's own setting: where its user profile lives. */
const runtime = (scope: ClientSettingsScope<Config>, options: PageOptions = {}, t: MnemonTranslate = translateZh) =>
  <RuntimeSettings scope={scope} t={t} page={page(RUNTIME_PACKAGE, options)} />
/** A group's Apply, shown once something in it changed. */
const apply = (name = '应用') => screen.getByRole('button', { name }) as HTMLButtonElement
/** The data directory's default or custom choice. */
const directoryChoice = (option: string, group = '数据目录') => within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }) as HTMLInputElement
/** A selector found by its row id, where row titles share a prefix. */
const rowSelector = (id: string) => document.querySelector<HTMLButtonElement>(`[aria-labelledby^="${id}-title "]`)!
function chooseIn(id: string, option: string): void {
  fireEvent.click(rowSelector(id))
  fireEvent.click(screen.getAllByRole('menuitem').find(item => item.textContent?.startsWith(option) || item.textContent?.includes(option))!)
}

describe('MnemonSettingsCard', () => {
  it.each([false, true])('submits the OpenViking user-key scope to its owning instance and reports rejection=%s', async rejected => {
    const snapshot = { status: 'ready' as const, value: {}, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }
    const scope = settingsScope(snapshot)
    const descriptor = MEMORY_PROVIDER_CATALOG.find(candidate => candidate.id === 'openviking')!
    const providers = ['work-cloud', 'personal-cloud'].map(id => ({ ...descriptor, id, typeId: 'openviking', label: id }))
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: {
        providers, items: providers.map(provider => ({ providerId: provider.id, enabled: true, configured: true, settings: { endpoint: 'https://memory.example/openviking', account: 'work' }, configuredSecrets: ['apiKey'] })), generatedAt: '2026-09-25T00:00:00.000Z',
      } }
      if (channel === '/dsh-mnemon-write' && endpoint === 'provider-service-update') {
        if (rejected) throw new Error('Synthetic user key cannot access this memory namespace')
        const request = payload as { providerId: string; settings: Record<string, string> }
        return { ok: true as const, value: { ...request, enabled: true, configured: true, configuredSecrets: ['apiKey'] } }
      }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/fixture/.mnemon', scope: 'global' } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })
    // A saved Provider tells the Memory System, so its Memory Spaces page re-reads the Providers.
    const componentChanges = { bump: vi.fn() }
    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle, {}, translateZh, componentChanges))
    const card = await screen.findByRole('group', { name: 'work-cloud 服务配置' })
    await waitFor(() => expect((within(card).getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(card).getByRole('button'))
    const user = within(card).getByRole('textbox', { name: 'User Key 所属用户（跳过 Admin）' })
    fireEvent.change(user, { target: { value: rejected ? 'bob' : 'alice' } })
    fireEvent.click(within(card).getByRole('button', { name: '保存服务配置' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'provider-service-update', {
      providerId: 'work-cloud', enabled: true, settings: { endpoint: 'https://memory.example/openviking', account: 'work', discoveryUser: rejected ? 'bob' : 'alice' },
    }))
    await within(card).findByText(rejected ? /Synthetic user key cannot access/ : '服务配置已保存，记忆空间目录已同步')
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'provider-service-update')).toHaveLength(1)
    expect(componentChanges.bump).toHaveBeenCalledTimes(rejected ? 0 : 1)
    expect(within(screen.getByRole('group', { name: 'personal-cloud 服务配置' })).queryByRole('textbox')).toBeNull()
  })

  it('applies review choices at once and waits for Apply on the typed limits', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: {}, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
    render(threeTier(scope))
    // A choice applies when made, writing the idle review with only what changed.
    choose('Agent Teams 兼容模式', '受限任务 Agent 审查')
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['idleReview'], value: { agentTeams: 'scoped' } }]))
    expect(selector('Agent Teams 兼容模式').textContent).toBe('受限任务 Agent 审查')
    // The limits are typed: Apply appears once one changes and refuses what the Host would.
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    expect((screen.getByRole('spinbutton', { name: '最小审查间隔（秒）' }) as HTMLInputElement).value).toBe('300')
    fireEvent.change(screen.getByRole('spinbutton', { name: '每会话最多尝试次数' }), { target: { value: '-1' } })
    expect(screen.getByRole('alert').textContent).toBe('每会话最多尝试次数需在 0–200 之间')
    expect(apply().disabled).toBe(true)
    fireEvent.change(screen.getByRole('spinbutton', { name: '每会话最多尝试次数' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '最小审查间隔（秒）' }), { target: { value: '120' } })
    fireEvent.click(apply())
    await waitFor(() => expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['idleReview'], value: { agentTeams: 'scoped', maxPerSession: 3, minIntervalMs: 120_000 } }]))
    await waitFor(() => expect(screen.queryByRole('button', { name: '应用' })).toBeNull())
    // Turning review off applies at once and hides what it controls.
    fireEvent.click(screen.getByRole('switch', { name: '启用空闲审查' }))
    await waitFor(() => expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['idleReview'], value: { agentTeams: 'scoped', maxPerSession: 3, minIntervalMs: 120_000, enabled: false } }]))
    expect(screen.queryByRole('button', { name: /^Agent Teams 兼容模式 / })).toBeNull()
  })

  it('switches runtime memory writes for idle review at once (#319)', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: {}, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
    render(threeTier(scope))
    const runtime = screen.getByRole('switch', { name: '写入运行时记忆' })
    expect(checked(runtime)).toBe(true)
    expect(screen.getByText('只记你明确说过的偏好和规则；关闭后只建项目档案')).toBeTruthy()
    fireEvent.click(runtime)
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['idleReview'], value: { runtimeMemory: false } }]))
    expect(checked(screen.getByRole('switch', { name: '写入运行时记忆' }))).toBe(false)
    // The switch belongs to review: turning review off hides it.
    fireEvent.click(screen.getByRole('switch', { name: '启用空闲审查' }))
    await waitFor(() => expect(screen.queryByRole('switch', { name: '写入运行时记忆' })).toBeNull())
  })

  it('keeps Team review compatibility selection read-only without the Host settings grant', () => {
    const snapshot = { status: 'ready' as const, value: { idleReview: { agentTeams: 'scoped' as const } }, revision: 0, writable: false, mode: 'host' as const }
    const scope = settingsScope(snapshot)
    render(threeTier(scope, undefined, { language: 'en' }, translateEn))
    const choice = selector('Agent Teams compatibility')
    expect(choice.textContent).toBe('Scoped task Agent review')
    expect(choice.disabled).toBe(true)
    expect(scope.mutate).not.toHaveBeenCalled()
  })
  it('applies DSH management of the embedding at once, and the typed connection from its Apply', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)

    render(spaces(scope))

    const managed = screen.getByRole('switch', { name: '由 DSH 管理嵌入配置' })
    expect(checked(managed)).toBe(false)
    // While Mnemon keeps its own embedding, the connection stays out of the way.
    expect(screen.queryByRole('textbox', { name: '嵌入 Endpoint' })).toBeNull()
    fireEvent.click(managed)
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{
      op: 'set', path: ['embedding'], value: { enabled: true, endpoint: 'http://localhost:11434', model: 'nomic-embed-text', apiKey: '', protocol: 'auto' },
    }]))
    const endpoint = await screen.findByRole('textbox', { name: '嵌入 Endpoint' }) as HTMLInputElement
    const model = screen.getByRole('textbox', { name: '嵌入模型' }) as HTMLInputElement
    const apiKey = screen.getByLabelText('API Key（可选，OpenAI 兼容服务）') as HTMLInputElement
    const protocol = screen.getByRole('button', { name: /^协议/ })
    expect(checked(screen.getByRole('switch', { name: '由 DSH 管理嵌入配置' }))).toBe(true)
    expect(endpoint.value).toBe('http://localhost:11434')
    expect(model.value).toBe('nomic-embed-text')
    expect(apiKey.value).toBe('')
    expect(apiKey.type).toBe('password')
    expect(protocol.textContent).toBe('自动（按 /v1 探测）')
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()

    fireEvent.change(endpoint, { target: { value: 'ftp://invalid.example' } })
    expect(screen.getByRole('alert').textContent).toContain('HTTP(S)')
    expect(apply().disabled).toBe(true)

    fireEvent.change(endpoint, { target: { value: 'http://127.0.0.1:11434?' } })
    expect(apply().disabled).toBe(true)

    fireEvent.change(endpoint, { target: { value: ' http://127.0.0.1:8080/api/// ' } })
    fireEvent.change(model, { target: { value: ' qwen3-embedding:0.6b ' } })
    fireEvent.change(apiKey, { target: { value: '  sk-secret  ' } })
    fireEvent.click(protocol)
    fireEvent.click(screen.getByRole('menuitem', { name: 'OpenAI 兼容' }))
    fireEvent.click(apply())

    await waitFor(() => expect(mutate).toHaveBeenLastCalledWith([{
      op: 'set',
      path: ['embedding'],
      value: { enabled: true, endpoint: 'http://127.0.0.1:8080/api', model: 'qwen3-embedding:0.6b', apiKey: 'sk-secret', protocol: 'openai' },
    }]))
  })

  it('turns DSH management off at once with the saved connection, dropping unapplied edits', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: {
        storageScope: 'global' as const,
        embedding: { enabled: true, endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b' },
      },
      base: {}, user: {}, revision: 1, writable: true, mode: 'host' as const,
    }
    const scope = liveSettingsScope<Config>(snapshot, mutate)

    render(spaces(scope))
    fireEvent.change(screen.getByRole('textbox', { name: '嵌入 Endpoint' }), { target: { value: 'ftp://invalid.example' } })
    fireEvent.click(screen.getByRole('switch', { name: '由 DSH 管理嵌入配置' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['embedding'],
      value: { enabled: false, endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b', apiKey: '', protocol: 'auto' },
    }]))
    expect(screen.queryByRole('textbox', { name: '嵌入 Endpoint' })).toBeNull()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
  })

  it('tests the saved embedding runtime through Mnemon and reports connection plus coverage', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: {
        storageScope: 'global' as const,
        embedding: { enabled: true, endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b' },
      },
      base: {}, user: {}, revision: 1, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'embedding-status') return {
        ok: true as const,
        value: { available: true, model: 'qwen3-embedding:0.6b', totalInsights: 8, embedded: 6, coverage: '75%' },
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '' } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))

    expect(await screen.findByText('嵌入服务可用 · qwen3-embedding:0.6b · 已嵌入 6/8（75%）')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'embedding-status', {})
  })

  it('lists the vectors of each Mnemon Native space, so a full count for one never reads as all of them (#392)', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 1, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const space = (memoryBodyId: string, name: string, totalInsights: number, embedded: number, coverage: string, active = true) => ({ memoryBodyId, name, active, totalInsights, embedded, coverage })
    let filled = false
    const fill = Promise.withResolvers<void>()
    const call = vi.fn(async (channel: string, endpoint: string, payload?: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'embedding-status') return {
        ok: true as const,
        value: {
          available: true, model: 'nomic-embed-text', totalInsights: 158, embedded: filled ? 158 : 127, coverage: filled ? '100%' : '80%',
          spaces: [
            space('default', 'Lumen 项目', 94, 94, '100%'),
            filled ? space('7b3da8e7', '工具实测', 64, 64, '100%') : space('7b3da8e7', '工具实测', 64, 33, '51%'),
            space('archive', '调研归档', 0, 0, '0%', false),
            { ...space('broken', '损坏的空间', 0, 0, '0%'), error: 'database disk image is malformed' },
          ],
        },
      }
      if (channel === '/dsh-mnemon-write' && endpoint === 'embedding-fill') {
        expect(payload).toEqual({ memoryBodyId: '7b3da8e7' })
        await fill.promise
        filled = true
        return { ok: true as const, value: { memoryBodyId: '7b3da8e7', filled: 31, remaining: 0, model: 'nomic-embed-text' } }
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '' } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))
    expect(screen.getByText('尚未检查嵌入服务的连接与各 Mnemon Native 空间的覆盖率。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))

    expect(await screen.findByText('嵌入服务可用 · nomic-embed-text · 已嵌入 127/158（80%）')).toBeTruthy()
    const rows = () => within(screen.getByRole('list', { name: '各 Mnemon Native 空间' })).getAllByRole('listitem')
    expect(rows().map(item => item.textContent)).toEqual([
      'Lumen 项目已嵌入 94/94（100%）',
      '工具实测已嵌入 33/64（51%）补齐',
      '调研归档未激活已嵌入 0/0（0%）',
      '损坏的空间无法读取：database disk image is malformed',
    ])
    // The marker is not part of the name, which is what shortens in a narrow card.
    expect(within(rows()[2]!).getByText('调研归档').getAttribute('title')).toBe('调研归档')
    // Only a space that lacks vectors is marked and can be filled in.
    expect(rows().map(item => item.hasAttribute('data-missing'))).toEqual([false, true, false, false])
    expect(screen.getByText('没有向量的记忆不参与语义匹配；点空间旁的「补齐」即可生成缺少的向量。')).toBeTruthy()
    expect(screen.getByText('无法读取的空间没有计入合计。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '补齐「工具实测」的向量' }))
    const running = await screen.findByRole('button', { name: '正在补齐「工具实测」的向量' })
    expect(running.textContent).toBe('补齐中…')
    expect(running.getAttribute('aria-busy')).toBe('true')
    // A test would wait for the fill's lock; it waits for the fill instead.
    expect(screen.getByRole('button', { name: '测试状态' })).toHaveProperty('disabled', true)
    fill.resolve()
    // The counts are read again once the Host has filled the space in, and the line says what it did.
    expect((await screen.findByRole('status')).textContent).toBe('已为「工具实测」补齐 31 条向量。')
    expect(await screen.findByText('嵌入服务可用 · nomic-embed-text · 已嵌入 158/158（100%）')).toBeTruthy()
    expect(rows()[1]!.textContent).toBe('工具实测已嵌入 64/64（100%）')
    expect(screen.queryByRole('button', { name: /补齐「工具实测」的向量/u })).toBeNull()
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'embedding-status')).toHaveLength(2)
  })

  it('fills in no vector of a read-only space, and says it is one (#434)', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 1, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const space = (memoryBodyId: string, name: string, totalInsights: number, embedded: number, coverage: string) => ({ memoryBodyId, name, active: true, totalInsights, embedded, coverage })
    let listed = [{ ...space('legacy', '旧知识库', 40, 10, '25%'), writePolicy: 'read-only' as const }, space('work', '工作记忆', 10, 5, '50%')]
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'embedding-status') return {
        ok: true as const,
        value: { available: true, model: 'nomic-embed-text', totalInsights: 50, embedded: 15, coverage: '30%', spaces: listed },
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '' } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))
    const rows = async () => within(await screen.findByRole('list', { name: '各 Mnemon Native 空间' })).getAllByRole('listitem')
    expect((await rows()).map(item => item.textContent)).toEqual(['旧知识库只读已嵌入 10/40（25%）', '工作记忆已嵌入 5/10（50%）补齐'])
    expect(screen.queryByRole('button', { name: '补齐「旧知识库」的向量' })).toBeNull()
    expect(screen.getByText('没有向量的记忆不参与语义匹配；点空间旁的「补齐」即可生成缺少的向量。')).toBeTruthy()
    // With only a read-only space missing vectors, nothing here can fill them in, and the line does not say it can.
    listed = [listed[0]!]
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))
    await waitFor(async () => expect((await rows()).map(item => item.textContent)).toEqual(['旧知识库只读已嵌入 10/40（25%）']))
    expect(screen.getByText('没有向量的记忆不参与语义匹配。')).toBeTruthy()
  })

  it('says why a fill failed, and offers none while the embedding service is down (#392)', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 1, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    let available = true
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'embedding-status') return {
        ok: true as const,
        value: { available, model: 'nomic-embed-text', totalInsights: 64, embedded: 33, coverage: '51%',
          spaces: [{ memoryBodyId: 'tools', name: '工具实测', active: true, totalInsights: 64, embedded: 33, coverage: '51%' }] },
      }
      if (channel === '/dsh-mnemon-write' && endpoint === 'embedding-fill') {
        available = false
        return { ok: false as const, error: { message: 'Ollama embedding provider not available at http://127.0.0.1:11434' } }
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '' } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))
    fireEvent.click(await screen.findByRole('button', { name: '补齐「工具实测」的向量' }))
    expect((await screen.findByRole('alert')).textContent).toBe('「工具实测」的向量没有补齐：Ollama embedding provider not available at http://127.0.0.1:11434')
    // The status read again finds the service down: no fill is offered, and the hint says when one will be.
    expect(await screen.findByText('嵌入服务不可达 · nomic-embed-text · 已嵌入 33/64（51%）')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '补齐「工具实测」的向量' })).toBeNull()
    expect(screen.getByText('没有向量的记忆不参与语义匹配；嵌入服务可用后，可以在这里补齐。')).toBeTruthy()
    // A new test starts clean.
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('says what a fill that stopped early did, and promises no fill a read-only Host cannot make (#392)', async () => {
    const snapshot = (writeEnabled: boolean) => ({
      status: 'ready' as const,
      value: { storageScope: 'global' as const, writeEnabled },
      base: {}, user: {}, revision: 1, writable: true, mode: 'host' as const,
    })
    const results = [
      // The service answers Mnemon's probe and returns no vector, as when its model is not pulled.
      { memoryBodyId: 'tools', filled: 0, remaining: 64, model: 'nomic-embed-text', stopped: 'refused' },
      { memoryBodyId: 'tools', filled: 50, remaining: 14, model: 'nomic-embed-text', stopped: 'time' },
      { memoryBodyId: 'tools', filled: 10, remaining: 4, model: 'nomic-embed-text', stopped: 'refused' },
    ]
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'embedding-status') return {
        ok: true as const,
        value: { available: true, model: 'nomic-embed-text', totalInsights: 64, embedded: 0, coverage: '0%',
          spaces: [{ memoryBodyId: 'tools', name: '工具实测', active: true, totalInsights: 64, embedded: 0, coverage: '0%' }] },
      }
      if (channel === '/dsh-mnemon-write' && endpoint === 'embedding-fill') return { ok: true as const, value: results.shift()! }
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '' } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })
    const connection = { rpc: { call }, isLoopback: true } as ClientConnectionHandle
    const view = render(spaces(settingsScope(snapshot(true)), connection))
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))
    const fillIn = async (): Promise<void> => {
      const button = await screen.findByRole('button', { name: '补齐「工具实测」的向量' })
      await waitFor(() => expect(button).toHaveProperty('disabled', false))
      fireEvent.click(button)
    }
    await fillIn()
    expect((await screen.findByRole('alert')).textContent).toBe('嵌入服务没有为「工具实测」返回向量，请确认它在运行并提供模型 nomic-embed-text。')
    await fillIn()
    expect((await screen.findByRole('status')).textContent).toBe('已为「工具实测」补齐 50 条向量，还缺 14 条，再点「补齐」继续。')
    await fillIn()
    expect((await screen.findByRole('status')).textContent).toBe('已为「工具实测」补齐 10 条向量；其余 4 条嵌入服务没有返回向量，可以稍后再点「补齐」。')
    view.unmount()

    render(spaces(settingsScope(snapshot(false)), connection))
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))
    expect(await screen.findByText('没有向量的记忆不参与语义匹配。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /补齐/u })).toBeNull()
  })

  it('renders one switch per live Catalog layer and persists only its enabled state', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot, mutate)
    const participation = { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' } as const
    const descriptor: MemoryCompositionStatus = {
      serving: true,
      evaluation: { state: 'ready', contributionRevision: 4, sourceInstanceKeys: [], diagnostics: [] },
      sources: [],
      configuration: {
        id: 'default-three-tier', strategyId: 'default-three-tier',
        layers: Object.fromEntries(['runtime', 'documents', 'memory-spaces'].map(id => [id, { enabled: true, participation: { ...participation }, adapterIds: [] }])),
      },
    }
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'memory-system') return { ok: true as const, value: descriptor }
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '' } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    const view = render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call }, isLoopback: true } as ClientConnectionHandle} />)

    // The components cannot be read here, but the saved layers still switch,
    // named by their ids since no component can name them.
    await screen.findByRole('switch', { name: 'documents' })
    expect(screen.getByText('暂时无法读取记忆组件；这里只能开关记忆层。')).toBeTruthy()
    expect(screen.queryByText('Narrative records')).toBeNull()

    view.rerender(<MnemonSettingsCard scope={scope} connection={{ rpc: { call }, isLoopback: true } as ClientConnectionHandle} t={translateEn} />)
    const enabled = await screen.findByRole('switch', { name: 'documents' })
    expect(screen.getByText('Memory components cannot be read right now; only the memory layers can be switched here.')).toBeTruthy()
    expect(screen.queryByText('Narrative records')).toBeNull()
    expect(screen.queryByRole('combobox', { name: /documents/ })).toBeNull()
    // A layer switch applies at once, without the Save the staged groups use.
    fireEvent.click(enabled)
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['memoryTopology', 'layers', 'documents', 'enabled'],
      value: false,
    }]))
  })

  it('shows a layer whose component is off as off, and keeps the Providers on Memory Spaces\' page until it runs', async () => {
    const scope = settingsScope({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const })
    const participation = { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' } as const
    const descriptor: MemoryCompositionStatus = {
      serving: true,
      evaluation: { state: 'ready', contributionRevision: 4, sourceInstanceKeys: [], diagnostics: [] },
      sources: [],
      configuration: {
        id: 'default-three-tier', strategyId: 'default-three-tier',
        layers: Object.fromEntries(['runtime', 'documents', 'memory-spaces'].map(id => [id, { enabled: true, participation: { ...participation }, adapterIds: [] }])),
      },
    }
    // Each component names itself, as the shipped packages do.
    const names: Record<string, string> = { 'mnemon-source-runtime': '运行时记忆', 'mnemon-source-documents': '项目档案', 'mnemon-source-memory-spaces': '记忆空间', 'mnemon-strategy-default-three-tier': '分层策略' }
    const component = (entryId: string, packageName: string, roles: MemoryPluginEntryView['roles'], values: Partial<MemoryPluginEntryView>): MemoryPluginEntryView => ({
      entryId, packageName, roles, label: { en: entryId, 'zh-CN': names[entryId] ?? entryId }, description: { en: '', 'zh-CN': '' }, fields: [], provides: [], requires: [], requiredBy: [],
      enabled: true, active: true, writable: true, config: {}, ...values,
    })
    let dashboard: MemoryViewDashboard = {
      revision: 'view-1', writable: true, strategyTypeId: 'default-three-tier', currentUnavailable: 'no-session', sources: [], diagnostics: [],
      pluginInstallation: { supported: false, reason: 'loader-unavailable', suggestions: [] },
      entries: [
        component('mnemon-strategy-default-three-tier', 'dsh-mnemon-strategy-default-three-tier', ['strategy'], { typeId: 'default-three-tier', provides: [{ id: 'strategy', exclusive: false }] }),
        component('mnemon-source-runtime', 'dsh-mnemon-source-runtime', ['source'], { typeId: 'runtime' }),
        // A Source that is off has registered nothing, so it has no type id.
        component('mnemon-source-documents', 'dsh-mnemon-source-documents', ['source'], { enabled: false, active: false }),
        component('mnemon-source-memory-spaces', 'dsh-mnemon-source-memory-spaces', ['source'], { enabled: false, active: false }),
      ],
    }
    const applied: MemoryViewConfigurationRequest[] = []
    const call = vi.fn(async (channel: string, endpoint: string, payload?: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'memory-system') return { ok: true as const, value: descriptor }
      if (channel === '/dsh-mnemon-view' && endpoint === 'dashboard') return { ok: true as const, value: structuredClone(dashboard) }
      if (channel === '/dsh-mnemon-view-settings' && endpoint === 'apply') {
        const request = (payload as { configuration: MemoryViewConfigurationRequest }).configuration
        applied.push(request)
        dashboard = { ...dashboard, revision: 'view-2', entries: dashboard.entries.map(entry => request.entries[entry.entryId] === undefined ? entry : { ...entry, enabled: true, active: true, typeId: 'memory-spaces' }) }
        return { ok: true as const, value: { saved: true as const } }
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '2026-09-27T00:00:00.000Z' } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    const connection = { rpc: { call }, isLoopback: true } as ClientConnectionHandle
    // The configuration renders what components contributed to their pages; here Memory Spaces' own settings.
    const componentSettings = {
      has: (packageName: string) => packageName === MEMORY_SPACES_PACKAGE,
      render: (entry: MemoryPluginEntryView, current: { enabled: boolean; label: string; writable: boolean; language: string }) =>
        <MemorySpacesSettings component={{ packageName: entry.packageName, label: current.label, enabled: current.enabled }} writable={current.writable} language={current.language} host={hostFor(scope, connection, {})!} />,
    }
    render(<MnemonSettingsCard scope={scope} connection={connection} componentSettings={componentSettings} />)
    // A layer whose Source component is off reads as off: the component is the layer's switch.
    const documents = (await screen.findByRole('switch', { name: '项目档案' })).closest('[data-mnemon-target]') as HTMLElement
    expect(within(documents).getByText('已关闭')).toBeTruthy()
    // The page's top level carries no Provider group: they are Memory Spaces' own settings.
    expect(screen.queryByRole('region', { name: '记忆 Provider' })).toBeNull()
    const spacesRow = screen.getByRole('switch', { name: '记忆空间' }).closest('[data-mnemon-target]') as HTMLElement
    fireEvent.click(within(spacesRow).getByRole('button', { name: '“记忆空间”的选项' }))
    const spacesPage = screen.getByRole('dialog', { name: '记忆空间' })
    expect(within(spacesPage).getByText('开启后可配置 Provider 与嵌入')).toBeTruthy()
    // The Providers are not read while their Source is off.
    expect(call.mock.calls.some(([, endpoint]) => endpoint === 'provider-services')).toBe(false)

    // The page's switch is the row's; once it runs, its settings read the Providers.
    fireEvent.click(within(spacesPage).getByRole('switch', { name: '记忆空间' }))
    await waitFor(() => expect(applied).toEqual([{ expectedRevision: 'view-1', strategyTypeId: 'default-three-tier', entries: { 'mnemon-source-memory-spaces': { enabled: true, config: {} } } }]))
    await waitFor(() => expect(call.mock.calls.some(([, endpoint]) => endpoint === 'provider-services')).toBe(true))
    expect(within(screen.getByRole('dialog', { name: '记忆空间' })).getByRole('heading', { name: '记忆 Provider' })).toBeTruthy()
    expect(within(documents).getByText('已关闭')).toBeTruthy()
  })

  it('marks 技能管理 experimental on its row and its page, and no other component', async () => {
    const scope = settingsScope({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const })
    const participation = { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' } as const
    const descriptor: MemoryCompositionStatus = {
      serving: true,
      evaluation: { state: 'ready', contributionRevision: 1, sourceInstanceKeys: [], diagnostics: [] },
      sources: [],
      configuration: { id: 'default-three-tier', strategyId: 'default-three-tier', layers: Object.fromEntries(['runtime', 'skills'].map(id => [id, { enabled: true, participation: { ...participation }, adapterIds: [] }])) },
    }
    const component = (entryId: string, packageName: string, label: string, roles: MemoryPluginEntryView['roles'], typeId: string): MemoryPluginEntryView => ({
      entryId, packageName, roles, typeId, label: { en: label, 'zh-CN': label }, description: { en: '', 'zh-CN': '' }, fields: [], provides: [], requires: [], requiredBy: [],
      enabled: true, active: true, writable: true, config: {},
    })
    const dashboard: MemoryViewDashboard = {
      revision: 'view-1', writable: true, strategyTypeId: 'default-three-tier', currentUnavailable: 'no-session', sources: [], diagnostics: [],
      pluginInstallation: { supported: false, reason: 'loader-unavailable', suggestions: [] },
      entries: [
        { ...component('mnemon-strategy-default-three-tier', 'dsh-mnemon-strategy-default-three-tier', '分层策略', ['strategy'], 'default-three-tier'), provides: [{ id: 'strategy', exclusive: false }] },
        component('mnemon-source-runtime', 'dsh-mnemon-source-runtime', '运行时记忆', ['source'], 'runtime'),
        component('mnemon-source-skills', 'dsh-mnemon-source-skills', '技能管理', ['source'], 'skills'),
      ],
    }
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'memory-system') return { ok: true as const, value: descriptor }
      if (channel === '/dsh-mnemon-view' && endpoint === 'dashboard') return { ok: true as const, value: structuredClone(dashboard) }
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })
    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call }, isLoopback: true } as ClientConnectionHandle} />)
    const skills = (await screen.findByRole('switch', { name: '技能管理' })).closest('[data-mnemon-target]') as HTMLElement
    expect(within(skills).getByText('实验性')).toBeTruthy()
    const runtime = screen.getByRole('switch', { name: '运行时记忆' }).closest('[data-mnemon-target]') as HTMLElement
    expect(within(runtime).queryByText('实验性')).toBeNull()
    fireEvent.click(within(skills).getByRole('button', { name: '技能管理' }))
    expect(within(await screen.findByRole('dialog', { name: '技能管理' })).getByText('实验性')).toBeTruthy()
  })

  it('ignores a Provider catalog response from the previously selected workspace', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'workspace' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const provider = MEMORY_PROVIDER_CATALOG.find(candidate => candidate.id === 'openviking')!
    const catalog = (endpoint: string) => ({
      ok: true as const,
      value: {
        providers: [provider],
        items: [{ providerId: 'openviking' as const, enabled: true, configured: true, settings: { endpoint }, configuredSecrets: [] }],
        generatedAt: '2026-08-17T00:00:00.000Z',
      },
    })
    const firstWorkspace = deferred<ReturnType<typeof catalog>>()
    const call = vi.fn(async (channel: string, endpoint: string, payload?: { workspaceId?: string }) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') {
        return payload?.workspaceId === 'workspace-1' ? firstWorkspace.promise : catalog('https://workspace-2.example')
      }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/workspace/.mnemon', scope: 'workspace' as const } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })
    const connection = { rpc: { call }, isLoopback: true } as ClientConnectionHandle
    const view = render(spaces(scope, connection, { workspaceId: 'workspace-1', workspaceLabel: 'One' }))

    view.rerender(spaces(scope, connection, { workspaceId: 'workspace-2', workspaceLabel: 'Two' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'provider-services', { workspaceId: 'workspace-2' }))
    const providerGroup = await screen.findByRole('group', { name: 'OpenViking 服务配置' }, { timeout: 5_000 })
    fireEvent.click(within(providerGroup).getByRole('button'))
    await waitFor(() => expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('https://workspace-2.example'), { timeout: 5_000 })

    await act(async () => { firstWorkspace.resolve(catalog('https://workspace-1.example')); await firstWorkspace.promise })
    expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('https://workspace-2.example')
  }, 10_000)

  it('uses the Host settings grant instead of transport locality on a trusted remote connection', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const call = vi.fn(async (channel: string, remoteEndpoint: string, rawArgs: unknown) => {
      const endpoint = (rawArgs as { args: { endpoint: string } }).args.endpoint
      if (channel === '/api' && remoteEndpoint === 'dshMnemon/read' && endpoint === 'task-agent-models') return {
        ok: true as const,
        value: { ok: true as const, value: { effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const }, groups: [], failures: [] } },
      }
      if (channel === '/api' && remoteEndpoint === 'dshMnemon/read' && endpoint === 'provider-services') return {
        ok: true as const, value: { ok: true as const, value: { providers: [], items: [], generatedAt: '' } },
      }
      if (channel === '/api' && remoteEndpoint === 'dshMnemon/pack' && endpoint === 'target') return {
        ok: true as const, value: { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } },
      }
      throw new Error(`unexpected ${channel} ${remoteEndpoint}/${endpoint}`)
    })
    const connection = { rpc: { call }, isLoopback: false } as ClientConnectionHandle

    render(<><MnemonSettingsCard scope={scope} connection={connection} />{spaces(scope, connection)}{threeTier(scope, connection)}</>)

    await waitFor(() => expect(call).toHaveBeenCalledWith('/api', 'dshMnemon/read', {
      args: { endpoint: 'task-agent-models', payload: { includeCatalog: false } },
    }))
    expect(selector('存储范围').disabled).toBe(false)
    expect(selector('任务 Agent 模型').disabled).toBe(false)
    expect(screen.queryByText('当前部署的插件设置为只读。')).toBeNull()
    await waitFor(() => expect(call.mock.calls.some(([, remoteEndpoint, args]) => remoteEndpoint === 'dshMnemon/read' && (args as { args: { endpoint: string } }).args.endpoint === 'provider-services')).toBe(true))
    expect(call.mock.calls.some(([, remoteEndpoint, args]) => remoteEndpoint === 'dshMnemon/pack' && (args as { args: { endpoint: string } }).args.endpoint === 'target')).toBe(true)
  })

  it('shows an actionable error instead of a blank settings page when both scopes are unavailable', () => {
    const snapshot = { status: 'unavailable' as const, writable: false, mode: 'host' as const }
    const scope = settingsScope<Config>(snapshot)

    render(<MnemonSettingsCard scope={scope} />)

    expect(screen.getByRole('alert').textContent).toContain('无法加载记忆系统设置')
  })

  it('follows global by default and applies a custom Provider and model at once', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
    const call = vi.fn(async (channel: string, endpoint: string, _payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return {
        ok: true as const,
        value: {
          effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
          defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
          groups: [
            { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
            {
              id: 'deepseek-official',
              name: 'DeepSeek',
              models: [{
                id: 'deepseek-v4-flash-vision-exp',
                name: 'DeepSeek-V4-Flash-Vision-Exp',
                inputModalities: ['text', 'image'],
              }],
            },
            { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
          ],
          failures: [],
        },
      }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(threeTier(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))

    expect(selector('任务 Agent 模型').textContent).toBe('跟随全局')
    expect(await screen.findByText('deepseek / deepseek-chat')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'task-agent-models', { includeCatalog: false })
    // Choosing a custom model applies at once, starting from DSH's new-session model.
    choose('任务 Agent 模型', '自定义')
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'task-agent-models', { includeCatalog: true }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['taskAgentModel'], value: { mode: 'fixed', provider: 'deepseek', model: 'deepseek-chat' } }]))
    // Providers sharing a name are told apart by their ids; a Provider starts from its first model.
    chooseIn('mnemon-task-agent-provider', 'deepseek-official')
    await waitFor(() => expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['taskAgentModel'], value: { mode: 'fixed', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' } }]))
    fireEvent.click(rowSelector('mnemon-task-agent-model'))
    expect(screen.getByRole('menuitem', { name: /DeepSeek-V4-Flash-Vision-Exp.*图片输入/u })).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    chooseIn('mnemon-task-agent-provider', 'OpenAI')
    await waitFor(() => expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['taskAgentModel'], value: { mode: 'fixed', provider: 'openai', model: 'gpt-5' } }]))
    expect(rowSelector('mnemon-task-agent-model').textContent).toBe('GPT-5')
    expect(screen.getByText('openai / gpt-5')).toBeTruthy()
  })

  it('follows the conversation the page was opened from only once that is chosen, and reads a choice stored elsewhere', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
    const call = vi.fn(async (channel: string, endpoint: string, _payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: conversationDirectory }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(threeTier(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle, { sessionId: 'session-7', workspaceId: 'workspace-3' }))

    // Following global keeps DSH's new-session model whatever the conversation runs on.
    expect(await screen.findByText('deepseek / deepseek-chat')).toBeTruthy()
    expect(screen.getByText('新会话模型')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'task-agent-models', { includeCatalog: false, sessionId: 'session-7', workspaceId: 'workspace-3' })
    choose('任务 Agent 模型', '跟随会话')
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['taskAgentModel'], value: { mode: 'inherit', followConversation: true } }]))
    // The conversation's model reads before the Host is asked again.
    expect(await screen.findByText('ai / space-bunny')).toBeTruthy()
    expect(screen.getByText('当前会话')).toBeTruthy()
    expect(selector('任务 Agent 模型').textContent).toBe('跟随会话')

    // A choice stored elsewhere reads here at once.
    await act(async () => { await scope.mutate([{ op: 'set', path: ['taskAgentModel'], value: { mode: 'inherit' } }]) })
    expect(await screen.findByText('deepseek / deepseek-chat')).toBeTruthy()
    expect(selector('任务 Agent 模型').textContent).toBe('跟随全局')
  })

  it('keeps following the conversation when a custom model is given up before it was written', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'global' as const, taskAgentModel: { mode: 'inherit', followConversation: true } }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
    // The whole directory never arrives, so choosing a custom model waits.
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') {
        return (payload as { includeCatalog: boolean }).includeCatalog ? new Promise(() => {}) : { ok: true as const, value: conversationDirectory }
      }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(threeTier(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle, { sessionId: 'session-7' }))
    expect(await screen.findByText('ai / space-bunny')).toBeTruthy()
    choose('任务 Agent 模型', '自定义')
    choose('任务 Agent 模型', '跟随会话')

    expect(selector('任务 Agent 模型').textContent).toBe('跟随会话')
    expect(screen.getByText('ai / space-bunny')).toBeTruthy()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('reads the whole directory again for a custom route after a failed read', async () => {
    let full = 0
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'global' as const, taskAgentModel: { mode: 'fixed', provider: 'openai', model: 'gpt-5' } }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, vi.fn(async () => {}))
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') {
        if ((payload as { includeCatalog: boolean }).includeCatalog && ++full === 1) return { ok: false as const, error: { code: 'unavailable', message: 'the model directory is down' } }
        return { ok: true as const, value: conversationDirectory }
      }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(threeTier(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))
    expect(await screen.findByText(/模型目录读取失败/u)).toBeTruthy()
    // A failed read is a statement with its retry, not an alert to dismiss.
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(full).toBe(2))
    // With the directory read, the custom route can be changed in place.
    await waitFor(() => expect(rowSelector('mnemon-task-agent-model').disabled).toBe(false))
    expect(rowSelector('mnemon-task-agent-model').textContent).toBe('GPT-5')
  })

  it('states the route the Host takes without a DSH default, and the Host\'s route before the settings are read', async () => {
    const without = { ...conversationDirectory, defaultSelection: undefined, inherited: { provider: 'ai', model: 'starter', source: 'active-agent' as const }, effective: { provider: 'ai', model: 'starter', source: 'active-agent' as const } }
    const call = vi.fn(async (_channel: string, _endpoint: string, _payload: unknown) => ({ ok: true as const, value: without }))
    const ready = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, vi.fn(async () => {}))
    const { unmount } = render(threeTier(ready, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))
    expect(await screen.findByText('ai / starter')).toBeTruthy()
    expect(screen.getByText('已打开的会话')).toBeTruthy()
    unmount()

    // Until the page has the settings, only the Host knows the stored choice.
    const stored = { ...conversationDirectory, effective: { provider: 'openai', model: 'gpt-5', source: 'fixed' as const } }
    const loading = settingsScope<Config>({ status: 'loading' as const, writable: false, mode: 'host' as const } as never)
    render(threeTier(loading, { rpc: { call: vi.fn(async () => ({ ok: true as const, value: stored })) }, isLoopback: true } as ClientConnectionHandle))
    expect(await screen.findByText('openai / gpt-5')).toBeTruthy()
    expect(screen.getByText('自定义')).toBeTruthy()
  })

  it('keeps rapid route-mode switches stable while model requests finish out of order', async () => {
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
    const catalog = {
      effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const },
      defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
      failures: [],
    }
    let resolveRoute!: (value: { ok: true; value: typeof catalog }) => void
    let resolveCatalog!: (value: { ok: true; value: typeof catalog }) => void
    const route = new Promise<{ ok: true; value: typeof catalog }>(resolve => { resolveRoute = resolve })
    const full = new Promise<{ ok: true; value: typeof catalog }>(resolve => { resolveCatalog = resolve })
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') {
        return (payload as { includeCatalog: boolean }).includeCatalog ? full : route
      }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(threeTier(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))
    // A custom model chosen before the catalog arrives waits for it; following global again cancels it.
    choose('任务 Agent 模型', '自定义')
    choose('任务 Agent 模型', '跟随全局')

    await act(async () => {
      resolveCatalog({ ok: true, value: catalog })
      await full
      resolveRoute({ ok: true, value: catalog })
      await route
    })

    expect(selector('任务 Agent 模型').textContent).toBe('跟随全局')
    const writes = mutate.mock.calls as unknown as Array<[Array<{ value: { mode: string } }>]>
    expect(writes.every(([operations]) => operations[0]!.value.mode === 'inherit')).toBe(true)
    choose('任务 Agent 模型', '自定义')
    await waitFor(() => expect(rowSelector('mnemon-task-agent-provider').disabled).toBe(false))
    expect(rowSelector('mnemon-task-agent-provider').textContent).toBe('DeepSeek')
    // The catalog read once in full is not read again.
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'task-agent-models')).toHaveLength(2)
  })

  it('hydrates the full model catalog when a fixed route was already saved', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: {
        storageScope: 'global' as const,
        taskAgentModel: { mode: 'fixed' as const, provider: 'openai', model: 'gpt-5' },
      },
      base: {}, user: {}, revision: 1, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return {
        ok: true as const,
        value: {
          effective: { provider: 'openai', model: 'gpt-5', source: 'fixed' as const },
          defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
          groups: [
            { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
            { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
          ],
          failures: [],
        },
      }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(threeTier(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))

    expect(selector('任务 Agent 模型').textContent).toBe('自定义')
    await waitFor(() => expect(rowSelector('mnemon-task-agent-provider').disabled).toBe(false))
    expect(rowSelector('mnemon-task-agent-provider').textContent).toBe('OpenAI')
    expect(rowSelector('mnemon-task-agent-model').textContent).toBe('GPT-5')
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'task-agent-models', { includeCatalog: true })
  })

  it.each([undefined, 'builtin', 'buildin', 'sidebar'] as const)('applies displayMode=%s at once, while storage waits for its Apply', async displayMode => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const, ...(displayMode === undefined ? {} : { displayMode }) },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = liveSettingsScope<Config>(snapshot, mutate)

    render(<MnemonSettingsCard scope={scope} />)

    const isBuiltin = displayMode === 'builtin' || displayMode === 'buildin'
    expect(selector('记忆系统入口').textContent).toBe(isBuiltin ? '会话标签页' : '侧边栏')
    expect(mutate).not.toHaveBeenCalled()
    choose('记忆系统入口', isBuiltin ? '侧边栏' : '会话标签页')
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['displayMode'], value: isBuiltin ? 'sidebar' : 'builtin' }]))
    expect(selector('记忆系统入口').textContent).toBe(isBuiltin ? '侧边栏' : '会话标签页')
    // Moving the storage says what it does and waits for its own Apply.
    choose('存储范围', '工作区')
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(screen.getByText('应用后读写新位置，已有数据不会迁移')).toBeTruthy()
    fireEvent.click(apply())
    await waitFor(() => expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['storageScope'], value: 'workspace' }]))
  })

  it('applies a storage change from its own line and says it was saved', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { timeoutMs: 10000, defaultRecallLimit: 10, routingGuidance: true, lifecycleEnabled: true, recallMode: 'guided' as const, writebackMode: 'guided' as const, tabEnabled: true, writeEnabled: true },
      base: { timeoutMs: 10000, defaultRecallLimit: 10, routingGuidance: true, lifecycleEnabled: true, recallMode: 'guided' as const, writebackMode: 'guided' as const, tabEnabled: true, writeEnabled: true },
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const scope = settingsScope(snapshot, mutate)

    render(<MnemonSettingsCard scope={scope} />)
    choose('存储范围', '工作区')
    expect(screen.queryByRole('textbox', { name: '数据目录' })).toBeNull()
    fireEvent.click(apply())

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['storageScope'], value: 'workspace' }]))
    expect(screen.getByText('已保存并实时生效')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复默认' })).toBeNull()
    expect(screen.queryByText(/\.dsh\/settings.yaml/)).toBeNull()
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('keeps where USER.md lives on Runtime Memory\'s page, applied when chosen', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'workspace' as const, runtimeUserScope: 'storage' as const },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const scope = liveSettingsScope<Config>(snapshot, mutate)

    render(<><MnemonSettingsCard scope={scope} />{runtime(scope)}</>)

    // The configuration page keeps only what belongs to no component.
    expect(screen.getAllByRole('button', { name: /^用户画像范围 /u })).toHaveLength(1)
    expect(selector('用户画像范围').textContent).toBe('跟随存储范围')
    choose('用户画像范围', '全局共享')
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['runtimeUserScope'], value: 'global' }]))
    expect(selector('用户画像范围').textContent).toBe('全局共享')
  })

  it('uses the DSH-bound locale in the plugin configuration slot', () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)

    render(<MnemonSettingsCard scope={scope} t={translateEn} />)

    expect(selector('Storage scope').textContent).toBe('Global')
    choose('Storage scope', 'Workspace')
    expect(screen.getByText('Memory moves to the new location; existing data stays where it is')).toBeTruthy()
    expect(apply('Apply')).toBeTruthy()
  })

  it('explains the grouping row only while DSH lists it below the configuration', () => {
    const scope = settingsScope({ status: 'ready' as const, value: {}, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const })
    const componentList = new MnemonComponentListSeat()
    const note = () => screen.queryByText(/dsh-mnemon\/bundle is the Starter's grouping entry/u)
    render(<MnemonSettingsCard scope={scope} t={translateEn} componentList={componentList} />)
    expect(note()).toBeNull()
    let withdraw = (): void => {}
    act(() => { withdraw = componentList.report(true) })
    expect(note()).toBeTruthy()
    act(() => { withdraw(); withdraw = componentList.report(false) })
    expect(note()).toBeNull()
    act(() => withdraw())
    expect(note()).toBeNull()
  })

  it('accepts and persists a manually entered custom directory', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const scope = settingsScope(snapshot, mutate)
    const view = render(<MnemonSettingsCard scope={scope} />)

    // The default location has no field; choosing Custom opens one, ready to type in.
    expect(directoryChoice('默认').checked).toBe(true)
    expect(view.queryByRole('textbox', { name: '数据目录' })).toBeNull()
    fireEvent.click(directoryChoice('自定义'))
    const directory = view.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement
    expect(document.activeElement).toBe(directory)
    expect(directory.placeholder).toBe('例如 ~/Documents/mnemon')
    expect(apply().disabled).toBe(true)
    fireEvent.change(directory, { target: { value: '  /tmp/mnemon-custom  ' } })
    expect(selector('存储范围').textContent).toBe('全局')
    fireEvent.click(apply())

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['storageScope'], value: 'custom' },
      { op: 'set', path: ['dataDir'], value: '/tmp/mnemon-custom' },
    ]))
  })

  it('migrates a legacy named Pack to the single selected directory', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: {
        storageScope: 'custom' as const,
        customPackId: 'project',
        customPacks: [
          { id: 'project', name: 'Project', dataDir: '/packs/project' },
          { id: 'research', name: 'Research', dataDir: '/packs/research' },
        ],
      },
      base: {},
      user: {
        storageScope: 'custom' as const,
        customPackId: 'project',
        customPacks: [
          { id: 'project', name: 'Project', dataDir: '/packs/project' },
          { id: 'research', name: 'Research', dataDir: '/packs/research' },
        ],
      },
      revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot, mutate)

    render(<MnemonSettingsCard scope={scope} />)
    const directory = screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement
    expect(directory.value).toBe('/packs/project')
    expect(selector('存储范围').textContent).toBe('全局')
    fireEvent.change(directory, { target: { value: '/packs/research' } })
    fireEvent.click(apply())

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['dataDir'], value: '/packs/research' },
      { op: 'unset', path: ['customPackId'] },
      { op: 'unset', path: ['customPacks'] },
    ]))
  })

  it('returns to the default directory by choosing it, not by emptying the field', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const mutate = vi.fn(async () => {})
    const scope = settingsScope({ ...snapshot, value: { storageScope: 'custom' as const, dataDir: '/data/mnemon' } }, mutate)

    render(<MnemonSettingsCard scope={scope} />)
    const directory = screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement
    expect(directory.value).toBe('/data/mnemon')
    expect(directoryChoice('自定义').checked).toBe(true)
    // An emptied field waits for a directory rather than meaning the default, which is a choice of its own.
    fireEvent.change(directory, { target: { value: '' } })
    expect(apply().disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(directory.getAttribute('aria-invalid')).toBe('false')
    fireEvent.click(directoryChoice('默认'))
    expect(screen.queryByRole('textbox', { name: '数据目录' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(apply())

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['storageScope'], value: 'global' },
      { op: 'unset', path: ['dataDir'] },
    ]))
  })

  it('accepts Windows drive and UNC paths in the browser form', () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)

    render(<MnemonSettingsCard scope={scope} />)
    fireEvent.click(directoryChoice('自定义'))
    const directory = screen.getByRole('textbox', { name: '数据目录' })
    fireEvent.change(directory, { target: { value: 'relative/mnemon' } })
    expect(screen.getByRole('alert').textContent).toContain('绝对路径')
    fireEvent.change(directory, { target: { value: 'C:\\memory\\mnemon' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(directory, { target: { value: '\\\\server\\share\\mnemon' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uses native disabled semantics for a read-only settings scope', () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {},
      user: {},
      revision: 0,
      writable: false,
      mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)

    render(<><MnemonSettingsCard scope={scope} />{threeTier(scope)}</>)

    expect(selector('存储范围').disabled).toBe(true)
    expect(directoryChoice('默认').disabled).toBe(true)
    expect(directoryChoice('自定义').disabled).toBe(true)
    expect((screen.getByRole('switch', { name: '启用空闲审查' }) as HTMLButtonElement).disabled).toBe(true)
    expect(selector('审查方式').disabled).toBe(true)
    expect(selector('记忆系统入口').disabled).toBe(true)
    expect((screen.getByRole('switch', { name: '回合记忆栏' }) as HTMLButtonElement).disabled).toBe(true)
    // The notice leads the page, above every group, as on DSH's own settings forms.
    const notice = screen.getByText('当前部署的插件设置为只读。')
    const configuration = screen.getByRole('region', { name: '记忆系统配置' })
    expect(configuration.firstElementChild).toBe(notice)
  })

  it('says a remote page needs the management grant instead of calling the deployment read-only', () => {
    const snapshot = { status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: false, mode: 'host' as const }
    const call = vi.fn(async () => ({ ok: false as const, error: { code: 'unavailable', message: 'offline', details: { issues: [] } } }))
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'memory.example' })
    try {
      render(<MnemonSettingsCard scope={settingsScope(snapshot)} connection={{ isLoopback: false, rpc: { call } } as never} />)
      expect(screen.getByText(/^远程访问时插件设置为只读：/)).toBeTruthy()
      expect(screen.queryByText('当前部署的插件设置为只读。')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not present temporary defaults as read-only while settings load', () => {
    const snapshot = {
      status: 'loading' as const,
      writable: false,
      mode: 'host' as const,
    }
    const scope = settingsScope<Config>(snapshot)

    render(<MnemonSettingsCard scope={scope} />)

    expect(screen.getByRole('status').textContent).toBe('载入中…')
    expect(screen.queryByText('当前部署的插件设置为只读。')).toBeNull()
    expect(screen.queryByRole('button', { name: /^存储范围 / })).toBeNull()
  })

  it('applies an interaction toggle at once through the mnemon-ui scope', async () => {
    const interactionMutate = vi.fn(async () => {})
    const coreSnapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const scope = settingsScope(coreSnapshot)
    const interactionSnapshot = {
      status: 'ready' as const,
      value: { turnBar: true, saveAction: true },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const interactionScope = liveSettingsScope(interactionSnapshot, interactionMutate)

    const view = render(<MnemonSettingsCard scope={scope} interactionScope={interactionScope} />)

    const turnBar = view.getByRole('switch', { name: '回合记忆栏' })
    expect(checked(turnBar)).toBe(true)
    expect(view.queryByLabelText('记忆工具卡')).toBeNull()

    fireEvent.click(turnBar)
    await waitFor(() => expect(interactionMutate).toHaveBeenCalledWith([
      { op: 'set', path: ['turnBar'], value: false },
    ]))
    expect(checked(view.getByRole('switch', { name: '回合记忆栏' }))).toBe(false)
    expect(view.queryByRole('button', { name: '应用' })).toBeNull()
  })

  it('shows the saved value again beside the reason when a toggle is refused', async () => {
    const scope = settingsScope({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const })
    const interactionScope = liveSettingsScope({ status: 'ready' as const, value: { turnBar: true, saveAction: true }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const },
      vi.fn(async () => { throw new Error('settings are locked') }))

    render(<MnemonSettingsCard scope={scope} interactionScope={interactionScope} />)
    fireEvent.click(screen.getByRole('switch', { name: '存入记忆按钮' }))
    expect((await screen.findByRole('alert')).textContent).toBe('保存失败：settings are locked')
    expect(checked(screen.getByRole('switch', { name: '存入记忆按钮' }))).toBe(true)
  })

  it('presents the two remaining interaction toggles checked by default', () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)

    const view = render(<MnemonSettingsCard scope={scope} />)

    expect(view.queryByLabelText('记忆工具卡')).toBeNull()
    expect(checked(view.getByRole('switch', { name: '回合记忆栏' }))).toBe(true)
    expect(checked(view.getByRole('switch', { name: '存入记忆按钮' }))).toBe(true)
  })

  it('does not invent Provider registrations while the Host catalog is loading', () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'workspace' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const providerSettings = new Promise<never>(() => {})
    const call = vi.fn((channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return providerSettings
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return Promise.resolve({ ok: true as const, value: { root: '/active/.mnemon', scope: 'global' } })
      return Promise.reject(new Error(`unexpected ${channel} ${endpoint}`))
    })

    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))

    expect(screen.queryAllByRole('group', { name: /服务配置/ })).toHaveLength(0)
    expect(screen.queryAllByRole('switch', { name: /^启用 / })).toHaveLength(0)
    expect(screen.getByText('正在读取 Provider 配置…').getAttribute('role')).toBe('status')
  })

  it('uses the native default/custom location pattern for a scope-aware local provider', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const provider = {
      id: 'holographic' as const,
      label: 'Holographic', kind: 'local' as const, origin: 'third-party' as const, summary: 'Local facts',
      workspaceBinding: 'optional-override' as const,
      capabilities: { search: true, browse: true, graph: true, entities: true, related: true, remember: true, link: false, forget: true, writeMode: 'exact' as const, deletionMode: 'hard' as const },
      fields: [{ key: 'dataPath', label: 'Fact store path', i18nKey: 'overview.providerField.dataPath' as const, scope: 'service' as const, role: 'global-location' as const, input: 'path' as const, required: false }],
    }
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [provider], items: [{ providerId: 'holographic', enabled: true, configured: true, settings: { dataPath: '/srv/dsh/holographic.json' }, configuredSecrets: [] }], generatedAt: '2026-08-17T00:00:00.000Z' } }
      if (channel === '/dsh-mnemon-write' && endpoint === 'provider-service-update') {
        const request = payload as { settings: Record<string, string> }
        return { ok: true as const, value: { providerId: 'holographic', enabled: true, configured: true, settings: request.settings, configuredSecrets: [] } }
      }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/active/.mnemon', scope: 'global' } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))

    const card = await screen.findByRole('group', { name: 'Holographic 服务配置' })
    fireEvent.click(within(card).getByText('Holographic'))
    const location = within(card).getByRole('radiogroup', { name: 'Holographic 全局数据位置' })
    const defaultLocation = within(location).getByRole('radio', { name: '默认（跟随范围）' }) as HTMLInputElement
    const customLocation = within(location).getByRole('radio', { name: '自定义' }) as HTMLInputElement
    const scrollViewport = card.parentElement as HTMLElement
    scrollViewport.style.overflowY = 'auto'
    Object.defineProperties(scrollViewport, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 1000 } })
    const hiddenViewport = scrollViewport.parentElement as HTMLElement
    hiddenViewport.style.overflowY = 'hidden'

    expect(customLocation.checked).toBe(true)
    hiddenViewport.scrollTop = 240
    fireEvent.click(customLocation)
    expect(hiddenViewport.scrollTop).toBe(0)
    for (let cycle = 0; cycle < 3; cycle += 1) {
      hiddenViewport.scrollTop = 240
      fireEvent.click(defaultLocation)
      expect(within(card).queryByRole('textbox', { name: '事实存储路径' })).toBeNull()
      expect(hiddenViewport.scrollTop).toBe(0)
      fireEvent.click(customLocation)
      expect((within(card).getByRole('textbox', { name: '事实存储路径' }) as HTMLInputElement).value).toBe('/srv/dsh/holographic.json')
    }
    const path = within(card).getByRole('textbox', { name: '事实存储路径' })
    const save = within(card).getByRole('button', { name: '保存服务配置' }) as HTMLButtonElement
    fireEvent.change(path, { target: { value: '/srv/dsh/holographic-v2.json' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'provider-service-update', expect.objectContaining({
      providerId: 'holographic', enabled: true, settings: { dataPath: '/srv/dsh/holographic-v2.json' },
    })))
  })

  it('renders and saves an unknown Provider instance entirely from its descriptor', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const provider = {
      id: 'work-account', typeId: 'vector-store', label: 'Vector Store', icon: { kind: 'glyph' as const, value: 'VS' },
      kind: 'remote' as const, origin: 'third-party' as const, workspaceBinding: 'provider-global' as const,
      summary: 'Independent vector memory.',
      capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: false, writeMode: 'exact' as const, deletionMode: 'unsupported' as const },
      fields: [
        { key: 'serverUrl', label: 'Vector endpoint', scope: 'service' as const, input: 'url' as const, required: true },
        { key: 'apiToken', label: 'Vector API token', scope: 'service' as const, input: 'secret' as const, required: true },
        { key: 'collection', label: 'Collection', scope: 'memory' as const, input: 'text' as const, required: true },
      ],
    }
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return {
        ok: true as const,
        value: {
          providers: [provider],
          items: [{ providerId: 'work-account', enabled: true, configured: true, settings: { serverUrl: 'https://vectors.example' }, configuredSecrets: ['apiToken'] }],
          generatedAt: '2026-08-30T00:00:00.000Z',
        },
      }
      if (channel === '/dsh-mnemon-write' && endpoint === 'provider-service-update') {
        const request = payload as { settings: Record<string, string> }
        return { ok: true as const, value: { providerId: 'work-account', enabled: true, configured: true, settings: request.settings, configuredSecrets: ['apiToken'] } }
      }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/active/.mnemon', scope: 'global' } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))

    const card = await screen.findByRole('group', { name: 'Vector Store 服务配置' })
    expect(card.querySelector('[data-provider-icon="work-account"]')?.textContent).toBe('VS')
    expect(within(card).getByText('Independent vector memory.')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button'))
    const endpoint = within(card).getByRole('textbox', { name: 'Vector endpoint' })
    expect((within(card).getByLabelText('Vector API token') as HTMLInputElement).type).toBe('password')
    fireEvent.change(endpoint, { target: { value: 'https://vectors-v2.example' } })
    fireEvent.click(within(card).getByRole('button', { name: '保存服务配置' }))

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'provider-service-update', expect.objectContaining({
      providerId: 'work-account', enabled: true, settings: { serverUrl: 'https://vectors-v2.example' },
    })))
  })

  it('edits a reusable provider service and reports its Memory Space synchronization', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'workspace' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const provider = {
      id: 'openviking' as const,
      label: 'OpenViking', kind: 'remote' as const, origin: 'third-party' as const, summary: 'Shared memory',
      workspaceBinding: 'provider-global' as const,
      capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: true, writeMode: 'async-extracting' as const, deletionMode: 'hard' as const },
      fields: [
        { key: 'endpoint', label: 'Endpoint', i18nKey: 'overview.providerEndpoint' as const, scope: 'service' as const, input: 'url' as const, required: true, defaultValue: 'http://127.0.0.1:1933' },
        { key: 'apiKey', label: 'API key', i18nKey: 'overview.providerApiKey' as const, scope: 'service' as const, input: 'secret' as const, required: false },
        { key: 'targetUri', label: 'Memory URI', scope: 'memory' as const, input: 'text' as const, required: true, defaultValue: 'viking://user/memories' },
      ],
    }
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [provider], items: [{ providerId: 'openviking', enabled: true, configured: true, settings: { endpoint: 'http://127.0.0.1:1933' }, configuredSecrets: ['apiKey'], secretValues: { apiKey: 'service-secret' } }], generatedAt: '2026-08-17T00:00:00.000Z' } }
      if (channel === '/dsh-mnemon-write' && endpoint === 'provider-service-update') return { ok: true as const, value: { providerId: 'openviking', enabled: true, configured: true, settings: { endpoint: 'http://127.0.0.1:1933' }, configuredSecrets: ['apiKey'], secretValues: { apiKey: 'service-secret' } } }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/workspace/.mnemon', scope: 'workspace' } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })
    const connection = { rpc: { call }, isLoopback: true } as ClientConnectionHandle

    render(spaces(scope, connection, { sessionId: 'session-1', workspaceId: 'workspace-1', workspaceLabel: 'dsh-mnemon' }))

    await waitFor(() => expect(screen.getByText('OpenViking')).toBeTruthy())
    expect(screen.getByRole('group', { name: 'OpenViking 服务配置' })).toBeTruthy()
    const disclosure = screen.getByText('OpenViking').closest('button') as HTMLButtonElement
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(checked(screen.getByRole('switch', { name: '启用 OpenViking' }))).toBe(true)
    expect(screen.getByText('当前工作区：dsh-mnemon；标记“工作区”的 Provider 配置与记忆空间使用此范围。')).toBeTruthy()
    fireEvent.click(screen.getByText('OpenViking'))
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('http://127.0.0.1:1933')
    expect(screen.queryByLabelText('记忆范围 URI')).toBeNull()
    expect(screen.queryByLabelText('记忆空间名称')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '清除已保存的凭据' })).toBeNull()
    const apiKey = screen.getByLabelText('API Key') as HTMLInputElement
    expect(apiKey.value).toBe('service-secret')
    expect(apiKey.type).toBe('password')
    expect(screen.queryByText(/已安全保存/)).toBeNull()
    expect(screen.queryByRole('button', { name: /移除已保存/ })).toBeNull()
    const showCredential = screen.getByRole('button', { name: '显示凭证' }) as HTMLButtonElement
    expect(showCredential.disabled).toBe(false)
    fireEvent.click(showCredential)
    expect(apiKey.type).toBe('text')
    expect(apiKey.value).toBe('service-secret')
    fireEvent.change(apiKey, { target: { value: 'replacement-secret' } })
    expect(apiKey.value).toBe('replacement-secret')
    fireEvent.click(screen.getByRole('button', { name: '隐藏凭证' }))
    expect(apiKey.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: '保存服务配置' }))

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'provider-service-update', {
      providerId: 'openviking',
      settings: { endpoint: 'http://127.0.0.1:1933', apiKey: 'replacement-secret' },
      enabled: true,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    }))
    expect(await screen.findByText('服务配置已保存，记忆空间目录已同步')).toBeTruthy()
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'provider-services')).toHaveLength(1)
    expect(call.mock.calls.some(([, endpoint]) => endpoint === 'body-create')).toBe(false)
  })

  it('keeps a new provider off until its required service configuration is saved', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const provider = {
      id: 'supermemory' as const,
      label: 'Supermemory', kind: 'remote' as const, origin: 'third-party' as const, summary: 'Semantic memory',
      workspaceBinding: 'provider-global' as const,
      capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: true, writeMode: 'async-extracting' as const, deletionMode: 'soft' as const },
      fields: [
        { key: 'endpoint', label: 'Endpoint', i18nKey: 'overview.providerEndpoint' as const, scope: 'service' as const, input: 'url' as const, required: true, defaultValue: 'https://api.supermemory.ai' },
        { key: 'apiKey', label: 'API key', i18nKey: 'overview.providerApiKey' as const, scope: 'service' as const, input: 'secret' as const, required: true },
      ],
    }
    let service = { providerId: 'supermemory' as const, enabled: false, configured: false, settings: {}, configuredSecrets: [] as string[] }
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [provider], items: [service], generatedAt: '2026-08-17T00:00:00.000Z' } }
      if (channel === '/dsh-mnemon-write' && endpoint === 'provider-service-update') {
        const request = payload as { enabled: boolean; settings: Record<string, unknown> }
        service = {
          providerId: 'supermemory', enabled: request.enabled, configured: service.configured || Object.keys(request.settings).length > 0,
          settings: Object.hasOwn(request.settings, 'endpoint') ? { endpoint: request.settings.endpoint as string } : service.settings,
          configuredSecrets: Object.hasOwn(request.settings, 'apiKey') ? ['apiKey'] : service.configuredSecrets,
        }
        return { ok: true as const, value: service }
      }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/active/.mnemon', scope: 'global' } }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })

    render(spaces(scope, { rpc: { call }, isLoopback: true } as ClientConnectionHandle))

    const providerToggle = await screen.findByRole('switch', { name: '启用 Supermemory' })
    const providerCard = screen.getByRole('group', { name: 'Supermemory 服务配置' }) as HTMLDivElement
    const scrollViewport = providerCard.parentElement as HTMLDivElement
    scrollViewport.style.overflowY = 'auto'
    Object.defineProperties(scrollViewport, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 1000 } })
    const hiddenViewport = scrollViewport.parentElement as HTMLDivElement
    hiddenViewport.style.overflowY = 'hidden'
    hiddenViewport.scrollTop = 240
    expect(checked(providerToggle)).toBe(false)
    expect(screen.queryByLabelText('服务地址')).toBeNull()

    fireEvent.click(providerToggle)
    expect(checked(providerToggle)).toBe(true)
    expect(screen.getByLabelText('服务地址')).toBeTruthy()
    const enable = screen.getByRole('button', { name: '保存并启用' }) as HTMLButtonElement
    expect(enable.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'service-secret' } })
    expect(enable.disabled).toBe(false)
    fireEvent.click(enable)

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'provider-service-update', expect.objectContaining({
      providerId: 'supermemory', enabled: true, settings: { endpoint: 'https://api.supermemory.ai', apiKey: 'service-secret' },
    })))
    expect(await screen.findByText('服务配置已保存，记忆空间目录已同步')).toBeTruthy()

    fireEvent.click(providerToggle)
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'provider-service-update', expect.objectContaining({
      providerId: 'supermemory', enabled: false, settings: {},
    })))
    expect(hiddenViewport.scrollTop).toBe(0)
    expect(screen.queryByLabelText('服务地址')).toBeNull()

    fireEvent.click(providerToggle)
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('/dsh-mnemon-write', 'provider-service-update', expect.objectContaining({
      providerId: 'supermemory', enabled: true, settings: {},
    })))
    expect(checked(providerToggle)).toBe(true)
    fireEvent.click(screen.getByText('Supermemory'))
    expect(screen.getByLabelText('服务地址')).toBeTruthy()
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'provider-services')).toHaveLength(1)
  })

  it('previews and safely imports one complete directory ZIP', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = settingsScope(snapshot)
    const call = vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
      if (endpoint === 'target') return { ok: true as const, value: { root: '/active/.mnemon', scope: 'global' } }
      if (endpoint === 'inspect') return {
        ok: true as const,
        value: {
          fileName: 'backup.zip', archiveBytes: 4, expandedBytes: 2048,
          targetRoot: '/active/.mnemon', targetScope: 'global',
          occupied: { runtime: true, documents: true, 'memory-spaces': true },
          manifest: {
            format: 'mnemonpack', version: 1, scope: 'full', exportedAt: '2026-08-14T12:00:00.000Z',
            source: { plugin: 'dsh-mnemon', pluginVersion: '0.1.0' },
            components: ['runtime', 'documents', 'memory-spaces'],
            summary: [
              { component: 'runtime', files: 3, bytes: 600, items: 2 },
              { component: 'documents', files: 2, bytes: 700, items: 1 },
              { component: 'memory-spaces', files: 2, bytes: 748, items: 1 },
            ],
          },
        },
      }
      if (endpoint === 'import') return {
        ok: true as const,
        value: { imported: true, mode: 'merge', targetRoot: '/active/.mnemon', components: ['runtime', 'documents', 'memory-spaces'], summary: [] },
      }
      throw new Error(`unexpected endpoint ${endpoint}: ${JSON.stringify(payload)}`)
    })
    const connection = { rpc: { call }, isLoopback: true } as ClientConnectionHandle

    // The memory views read this signal; an import moves it, so they show what came in.
    const changes = new MnemonChangeSignal(0)
    render(<MnemonSettingsCard scope={scope} connection={connection} componentChanges={changes} />)
    await waitFor(() => expect(screen.getByTitle('/active/.mnemon')).toBeTruthy())

    const file = new File(['pack'], 'backup.zip', { type: 'application/zip' })
    fireEvent.change(screen.getByLabelText('选择 Mnemon 备份 ZIP'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText('backup.zip')).toBeTruthy())
    expect(screen.getByText(/校验通过 · 3 个组件 · 4 项/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Documents/ })).toBeNull()
    // Checking a ZIP writes nothing.
    expect(changes.getSnapshot()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: '安全导入' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-pack', 'import', {
      base64: 'cGFjaw==',
    }))
    expect(screen.getByText('已将 ZIP 安全合并到 /active/.mnemon。')).toBeTruthy()
    await waitFor(() => expect(changes.getSnapshot()).toBe(1))
    // The page reads its own data again too, and keeps saying what the import did.
    await waitFor(() => expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'target')).toHaveLength(2))
    expect(screen.getByText('已将 ZIP 安全合并到 /active/.mnemon。')).toBeTruthy()
  })

  it('tells the memory views after an import that reports a failure, since it can have merged first', async () => {
    const scope = settingsScope({ status: 'ready' as const, value: { storageScope: 'global' as const }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const })
    const call = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'target') return { ok: true as const, value: { root: '/active/.mnemon', scope: 'global' } }
      if (endpoint === 'inspect') return { ok: true as const, value: {
        fileName: 'backup.zip', archiveBytes: 4, expandedBytes: 2048, targetRoot: '/active/.mnemon', targetScope: 'global',
        occupied: { runtime: true, documents: true, 'memory-spaces': true },
        manifest: { format: 'mnemonpack', version: 1, scope: 'full', exportedAt: '2026-08-14T12:00:00.000Z', source: { plugin: 'dsh-mnemon', pluginVersion: '0.1.0' },
          components: ['memory-spaces'], summary: [{ component: 'memory-spaces', files: 2, bytes: 748, items: 1 }] },
      } }
      // The Host merged the archive, then reading Memory Spaces again failed.
      if (endpoint === 'import') return { ok: false as const, error: { code: 'internal', message: 'memory spaces reload failed' } }
      throw new Error(`unexpected endpoint ${endpoint}`)
    })
    const changes = new MnemonChangeSignal(0)
    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call }, isLoopback: true } as ClientConnectionHandle} componentChanges={changes} />)
    await waitFor(() => expect(screen.getByTitle('/active/.mnemon')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('选择 Mnemon 备份 ZIP'), { target: { files: [new File(['pack'], 'backup.zip', { type: 'application/zip' })] } })
    fireEvent.click(await screen.findByRole('button', { name: '安全导入' }))
    expect(await screen.findByText(/memory spaces reload failed/u)).toBeTruthy()
    await waitFor(() => expect(changes.getSnapshot()).toBe(1))
  })
})

describe('centralized workspace storage settings', () => {
  function settings(value: Config, writable = true) {
    const snapshot = { status: 'ready' as const, value, base: {}, user: {}, revision: 0, writable, mode: 'host' as const }
    const mutate = vi.fn(async () => {})
    return { scope: settingsScope(snapshot, mutate), mutate }
  }
  it('applies the scope and central root together from the storage section', async () => {
    const { scope, mutate } = settings({ storageScope: 'global' })
    render(<MnemonSettingsCard scope={scope} />)
    choose('存储范围', '集中存储 · 按工作区隔离')
    const section = screen.getByRole('region', { name: '存储' })
    fireEvent.click(directoryChoice('自定义'))
    fireEvent.change(within(section).getByRole('textbox', { name: '数据目录' }), { target: { value: '  /tmp/central-memory  ' } })
    fireEvent.click(within(section).getByRole('button', { name: '应用' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['storageScope'], value: 'workspaces' },
      { op: 'set', path: ['dataDir'], value: '/tmp/central-memory' },
    ]))
  })

  it('rejects a relative central root and returns to the default root without changing scope', async () => {
    const { scope, mutate } = settings({ storageScope: 'workspaces', dataDir: '/old-root' })
    render(<MnemonSettingsCard scope={scope} t={translateEn} />)
    const input = screen.getByRole('textbox', { name: 'Data directory' })
    fireEvent.change(input, { target: { value: 'relative' } })
    expect(apply('Apply').disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('absolute')
    fireEvent.click(directoryChoice('Default', 'Data directory'))
    fireEvent.click(apply('Apply'))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['dataDir'], value: '' }]))
  })
  it('disables the new scope and its root when settings are read-only', () => {
    const { scope, mutate } = settings({ storageScope: 'workspaces' }, false)
    render(<MnemonSettingsCard scope={scope} />)
    expect(selector('存储范围').disabled).toBe(true)
    expect(selector('存储范围').textContent).toBe('集中存储 · 按工作区隔离')
    expect(directoryChoice('默认').disabled).toBe(true)
    expect(directoryChoice('自定义').disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('shows the one directory memory uses: the default under its title, a typed one in its field', async () => {
    const connection = (root: string, scope: string) => {
      const call = vi.fn(async (channel: string, endpoint: string) => {
        if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root, scope, defaultRoot: '/home/me/.mnemon' } }
        throw new Error(`unexpected ${channel} ${endpoint}`)
      })
      return { call, connection: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle }
    }

    // The default: its path under the title, with no empty field beside it.
    const global = connection('/home/me/.mnemon', 'global')
    const first = render(<MnemonSettingsCard scope={settings({ storageScope: 'global' }).scope} connection={global.connection} />)
    expect(await screen.findByTitle('/home/me/.mnemon')).toBeTruthy()
    expect(directoryChoice('默认').checked).toBe(true)
    expect(screen.queryByRole('textbox', { name: '数据目录' })).toBeNull()
    first.unmount()

    // A central root: this workspace's own directory under it.
    const central = connection('/home/me/.mnemon/workspaces/project-1a2b', 'workspaces')
    const second = render(<MnemonSettingsCard scope={settings({ storageScope: 'workspaces' }).scope} connection={central.connection} />)
    expect(await screen.findByTitle('/home/me/.mnemon/workspaces/project-1a2b')).toBeTruthy()
    expect(screen.getByText('本工作区')).toBeTruthy()
    second.unmount()

    // A typed directory shows in its field only; choosing Default shows where memory would go.
    const custom = connection('/data/mnemon', 'custom')
    render(<MnemonSettingsCard scope={settings({ storageScope: 'custom', dataDir: '/data/mnemon' }).scope} connection={custom.connection} />)
    await waitFor(() => expect(custom.call).toHaveBeenCalledWith('/dsh-mnemon-pack', 'target', expect.anything()))
    await act(async () => {})
    expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/data/mnemon')
    expect(screen.queryByTitle('/data/mnemon')).toBeNull()
    fireEvent.click(directoryChoice('默认'))
    expect(screen.getByTitle('/home/me/.mnemon')).toBeTruthy()
    expect(screen.getByText('应用后读写新位置，已有数据不会迁移')).toBeTruthy()
  })
})
