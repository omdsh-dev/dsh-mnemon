import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { COMPOSABLE_MEMORY_API_VERSION, type MemorySourceDefinition } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, defineMemorySource, installMemory, memoryConfigurationDigest, memoryInputRecord, truncateMemoryText } from 'dsh-mnemon/extension-sdk'
import { sourceRecordDirectory, visibleRecord } from 'dsh-mnemon/source-sdk'
import { SyncEngine, type SyncConfig } from './engine.ts'
export const name = 'dsh-mnemon-source-sync'
export const inject = ['mnemonMemory']
export type Config = SyncConfig
export const Config = z.object({ dataDir: z.string(), allowLocalRemotes: z.boolean().default(false) }) as z<Config>
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Memory synchronization', 'zh-CN': '记忆同步' }, description: { en: 'Review independent snapshots and resolve cross-device changes.', 'zh-CN': '审阅独立快照，处理跨设备修改与冲突。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.memory-sync' }] })
export function createSyncSource(config: Config = {}): MemorySourceDefinition {
  return defineMemorySource({ manifest: { context: {"mode":"routed","weight":1} satisfies import('dsh-mnemon/contracts').MemoryContextProfile, apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'sync', packageName: name, role: 'memory-sync', consistency: 'exact-snapshot', capabilities: ['status', 'project'], management: { label: 'Memory synchronization', description: 'Human-reviewed snapshots, conflict decisions and explicit push.', operations: { reads: [{ id: 'plan', description: 'Inspect snapshot differences and unresolved conflicts.', access: { kinds: ['read'], result: 'records' } }, { id: 'push-plan', description: 'Review the exact destination and snapshot before transmission.', access: { kinds: ['read'], result: 'records' } }], actions: [{ id: 'prepare', description: 'Prepare an independent snapshot for review.', requiresApproval: true, operation: { effects: ['propose'], execution: 'immediate' } }, { id: 'push', description: 'Transmit the exact reviewed snapshot to its configured destination.', requiresApproval: true, operation: { effects: ['transfer', 'deliver'], execution: 'immediate' } }] } }, routes: [], actions: [] }, create(context) {
    const engine = new SyncEngine(sourceRecordDirectory('sync', context, config), config)
    return {
      async facts(request, signal) { const value = await engine.store.read(signal); return { sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'sync', role: 'memory-sync', revision: value.revision, availability: 'ready', capabilities: ['status', 'project'], routeIds: [], actionIds: [], hints: { targets: value.records.filter(record => visibleRecord(record, request.scope)).length } } },
      async project(request, signal) { const value = await engine.store.read(signal); if (value.revision !== request.expectedRevision) throw new Error('Sync settings changed during composition'); return { fragments: request.includeProjection ? [{ id: context.sourceInstanceKey + '/summary', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode, revision: value.revision, text: truncateMemoryText('Memory synchronization is controlled by the user in its Source page. Snapshot preparation, conflict resolution, imports and pushes require explicit human management; no model operations are exposed.', request.maxCharacters) }] : [] } },
      async manage(request) {
        const input = memoryInputRecord(request.input ?? {}, 'sync management')
        if (request.mode === 'read') {
          if (request.operation === 'status' || request.operation === 'snapshot') return engine.status(request.scope, request.signal)
          if (request.operation === 'plan') return engine.plan(request.scope, input.id)
          if (request.operation === 'push-plan') return engine.pushPlan(request.scope, input.id)
          throw new Error('Unsupported sync read')
        }
        if (!request.confirmed || !request.expectedRevision) throw new Error('A confirmed, revision-fenced sync operation is required')
        if (request.operation === 'configure') return engine.configure(request.scope, input, request.expectedRevision, request.signal)
        if (request.operation === 'prepare') return engine.prepare(request.scope, input, request.expectedRevision, request.signal)
        if (request.operation === 'push') return engine.push(request.scope, input, request.expectedRevision, request.signal)
        return engine.changePlan(request.operation, request.scope, input, request.expectedRevision, request.signal)
      },
      dispose() { engine.dispose() },
    }
  } })
}
export function apply(ctx: Context, config: Config = {}) { installMemory(ctx, { plugin: memoryPlugin, sources: [createSyncSource(config)] }, { effectiveDigest: memoryConfigurationDigest(config) }) }
