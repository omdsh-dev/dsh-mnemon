import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createMemoryMutationReceipt } from 'dsh-mnemon/extension-sdk'
import { RecordStore, sourceRecordDirectory, visibleRecord } from 'dsh-mnemon/source-sdk'
import { modelCatalog } from './catalog.ts'
import { sessionActions, sessionOperation } from './operations.ts'
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import type { MemoryJsonValue, MemorySourceDefinition } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest, memoryInputInteger, memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { allowedDirectories, createRecordSource, digest, json, withLookupRoutes, type LookupResult, type RecordSourceConfig } from 'dsh-mnemon/source-sdk'
import { DshWorkspaceAdapter, type VisibleMessage } from 'dsh-mnemon-workspace-kit/dsh'
import { importedSessions } from './imported.ts'

export const name = 'dsh-mnemon-source-sessions'
export const inject = ['mnemonMemory', 'agentPresets', 'sessionQuery', 'agents', 'workspaceRegistry', 'llm', 'sessionTitle']
export interface Config extends RecordSourceConfig { historyRoots?: string[]; rgPath?: string }
export const Config = z.object({ dataDir: z.string(), historyRoots: z.array(z.string()).default([]), rgPath: z.string().default('') }) as z<Config>
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Conversations', 'zh-CN': '会话资料' }, description: { en: 'Visible conversation search, bookmarks and explicit session actions.', 'zh-CN': '可见对话检索、轮次书签和会话操作。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.session-history' }] })
const queryProperties = { query: { type: 'string', maxLength: 1000 }, sessionId: { type: 'string' }, origin: { type: 'string', enum: ['all', 'native', 'imported'] }, sort: { type: 'string', enum: ['relevance', 'newest', 'oldest'] }, limit: { type: 'integer', minimum: 1, maximum: 100 }, active: { type: 'boolean' }, requestId: { type: 'string' } }
export function createSessionsSource(config: Config = {}, adapter?: DshWorkspaceAdapter, llm?: LlmRuntime): MemorySourceDefinition {
  const base = createRecordSource({ context: {"mode":"routed","weight":1} satisfies import('dsh-mnemon/contracts').MemoryContextProfile, typeId: 'sessions', role: 'session-history', label: 'Conversation bookmarks', description: 'Scoped conversation references and aliases.', kinds: ['bookmark', 'alias'], scopes: ['project'], defaultScope: 'project',
    validate(record) {
      if (typeof record.data.sessionId !== 'string' || !record.data.sessionId || record.data.sessionId.length > 200) throw new Error('A conversation id is required')
      if (record.kind === 'bookmark' && (!Number.isSafeInteger(record.data.seq) || Number(record.data.seq) < 0)) throw new Error('A valid conversation sequence is required')
    }, project() { return 'Conversation history is read-only and available on demand. Retrieve visible user/assistant messages or scoped bookmarks; use the offered session actions for authorized ordinary conversations. Use models and presets routes to discover native options.' },
  }, config)
  const source = withLookupRoutes(base, {
    routes: [
      { access: {"kinds":["read"],"result":"records"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'session-info', description: 'Read current or selected workspace conversation identity, title, preset, model, status and activity timestamp.', capability: 'status', inputSchema: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string' } } }, maxCalls: 4, maxResults: 1, maxCharacters: 4000 },
      { access: {"kinds":["browse"],"result":"records"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'models', description: 'Read native model names, descriptions and image capability. Exact provider/model queries also report reasoning efforts and context capacity; null means unknown. The catalog is advisory, not an enablement list.', capability: 'status', inputSchema: { type: 'object', additionalProperties: false, properties: { provider: { type: 'string' }, model: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } }, maxCalls: 4, maxResults: 30, maxCharacters: 14000 },
      { access: {"kinds":["browse"],"result":"records"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'presets', description: 'Discover native agent presets before creating a normal conversation.', capability: 'status', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, maxCalls: 2, maxResults: 30, maxCharacters: 8000 },
      { access: {"kinds":["search"],"result":"events"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'history', description: 'Search visible user and assistant messages within this workspace, including configured JSONL imports. Never returns thoughts or tool internals.', capability: 'recall', inputSchema: { type: 'object', additionalProperties: false, properties: queryProperties }, maxCalls: 6, maxResults: 20, maxCharacters: 14_000 },
      { access: {"kinds":["read"],"result":"events"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'conversation', description: 'Read visible neighboring messages or completed turns in a workspace conversation.', capability: 'recall', inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: { type: 'string' }, seq: { type: 'integer', minimum: 0 }, radius: { type: 'integer', minimum: 0, maximum: 10 }, turns: { type: 'boolean' }, requestId: { type: 'string' } } }, maxCalls: 6, maxResults: 21, maxCharacters: 16_000 },
      { access: {"kinds":["browse"],"result":"records"} satisfies import('dsh-mnemon/contracts').MemoryAccessSemantics, id: 'list-sessions', description: 'List sessions in the current workspace and their live status.', capability: 'status', inputSchema: { type: 'object', additionalProperties: false, properties: { active: { type: 'boolean' }, requestId: { type: 'string' } } }, maxCalls: 3, maxResults: 30, maxCharacters: 6000 },
    ],
    async namespace(scope) { return { workspaceId: scope.workspaceId ?? null, historyRoots: await allowedDirectories(config.historyRoots ?? []) } },
    async run(operation, input, namespace, scope, signal): Promise<LookupResult> {
      const pinned = memoryInputRecord(namespace, 'history namespace')
      if (pinned.workspaceId !== (scope.workspaceId ?? null)) throw new Error('Conversation namespace changed')
      if (operation === 'session-info') {
        if (!adapter) throw new Error('The DSH session adapter is unavailable')
        const id = memoryInputText(input.sessionId ?? scope.sessionId, 'sessionId', 200)!
        const info = await adapter.describe(id, scope, signal)
        return { items: [{ id, text: JSON.stringify(info, null, 2), provenance: json(info) }] }
      }
      if (operation === 'models') return modelCatalog(llm, input, signal)
      if (operation === 'presets') {
        if (!adapter?.services.agentPresets) throw new Error('The native agent preset catalog is unavailable')
        const roster = await adapter.services.agentPresets.remoteExportList()
        return { items: [{ id: 'presets', text: JSON.stringify(roster, null, 2), provenance: json(roster) }] }
      }
      if (operation === 'conversation' && adapter && input.turns !== true && typeof input.sessionId === 'string' && !input.sessionId.startsWith('imported-')) {
        const window = await adapter.conversationWindow(input.sessionId, scope, input.seq === undefined ? undefined : memoryInputInteger(input.seq, 0, 0, Number.MAX_SAFE_INTEGER), memoryInputInteger(input.radius, 3, 0, 10), signal)
        return { items: window.messages.map(message => ({ id: input.sessionId + '/' + message.seq, text: message.text, provenance: json({ sessionId: input.sessionId, ...message, target: message.seq === window.targetSeq, throughSeq: window.throughSeq, turn: window.turn }) })), truncated: window.truncated }
      }
      const sessions = adapter ? await adapter.list(scope, signal) : []
      if (operation === 'list-sessions') {
        const selected = sessions.filter(session => !input.active || session.live)
        return { items: selected.slice(0, 100).map(session => ({ id: session.id, text: `${session.id}\n${session.status} · ${session.createdAt}${session.parentId ? '\nParent: ' + session.parentId : ''}`, provenance: json({ sessionId: session.id, at: session.createdAt, status: session.status }) })), truncated: selected.length > 100 }
      }
      const origin = input.origin ?? 'all'
      if (!['all', 'native', 'imported'].includes(String(origin))) throw new Error('Unsupported history origin')
      const id = memoryInputText(input.sessionId, 'sessionId', 200, false)
      const imported = origin !== 'native' ? await importedSessions(pinned.historyRoots as string[], scope.workspaceId, signal, config.rgPath) : { sessions: [], truncated: false }
      const corpus: Array<{ id: string; messages: VisibleMessage[]; path?: string; turns?: Array<{ turn: number; seq: number }> }> = imported.sessions.map(session => ({ id: session.id, messages: session.messages, path: session.path }))
      let truncated = imported.truncated
      if (origin !== 'imported' && adapter) {
        const native = sessions.filter(session => (!id || session.id === id) && (!input.active || session.live))
        truncated ||= native.length > 100
        for (const session of native.slice(0, 100)) {
          signal.throwIfAborted()
          const transcript = await adapter.transcript(session.id, scope, signal)
          corpus.push({ id: session.id, messages: transcript.messages, turns: transcript.turns })
          truncated ||= transcript.truncated
        }
      }
      if (operation === 'conversation') {
        const session = corpus.find(session => session.id === id)
        if (!session) throw new Error('Conversation is not available in this workspace')
        if (input.turns === true) return { items: (session.turns ?? []).slice(-100).map(turn => ({ id: `${session.id}/${turn.seq}`, text: `Turn ${turn.turn} · sequence ${turn.seq}`, provenance: { sessionId: session.id, seq: turn.seq, turn: turn.turn } })), truncated: (session.turns?.length ?? 0) > 100 }
        const seq = memoryInputInteger(input.seq, session.messages[0]?.seq ?? 0, 0, Number.MAX_SAFE_INTEGER)
        const index = session.messages.findIndex(message => message.seq === seq)
        if (index < 0) throw new Error('The exact visible message is no longer available')
        const radius = memoryInputInteger(input.radius, 3, 0, 10)
        const selected = index < 0 ? [] : session.messages.slice(Math.max(0, index - radius), index + radius + 1)
        return { items: selected.map(message => ({ id: `${session.id}/${message.seq}`, text: message.text, provenance: json({ sessionId: session.id, seq: message.seq, role: message.role, at: message.at, path: session.path }) })), truncated: truncated || selected.length < session.messages.length }
      }
      const term = (memoryInputText(input.query, 'query', 1000, false) ?? '').toLocaleLowerCase()
      const hits = corpus.filter(session => !id || session.id === id).flatMap(session => session.messages.flatMap(message => {
        const lower = message.text.toLocaleLowerCase(), position = term ? lower.indexOf(term) : 0
        if (position < 0) return []
        return [{ session, message, position, score: term ? lower.split(term).length - 1 : 0 }]
      }))
      if (input.sort !== undefined && !['relevance', 'newest', 'oldest'].includes(String(input.sort))) throw new Error('Unsupported history sort')
      hits.sort((a, b) => input.sort === 'oldest' ? a.message.at.localeCompare(b.message.at) : input.sort === 'newest' ? b.message.at.localeCompare(a.message.at) : b.score - a.score || b.message.at.localeCompare(a.message.at))
      const limit = memoryInputInteger(input.limit, 30, 1, 100)
      return { items: hits.slice(0, limit).map(({ session, message, position }) => ({ id: digest([session.id, message.seq]), text: message.text.slice(Math.max(0, position - 120), Math.max(0, position - 120) + 1500), provenance: json({ sessionId: session.id, seq: message.seq, role: message.role, at: message.at, path: session.path, excerpt: message.text.length > 1500 }) })), truncated: truncated || hits.length > limit }
    },
  })
  return { ...source, manifest: { ...source.manifest, actions: [...source.manifest.actions ?? [], ...sessionActions] }, create(context) {
    const runtime = source.create(context), operations = new RecordStore(join(sourceRecordDirectory('sessions', context, config), 'operations'))
    return { ...runtime,
      async facts(request, signal) { const value = await runtime.facts(request, signal); return { ...value, actionIds: [...value.actionIds, ...sessionActions.map(action => action.id)] } },
      async mutate(request) {
        const action = sessionActions.find(action => action.id === request.offer.sourceActionId)
        if (!action) return runtime.mutate!(request)
        if (request.offer.authority !== action.authority) throw new Error('Explicit native session authority is required')
        const value = await sessionOperation(operations, adapter, action.id, request.input, request.view.scope, request.signal)
        return createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, (await operations.read()).revision, value, 'committed')
      },
      async manage(request) {
        if (request.mode === 'read' && request.operation === 'session-operation-history') {
          const snapshot = await operations.read(request.signal)
          return { revision: snapshot.revision, value: { items: snapshot.records.filter(record => visibleRecord(record, request.scope) && record.data.initiator === (request.scope.sessionId ?? '')).slice(-50).reverse().map(record => ({ id: record.id, text: JSON.stringify(record.data, null, 2), provenance: record.data })) } }
        }
        if (!sessionActions.some(action => action.id === request.operation)) return runtime.manage!(request)
        if (request.mode !== 'mutate' || !request.confirmed || request.expectedRevision === undefined) throw new Error('A confirmed session operation is required')
        const current = await runtime.manage!({ ...request, mode: 'read', operation: 'snapshot', input: {} })
        if (current.revision !== request.expectedRevision) throw new Error('Conversation records changed; refresh before continuing')
        const input = memoryInputRecord(request.input, 'session operation')
        const receipt = await sessionOperation(operations, adapter, request.operation, { ...input, requestId: input.requestId ?? randomUUID() }, request.scope, request.signal)
        return { revision: current.revision, value: { items: [{ id: 'session-operation', text: JSON.stringify(receipt, null, 2), provenance: receipt }] } }
      },
    }
  } }
}
export function apply(ctx: Context, config: Config = {}): void { installMemory(ctx, { plugin: memoryPlugin, sources: [createSessionsSource(config, new DshWorkspaceAdapter({ agentPresets: ctx.agentPresets, sessionTitle: ctx.sessionTitle, sessionQuery: ctx.sessionQuery, agents: ctx.agents, workspaceRegistry: ctx.workspaceRegistry }), ctx.llm)] }, { effectiveDigest: memoryConfigurationDigest(config) }) }
