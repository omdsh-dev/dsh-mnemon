import { describe, expect, it } from 'vitest'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { sourceOptions } from '../src/source.ts'
const value = (data: Record<string, any> = {}): RecordValue => ({ id: 'sample', kind: 'fact', title: 'Sample', content: 'Content', scope: 'project', workspaceId: '/project-a', state: 'active', data, signals: 1, version: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', history: [] })
describe('project notes', () => {
 it('rejects malformed branch scope and omits routed notes from eager context', () => {
   expect(() => sourceOptions.validate(value({ branches: 'main' }))).toThrow(/Branches/)
   const note = value(); note.kind = 'note'
   expect(sourceOptions.project!([note], { storage: 'custom' })).not.toContain('Content')
 })
 it('keeps notes visible when the workspace is not a repository', async () => {
   expect(await sourceOptions.visible!(value({ branches: ['main'] }), { storage: 'custom', workspaceId: '/nonexistent-project' })).toBe(true)
 })
})
