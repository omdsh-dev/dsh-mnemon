// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryCompositionEditor } from '../src/client/MemoryCompositionEditor.tsx'
import type { ClientConnectionHandle, MemoryViewDashboard } from '../src/host/protocol.ts'
afterEach(cleanup)
const dashboard: MemoryViewDashboard = { revision: 'r1', writable: true, strategyTypeId: 'workspace', sources: [
  { sourceInstanceKey: 'source:tasks', sourceTypeId: 'tasks', packageName: 'tasks', role: 'task-context', label: 'Tasks' },
  { sourceInstanceKey: 'source:notes', sourceTypeId: 'notes', packageName: 'notes', role: 'project-context', label: 'Notes' },
], entries: [{ entryId: 'focus', packageName: 'test-focus', typeId: 'focus', strategyTypeId: 'workspace', slot: 'focus', roles: ['strategy-extension'], label: { en: 'Focused context', 'zh-CN': '专注上下文' }, description: { en: 'Select Sources', 'zh-CN': '选择来源' }, fields: [
  { key: 'sourceKeys', label: { en: 'Sources', 'zh-CN': '参与来源' }, input: 'source-list' },
  { key: 'writableSourceKeys', label: { en: 'Writable Sources', 'zh-CN': '写入来源' }, input: 'source-list' },
  { key: 'maxProjectionCharacters', label: { en: 'Characters', 'zh-CN': '字符预算' }, input: 'number', defaultValue: 8192, minimum: 1, maximum: 65536 },
], enabled: false, active: false, writable: true, provides: [], requires: [], requiredBy: [], config: {} }], diagnostics: [], pluginInstallation: { supported: false, suggestions: [] } }
function open() { const details = screen.getByText('组合策略配置').closest('details')!; details.open = true; fireEvent(details, new Event('toggle')) }
it('previews exact descriptor-owned settings before saving and invalidates an edited preview', async () => {
  const call = vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: endpoint === 'dashboard' ? structuredClone(dashboard) : endpoint === 'preview' ? { projection: [], routes: [], actions: [], diagnostics: [] } : { saved: true } }))
  render(<MemoryCompositionEditor connection={{ rpc: { call } } as ClientConnectionHandle} locale="zh-CN" sessionId="one" />)
  expect(call).not.toHaveBeenCalled(); open()
  fireEvent.click(await screen.findByRole('button', { name: '配置 专注上下文' }))
  fireEvent.click(screen.getByLabelText('启用 专注上下文'))
  fireEvent.click(screen.getByLabelText('手动设置 参与来源'))
  fireEvent.click(within(screen.getByRole('group', { name: '参与来源' })).getByLabelText(/Tasks/))
  fireEvent.click(screen.getByLabelText('手动设置 写入来源'))
  expect(screen.queryByRole('button', { name: '保存这份组合' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '预览组合' }))
  await screen.findByRole('button', { name: '保存这份组合' })
  expect(call).toHaveBeenCalledWith('/dsh-mnemon-view', 'preview', { sessionId: 'one', configuration: { expectedRevision: 'r1', strategyTypeId: 'workspace', entries: { focus: { enabled: true, config: { sourceKeys: ['source:tasks'], writableSourceKeys: [] } } } } })
  fireEvent.change(screen.getByLabelText('字符预算'), { target: { value: '512' } })
  expect(screen.queryByRole('button', { name: '保存这份组合' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '预览组合' })); fireEvent.click(await screen.findByRole('button', { name: '保存这份组合' }))
  await screen.findByText('组合配置已保存，新轮次将使用这些设置。')
  expect(call).toHaveBeenCalledWith('/dsh-mnemon-view-settings', 'apply', { sessionId: 'one', confirmed: true, configuration: { expectedRevision: 'r1', strategyTypeId: 'workspace', entries: { focus: { enabled: true, config: { sourceKeys: ['source:tasks'], writableSourceKeys: [], maxProjectionCharacters: 512 } } } } })
})
it('discards an old session dashboard after the settings scope changes', async () => {
  const old = Promise.withResolvers<any>()
  const call = vi.fn(async (_channel: string, _endpoint: string, payload: any) => payload.sessionId === 'old' ? old.promise : { ok: true, value: { ...dashboard, writable: false, entries: [{ ...dashboard.entries[0]!, label: { en: 'Current', 'zh-CN': '当前配置' } }] } })
  const connection = { rpc: { call } } as ClientConnectionHandle
  const rendered = render(<MemoryCompositionEditor connection={connection} locale="zh-CN" sessionId="old" />); open()
  await waitFor(() => expect(call).toHaveBeenCalledOnce())
  rendered.rerender(<MemoryCompositionEditor connection={connection} locale="zh-CN" sessionId="new" />)
  await screen.findByRole('button', { name: '配置 当前配置' })
  old.resolve({ ok: true, value: dashboard })
  await waitFor(() => expect(screen.queryByRole('button', { name: '配置 专注上下文' })).toBeNull())
  expect((screen.getByLabelText('组合策略') as HTMLSelectElement).disabled).toBe(true)
  expect((screen.getByLabelText('启用 当前配置') as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '配置 当前配置' }))
  expect(screen.getByLabelText('字符预算').matches(':disabled')).toBe(true)
})

it('keeps read-only preview useful without exposing an enabled save action', async () => {
  const call = vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: endpoint === 'dashboard' ? { ...structuredClone(dashboard), writable: false } : { projection: [], routes: [], actions: [], diagnostics: [] } }))
  render(<MemoryCompositionEditor connection={{ rpc: { call } } as ClientConnectionHandle} locale="zh-CN" />); open()
  await screen.findByText('当前设置为只读。')
  fireEvent.click(screen.getByRole('button', { name: '预览组合' }))
  const save = await screen.findByRole('button', { name: '保存这份组合' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.click(save)
  expect(call.mock.calls.some(([, endpoint]) => endpoint === 'apply')).toBe(false)
})

it('keeps a new line while editing a string list and previews normalized entries', async () => {
  const current = structuredClone(dashboard)
  current.entries[0]!.fields = [{ key: 'instructions', label: { en: 'Instructions', 'zh-CN': '补充说明' }, input: 'string-list' }]
  const call = vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: endpoint === 'dashboard' ? current : { projection: [], routes: [], actions: [], diagnostics: [] } }))
  render(<MemoryCompositionEditor connection={{ rpc: { call } } as ClientConnectionHandle} locale="zh-CN" />); open()
  fireEvent.click(await screen.findByRole('button', { name: '配置 专注上下文' }))
  fireEvent.click(screen.getByLabelText('手动设置 补充说明'))
  const input = screen.getByRole('textbox', { name: '补充说明' }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'Check scope' } })
  fireEvent.change(input, { target: { value: 'Check scope\n' } })
  expect(input.value).toBe('Check scope\n')
  fireEvent.change(input, { target: { value: 'Check scope\nVerify results' } })
  fireEvent.click(screen.getByRole('button', { name: '预览组合' }))
  await screen.findByRole('button', { name: '保存这份组合' })
  expect(call).toHaveBeenCalledWith('/dsh-mnemon-view', 'preview', { configuration: { expectedRevision: 'r1', strategyTypeId: 'workspace', entries: { focus: { enabled: false, config: { instructions: ['Check scope', 'Verify results'] } } } } })
})
