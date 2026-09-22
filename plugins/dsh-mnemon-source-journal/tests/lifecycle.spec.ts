import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RecordStore } from 'dsh-mnemon/source-sdk'
import { type WorkspaceActivity } from 'dsh-mnemon-workspace-kit'
import { captureJournalEvent, captureWorkspaceActivity } from '../src/lifecycle.ts'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true}) })
async function fixture() { const root = await mkdtemp(join(tmpdir(),'mnemon-journal-'));dirs.push(root);await promisify(execFile)('git',['init','--initial-branch=main',root]);return { root, store:new RecordStore(join(root,'journal')) } }
it('captures feedback with real branch provenance and deduplicates the original event', async () => {
  const {root,store}=await fixture(), agent={session:{id:'session',header:{id:'session',cwd:root,origin:'human'}}} as unknown as Agent
  const event={type:'feedback/record',seq:17,time:Date.now(),data:{text:'Keep the exact quotation.'}} as SessionEvent
  await captureJournalEvent(store,agent,event,{});await captureJournalEvent(store,agent,event,{})
  const records=(await store.read()).records;expect(records).toHaveLength(1);expect(records[0]).toMatchObject({content:'Keep the exact quotation.',data:{branch:'main',exactQuote:true}})
})
it('accepts category-only feedback without inventing a user quotation', async () => {
  const {root,store}=await fixture(), agent={session:{id:'session',header:{id:'session',cwd:root,origin:'human'}}} as unknown as Agent
  const event: SessionEvent={type:'feedback/record',seq:SessionSeq(18),time:Date.now(),data:{category:'other'}}
  expect(await captureJournalEvent(store,agent,event,{})).toBe(false)
  expect((await store.read()).records).toHaveLength(0)
})
it('captures each finished job once in project and daily logs, with opt-in and cancellation', async () => {
  const {root,store}=await fixture(), activity:WorkspaceActivity={eventKey:'job/completed',sourceInstanceKey:'source:jobs',scope:{storage:'custom',workspaceId:root,sessionId:'owner'},kind:'job-completed',title:'Validation result',summary:'Actual output',level:'info',recordId:'job'}
  await captureWorkspaceActivity(store,activity,{});expect((await store.read()).records).toHaveLength(0)
  await captureWorkspaceActivity(store,activity,{captureJobResults:true});await captureWorkspaceActivity(store,activity,{captureJobResults:true})
  const records=(await store.read()).records;expect(records.map(record=>record.scope)).toEqual(['project','daily']);expect(records.every(record=>record.content==='Actual output'&&record.data.branch==='main')).toBe(true)
  const abort=new AbortController();abort.abort();await expect(captureWorkspaceActivity(store,{...activity,eventKey:'another'},{captureJobResults:true},abort.signal)).rejects.toThrow()
  expect((await store.read()).records).toHaveLength(2)
})
