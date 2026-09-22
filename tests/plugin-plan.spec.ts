import { expect, it } from 'vitest'
import { planMemoryPluginChange } from '../src/host/plugin-plan.ts'
import type { MemoryPluginEntryView } from '../src/host/view-protocol.ts'
const entry = (entryId: string, fields: Partial<MemoryPluginEntryView> = {}): MemoryPluginEntryView => ({ entryId, packageName: `dsh-mnemon-source-${entryId}`, roles: ['source'], label: { en: entryId, 'zh-CN': entryId }, description: { en: '', 'zh-CN': '' }, provides: [], requires: [], requiredBy: [], fields: [], config: {}, enabled: false, active: false, writable: true, ...fields })
function catalog(workspaceEnabled = false) { return { writable: true, revision: 'r1', entries: [
  entry('runtime', { enabled: true, provides: [{ id: 'source', exclusive: false }] }),
  entry('default', { enabled: true, roles: ['strategy'], typeId: 'default', provides: [{ id: 'strategy.default', exclusive: false }] }),
  entry('workspace', { enabled: workspaceEnabled, roles: ['strategy'], typeId: 'workspace', provides: [{ id: 'strategy.workspace', exclusive: false }], requires: ['source'] }),
  entry('capture', { enabled: true, roles: ['strategy-extension'], strategyTypeId: 'default', requires: ['strategy.default'] }),
  entry('learning', { provides: [{ id: 'source.learning', exclusive: false }] }),
  entry('cycle', { roles: ['strategy-extension'], strategyTypeId: 'workspace', requires: ['strategy.workspace', 'source.learning'] }),
] } }
it.each([false, true])('selects the owning Strategy, includes its Source and retires incompatible enhancements (%s)', workspaceEnabled => {
  const current = catalog(workspaceEnabled), plan = planMemoryPluginChange(current, 'default', 'cycle', true)
  expect(plan.configuration.strategyTypeId).toBe('workspace')
  expect(plan.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ entryId: 'default', enabled: false, reason: 'strategy-change' }),
    expect.objectContaining({ entryId: 'capture', enabled: false, reason: 'strategy-change' }),
    expect.objectContaining({ entryId: 'learning', enabled: true, reason: 'requirement' }),
    expect.objectContaining({ entryId: 'cycle', enabled: true, reason: 'requested' }),
  ]))
  expect(current.entries.find(value => value.entryId === 'learning')!.enabled).toBe(false)
})
it('does not guess ambiguous providers, disable the selected Strategy, or change read-only entries', () => {
  const current = catalog(); current.entries.push(entry('other-learning', { provides: [{ id: 'source.learning', exclusive: false }] }))
  expect(() => planMemoryPluginChange(current, 'default', 'cycle', true)).toThrow('ambiguous')
  expect(() => planMemoryPluginChange(current, 'default', 'default', false)).toThrow('another composition')
  current.entries.find(value => value.entryId === 'default')!.writable = false
  expect(() => planMemoryPluginChange(current, 'default', 'workspace', true)).toThrow('read-only')
})
