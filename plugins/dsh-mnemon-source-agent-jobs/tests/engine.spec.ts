import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { JobEngine, preparePlan, type JobConfig } from '../src/engine.ts'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { contextCaptures } from '../src/inputs.ts'
const waitFor = async (engine: JobEngine, id: string, states: string[]) => {
  for (let n = 0; n < 120; n++) { const record = (await engine.store.read()).records.find(value => value.id === id)!; if (states.includes(String(record.data.status))) return record; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('Job did not reach ' + states.join('/'))
}
async function fixture(code: string, timeoutSeconds = 10) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mnemon-jobs-'))), executable = join(root, 'worker.mjs')
  await writeFile(executable, code)
  const config: JobConfig = { maxParallel: 1, adapters: [{ id: 'test', label: 'Local test', command: process.execPath, args: [executable, '{prompt}'], resumeArgs: [executable, '{prompt}', '{session}'], timeoutSeconds }] }
  const engine = new JobEngine(join(root, 'data'), config), scope = { storage: 'custom' as const, workspaceId: root, sessionId: 'owner' }
  const create = async (content: string) => {
    const now = new Date().toISOString(), record: RecordValue = { id: randomUUID(), kind: 'job', title: 'Test', content, scope: 'project', workspaceId: root, state: 'active', data: { adapter: 'test', model: '', attachments: [], context: '', status: 'draft', notify: false }, version: 1, signals: 1, createdAt: now, updatedAt: now, history: [] }
    await engine.store.change(undefined, records => { records.push(record) }); return record
  }
  return { engine, scope, config, create }
}
describe('durable CLI jobs', () => {
  it('freezes copied image bytes and Source context and rejects damaged assets before execution', async () => {
    const f = await fixture('console.log(process.argv[2]); console.log(process.argv.slice(3).join("\\n"))')
    f.config.adapters![0]!.supportsImages = true; f.config.adapters![0]!.attachmentArgs = ['--image', '{attachment}']
    try {
      const original = join(f.scope.workspaceId, 'input.png'), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
      await writeFile(original, bytes)
      const record = await f.create('Analyze the retained input'), assets = await f.engine.inputs.copy([{ path: original }], f.scope)
      const captures = contextCaptures([{ sourceKey: 'source:notes', label: 'Project notes', track: 'project', revision: 'v1', capturedAt: new Date().toISOString(), text: 'Pinned project evidence' }])
      await f.engine.store.change(undefined, records => { records[0]!.data.assets = JSON.parse(JSON.stringify(assets)); records[0]!.data.contextSnapshots = JSON.parse(JSON.stringify(captures)) })
      const saved = (await f.engine.store.read()).records[0]!, plan = await preparePlan(saved, f.scope, f.config, f.engine.inputs)
      await writeFile(original, 'changed original')
      expect(await readFile(plan.attachments[0]!)).toEqual(bytes)
      expect(plan.prompt).toContain('Pinned project evidence'); expect(plan.prompt).toContain('revision: v1')
      captures[0]!.text = 'later context'
      expect((await preparePlan(saved, f.scope, f.config, f.engine.inputs)).digest).toBe(plan.digest)
      await f.engine.enqueue(record.id, plan, f.scope)
      expect((await waitFor(f.engine, record.id, ['succeeded'])).data.output).toContain('Pinned project evidence')
      const next = await f.create('damaged input')
      await f.engine.store.change(undefined, records => { records.find(record => record.id === next.id)!.data.assets = JSON.parse(JSON.stringify(assets)) })
      const pending = (await f.engine.store.read()).records.find(record => record.id === next.id)!, shown = await preparePlan(pending, f.scope, f.config, f.engine.inputs)
      await writeFile(shown.attachments[0]!, 'damaged')
      await expect(f.engine.enqueue(next.id, shown, f.scope)).rejects.toThrow(/changed|size|limit|damaged/)
      expect(() => contextCaptures([{ ...captures[0], text: 'x'.repeat(20001) }])).toThrow(/20000/)
    } finally { await f.engine.dispose() }
  })
  it('reports concurrency and prunes only expired completed jobs in the selected project', async () => {
    const f = await fixture('console.log("complete")')
    try {
      const old = await f.create('old'), recent = await f.create('recent'), foreign = await f.create('foreign'), draft = await f.create('draft')
      await f.engine.enqueue(old.id, await preparePlan(old, f.scope, f.config), f.scope); await waitFor(f.engine, old.id, ['succeeded'])
      const log = join(f.engine.directory, 'logs', old.id + '.log'); expect((await stat(log)).isFile()).toBe(true)
      await f.engine.store.change(undefined, records => {
        records.find(record => record.id === old.id)!.data.finishedAt = '2000-01-01T00:00:00.000Z'
        const other = records.find(record => record.id === foreign.id)!; other.workspaceId = '/other'; other.data.status = 'succeeded'; other.data.finishedAt = '2000-01-01T00:00:00.000Z'
      })
      expect(await f.engine.statistics(f.scope)).toMatchObject({ parallelLimit: 1, expired: 1, retentionDays: 90 })
      expect(await f.engine.prune(f.scope, (await f.engine.store.read()).revision)).toBe(1)
      expect((await f.engine.store.read()).records.map(record => record.id).sort()).toEqual([recent.id, foreign.id, draft.id].sort())
      await expect(stat(log)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.engine.dispose() }
  })
  it('executes the reviewed literal argv, persists logs and external session references', async () => {
    const f = await fixture('console.log(JSON.stringify({session_id:"external-42"})); console.log(process.argv[2])')
    try {
      const record = await f.create('$(touch never-created); 中文'), plan = await preparePlan(record, f.scope, f.config)
      await f.engine.enqueue(record.id, plan, f.scope)
      const finished = await waitFor(f.engine, record.id, ['succeeded'])
      expect(finished.data.externalSessionId).toBe('external-42'); expect(await f.engine.log(record.id, f.scope)).toContain('$(touch never-created); 中文')
      await expect(f.engine.log(record.id, { ...f.scope, workspaceId: '/elsewhere' })).rejects.toThrow(/outside/)
      await expect(f.engine.enqueue(record.id, plan, f.scope)).rejects.toThrow(/draft/)
    } finally { await f.engine.dispose() }
  })
  it('rejects a modified or stale execution plan without starting a process', async () => {
    const f = await fixture('console.log("unexpected")')
    try {
      const record = await f.create('original'), plan = await preparePlan(record, f.scope, f.config)
      await expect(f.engine.enqueue(record.id, { ...plan, args: ['-e', 'process.exit(0)'] }, f.scope)).rejects.toThrow(/plan changed/)
      await f.engine.store.change(undefined, records => { records[0]!.content = 'changed'; records[0]!.version++ })
      await expect(f.engine.enqueue(record.id, plan, f.scope)).rejects.toThrow(/plan changed/)
      expect((await f.engine.store.read()).records[0]!.data.status).toBe('draft')
    } finally { await f.engine.dispose() }
  })
  it('cancels running and queued jobs and drains processes on unload', async () => {
    const f = await fixture('console.log("started");setInterval(()=>{},1000)')
    try {
      const a = await f.create('a'), b = await f.create('b')
      await f.engine.enqueue(a.id, await preparePlan(a, f.scope, f.config), f.scope); await f.engine.enqueue(b.id, await preparePlan(b, f.scope, f.config), f.scope)
      await waitFor(f.engine, a.id, ['running']); await f.engine.cancel(b.id, f.scope); await f.engine.cancel(a.id, f.scope)
      expect((await waitFor(f.engine, a.id, ['cancelled'])).data.status).toBe('cancelled')
      expect((await waitFor(f.engine, b.id, ['cancelled'])).data.startedAt).toBeUndefined()
      const c = await f.create('c'); await f.engine.enqueue(c.id, await preparePlan(c, f.scope, f.config), f.scope); await f.engine.dispose()
      expect((await f.engine.store.read()).records.find(value => value.id === c.id)?.data.status).toBe('cancelled')
    } finally { await f.engine.dispose() }
  })
  it('reports process failure and timeout as failure outcomes, never successful completion', async () => {
    const f = await fixture('if(process.argv[2]==="fail"){console.error("fixture failure");process.exitCode=9}else setInterval(()=>{},1000)', 1)
    try {
      for (const [prompt, state] of [['fail', 'failed'], ['slow', 'timed-out']]) {
        const record = await f.create(prompt!); await f.engine.enqueue(record.id, await preparePlan(record, f.scope, f.config), f.scope)
        const finished = await waitFor(f.engine, record.id, [state!]); expect(finished.data.error).toBeTruthy()
      }
    } finally { await f.engine.dispose() }
  })
})
