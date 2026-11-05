// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComponentOptions } from '../src/client/component-options.tsx'
import { translateEn } from '../src/client/locales.ts'
import type { MemoryPluginEntryView, MemoryViewDashboard } from '../src/host/view-protocol.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture(config: MemoryPluginEntryView['config'] = {}) {
  const entry: MemoryPluginEntryView = {
    entryId: 'include:scoped', packageName: 'dsh-mnemon-strategy-scoped', typeId: 'scoped', roles: ['strategy-extension'],
    label: { en: 'Scoped composition', 'zh-CN': '范围组合' }, description: { en: '', 'zh-CN': '' },
    provides: [], requires: [], requiredBy: [], enabled: true, active: true, writable: true, config,
    fields: ['sourceKeys', 'writableSourceKeys'].map(key => ({ key, input: 'source-list', label: { en: key, 'zh-CN': key } })),
  }
  const sources: MemoryViewDashboard['sources'] = [
    ['runtime', 'working-context'], ['documents', 'narrative'], ['spaces', 'durable-evidence'], ['skills', 'capability'],
  ].map(([id, role]) => ({ sourceInstanceKey: `source:${id}`, sourceTypeId: id!, packageName: `test-${id}`, role: role!, label: id! }))
  const onApply = vi.fn().mockResolvedValue(true)
  render(<ComponentOptions entry={entry} name="Scoped composition" dashboard={{ sources, entries: [] }} language="en" t={translateEn}
    disabled={false} pending={false} onApply={onApply} />)
  const group = screen.getByRole('group', { name: 'sourceKeys' })
  return { onApply, group, boxes: within(group).getAllByRole('checkbox') }
}

it('shows effective defaults and starts the first edit from them', () => {
  const { boxes, onApply } = fixture()
  expect(boxes).toHaveLength(3)
  expect(boxes.every(box => (box as HTMLInputElement).checked)).toBe(true)
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  fireEvent.click(boxes[0]!)
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onApply).toHaveBeenCalledWith({ sourceKeys: ['source:documents', 'source:spaces'] })
})

it('does not write a cancelled empty selection, but preserves an explicitly confirmed one', () => {
  const { boxes, onApply } = fixture()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  boxes.forEach(box => fireEvent.click(box))
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(confirm).toHaveBeenCalledOnce()
  expect(onApply).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onApply).toHaveBeenCalledWith({ sourceKeys: [] })
})

it('reset removes the override while preserving a separate read-only restriction', () => {
  const { boxes, onApply } = fixture({ sourceKeys: [], writableSourceKeys: [] })
  expect(boxes.every(box => !(box as HTMLInputElement).checked)).toBe(true)
  fireEvent.click(screen.getAllByRole('button', { name: 'Reset to default' })[0]!)
  expect(boxes.every(box => (box as HTMLInputElement).checked)).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onApply).toHaveBeenCalledWith({ writableSourceKeys: [] })
})

it('saving another option leaves inherited source selection unset', () => {
  const { onApply } = fixture({ writableSourceKeys: [] })
  fireEvent.click(within(screen.getByRole('group', { name: 'writableSourceKeys' })).getAllByRole('checkbox')[0]!)
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onApply).toHaveBeenCalledWith({ writableSourceKeys: ['source:runtime'] })
})
