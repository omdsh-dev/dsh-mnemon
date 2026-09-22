// Import the optional DSH activity-bus declaration independently of storage helpers.
import type {} from 'dsh-mnemon-workspace-kit'
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { createRecordSource, RecordStore, sourceRecordDirectory, visibleRecord, type RecordSnapshot, type RecordSourceConfig } from 'dsh-mnemon/source-sdk'
import { sourceOptions } from './source.ts'
import type { MemoryOperationScope, MemorySourceDefinition } from 'dsh-mnemon/contracts'
export const name = 'dsh-mnemon-source-tasks'
export const inject = ['mnemonMemory']
export type Config = RecordSourceConfig
export const Config = z.object({ dataDir: z.string() }) as z<Config>
export const memoryPlugin = defineMemoryPlugin({
 packageName: name, label: { en: 'Tasks', 'zh-CN': '任务清单' },
 description: { en: 'Personal, work, project and daily tasks with review and deadlines.', 'zh-CN': '个人、工作、项目和每日任务，支持审核与截止日期。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.task-context' }],
})
export function apply(ctx: Context, config: Config = {}): void {
 const base = createRecordSource(sourceOptions, config)
 const source: MemorySourceDefinition = { ...base, create(context) {
   const runtime = base.create(context), store = new RecordStore(sourceRecordDirectory('tasks', context, config))
   async function publish(before: RecordSnapshot, scope: MemoryOperationScope) {
     const after = await store.read()
     for (const record of after.records) {
       const previous = before.records.find(item => item.id === record.id)
       if (!visibleRecord(record, scope) || record.state !== 'active' || !['done', 'blocked'].includes(String(record.data.status)) || previous?.state === record.state && previous.data.status === record.data.status) continue
       ctx.emit('mnemon-workspace/activity', { eventKey: `${record.id}:${record.version}:${String(record.data.status)}`, sourceInstanceKey: context.sourceInstanceKey, scope, kind: record.data.status === 'done' ? 'task-completed' : 'task-blocked', title: record.title, summary: record.content || record.title, level: record.data.status === 'done' ? 'info' : 'warning', recordId: record.id })
     }
   }
   return { ...runtime,
     async manage(request) { if (request.mode === 'read') return runtime.manage!(request); const before = await store.read(request.signal), result = await runtime.manage!(request); try { await publish(before, request.scope) } catch (error) { ctx.logger(name).warn('Task feedback publication failed: %s', String(error)) }; return result },
     async mutate(request) { const before = await store.read(request.signal), result = await runtime.mutate!(request); try { await publish(before, request.view.scope) } catch (error) { ctx.logger(name).warn('Task feedback publication failed: %s', String(error)) }; return result },
   }
 } }
 installMemory(ctx, { plugin: memoryPlugin, sources: [source] }, { effectiveDigest: memoryConfigurationDigest(config) })
}
export { sourceOptions }
