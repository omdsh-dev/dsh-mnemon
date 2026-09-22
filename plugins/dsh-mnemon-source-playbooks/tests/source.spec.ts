import { describe, expect, it } from 'vitest'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { sourceOptions } from '../src/source.ts'
const value = (data: Record<string, any> = {}): RecordValue => ({ id: 'sample', kind: 'skill', title: 'Sample', content: 'Content', scope: 'project', workspaceId: '/project-a', state: 'active', data, signals: 1, version: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', history: [] })
describe('playbooks', () => {
 it('requires a stable skill name and hides disabled content', () => {
   expect(() => sourceOptions.validate(value({ enabled: true, slug: '../bad' }))).toThrow(/name/)
   expect(sourceOptions.visible!(value({ enabled: false }), { storage: 'custom' })).toBe(false)
   expect(sourceOptions.project!([value({ enabled: true })], { storage: 'custom' })).not.toContain('Content')
 })
 it('records enablement history and rejects cross-project changes', async () => {
   const record = value({ enabled: true, slug: 'debugging-process' })
   await expect(async () => sourceOptions.mutate!('toggle', { id: record.id }, { records: [record], scope: { storage: 'custom', workspaceId: '/project-b' } })).rejects.toThrow(/not found/)
   await sourceOptions.mutate!('toggle', { id: record.id }, { records: [record], scope: { storage: 'custom', workspaceId: '/project-a' } })
   expect(record.data.enabled).toBe(false); expect(record.history[0]?.data.enabled).toBe(true)
 })
 it('renames and removes categories within the selected scope while retaining content and prior metadata', async () => {
   const first = value({ enabled: true, slug: 'first', category: 'Review' }), second = { ...value({ enabled: true, slug: 'second', category: 'Review' }), id: 'second' }
   const global = { ...value({ enabled: true, slug: 'global', category: 'Review' }), id: 'global', scope: 'global' as const }, other = { ...value({ enabled: true, slug: 'other', category: 'Review' }), id: 'other', workspaceId: '/project-b' }
   const records = [first, second, global, other], scope = { storage: 'custom' as const, workspaceId: '/project-a' }
   await sourceOptions.mutate!('rename-category', { id: first.id, version: 1, category: 'Quality' }, { records, scope })
   expect(records.map(record => record.data.category)).toEqual(['Quality', 'Quality', 'Review', 'Review'])
   expect(first.history[0]?.data.category).toBe('Review')
   expect(first.content).toBe('Content')
   await expect(async () => sourceOptions.mutate!('clear-category', { id: first.id, version: 1 }, { records, scope })).rejects.toThrow('version changed')
   await sourceOptions.mutate!('clear-category', { id: first.id, version: 2 }, { records, scope })
   expect(records.map(record => record.data.category)).toEqual(['', '', 'Review', 'Review'])
 })
})
