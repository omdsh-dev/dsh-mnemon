// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MnemonSettingsCard } from '../src/client/MnemonSettingsCard.tsx'
import { translateEn } from '../src/client/locales.ts'
import type { ClientConnectionHandle, ClientSettingsScope } from "../src/host/dsh.ts"
import type { Config, InteractionConfig } from "../src/host/config.ts"
import type { MemoryCompositionStatus } from "../src/host/protocol.ts"
import { TEST_PROVIDERS as MEMORY_PROVIDER_CATALOG } from './fixtures/providers.ts'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('MnemonSettingsCard', () => {
  it('persists a validated DSH-managed Mnemon embedding override as one live setting', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)

    const managed = screen.getByRole('checkbox', { name: '由 DSH 管理嵌入配置' })
    const endpoint = screen.getByRole('textbox', { name: '嵌入 Endpoint' }) as HTMLInputElement
    const model = screen.getByRole('textbox', { name: '嵌入模型' }) as HTMLInputElement
    const apiKey = screen.getByLabelText('API Key（可选，OpenAI 兼容服务）') as HTMLInputElement
    const protocol = screen.getByRole('combobox', { name: '协议' }) as HTMLSelectElement
    expect((managed as HTMLInputElement).checked).toBe(false)
    expect(endpoint.value).toBe('http://localhost:11434')
    expect(model.value).toBe('nomic-embed-text')
    expect(apiKey.value).toBe('')
    expect(apiKey.type).toBe('password')
    expect(protocol.value).toBe('auto')
    expect(endpoint.disabled).toBe(true)
    expect(apiKey.disabled).toBe(true)
    expect(protocol.disabled).toBe(true)

    fireEvent.click(managed)
    fireEvent.change(endpoint, { target: { value: 'ftp://invalid.example' } })
    expect(screen.getByRole('alert').textContent).toContain('HTTP(S)')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(endpoint, { target: { value: 'http://127.0.0.1:11434?' } })
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(endpoint, { target: { value: ' http://127.0.0.1:8080/api/// ' } })
    fireEvent.change(model, { target: { value: ' qwen3-embedding:0.6b ' } })
    fireEvent.change(apiKey, { target: { value: '  sk-secret  ' } })
    fireEvent.change(protocol, { target: { value: 'openai' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['embedding'],
      value: { enabled: true, endpoint: 'http://127.0.0.1:8080/api', model: 'qwen3-embedding:0.6b', apiKey: 'sk-secret', protocol: 'openai' },
    }]))
  })

  it('drops an invalid embedding draft when management is disabled', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: {
        storageScope: 'global' as const,
        embedding: { enabled: true, endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b' },
      },
      base: {}, user: {}, revision: 1, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)
    fireEvent.change(screen.getByRole('textbox', { name: '嵌入 Endpoint' }), { target: { value: 'ftp://invalid.example' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '由 DSH 管理嵌入配置' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['embedding'],
      value: { enabled: false, model: 'qwen3-embedding:0.6b', apiKey: '', protocol: 'auto' },
    }]))
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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

    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)
    fireEvent.click(screen.getByRole('button', { name: '测试状态' }))

    expect(await screen.findByText('嵌入服务可用 · qwen3-embedding:0.6b · 已嵌入 6/8（75%）')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'embedding-status', {})
  })

  it('renders one switch per live Catalog layer and persists only its enabled state', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
    const participation = { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' } as const
    const descriptor: MemoryCompositionStatus = {
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

    const view = render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)

    await screen.findByRole('checkbox', { name: '启用 项目档案' })
    expect(screen.getByText('可版本化的叙事文档，先检索，再按需阅读全文。')).toBeTruthy()
    expect(screen.queryByText('Narrative records')).toBeNull()

    view.rerender(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} t={translateEn} />)
    const enabled = await screen.findByRole('checkbox', { name: 'Enable Project Documents' })
    expect(screen.getByText('Versioned narrative documents searched first and read in full on demand.')).toBeTruthy()
    expect(screen.queryByText('Narrative records')).toBeNull()
    expect(screen.queryByRole('combobox', { name: /Project Documents/ })).toBeNull()
    fireEvent.click(enabled)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['memoryTopology', 'layers', 'documents', 'enabled'],
      value: false,
    }]))
  })

  it('ignores a Provider catalog response from the previously selected workspace', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'workspace' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config>
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
    const connection = { rpc: { call } } as ClientConnectionHandle
    const view = render(<MnemonSettingsCard scope={scope} connection={connection} workspaceId="workspace-1" workspaceLabel="One" />)

    view.rerender(<MnemonSettingsCard scope={scope} connection={connection} workspaceId="workspace-2" workspaceLabel="Two" />)
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return {
        ok: true as const,
        value: { effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' as const }, groups: [], failures: [] },
      }
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return {
        ok: true as const, value: { providers: [], items: [], generatedAt: '' },
      }
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return {
        ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const },
      }
      throw new Error(`unexpected ${channel} ${endpoint}`)
    })
    const connection = { rpc: { call }, isLoopback: false } as ClientConnectionHandle

    render(<MnemonSettingsCard scope={scope} connection={connection} />)

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'task-agent-models', { includeCatalog: false }))
    expect((screen.getByRole('radio', { name: '工作区' }) as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByRole('radio', { name: '跟随主链路' }) as HTMLInputElement).disabled).toBe(false)
    expect(screen.queryByText('当前部署的插件设置为只读。')).toBeNull()
    await waitFor(() => expect(call.mock.calls.some(([, endpoint]) => endpoint === 'provider-services')).toBe(true))
    expect(call.mock.calls.some(([, endpoint]) => endpoint === 'target')).toBe(true)
  })

  it('shows an actionable error instead of a blank settings page when both scopes are unavailable', () => {
    const snapshot = { status: 'unavailable' as const, writable: false, mode: 'host' as const }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)

    expect(screen.getByRole('alert').textContent).toContain('无法加载记忆系统设置')
  })

  it('inherits the new-session route by default and persists an explicit Provider plus model', async () => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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

    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)

    expect((screen.getByRole('radio', { name: '跟随主链路' }) as HTMLInputElement).checked).toBe(true)
    expect(await screen.findByText('deepseek / deepseek-chat')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'task-agent-models', { includeCatalog: false })
    fireEvent.click(screen.getByRole('radio', { name: '指定模型 Provider' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'task-agent-models', { includeCatalog: true }))
    fireEvent.change(screen.getByRole('combobox', { name: '模型 Provider' }), { target: { value: 'deepseek-official' } })
    expect(screen.getByRole('option', { name: 'DeepSeek-V4-Flash-Vision-Exp · 图片输入' })).toBeTruthy()
    expect((screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement).value).toBe('deepseek-v4-flash-vision-exp')
    fireEvent.change(screen.getByRole('combobox', { name: '模型 Provider' }), { target: { value: 'openai' } })
    expect((screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement).value).toBe('gpt-5')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{
      op: 'set', path: ['taskAgentModel'], value: { mode: 'fixed', provider: 'openai', model: 'gpt-5' },
    }]))
  })

  it('keeps rapid route-mode switches stable while model requests finish out of order', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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

    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)
    fireEvent.click(screen.getByText('指定模型 Provider', { exact: true }))
    fireEvent.click(screen.getByText('跟随主链路', { exact: true }))

    await act(async () => {
      resolveCatalog({ ok: true, value: catalog })
      await full
      resolveRoute({ ok: true, value: catalog })
      await route
    })

    expect((screen.getByRole('radio', { name: '跟随主链路' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByText('指定模型 Provider', { exact: true }))
    await waitFor(() => expect((screen.getByRole('combobox', { name: '模型 Provider' }) as HTMLSelectElement).disabled).toBe(false))
    expect((screen.getByRole('combobox', { name: '模型 Provider' }) as HTMLSelectElement).value).toBe('deepseek')
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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

    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)

    expect((screen.getByRole('radio', { name: '指定模型 Provider' }) as HTMLInputElement).checked).toBe(true)
    await waitFor(() => expect((screen.getByRole('combobox', { name: '模型 Provider' }) as HTMLSelectElement).disabled).toBe(false))
    expect((screen.getByRole('combobox', { name: '模型 Provider' }) as HTMLSelectElement).value).toBe('openai')
    expect((screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement).value).toBe('gpt-5')
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-read', 'task-agent-models', { includeCatalog: true })
  })

  it.each([undefined, 'builtin', 'buildin', 'sidebar'] as const)('stages displayMode=%s independently of storage and saves only changed fields', async displayMode => {
    const mutate = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const, ...(displayMode === undefined ? {} : { displayMode }) },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
      mutate,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)

    const sidebar = screen.getByRole('radio', { name: 'Sidebar' }) as HTMLInputElement
    const builtin = screen.getByRole('radio', { name: 'Builtin' }) as HTMLInputElement
    const isBuiltin = displayMode === 'builtin' || displayMode === 'buildin'
    expect(sidebar.checked).toBe(!isBuiltin)
    expect(builtin.checked).toBe(isBuiltin)
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(isBuiltin ? sidebar : builtin)
    fireEvent.click(screen.getByRole('radio', { name: '工作区' }))
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['displayMode'], value: isBuiltin ? 'sidebar' : 'builtin' },
      { op: 'set', path: ['storageScope'], value: 'workspace' },
    ]))
  })

  it('stages settings and writes them through the DSH settings scope', async () => {
    const set = vi.fn(async () => {})
    const unset = vi.fn(async () => {})
    const snapshot = {
      status: 'ready' as const,
      value: { timeoutMs: 10000, defaultRecallLimit: 10, routingGuidance: true, lifecycleEnabled: true, recallMode: 'guided' as const, writebackMode: 'guided' as const, tabEnabled: true, writeEnabled: true },
      base: { timeoutMs: 10000, defaultRecallLimit: 10, routingGuidance: true, lifecycleEnabled: true, recallMode: 'guided' as const, writebackMode: 'guided' as const, tabEnabled: true, writeEnabled: true },
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set,
      unset,
      setPath: set,
      unsetPath: unset,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)
    fireEvent.click(screen.getByRole('radio', { name: /工作区/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(set).toHaveBeenCalledWith('storageScope', 'workspace'))
    expect(screen.getByText('已保存并实时生效')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复默认' })).toBeNull()
    expect(screen.getByText(/\.dsh\/settings.yaml/)).toBeTruthy()
    expect(unset).not.toHaveBeenCalled()
  })

  it('configures a global USER.md independently from workspace project memory', async () => {
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
      mutate,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)

    expect((screen.getByRole('radio', { name: /工作区/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: /跟随记忆范围/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /全局用户档案/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['runtimeUserScope'], value: 'global' },
    ]))
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} t={translateEn} />)

    expect(screen.getByRole('radiogroup', { name: 'Memory system scope' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Workspace/ }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
      mutate,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
    const view = render(<MnemonSettingsCard scope={scope} />)

    fireEvent.click(view.getByRole('radio', { name: '自定义' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Mnemon 自定义数据目录' }), { target: { value: '  /tmp/mnemon-custom  ' } })
    fireEvent.click(view.getByRole('button', { name: '保存' }))

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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}), mutate,
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)
    const directory = screen.getByRole('textbox', { name: 'Mnemon 自定义数据目录' }) as HTMLInputElement
    expect(directory.value).toBe('/packs/project')
    fireEvent.change(directory, { target: { value: '/packs/research' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['dataDir'], value: '/packs/research' },
      { op: 'unset', path: ['customPackId'] },
      { op: 'unset', path: ['customPacks'] },
    ]))
  })

  it('keeps custom storage invalid until a directory is entered', () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)
    fireEvent.click(screen.getByRole('radio', { name: '自定义' }))

    expect((screen.getByRole('textbox', { name: 'Mnemon 自定义数据目录' }) as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('alert').textContent).toBe('选择自定义存储时必须填写数据目录。')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('accepts Windows drive and UNC paths in the browser form', () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)
    fireEvent.click(screen.getByRole('radio', { name: '自定义' }))
    const directory = screen.getByRole('textbox', { name: 'Mnemon 自定义数据目录' })
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)

    expect((screen.getByRole('radio', { name: /^全局$/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: 'Sidebar' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: 'Builtin' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('当前部署的插件设置为只读。')).toBeTruthy()
  })

  it('does not present temporary defaults as read-only while settings load', () => {
    const snapshot = {
      status: 'loading' as const,
      writable: false,
      mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    render(<MnemonSettingsCard scope={scope} />)

    expect(screen.getByRole('status').textContent).toBe('载入中…')
    expect(screen.queryByText('当前部署的插件设置为只读。')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: '记忆系统范围' })).toBeNull()
  })

  it('persists live interaction toggles as one atomic mnemon-ui mutation', async () => {
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
    const scope = {
      snapshot: coreSnapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
      setPath: vi.fn(async () => {}),
      unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof coreSnapshot }
    const interactionSnapshot = {
      status: 'ready' as const,
      value: { turnBar: true, saveAction: true },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host' as const,
    }
    const interactionScope = {
      snapshot: interactionSnapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
      setPath: vi.fn(async () => {}),
      unsetPath: vi.fn(async () => {}),
      mutate: interactionMutate,
    } satisfies ClientSettingsScope<InteractionConfig> & { snapshot: typeof interactionSnapshot }

    const view = render(<MnemonSettingsCard scope={scope} interactionScope={interactionScope} />)

    const turnBar = view.getByLabelText('回合记忆条') as HTMLInputElement
    expect(turnBar.checked).toBe(true)
    expect(view.queryByLabelText('记忆工具卡')).toBeNull()

    fireEvent.click(turnBar)
    fireEvent.click(view.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(interactionMutate).toHaveBeenCalledWith([
      { op: 'set', path: ['turnBar'], value: false },
    ]))
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
      setPath: vi.fn(async () => {}),
      unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }

    const view = render(<MnemonSettingsCard scope={scope} />)

    expect(view.queryByLabelText('记忆工具卡')).toBeNull()
    expect((view.getByLabelText('回合记忆条') as HTMLInputElement).checked).toBe(true)
    expect((view.getByLabelText('存入记忆按钮') as HTMLInputElement).checked).toBe(true)
  })

  it('does not invent Provider registrations while the Host catalog is loading', () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'workspace' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
    const providerSettings = new Promise<never>(() => {})
    const call = vi.fn((channel: string, endpoint: string) => {
      if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return providerSettings
      if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return Promise.resolve({ ok: true as const, value: { root: '/active/.mnemon', scope: 'global' } })
      return Promise.reject(new Error(`unexpected ${channel} ${endpoint}`))
    })

    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)

    expect(screen.queryAllByRole('group', { name: /服务配置/ })).toHaveLength(0)
    expect(screen.queryAllByRole('checkbox', { name: /^启用 / })).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('正在读取 Provider 配置…')
  })

  it('uses the native default/custom location pattern for a scope-aware local provider', async () => {
    const snapshot = {
      status: 'ready' as const,
      value: { storageScope: 'global' as const },
      base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
    }
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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

    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)

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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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

    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)

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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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
    const connection = { rpc: { call } } as ClientConnectionHandle

    render(<MnemonSettingsCard scope={scope} connection={connection} sessionId="session-1" workspaceId="workspace-1" workspaceLabel="dsh-mnemon" />)

    await waitFor(() => expect(screen.getByText('OpenViking')).toBeTruthy())
    expect(screen.getByRole('group', { name: 'OpenViking 服务配置' })).toBeTruthy()
    const disclosure = screen.getByText('OpenViking').closest('button') as HTMLButtonElement
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect((screen.getByRole('checkbox', { name: '启用 OpenViking' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('当前工作区：dsh-mnemon；标记“工作区”的 Provider 配置与记忆体使用此范围。')).toBeTruthy()
    fireEvent.click(screen.getByText('OpenViking'))
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('http://127.0.0.1:1933')
    expect(screen.queryByLabelText('记忆范围 URI')).toBeNull()
    expect(screen.queryByLabelText('记忆体名称')).toBeNull()
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
    expect(await screen.findByText('服务配置已保存，记忆体目录已同步')).toBeTruthy()
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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

    render(<MnemonSettingsCard scope={scope} connection={{ rpc: { call } } as ClientConnectionHandle} />)

    const providerToggle = await screen.findByRole('checkbox', { name: '启用 Supermemory' }) as HTMLInputElement
    const providerCard = screen.getByRole('group', { name: 'Supermemory 服务配置' }) as HTMLDivElement
    const scrollViewport = providerCard.parentElement as HTMLDivElement
    scrollViewport.style.overflowY = 'auto'
    Object.defineProperties(scrollViewport, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 1000 } })
    const hiddenViewport = scrollViewport.parentElement as HTMLDivElement
    hiddenViewport.style.overflowY = 'hidden'
    hiddenViewport.scrollTop = 240
    expect(providerToggle.checked).toBe(false)
    expect(screen.queryByLabelText('服务地址')).toBeNull()

    fireEvent.click(providerToggle)
    expect(providerToggle.checked).toBe(true)
    expect(screen.getByLabelText('服务地址')).toBeTruthy()
    const enable = screen.getByRole('button', { name: '保存并启用' }) as HTMLButtonElement
    expect(enable.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'service-secret' } })
    expect(enable.disabled).toBe(false)
    fireEvent.click(enable)

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-write', 'provider-service-update', expect.objectContaining({
      providerId: 'supermemory', enabled: true, settings: { endpoint: 'https://api.supermemory.ai', apiKey: 'service-secret' },
    })))
    expect(await screen.findByText('服务配置已保存，记忆体目录已同步')).toBeTruthy()

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
    expect(providerToggle.checked).toBe(true)
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
    const scope = {
      snapshot,
      getSnapshot() { return this.snapshot },
      subscribe() { return () => {} },
      set: vi.fn(async () => {}), unset: vi.fn(async () => {}), setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    } satisfies ClientSettingsScope<Config> & { snapshot: typeof snapshot }
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
    const connection = { rpc: { call } } as ClientConnectionHandle

    render(<MnemonSettingsCard scope={scope} connection={connection} />)
    await waitFor(() => expect(screen.getByText('/active/.mnemon')).toBeTruthy())

    const file = new File(['pack'], 'backup.zip', { type: 'application/zip' })
    fireEvent.change(screen.getByLabelText('选择 Mnemon 备份 ZIP'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText('backup.zip')).toBeTruthy())
    expect(screen.getByText(/校验通过 · 3 个组件 · 4 项/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Documents/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '安全导入' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-pack', 'import', {
      base64: 'cGFjaw==',
    }))
    expect(screen.getByText('已将 ZIP 安全合并到 /active/.mnemon。')).toBeTruthy()
  })
})
