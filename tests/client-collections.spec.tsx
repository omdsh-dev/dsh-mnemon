// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { MemorySourcePageProps, MnemonSourceManagementClient } from 'dsh-mnemon/client'
import { createCollectionPage } from '../src/client/collection/client.tsx'
import { RecordActionPanel } from '../src/client/collection/action-client.tsx'
afterEach(cleanup)
it('keeps action forms and results bound to the selected scope during pending mutations', async () => {
  let finish!: (value: unknown) => void
  const first = { sourceInstanceKey: 'source:notes', revision: 'first', read: vi.fn(async () => result('First')), mutate: vi.fn(() => new Promise(resolve => { finish = resolve })) } as unknown as MnemonSourceManagementClient
  const second = { ...first, read: vi.fn(async () => result('Second')) } as unknown as MnemonSourceManagementClient
  const options = { title: { en: 'Actions', 'zh-CN': '操作' }, filter: () => true, fields: [{ key: 'text', label: { en: 'Message', 'zh-CN': '消息' }, type: 'text' as const }], buttons: [{ operation: 'send', label: { en: 'Send', 'zh-CN': '投递' } }] }
  const view = render(<RecordActionPanel {...props(first, '/first')} options={options} />)
  await screen.findByRole('heading', { name: 'First' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Old message' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(first.mutate).toHaveBeenCalledOnce())
  view.rerender(<RecordActionPanel {...props(second, '/second')} options={options} />)
  await screen.findByRole('heading', { name: 'Second' })
  await act(async () => { finish({ revision: 'old', value: { result: 'Old delivery' } }) })
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLInputElement).value).toBe('')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'First' })).toBeNull()
})
const record = (title: string) => ({ id:title, title, content:'', kind:'note', scope:'project', workspaceId:'/project', state:'active', data:{}, signals:1,version:1,history:[],createdAt:'2026-09-09T00:00:00Z',updatedAt:'2026-09-09T00:00:00Z' })
const result = (title: string) => ({revision:title,value:{revision:title,records:[record(title)]}})
const Page=createCollectionPage({title:{en:'Records','zh-CN':'记录'},description:{en:'Scoped','zh-CN':'范围'},kinds:[{value:'note',label:{en:'Note','zh-CN':'笔记'}}],scopes:['project'],defaultScope:'project'})
const props = (client:MnemonSourceManagementClient,workspaceId:string):MemorySourcePageProps => ({sourceTypeId:'notes',sourceInstanceKey:client.sourceInstanceKey,sourceInstances:[],management:client,locale:'en',writable:true,workspaceId})
it('rejects a late snapshot after the selected workspace changes', async () => {
  let finish!:(value:unknown)=>void
  const first={sourceInstanceKey:'source:notes',revision:'first',read:vi.fn(()=>new Promise(resolve=>{finish=resolve})),mutate:vi.fn()} as unknown as MnemonSourceManagementClient
  const second={...first,read:vi.fn(async()=>result('Second workspace'))} as unknown as MnemonSourceManagementClient
  const view=render(<Page {...props(first,'/first')} />)
  view.rerender(<Page {...props(second,'/second')} />)
  await screen.findByRole('heading',{name:'Second workspace'})
  await act(async()=>{finish(result('First workspace'))})
  expect(screen.queryByRole('heading',{name:'First workspace'})).toBeNull()
})
it('drops an old pending save and draft without resetting the new workspace', async () => {
  let finish!:(value:unknown)=>void
  const first={sourceInstanceKey:'source:notes',revision:'first',read:vi.fn(async()=>result('First')),mutate:vi.fn(()=>new Promise(resolve=>{finish=resolve}))} as unknown as MnemonSourceManagementClient
  const second={...first,read:vi.fn(async()=>result('Second'))} as unknown as MnemonSourceManagementClient
  const view=render(<Page {...props(first,'/first')} />);await screen.findByRole('heading',{name:'First'})
  fireEvent.click(screen.getByRole('button',{name:'Edit'}));fireEvent.change(screen.getByRole('textbox',{name:'Title'}),{target:{value:'Old draft'}});fireEvent.click(screen.getByRole('button',{name:'Save'}))
  await waitFor(()=>expect(first.mutate).toHaveBeenCalledOnce())
  view.rerender(<Page {...props(second,'/second')} />);await screen.findByRole('heading',{name:'Second'})
  await act(async()=>{finish(result('Old saved'))})
  expect(screen.queryByRole('textbox',{name:'Title'})).toBeNull();expect(screen.queryByRole('heading',{name:'Old saved'})).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it('submits the exact selected versions in one batch without including hidden or unselected records', async () => {
  const rows = [record('First'), record('Second')].map(value => ({ ...value, state: 'pending' }))
  const read = vi.fn(async () => ({ revision: 'r1', value: { revision: 'r1', records: rows } }))
  const mutate = vi.fn(async () => ({ revision: 'r2', value: { revision: 'r2', records: rows.map(value => ({ ...value, state: 'active', version: 2 })) } }))
  const client = { sourceInstanceKey: 'source:notes', read, mutate } as unknown as MnemonSourceManagementClient
  render(<Page {...props(client, '/project')} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Needs review 2' }))
  fireEvent.click(screen.getByLabelText('Select Second'))
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }))
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('batch-approve', { recordIds: ['Second'], versions: { Second: 1 }, supersededVersions: {} }, { confirmed: true, expectedRevision: 'r1' }))
})
