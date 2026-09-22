import { SessionId } from '@deepseek-ai/dsh-session'
import { promptActions, promptOperation } from './actions.ts'
import { libraryFields } from './library.ts'
import { createMemoryMutationReceipt } from 'dsh-mnemon/extension-sdk'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { archiveSkillFile, createSkillFile, listSkillFiles, readSkillFile, saveSkillFile } from './files.ts'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import z from 'schemastery'
import type { MemoryJsonValue, MemorySourceDefinition, MemorySourceRuntime } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest, memoryInputRecord } from 'dsh-mnemon/extension-sdk'
import { allowedDirectories, createRecordSource, digest, json, RecordStore, reviseRecord, sourceRecordDirectory, visibleRecord, type RecordSourceConfig } from 'dsh-mnemon/source-sdk'
import { agentMemoryScope, DshWorkspaceAdapter, installAgentHooks } from 'dsh-mnemon-workspace-kit/dsh'
import { sourceOptions } from './source.ts'
import { advanceSchedules, makeSchedule, renderPrompt } from './schedule.ts'
import { skillActions, skillRoutes, withSkillLifecycle, type SkillIntegration } from './skill-source.ts'
import { skillBundle, type SkillStore } from './skill-store.ts'
import type { SkillCatalog } from './skill-catalog.ts'
import { verifySkillFiles } from './skill-bundle.ts'
import { nativeSkillPorts } from './skill-dsh.ts'
import { join } from 'node:path'
export const name = 'dsh-mnemon-source-playbooks'
export const inject = ['mnemonMemory', 'agentPresets', 'agents', 'sessionQuery', 'workspaceRegistry', 'skills', 'llm', 'tools']
export interface Config extends RecordSourceConfig { providerName?: string; skillDirectories?: string[] }
export const Config = z.object({ dataDir: z.string(), providerName: z.string().default('workspace-playbooks'), skillDirectories: z.array(z.string()).default([]) }) as z<Config>
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Playbooks', 'zh-CN': '工作方法' }, description: { en: 'Reviewed native skills, reusable prompts and explicit session schedules.', 'zh-CN': '原生技能的生成、审核与发布，可复用提示词及会话调度。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.instruction-library' }, { id: 'source.skill-lifecycle' }] })
interface Integration extends SkillIntegration { attach?(store: RecordStore): void }
export function createPlaybooksSource(config: Config = {}, integration: Integration = {}): MemorySourceDefinition {
  const base = createRecordSource(sourceOptions, config)
  return { ...base, manifest: { ...base.manifest, management: { ...base.manifest.management!, operations: { reads: [...base.manifest.management?.operations?.reads ?? [], { id: 'skills-native-read', description: 'Read native skill resources and their exact version.', access: { kinds: ['read', 'browse'], result: 'resources' } }], actions: [...base.manifest.management?.operations?.actions ?? [], { id: 'skills-validate', description: 'Run the reviewed validation command against a candidate bundle.', requiresApproval: true, operation: { effects: ['execute'], execution: 'immediate' } }, { id: 'skills-publish', description: 'Publish a validated candidate as an enabled native skill version.', requiresApproval: true, operation: { effects: ['publish'], execution: 'immediate' } }, { id: 'skills-feedback', description: 'Attach human feedback to one exact skill version.', requiresApproval: true, operation: { effects: ['feedback'], execution: 'immediate' } }] } }, routes: [...(base.manifest.routes ?? []).map(route => ({ ...route, inputSchema: { ...(route.inputSchema as object), properties: { ...((route.inputSchema as { properties: object }).properties), ...libraryFields } } })), ...skillRoutes], actions: [...base.manifest.actions ?? [], ...promptActions, ...skillActions] }, create(context) {
    const runtime = base.create(context), store = new RecordStore(sourceRecordDirectory('playbooks', context, config))
    integration.attach?.(store)
    const stop = integration.ctx ? installAgentHooks(integration.ctx, { async beforeStep(input) {
      if (input.step !== 1 || !input.messages.some(message => message.source.kind === 'user')) return []
      const due = await advanceSchedules(store, agentMemoryScope(input.agent), input.turn, input.signal)
      if (due.length) integration.changed?.()
      return due.map(prompt => createUserMessage({ content: [{ type: 'text', text: `Scheduled prompt: ${prompt.title}\nInvocation: ${prompt.id}\n\n${prompt.text}` }], source: { kind: 'plugin', plugin: name, form: 'instructions' } }))
    } }) : undefined
    const enhanced: MemorySourceRuntime = { ...runtime,
      async facts(request, signal) { const value = await runtime.facts(request, signal); return { ...value, actionIds: [...value.actionIds, ...promptActions.map(action => action.id)] } },
      async manage(request) {
        if (request.mode === 'read' && ['native-skills', 'native-skill'].includes(request.operation)) {
          if (!integration.ctx) throw new Error('The native skill registry is unavailable')
          const input = memoryInputRecord(request.input ?? {}, 'native skill lookup'), lookup = { cwd: request.scope.workspaceId, signal: request.signal }
          const providerName = config.providerName ?? 'workspace-playbooks', snapshot = await store.read(request.signal)
          if (request.operation === 'native-skills') {
            const skills = (await integration.ctx.skills.list(lookup)).filter(skill => skill.provider === providerName).slice(0, 300)
            return { revision: snapshot.revision, value: json(skills.map(skill => ({ name: skill.name, description: skill.description.slice(0, 1000), provider: skill.provider }))) }
          }
          const skill = await integration.ctx.skills.get(String(input.name ?? ''), lookup)
          if (!skill || skill.provider !== providerName) throw new Error('The skill is not enabled in this Source and workspace')
          return { revision: snapshot.revision, value: { name: skill.name, content: skill.content.slice(0, 50000), truncated: skill.content.length > 50000 } }
        }
        if (['skill-roots', 'skill-files', 'skill-file', 'save-skill-file', 'create-skill-file', 'archive-skill-file'].includes(request.operation)) {
          const input = memoryInputRecord(request.input ?? {}, 'skill file operation'), snapshot = await store.read(request.signal)
          if (['save-skill-file', 'create-skill-file', 'archive-skill-file'].includes(request.operation)) {
            if (request.mode !== 'mutate' || !request.confirmed || request.expectedRevision !== snapshot.revision) throw new Error('Confirm the current skill file edit')
            const roots = config.skillDirectories ?? []
            const result = request.operation === 'create-skill-file'
              ? await createSkillFile(roots, String(input.root ?? ''), String(input.name ?? ''), String(input.content ?? ''), request.signal)
              : request.operation === 'archive-skill-file'
                ? await archiveSkillFile(roots, String(input.path ?? ''), String(input.digest ?? ''), request.signal)
                : await saveSkillFile(roots, String(input.path ?? ''), String(input.content ?? ''), String(input.digest ?? ''), request.signal)
            integration.changed?.(); return { revision: snapshot.revision, value: json(result) }
          }
          if (request.mode !== 'read') throw new Error('Skill browsing is read-only')
          if (request.operation === 'skill-roots') return { revision: snapshot.revision, value: json(await allowedDirectories(config.skillDirectories ?? [])) }
          return { revision: snapshot.revision, value: json(request.operation === 'skill-files' ? await listSkillFiles(config.skillDirectories ?? [], request.signal) : await readSkillFile(config.skillDirectories ?? [], String(input.path ?? ''), request.signal)) }
        }
        if (request.mode === 'read' && request.operation === 'prompt-preview') {
          const input = memoryInputRecord(request.input, 'prompt preview'), snapshot = await store.read(request.signal), book = snapshot.records.find(record => record.id === input.id && visibleRecord(record, request.scope) && record.state === 'active')
          if (!book || book.data.enabled === false) throw new Error('Choose an enabled, approved playbook')
          const variables = typeof input.variables === 'string' ? memoryInputRecord(JSON.parse(input.variables || '{}'), 'prompt variables') : memoryInputRecord(input.variables ?? {}, 'prompt variables')
          return { revision: snapshot.revision, value: { text: renderPrompt(book.content, variables, request.scope), version: book.version } }
        }
        if (request.mode === 'mutate' && ['schedule', 'use-now', 'stop-schedule'].includes(request.operation)) {
          if (!request.confirmed || request.expectedRevision === undefined) throw new Error('Confirm the current playbook before using it')
          const input = memoryInputRecord(request.input, 'playbook invocation')
          let invoked: ReturnType<typeof makeSchedule> | undefined
          await store.change(request.expectedRevision, records => {
            const record = records.find(record => record.id === input.id && visibleRecord(record, request.scope))
            if (!record || input.version !== undefined && record.version !== input.version) throw new Error('Playbook version changed')
            if (request.operation === 'stop-schedule') { if (record.kind !== 'schedule') throw new Error('Choose a schedule'); reviseRecord(record, 'stop'); record.data.status = 'stopped'; return }
            const variables = typeof input.variables === 'string' ? memoryInputRecord(JSON.parse(input.variables || '{}'), 'prompt variables') : memoryInputRecord(input.variables ?? {}, 'prompt variables')
            if (request.operation === 'schedule' && records.some(value => value.kind === 'schedule' && visibleRecord(value, request.scope) && value.state === 'active' && value.data.bookId === record.id && ['scheduled', 'delivering'].includes(String(value.data.status)))) throw new Error('This prompt already has an active schedule in this session')
            invoked = makeSchedule(record, request.scope, { variables, count: request.operation === 'use-now' ? 1 : Number(input.count ?? 1), interval: request.operation === 'use-now' ? 1 : Number(input.interval ?? 1), startAfter: request.operation === 'use-now' ? 1 : Number(input.startAfter ?? 1) })
            if (request.operation === 'use-now') { if (!integration.adapter) throw new Error('Live DSH session delivery is unavailable'); invoked.data.status = 'delivering' }
            records.push(invoked)
          }, request.signal)
          if (request.operation === 'use-now' && invoked) {
            try {
              const running = integration.adapter!.services.agents.get(SessionId(request.scope.sessionId!))?.status === 'running'
              await integration.adapter!.deliver(request.scope.sessionId!, `Playbook: ${invoked.title}\nInvocation: ${invoked.id}\n\n${invoked.content}`, request.scope, { plugin: name, wake: input.wake === true && !running, steering: input.wake === true && running, ...(request.signal ? { signal: request.signal } : {}) })
              await store.change(undefined, records => { const invocation = records.find(record => record.id === invoked!.id)!; reviseRecord(invocation, 'delivered'); invocation.data.status = 'completed'; invocation.data.uses = 1; invocation.data.remaining = 0; invocation.data.continuous = false; const book = records.find(record => record.id === invocation.data.bookId); if (book) { reviseRecord(book, 'use'); book.data.uses = Number(book.data.uses ?? 0) + 1 } })
            } catch (error) { await store.change(undefined, records => { const invocation = records.find(record => record.id === invoked!.id)!; reviseRecord(invocation, 'delivery-failed'); invocation.data.status = 'failed'; invocation.data.error = String(error).slice(0, 2000) }); throw error }
          }
          integration.changed?.()
          return runtime.manage!({ ...request, mode: 'read', operation: 'snapshot', input: {} })
        }
        const result = await runtime.manage!(request); if (request.mode === 'mutate') integration.changed?.(); return result
      },
      async mutate(request) {
        const action = promptActions.find(action => action.id === request.offer.sourceActionId)
        if (!action) { const result = await runtime.mutate!(request); integration.changed?.(); return result }
        if (request.offer.authority !== action.authority) throw new Error('Explicit prompt authority is required')
        const input = { ...memoryInputRecord(request.input, 'prompt action') }, snapshot = await store.read(request.signal), operation = promptOperation[action.id as keyof typeof promptOperation]
        if (operation !== 'create') {
          const record = snapshot.records.find(value => value.id === input.id && visibleRecord(value, request.view.scope))
          if (!record || record.version !== input.version) throw new Error('Prompt version changed; read the current record before retrying')
          if (operation === 'update' && record.kind !== 'prompt') throw new Error('Only reusable prompts can be updated through this action')
          if (operation === 'update' && input.data !== undefined) input.data = { ...record.data, ...memoryInputRecord(input.data, 'prompt data') }
        }
        const result = await enhanced.manage!({ sourceInstanceKey: context.sourceInstanceKey, scope: request.view.scope, mode: 'mutate', operation, input: { ...input, ...(operation === 'create' ? { kind: 'prompt' } : {}) }, expectedRevision: snapshot.revision, confirmed: true, ...(request.signal ? { signal: request.signal } : {}) })
        const records = (result.value as unknown as { records: import('dsh-mnemon-workspace-kit').RecordValue[] }).records
        const changed = ['create', 'schedule', 'use-now'].includes(operation) ? records.find(record => !snapshot.records.some(previous => previous.id === record.id)) : records.find(record => record.id === input.id)
        return createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, result.revision, json({ operation, id: changed?.id ?? input.id ?? null, version: changed?.version ?? null, status: changed?.data.status ?? changed?.state ?? null }), 'committed')
      },
      async dispose() { await stop?.(); await runtime.dispose?.() },
    }
    return withSkillLifecycle(enhanced, context, store, config, integration)
  } }
}
export function apply(ctx: Context, config: Config = {}): void {
  let store: RecordStore | undefined, invalidate: (() => void) | undefined, skills: SkillStore | undefined, catalog: SkillCatalog | undefined
  const providerName = config.providerName ?? 'workspace-playbooks'
  ctx.skills.registerProvider(control => {
    let files: Promise<FileSystemSkillProvider> | undefined, rootsDigest = ''
    const fileProvider = async () => {
      const roots = catalog ? await catalog.roots(control.signal) : await allowedDirectories(config.skillDirectories ?? []), nextDigest = digest(roots)
      if (!files || rootsDigest !== nextDigest) { const previous = files; rootsDigest = nextDigest; files = (async () => { await (await previous)?.dispose(); control.signal.throwIfAborted(); return new FileSystemSkillProvider(ctx, control, { providerName, includeDefaultRoots: false, customSkillDirs: roots, watch: false }) })() }
      return files
    }
    ctx.effect(() => async () => { await (await files)?.dispose() }, 'dispose playbook file provider')
    invalidate = control.invalidate
    const list = async (cwd?: string, signal?: AbortSignal) => (await store?.read(signal))?.records.filter(record => record.kind === 'skill' && record.state === 'active' && record.data.enabled === true && visibleRecord(record, { storage: 'custom', ...(cwd ? { workspaceId: cwd } : {}) })) ?? []
    return { name: providerName, async list(options) {
      const observed = await (await fileProvider()).list({ ...options, signal: options.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal })
      const fileCandidates = Array.isArray(observed) ? observed : observed.candidates
      const published = (await skills?.snapshot({ storage: 'custom', ...(options.cwd ? { workspaceId: options.cwd } : {}) }, options.signal))?.records.filter(record => record.kind === 'skill-version' && record.data.directory) ?? []
      const versions = published.filter(record => record.state === 'active').map(record => ({ name: skillBundle(record).name, description: skillBundle(record).description, invocation: { modelInvocable: record.data.enabled !== false, userInvocable: record.data.enabled !== false }, source: 'custom', provider: providerName, rank: record.scope === 'project' ? 240 : 250, locator: { skillVersionId: record.id, digest: record.data.contentDigest }, resourceBase: { kind: 'directory', path: String(record.data.directory) }, path: join(String(record.data.directory), 'SKILL.md'), metadata: { release: record.data.release, digest: record.data.contentDigest } } satisfies SkillCandidate))
      const names = new Set(published.map(record => skillBundle(record).name))
      const records = (await list(options.cwd, options.signal)).filter(record => !names.has(String(record.data.slug))).map(record => ({ name: String(record.data.slug), description: String(record.data.summary || record.title).slice(0, 1000), invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: providerName, rank: 250, locator: { recordId: record.id, version: record.version }, resourceBase: { kind: 'opaque', description: 'Approved playbook ' + record.id } } satisfies SkillCandidate))
      return { candidates: [...versions, ...records, ...fileCandidates.filter(candidate => !names.has(candidate.name))], complete: false }
    }, async get(candidate, options) {
      const locator = candidate.locator as { recordId?: string; version?: number; skillVersionId?: string; digest?: string }
      if (locator.skillVersionId) {
        const record = (await skills?.snapshot({ storage: 'custom', ...(options.cwd ? { workspaceId: options.cwd } : {}) }, options.signal))?.records.find(record => record.id === locator.skillVersionId && record.state === 'active' && record.data.contentDigest === locator.digest)
        if (!record) return
        const bundle = skillBundle(record)
        await verifySkillFiles(String(record.data.directory), bundle, options.signal)
        return { ...candidate, content: record.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '') }
      }
      if (!locator.recordId) return (await fileProvider()).get(candidate, options)
      const record = (await list(options.cwd, options.signal)).find(record => record.id === locator.recordId && record.version === locator.version)
      return record ? { ...candidate, content: record.content } : undefined
    } }
  })
  const adapter = new DshWorkspaceAdapter({ agentPresets: ctx.agentPresets, sessionQuery: ctx.sessionQuery, agents: ctx.agents, workspaceRegistry: ctx.workspaceRegistry })
  installMemory(ctx, { plugin: memoryPlugin, sources: [createPlaybooksSource(config, { ctx, attach(value) { store = value; invalidate?.() }, attachSkills(value, native) { skills = value; catalog = native; invalidate?.() }, changed() { invalidate?.() }, adapter, skillPorts: nativeSkillPorts(ctx, adapter) })] }, { effectiveDigest: memoryConfigurationDigest(config) })
}
export { sourceOptions }
