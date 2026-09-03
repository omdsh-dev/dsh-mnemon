// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MnemonSettingsCard } from '../src/client/MnemonSettingsCard.tsx'
import { translateEn } from '../src/client/locales.ts'
import type { ClientConnectionHandle, ClientSettingsScope, Config, MemoryPluginEntryView, MemoryViewConfigurationRequest, MemoryViewDashboard } from '../src/host/protocol.ts'

afterEach(cleanup)

const FEATURES = [
  ['capture', 'dsh-mnemon-strategy-auto-capture', 'Active capture'],
  ['light', 'dsh-mnemon-strategy-light-context', 'Light context'],
  ['scoped', 'dsh-mnemon-strategy-scoped', 'Scoped composition'],
] as const

function settingsScope(): ClientSettingsScope<Config> {
  const snapshot = {
    status: 'ready' as const,
    value: { storageScope: 'global' as const },
    base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: vi.fn(async () => {}), unset: vi.fn(async () => {}),
    setPath: vi.fn(async () => {}), unsetPath: vi.fn(async () => {}),
    mutate: vi.fn(async () => {}),
  }
}

function featureEntry([entryId, packageName, label]: typeof FEATURES[number]): MemoryPluginEntryView {
  return {
    entryId, packageName, typeId: entryId, strategyTypeId: 'default-three-tier', slot: entryId,
    roles: ['strategy-extension'], label: { en: label, 'zh-CN': label },
    description: { en: label, 'zh-CN': label }, fields: [],
    provides: [{ id: `strategy.default-three-tier.${entryId}`, exclusive: true }],
    requires: ['strategy.default-three-tier'], requiredBy: [],
    enabled: false, active: false, writable: true, config: {},
  }
}

function fixture(options: { writable?: boolean; failApply?: boolean; failRefreshAfterApply?: boolean; unavailable?: boolean } = {}) {
  let applied = false
  let dashboard: MemoryViewDashboard = {
    revision: 'view-1', writable: options.writable !== false, strategyTypeId: 'default-three-tier',
    entries: FEATURES.map(featureEntry), currentUnavailable: 'no-session', sources: [], diagnostics: [],
    pluginInstallation: { supported: false, reason: 'loader-unavailable', suggestions: [] },
  }
  const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
    if (channel === '/dsh-mnemon-view' && endpoint === 'dashboard') {
      if (options.unavailable) return { ok: false as const, error: { code: 'internal' as const, message: 'legacy host', details: {} } }
      if (options.failRefreshAfterApply && applied) return { ok: false as const, error: { code: 'internal' as const, message: 'refresh failed', details: {} } }
      return { ok: true as const, value: structuredClone(dashboard) }
    }
    if (channel === '/dsh-mnemon-view-settings' && endpoint === 'apply') {
      if (options.failApply) return { ok: false as const, error: { code: 'internal' as const, message: 'Memory plugin graph conflict', details: {} } }
      const request = (payload as { configuration: MemoryViewConfigurationRequest }).configuration
      dashboard = {
        ...dashboard,
        revision: 'view-2',
        entries: dashboard.entries.map(entry => request.entries[entry.entryId] === undefined
          ? entry
          : { ...entry, ...request.entries[entry.entryId], active: request.entries[entry.entryId]!.enabled }),
      }
      applied = true
      return { ok: true as const, value: { saved: true as const } }
    }
    if (channel === '/dsh-mnemon-read' && endpoint === 'task-agent-models') return { ok: true as const, value: { groups: [], failures: [] } }
    if (channel === '/dsh-mnemon-read' && endpoint === 'provider-services') return { ok: true as const, value: { providers: [], items: [], generatedAt: '' } }
    if (channel === '/dsh-mnemon-pack' && endpoint === 'target') return { ok: true as const, value: { root: '/root/.mnemon', scope: 'global' as const } }
    return { ok: false as const, error: { code: 'internal' as const, message: `unsupported ${channel} ${endpoint}`, details: {} } }
  })
  return { call, connection: { rpc: { call } } as ClientConnectionHandle }
}

describe('Memory enhancement settings', () => {
  it('shows only user-facing built-in behavior switches', async () => {
    const { connection } = fixture()
    render(<MnemonSettingsCard scope={settingsScope()} connection={connection} />)

    expect(await screen.findByRole('heading', { name: '记忆增强' })).toBeTruthy()
    for (const label of ['主动记录', '轻量上下文', '范围组合']) {
      expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(false)
    }
    expect(screen.queryByText(/dsh-mnemon-strategy-/u)).toBeNull()
    expect(screen.queryByText(/插件/u)).toBeNull()
    expect(screen.queryByRole('button', { name: /安装|发现/u })).toBeNull()
  })

  it('applies one enhancement directly without exposing the underlying graph', async () => {
    const { connection, call } = fixture()
    render(<MnemonSettingsCard scope={settingsScope()} connection={connection} sessionId="session-1" workspaceId="workspace-1" />)

    const capture = await screen.findByRole('checkbox', { name: '主动记录' }) as HTMLInputElement
    fireEvent.click(capture)
    expect(capture.checked).toBe(true)

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-view-settings', 'apply', {
      configuration: {
        expectedRevision: 'view-1', strategyTypeId: 'default-three-tier',
        entries: { capture: { enabled: true, config: {} } },
      },
      confirmed: true, sessionId: 'session-1', workspaceId: 'workspace-1',
    }))
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '主动记录' }) as HTMLInputElement).checked).toBe(true))
    expect(call.mock.calls.some(([, endpoint]) => endpoint === 'inspect-plugin' || endpoint === 'install-plugin')).toBe(false)
  })

  it('restores the switch and reports neutral copy when an enhancement cannot be applied', async () => {
    const { connection } = fixture({ failApply: true })
    render(<MnemonSettingsCard scope={settingsScope()} connection={connection} />)

    const light = await screen.findByRole('checkbox', { name: '轻量上下文' }) as HTMLInputElement
    fireEvent.click(light)
    await waitFor(() => expect(light.checked).toBe(false))
    expect(screen.getByRole('alert').textContent).toBe('无法更新记忆增强设置，请重试。')
    expect(screen.queryByText(/plugin graph|插件图/iu)).toBeNull()
  })

  it('keeps a committed value and prevents stale writes when only refresh fails', async () => {
    const { connection } = fixture({ failRefreshAfterApply: true })
    render(<MnemonSettingsCard scope={settingsScope()} connection={connection} />)

    const capture = await screen.findByRole('checkbox', { name: '主动记录' }) as HTMLInputElement
    fireEvent.click(capture)
    await waitFor(() => expect(capture.checked).toBe(true))
    await waitFor(() => expect(capture.disabled).toBe(true))
    expect(screen.getByRole('alert').textContent).toBe('设置已更新，但状态刷新失败；请重新打开设置。')
  })

  it('uses English feature copy and honors a read-only Host', async () => {
    const { connection } = fixture({ writable: false })
    render(<MnemonSettingsCard scope={settingsScope()} connection={connection} t={translateEn} />)

    expect(await screen.findByRole('heading', { name: 'Memory enhancements' })).toBeTruthy()
    for (const label of FEATURES.map(([, , label]) => label)) {
      expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).disabled).toBe(true)
    }
    expect(screen.queryByText(/dsh-mnemon-strategy-/u)).toBeNull()
  })

  it('preserves the v0.4 settings surface when the Host has no View channel', async () => {
    const { connection, call } = fixture({ unavailable: true })
    render(<MnemonSettingsCard scope={settingsScope()} connection={connection} />)

    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-view', 'dashboard', {}))
    expect(screen.queryByRole('heading', { name: '记忆增强' })).toBeNull()
    expect(screen.queryByText(/legacy host/u)).toBeNull()
    expect(screen.getByRole('heading', { name: '记忆层' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '记忆体 Provider' })).toBeTruthy()
  })
})
