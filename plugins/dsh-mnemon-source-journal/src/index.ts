import type { MemorySourceDefinition } from 'dsh-mnemon/contracts'
import { join } from 'node:path'
import { JournalProgress } from './progress.ts'
import { agentMemoryScope } from 'dsh-mnemon-workspace-kit/dsh'
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { createRecordSource, RecordStore, sourceRecordDirectory, type RecordSourceConfig } from 'dsh-mnemon/source-sdk'
import { installAgentHooks } from 'dsh-mnemon-workspace-kit/dsh'
import { captureJournalEvent, captureWorkspaceActivity, type JournalCaptureConfig } from './lifecycle.ts'
import { sourceOptions } from './source.ts'
export const name = 'dsh-mnemon-source-journal'
export const inject = ['mnemonMemory', 'agents']
export interface Config extends RecordSourceConfig, JournalCaptureConfig { writeReminderTurns?: number }
export const Config = z.object({ dataDir: z.string(), writeReminderTurns: z.number().min(0).max(1000).default(0), captureTurns: z.boolean().default(false), captureFeedback: z.boolean().default(true), captureJobResults: z.boolean().default(false) }) as z<Config>
export const memoryPlugin = defineMemoryPlugin({
 packageName: name, label: { en: 'Activity journal', 'zh-CN': '活动日志' },
 description: { en: 'Project progress, daily activity and feedback with durable history.', 'zh-CN': '项目进展、每日活动与反馈的持久记录。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.activity-log' }],
})
export function apply(ctx: Context, config: Config = {}): void {
 if (config.writeReminderTurns !== undefined && (!Number.isInteger(config.writeReminderTurns) || config.writeReminderTurns < 0 || config.writeReminderTurns > 1000)) throw new Error('Journal reminder threshold must be an integer from 0 to 1000')
 const base = createRecordSource(sourceOptions, config)
 const source: MemorySourceDefinition = { ...base, create(context: Parameters<typeof base.create>[0]) {
   const runtime = base.create(context), store = new RecordStore(sourceRecordDirectory('journal', context, config))
   const progress = new JournalProgress(new RecordStore(join(sourceRecordDirectory('journal', context, config), 'progress')), config.writeReminderTurns ?? 0)
   const stop = installAgentHooks(ctx, { async event(agent, event, signal) {
     if (!['turn/end', 'feedback/record'].includes(event.type)) return
     if (await captureJournalEvent(store, agent, event, config, signal)) await progress.written(agentMemoryScope(agent), signal)
     await progress.completed(agent, event, signal)
   }, error(error) { ctx.logger(name).warn('Journal capture: %s', String(error)) } })
   const abort = new AbortController(), pending = new Set<Promise<void>>()
   const unsubscribe = ctx.on('mnemon-workspace/activity', activity => {
     const task = captureWorkspaceActivity(store, activity, config, abort.signal).then(async captured => { if (captured) await progress.written(activity.scope, abort.signal) }).catch(error => { if (!abort.signal.aborted) ctx.logger(name).warn('Activity capture: %s', String(error)) })
     pending.add(task); void task.finally(() => pending.delete(task))
   })
   return { ...runtime,
     async facts(request, signal) { const facts = await runtime.facts(request, signal), state = await progress.status(request.scope, signal); return { ...facts, hints: { journalWriteDue: state.due, journalWriteGap: state.gap } } },
     async manage(request) {
       if (request.mode === 'read' && request.operation === 'progress-status') return { revision: (await store.read(request.signal)).revision, value: await progress.status(request.scope, request.signal) }
       const result = await runtime.manage!(request)
       if (request.mode === 'mutate' && ['create', 'update', 'approve'].includes(request.operation)) await progress.written(request.scope, request.signal)
       return result
     },
     async mutate(request) { const receipt = await runtime.mutate!(request); if (request.offer.sourceActionId === 'append') await progress.written(request.view.scope, request.signal); return receipt },
     async dispose() { unsubscribe(); abort.abort(); await stop(); await Promise.allSettled(pending); await runtime.dispose?.() } }
 } }
 installMemory(ctx, { plugin: memoryPlugin, sources: [source] }, { effectiveDigest: memoryConfigurationDigest(config) })
}
export { sourceOptions }
