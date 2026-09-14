import { expect, it } from 'vitest'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { filterTasks, taskQuadrant, type TaskFilters } from '../src/views.tsx'
const make = (id: string, data: RecordValue['data'], kind = 'project'): RecordValue => ({ id, kind, data, title: id, content: '', state: 'active', scope: 'project', workspaceId: '/project', signals: 1, version: 1, history: [], createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z' })
const filters: TaskFilters = { kind: '', status: '', due: '', date: '', category: '' }
it('combines task type, category, dates and open status without counting completed overdue tasks', () => {
  const open = make('open', { status: 'pending', due: '2026-09-08', category: 'release', important: true }), done = make('done', { ...open.data, status: 'done' }), personal = make('personal', { ...open.data }, 'personal')
  expect(filterTasks([done, personal, open], { ...filters, kind: 'project', due: 'overdue', category: 'release' }, '2026-09-09').map(value => value.id)).toEqual(['open'])
  const daily = { ...make('daily', {status: 'blocked', due: '2026-09-09'}, 'daily'), scope: 'daily' as const, date: '2026-09-09' }
  expect(filterTasks([daily, open], { ...filters, status: 'open', date: '2026-09-09', due: 'today' }, '2026-09-09')).toEqual([daily])
  expect(filterTasks([daily], { ...filters, due: 'upcoming' }, '2026-09-09')).toEqual([])
})
it('places tasks in all four priority groups and orders deadlines before undated work', () => {
  const records = [make('routine', {}), make('important', {important:true}), make('urgent', {urgent:true}), make('both', {important:true,urgent:true})]
  expect(records.map(taskQuadrant)).toEqual([3, 1, 2, 0])
  const due = make('deadline', {due:'2026-09-10'})
  expect(filterTasks([...records, due], filters, '2026-09-09').map(value => value.id)).toEqual(['deadline','both','important','urgent','routine'])
  expect(filterTasks([due,...records], {...filters,due:'none'}, '2026-09-09')).toHaveLength(4)
})
