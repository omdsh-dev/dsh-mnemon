// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryPluginManager } from '../src/client/MemoryPluginManager.tsx'
import type { ClientConnectionHandle, MemoryViewDashboard } from '../src/host/protocol.ts'
afterEach(cleanup)
const dashboard: MemoryViewDashboard = { revision: 'r1', writable: true, strategyTypeId: 'default-three-tier', sources: [], diagnostics: [], pluginInstallation: { supported: true, profileName: 'web', suggestions: [] }, entries: [
  { entryId: 'learning', packageName: 'dsh-mnemon-source-learning', roles: ['source'], label: { en: 'Learning', 'zh-CN': '经验整理' }, description: { en: 'Review learning', 'zh-CN': '整理明确证据' }, enabled: false, active: false, writable: true, config: {}, fields: [], provides: [], requires: [], requiredBy: [] },
] }
function open() { const details = screen.getByText('记忆插件').closest('details')!; details.open = true; fireEvent(details, new Event('toggle')) }
it('previews dependency changes and applies only the reviewed revision', async () => {
  const plan = { configuration: { expectedRevision: 'r1', strategyTypeId: 'workspace', entries: { learning: { enabled: true, config: {} } } }, changes: [{ entryId: 'learning', enabled: true, reason: 'requested', label: dashboard.entries[0]!.label }, { entryId: 'workspace', enabled: true, reason: 'requirement', label: { en: 'Workspace', 'zh-CN': '工作区策略' } }] }
  const call = vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: endpoint === 'dashboard' ? dashboard : endpoint === 'plan-plugin' ? plan : { saved: true } }))
  render(<MemoryPluginManager connection={{ rpc: { call } } as ClientConnectionHandle} sessionId="current" locale="zh-CN" />); open()
  fireEvent.click(await screen.findByRole('button', { name: '启用 经验整理' }))
  const preview = await screen.findByLabelText('插件变更预览')
  expect(preview.textContent).toContain('工作区策略')
  expect(call.mock.calls.some(([, endpoint]) => endpoint === 'apply')).toBe(false)
  fireEvent.click(within(preview).getByRole('button', { name: '应用这些变更' }))
  await screen.findByText('插件变更已生效，新轮次将使用更新后的组合。')
  expect(call).toHaveBeenCalledWith('/dsh-mnemon-view-settings', 'apply', { sessionId: 'current', confirmed: true, configuration: plan.configuration })
})
it('discards a stale plan when the selected scope changes', async () => {
  const pending = Promise.withResolvers<unknown>()
  const call = vi.fn(async (_channel: string, endpoint: string) => endpoint === 'plan-plugin' ? pending.promise : { ok: true, value: dashboard })
  const connection = { rpc: { call } } as ClientConnectionHandle
  const view = render(<MemoryPluginManager connection={connection} sessionId="old" locale="zh-CN" />); open()
  fireEvent.click(await screen.findByRole('button', { name: '启用 经验整理' }))
  view.rerender(<MemoryPluginManager connection={connection} sessionId="new" locale="zh-CN" />)
  await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-view', 'dashboard', { sessionId: 'new' }))
  await act(async () => pending.resolve({ ok: true, value: { configuration: {}, changes: [] } }))
  expect(screen.queryByLabelText('插件变更预览')).toBeNull()
})
it('shows the inspected compatibility failure without enabling installation', async () => {
  const call = vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: endpoint === 'dashboard' ? dashboard : { packageName: 'dsh-mnemon-source-example', version: '2.0.0', compatible: false, installed: false, registered: false, peerChecks: [{ packageName: 'dsh-mnemon', range: '^2', installedVersion: '0.5.8', compatible: false }] } }))
  render(<MemoryPluginManager connection={{ rpc: { call } } as ClientConnectionHandle} locale="zh-CN" />); open()
  fireEvent.click(await screen.findByText('安装其他插件'))
  fireEvent.change(screen.getByLabelText('软件包名称'), { target: { value: 'dsh-mnemon-source-example' } })
  fireEvent.click(screen.getByRole('button', { name: '检查软件包' }))
  await screen.findByText('当前运行环境不满足兼容要求。')
  expect((screen.getByRole('button', { name: '安装此版本' }) as HTMLButtonElement).disabled).toBe(true)
  expect(call.mock.calls.some(([, endpoint]) => endpoint === 'install-plugin')).toBe(false)
})
