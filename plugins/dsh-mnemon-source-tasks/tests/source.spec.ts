import { describe, expect, it } from 'vitest'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { sourceOptions } from '../src/source.ts'
const value = (data: Record<string, any> = {}): RecordValue => ({ id: 'sample', kind: 'project', title: 'Sample', content: 'Content', scope: 'project', workspaceId: '/project-a', state: 'active', data, signals: 1, version: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', history: [] })
describe('tasks', () => {
 it('routes personal tasks to global scope and keeps completion history', async () => {
   const record = value(); record.kind = 'personal'
   await sourceOptions.prepare!(record, { storage: 'custom', workspaceId: '/project-a' })
   expect(record.scope).toBe('global'); expect(record.workspaceId).toBeUndefined()
   await sourceOptions.mutate!('complete', { id: record.id }, { records: [record], scope: { storage: 'custom' } })
   expect(record.data.status).toBe('done'); expect(record.history).toHaveLength(1)
 })
 it('rejects impossible dates and excludes completed tasks from the due view', () => {
   expect(() => sourceOptions.validate(value({ due: '2026-02-31' }))).toThrow(/date/)
   expect(sourceOptions.search!([value({ status: 'done' })], {}, { storage: 'custom' })).toEqual([])
 })
})
