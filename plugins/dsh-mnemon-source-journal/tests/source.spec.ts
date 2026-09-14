import { describe, expect, it } from 'vitest'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { sourceOptions } from '../src/source.ts'
const value = (data: Record<string, any> = {}): RecordValue => ({ id: 'sample', kind: 'progress', title: 'Sample', content: 'Content', scope: 'project', workspaceId: '/project-a', state: 'active', data, signals: 1, version: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', history: [] })
describe('journal', () => {
 it('uses append-only model writes and removes forged branch provenance', async () => {
   const record = value({ branch: 'forged' })
   await sourceOptions.prepare!(record, { storage: 'custom', workspaceId: '/nonexistent-project' })
   expect(record.data.branch).toBeUndefined()
   expect(sourceOptions.modelWrites).toBe('append')
 })
 it('checks feedback fields and keeps full entries out of the resident cover', () => {
   expect(() => sourceOptions.validate(value({ sentiment: 'unknown' }))).toThrow(/sentiment/)
   expect(sourceOptions.project!([value()], { storage: 'custom' })).not.toContain('Content')
 })
})
