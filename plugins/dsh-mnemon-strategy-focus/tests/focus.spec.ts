import { expect, it } from 'vitest'
import { DEFAULT_MEMORY_VIEW_BUDGET, type MemoryAvailableSource } from 'dsh-mnemon/contracts'
import { createFocusExtension } from '../src/index.ts'
const request = { scope: { storage: 'custom' as const }, scenario: 'test', budget: DEFAULT_MEMORY_VIEW_BUDGET }
const source = (id: string): MemoryAvailableSource => ({ sourceInstanceKey: 'source:' + id, sourceTypeId: 'tasks', role: 'task-context', availability: 'ready', revision: '1', capabilities: [], routeIds: [], actionIds: [], routes: [], actions: [] })
it('keeps selection pure, distinguishes empty from unset, and captures configuration', () => {
  const config = { sourceKeys: ['source:b', 'source:a'], writableSourceKeys: ['source:b'], maxProjectionCharacters: 512 }
  const extension = createFocusExtension(config)
  config.sourceKeys.reverse(); config.writableSourceKeys.push('source:a')
  expect(extension.contribute(request, [source('a'), source('b')])).toMatchObject({ selection: { sourceKeys: ['source:b', 'source:a'], writableSourceKeys: ['source:b'], maxProjectionCharacters: 512 } })
  expect(createFocusExtension({ sourceKeys: [] }).contribute(request, [source('a')])).toMatchObject({ selection: { sourceKeys: [] } })
  expect(createFocusExtension().contribute(request, [source('b'), source('a')])).toMatchObject({ selection: { sourceKeys: ['source:a', 'source:b'] } })
})
it('rejects invalid budgets, duplicate keys and expansion of the writable subset', () => {
  for (const maxProjectionCharacters of [0, -1, 65537, 1.5, NaN]) expect(() => createFocusExtension({ maxProjectionCharacters })).toThrow()
  expect(() => createFocusExtension({ sourceKeys: ['source:a', 'source:a'] })).toThrow()
  expect(() => createFocusExtension({ sourceKeys: ['source:a'], writableSourceKeys: ['source:b'] })).toThrow()
  expect(() => createFocusExtension({ writableSourceKeys: ['source:absent'] }).contribute(request, [source('a')])).toThrow()
})
