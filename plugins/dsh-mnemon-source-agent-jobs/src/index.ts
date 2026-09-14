// Import the optional DSH activity-bus declaration independently of storage helpers.
import type {} from 'dsh-mnemon-workspace-kit'
import { createMemoryExecutionResult } from 'dsh-mnemon/source-sdk'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import type { MemoryJsonValue, MemoryOperationScope, MemorySourceDefinition, MemorySourceManagementRequest } from 'dsh-mnemon/contracts'
import { createMemoryMutationReceipt, defineMemoryPlugin, installMemory, memoryConfigurationDigest, memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { createRecordSource, digest, json, reviseRecord, sourceRecordDirectory, visibleRecord, withLookupRoutes, type LookupResult, type RecordValue } from 'dsh-mnemon/source-sdk'
import { DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'
import { JobEngine, preparePlan, terminalStates, validateJobConfig, type ExecutionPlan, type JobConfig } from './engine.ts'
import { contextCaptures, type JobInputs } from './inputs.ts'
export type { CliAdapter, ExecutionPlan, JobConfig } from './engine.ts'
export const name = 'dsh-mnemon-source-agent-jobs'
export const inject = ['mnemonMemory', 'agentPresets', 'sessionQuery', 'agents', 'workspaceRegistry', 'attachments']
export type Config = JobConfig
export const Config = z.object({ dataDir: z.string(), maxParallel: z.number().default(2), attachmentRoots: z.array(z.string()).default([]), attachmentUrlOrigins: z.array(z.string()).default([]), retentionDays: z.number().default(90), notifyOwner: z.boolean().default(true),
  adapters: z.array(z.object({ id: z.string(), label: z.string(), command: z.string(), args: z.array(z.string()), resumeArgs: z.array(z.string()), input: z.union(['argument', 'stdin']), attachmentArgs: z.array(z.string()), supportsImages: z.boolean(), supportsUrls: z.boolean(), models: z.array(z.string()), defaultModel: z.string(), timeoutSeconds: z.number() })).default([]),
}) as z<Config>
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Background jobs', 'zh-CN': '后台任务' }, description: { en: 'Reviewed CLI execution with durable status, logs and recovery.', 'zh-CN': '经审核的 CLI 执行，支持持久状态、日志和恢复。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.agent-jobs' }] })
export interface CompletedJob { sourceInstanceKey: string; record: RecordValue; scope: MemoryOperationScope }
declare module '@deepseek-ai/cordis' { interface Events { 'mnemon-jobs/completed'(event: CompletedJob): void } }
interface Integration { completed?(event: CompletedJob): Promise<void>; sessionImage?: ConstructorParameters<typeof JobInputs>[2] }
const engines = new Map<string, { engine: JobEngine; refs: number }>()
const idSchema: MemoryJsonValue = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } }
const planSchema: MemoryJsonValue = { type: 'object', additionalProperties: false, required: ['id', 'plan'], properties: { id: { type: 'string' }, plan: { type: 'object', additionalProperties: true } } }

export function createAgentJobsSource(config: Config = {}, integration: Integration = {}): MemorySourceDefinition {
  validateJobConfig(config)
  const base = createRecordSource({ context: {"mode":"routed","weight":1} satisfies import('dsh-mnemon/contracts').MemoryContextProfile, typeId: 'agent-jobs', role: 'agent-jobs', label: 'Background jobs', description: 'Approved project jobs and their execution history.', kinds: ['job'], scopes: ['project'], defaultScope: 'project',
    prepare(record, scope) {
      const data = record.data
      record.data = { adapter: String(data.adapter ?? ''), model: String(data.model ?? ''), attachments: data.attachments ?? [], assets: [], contextSnapshots: [], context: data.context ?? '', status: 'draft', ownerSessionId: scope.sessionId ?? '', notify: data.notify ?? true }
    },
    validate(record) {
      if (!config.adapters?.some(adapter => adapter.id === record.data.adapter)) throw new Error('Choose a configured CLI adapter')
      if (record.content.length > 30_000 || typeof record.data.context !== 'string' || record.data.context.length > 10_000 || typeof record.data.model !== 'string' || !Array.isArray(record.data.attachments) || record.data.attachments.length > 8) throw new Error('Invalid prompt, model, context or attachments')
      contextCaptures(record.data.contextSnapshots)
    },
    project(records) { return `Background jobs: ${records.filter(record => ['running', 'queued'].includes(String(record.data.status))).length} active, ${records.filter(record => terminalStates.includes(String(record.data.status))).length} finished. Read status and logs on demand. Preview a concrete execution plan before requesting external execution.` },
    modelActions: [{ operation: {"effects":["coordinate"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'cancel-job', description: 'Request cancellation of an owned queued/running job from this View.', capability: 'write', inputSchema: idSchema }],
    mutate(operation, input, { records, scope }) {
      const record = records.find(record => record.id === input.id && visibleRecord(record, scope))
      if (!record) throw new Error('Job is outside this project')
      if (operation === 'cancel-job') {
        if (!['queued', 'running'].includes(String(record.data.status))) throw new Error('Job is not running')
        reviseRecord(record, 'cancel-requested'); record.data.cancelRequested = true; return
      }
      if (operation !== 'retry-job' || !terminalStates.includes(String(record.data.status))) throw new Error('Only finished jobs can be copied for retry or resume')
      const now = new Date().toISOString()
      const data = { adapter: record.data.adapter!, model: record.data.model!, attachments: structuredClone(record.data.attachments!), assets: structuredClone(record.data.assets ?? []), contextSnapshots: structuredClone(record.data.contextSnapshots ?? []), context: record.data.context!, status: 'draft', ownerSessionId: scope.sessionId ?? '', notify: record.data.notify ?? true, previousJobId: record.id,
        ...(input.resume === true ? { resumeSessionId: memoryInputText(record.data.externalSessionId, 'external session id', 200)! } : {}) }
      records.push({ ...structuredClone(record), id: randomUUID(), title: record.title.slice(0, 280) + ' · retry', data, state: 'active', version: 1, signals: 1, createdAt: now, updatedAt: now, history: [] })
    },
  }, config)
  const manifest = { ...base.manifest, capabilities: base.manifest.capabilities.filter(capability => capability !== 'import'), actions: [...base.manifest.actions ?? [], { operation: {"effects":["execute"],"execution":"deferred","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'run-job', description: 'Start an approved draft using the exact displayed execution plan. The plan includes command, argv, workspace, prompt and attachments.', capability: 'write' as const, authority: 'process-execution', inputSchema: planSchema }] }
  return { manifest: { ...manifest, management: { ...base.manifest.management!, operations: {
    reads: [...base.manifest.management!.operations!.reads,
      { id: 'execution-plan', description: 'Inspect the exact command, inputs, workspace and version before starting a job.', access: { kinds: ['read'], result: 'records' } },
      { id: 'lookup-job-log', description: 'Observe the persisted execution log and outcome.', access: { kinds: ['observe'], result: 'execution' } },
    ],
    actions: [...base.manifest.management!.operations!.actions,
      { id: 'start-job', description: 'Start the reviewed plan and track its execution identity through completion.', requiresApproval: true, operation: { effects: ['execute'], execution: 'deferred' } },
      { id: 'stop-job', description: 'Cancel this owned job and retain its outcome.', requiresApproval: true, operation: { effects: ['coordinate'], execution: 'immediate' } },
    ],
  } }, consistency: 'namespace-pinned-live-read', routes: [
    { access: {"kinds":["read"],"result":"records"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'job-plan', description: 'Preview an approved job as a concrete JSON execution plan; oversized plans require the management page.', capability: 'recall', inputSchema: idSchema, maxCalls: 4, maxResults: 1, maxCharacters: 12_000 },
    { access: {"kinds":["observe"],"result":"text"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'job-log', description: 'Read the recent log output for one project job.', capability: 'recall', inputSchema: idSchema, maxCalls: 8, maxResults: 1, maxCharacters: 12_000 }, ...base.manifest.routes ?? [],
  ] }, create(context) {
    const directory = sourceRecordDirectory('agent-jobs', context, config), key = digest([directory, config])
    let entry = engines.get(key)
    if (!entry) { entry = { refs: 0, engine: new JobEngine(directory, config, async (record, scope) => { await integration.completed?.({ sourceInstanceKey: context.sourceInstanceKey, record, scope }) }, integration.sessionImage) }; engines.set(key, entry) }
    entry.refs++
    const engine = entry.engine
    const wrapped = withLookupRoutes({ ...base, manifest }, {
      routes: [
        { access: {"kinds":["read"],"result":"records"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'job-plan', description: 'Preview a concrete execution plan.', capability: 'recall', inputSchema: idSchema, maxCalls: 4, maxResults: 1, maxCharacters: 12_000 },
        { access: {"kinds":["observe"],"result":"text"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'job-log', description: 'Read a job log.', capability: 'recall', inputSchema: idSchema, maxCalls: 8, maxResults: 1, maxCharacters: 12_000 },
      ],
      async namespace(scope) { return { workspaceId: scope.workspaceId ?? null, adapterDigest: digest(config.adapters ?? []) } },
      async run(operation, input, namespace, scope): Promise<LookupResult> {
        const grant = memoryInputRecord(namespace, 'job namespace')
        if (grant.workspaceId !== (scope.workspaceId ?? null) || grant.adapterDigest !== digest(config.adapters ?? [])) throw new Error('The job namespace changed')
        const id = memoryInputText(input.id, 'id', 100)!
        if (operation === 'job-log') {
          const text = await engine.log(id, scope), record = (await engine.store.read()).records.find(record => record.id === id && visibleRecord(record, scope))
          if (!record) throw new Error('Job is unavailable in this scope')
          const execution = record.data.status === 'draft' ? undefined : createMemoryExecutionResult(id, String(record.data.status), typeof record.data.exitCode === 'number' ? record.data.exitCode : undefined)
          return { items: [{ id, text, reference: { id, revision: String(record.version) }, ...(execution ? { execution } : {}), provenance: { kind: 'process-log', jobId: id } }] }
        }
        const record = (await engine.store.read()).records.find(record => record.id === id && visibleRecord(record, scope) && record.state === 'active')
        if (!record) throw new Error('An approved project job is required')
        const plan = await preparePlan(record, scope, config, engine.inputs), text = JSON.stringify(plan, null, 2)
        return { items: [{ id, text: text.length <= 11_000 ? text : 'This plan exceeds the model review budget. Review and start it in the Background jobs page.', provenance: { kind: 'execution-plan', jobId: id } }], truncated: text.length > 11_000 }
      },
    }).create(context)
    const snapshot = (request: MemorySourceManagementRequest) => wrapped.manage!({ ...request, operation: 'snapshot', mode: 'read', input: {} })
    return { ...wrapped,
      async facts(request, signal) { await engine.ready; const facts = await wrapped.facts(request, signal); return { ...facts, capabilities: facts.capabilities.filter(capability => capability !== 'import'), actionIds: [...facts.actionIds, 'run-job'] } },
      async manage(request) {
        await engine.ready
        if (request.mode === 'mutate' && request.operation === 'import') throw new Error('Execution records cannot be imported; create a new draft request')
        if (request.mode === 'read' && request.operation === 'statistics') return { revision: (await engine.store.read()).revision, value: json(await engine.statistics(request.scope)) }
        if (request.mode === 'read' && request.operation === 'job-asset') {
          const input = memoryInputRecord(request.input, 'job image'), record = (await engine.store.read()).records.find(record => record.id === input.id && visibleRecord(record, request.scope))
          const reference = record && engine.inputs.references(record).find(asset => asset.id === input.assetId)
          if (!reference) throw new Error('Image does not belong to this project job')
          return { revision: (await engine.store.read()).revision, value: json({ ...reference, base64: (await engine.inputs.assets.read(reference, request.signal)).toString('base64') }) }
        }
        if (request.mode === 'mutate' && ['set-job-inputs', 'prune-jobs'].includes(request.operation)) {
          if (!request.confirmed || !request.expectedRevision) throw new Error('Confirm the current job input or cleanup selection')
          if (request.operation === 'prune-jobs') { await engine.prune(request.scope, request.expectedRevision, request.signal); return snapshot(request) }
          const input = memoryInputRecord(request.input, 'job inputs'), before = await engine.store.read(request.signal)
          if (before.revision !== request.expectedRevision) throw new Error('The job list changed; refresh before copying inputs')
          const selected = before.records.find(record => record.id === input.id && visibleRecord(record, request.scope))
          if (!selected || selected.data.status !== 'draft') throw new Error('Only a draft accepts new input snapshots')
          const captures = contextCaptures(input.contextSnapshots), keep = input.keepAssetIds ?? []
          if (!Array.isArray(keep) || keep.some(id => typeof id !== 'string' || !engine.inputs.references(selected).some(asset => asset.id === id))) throw new Error('Retained images must belong to this job')
          const copied = await engine.inputs.copy(input.images ?? [], request.scope, request.signal)
          const assets = [...new Map([...engine.inputs.references(selected).filter(asset => keep.includes(asset.id)), ...copied].map(asset => [asset.id, asset])).values()]
          if (assets.length > 8 || assets.reduce((total, asset) => total + asset.bytes, 0) > 20 * 1024 * 1024) throw new Error('Too many retained images')
          await engine.store.change(request.expectedRevision, records => { const record = records.find(record => record.id === selected.id)!; reviseRecord(record, 'inputs-captured'); record.data.assets = json(assets); record.data.contextSnapshots = json(captures); record.data.attachments = [] }, request.signal)
          return snapshot(request)
        }
        if (request.mode === 'mutate' && ['update', 'approve'].includes(request.operation)) {
          const input = memoryInputRecord(request.input, 'job update'), record = (await engine.store.read()).records.find(record => record.id === input.id && visibleRecord(record, request.scope))
          if (!record || record.data.status !== 'draft') throw new Error('Execution records are immutable after queueing; copy the job to retry')
          if (input.data !== undefined) {
            const data = memoryInputRecord(input.data, 'job fields'), editable = new Set(['adapter', 'model', 'attachments', 'context', 'notify'])
            for (const [key, value] of Object.entries(data)) if (!editable.has(key) && digest(value) !== digest(record.data[key])) throw new Error('Execution metadata cannot be edited')
            return wrapped.manage!({ ...request, input: { ...input, data: { ...record.data, ...data } } })
          }
        }
        if (request.mode === 'read' && request.operation === 'adapters') return { revision: (await snapshot(request)).revision, value: json((config.adapters ?? []).map(adapter => ({ id: adapter.id, label: adapter.label, models: adapter.models ?? [], supportsImages: adapter.supportsImages === true, resumable: !!adapter.resumeArgs }))) }
        if (request.mode === 'read' && request.operation === 'execution-plan') {
          const input = memoryInputRecord(request.input, 'job plan'), record = (await engine.store.read()).records.find(record => record.id === input.id && visibleRecord(record, request.scope) && record.state === 'active')
          if (!record) throw new Error('An approved job is required')
          return { revision: (await snapshot(request)).revision, value: json(await preparePlan(record, request.scope, config, engine.inputs)) }
        }
        if (request.mode === 'mutate' && ['start-job', 'stop-job'].includes(request.operation)) {
          if (!request.confirmed || request.expectedRevision === undefined) throw new Error('Confirm the current execution plan before starting')
          const input = memoryInputRecord(request.input, 'job control'), id = memoryInputText(input.id, 'id', 100)!
          if (request.operation === 'start-job') await engine.enqueue(id, input.plan as unknown as ExecutionPlan, request.scope, request.expectedRevision, request.signal)
          else await engine.cancel(id, request.scope, request.expectedRevision, request.signal)
          return snapshot(request)
        }
        return wrapped.manage!(request)
      },
      async mutate(request) {
        if (request.offer.sourceActionId !== 'run-job') return wrapped.mutate!(request)
        if (request.offer.authority !== 'process-execution') throw new Error('External execution authority is required')
        const input = memoryInputRecord(request.input, 'job execution'), id = memoryInputText(input.id, 'id', 100)!
        await engine.enqueue(id, input.plan as unknown as ExecutionPlan, request.view.scope, undefined, request.signal)
        const current = await engine.store.read(), record = current.records.find(record => record.id === id)!
        const execution = createMemoryExecutionResult(id, String(record.data.status), typeof record.data.exitCode === 'number' ? record.data.exitCode : undefined)
        return { ...createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, current.revision, { jobId: id, state: execution.state, message: 'Accepted by the background runner. Read its status and logs for the final outcome.' }, 'accepted'), execution }
      },
      async dispose() { await wrapped.dispose?.(); entry!.refs--; if (entry!.refs === 0) { engines.delete(key); await engine.dispose() } },
    }
  } }
}
export function apply(ctx: Context, config: Config = {}): void {
  const adapter = new DshWorkspaceAdapter({ agentPresets: ctx.agentPresets, sessionQuery: ctx.sessionQuery, agents: ctx.agents, workspaceRegistry: ctx.workspaceRegistry, attachments: ctx.attachments })
  installMemory(ctx, { plugin: memoryPlugin, sources: [createAgentJobsSource(config, { sessionImage: (id, scope, signal) => adapter.readSessionImage(id, scope, signal), async completed(event) {
    ctx.emit('mnemon-jobs/completed', event)
    const status = String(event.record.data.status), exitCode = typeof event.record.data.exitCode === 'number' ? event.record.data.exitCode : undefined
    ctx.emit('mnemon-workspace/activity', { eventKey: event.record.id + '/completed', sourceInstanceKey: event.sourceInstanceKey, scope: event.scope, kind: 'job-completed', title: 'Background job: ' + event.record.title.slice(0, 280), summary: `Status: ${status}${exitCode === undefined ? '' : ' · exit ' + exitCode}\n` + String(event.record.data.output || event.record.data.error || '').slice(-5900), level: status === 'succeeded' ? 'info' : 'warning', recordId: event.record.id, status, ...(exitCode === undefined ? {} : { exitCode }) })
    if (config.notifyOwner !== false && event.record.data.notify !== false && typeof event.record.data.ownerSessionId === 'string' && event.record.data.ownerSessionId) {
      await adapter.deliver(event.record.data.ownerSessionId, `Background job ${event.record.title} (${event.record.id}) ${String(event.record.data.status)}.\n${String(event.record.data.output ?? event.record.data.error ?? '').slice(-6000)}`, event.scope, { plugin: name })
    }
  } })] }, { effectiveDigest: memoryConfigurationDigest(config) })
}
