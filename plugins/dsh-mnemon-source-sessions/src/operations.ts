import { randomUUID } from 'node:crypto'
import type { MemoryJsonValue, MemoryOperationScope, MemorySourceActionManifest } from 'dsh-mnemon/contracts'
import { memoryInputInteger, memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { digest, json, RecordStore, recordScope, visibleRecord, type RecordValue } from 'dsh-mnemon/source-sdk'
import type { DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'

const common = { requestId: { type: 'string', minLength: 1, maxLength: 100 }, sessionId: { type: 'string', maxLength: 200 } }
const create = { preset: { type: 'string', maxLength: 200 }, provider: { type: 'string', maxLength: 200 }, model: { type: 'string', maxLength: 300 }, reasoningEffort: { type: 'string', maxLength: 100 }, text: { type: 'string', maxLength: 100000 }, wake: { type: 'boolean' } }
export const sessionActions: MemorySourceActionManifest[] = [
  { operation: {"effects":["update"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'session-rename', description: 'Rename the selected workspace conversation through the native title service after explicit approval.', capability: 'write', authority: 'session-management', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'sessionId', 'title'], properties: { ...common, title: { type: 'string', minLength: 1, maxLength: 300 } } } },
  { operation: {"effects":["coordinate"],"execution":"immediate"} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'session-create', description: 'Create one ordinary workspace conversation with the specified preset, optional model override and attributed initial message. Explicit wake starts work. Reuse requestId only to inspect the same operation receipt.', capability: 'write', authority: 'session-management', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { ...common, ...create } } },
  { operation: {"effects":["coordinate"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'session-fork', description: 'Fork through one exact completed-turn boundary in this workspace. Read conversation turns first. Preserve the parent preset and model unless explicitly overridden.', capability: 'write', authority: 'session-management', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'sessionId', 'seq'], properties: { ...common, ...create, seq: { type: 'integer', minimum: 0 } } } },
  { operation: {"effects":["deliver"],"execution":"immediate","requiresReadGrant":true} satisfies import('dsh-mnemon/contracts').MemoryOperationSemantics, id: 'session-send', description: 'Deliver the exact displayed message to an ordinary conversation in this workspace, retaining plugin attribution. Wake and steering must be explicitly requested.', capability: 'write', authority: 'session-message', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'sessionId', 'text'], properties: { ...common, text: { type: 'string', minLength: 1, maxLength: 100000 }, wake: { type: 'boolean' }, steering: { type: 'boolean' } } } },
]

/** A durable claim precedes native side effects. Interrupted claims never silently replay a launch or message. */
export async function sessionOperation(store: RecordStore, adapter: DshWorkspaceAdapter | undefined, operation: string, raw: MemoryJsonValue, scope: MemoryOperationScope, signal?: AbortSignal) {
  if (!adapter) throw new Error('The DSH session adapter is unavailable')
  const input = memoryInputRecord(raw, 'session operation'), requestId = memoryInputText(input.requestId, 'requestId', 100)!, nativeId = memoryInputText(input.sessionId, 'sessionId', 200, false), text = memoryInputText(input.text, 'message', 100000, false)
  if (!sessionActions.some(action => action.id === operation)) throw new Error('Unsupported session operation')
  if (!scope.workspaceId) throw new Error('Select a workspace before operating on a conversation')
  if ((operation === 'session-send' || operation === 'session-fork' || operation === 'session-rename') && !nativeId) throw new Error('Select a target conversation')
  if (operation === 'session-send' && !text) throw new Error('A message is required')
  if (input.wake && input.steering) throw new Error('Choose wake or steering, not both')
  const preset = memoryInputText(input.preset, 'preset', 200, false), provider = memoryInputText(input.provider, 'provider', 200, false), model = memoryInputText(input.model, 'model', 300, false), reasoning = memoryInputText(input.reasoningEffort, 'reasoningEffort', 100, false)
  if (!!provider !== !!model || reasoning && !model) throw new Error('A model override requires both provider and model')
  const seq = operation === 'session-fork' ? memoryInputInteger(input.seq, -1, 0, Number.MAX_SAFE_INTEGER) : undefined
  const key = digest([scope.workspaceId, scope.sessionId ?? '', requestId]), fingerprint = digest([operation, input])
  let claimed = false, record!: RecordValue
  await store.change(undefined, records => {
    const existing = records.find(value => value.id === key)
    if (existing) {
      if (!visibleRecord(existing, scope) || existing.data.fingerprint !== fingerprint) throw new Error('This requestId already belongs to a different operation')
      record = existing; return
    }
    signal?.throwIfAborted()
    const now = new Date().toISOString()
    record = { id: key, kind: 'operation', title: operation, content: text ?? '', ...recordScope('project', scope), state: 'active', createdAt: now, updatedAt: now, version: 1, signals: 1, history: [], data: { requestId, fingerprint, initiator: scope.sessionId ?? '', sessionId: ['session-send', 'session-rename'].includes(operation) ? nativeId! : randomUUID(), status: 'claimed', operation } }
    records.push(record); claimed = true
  }, signal)
  if (!claimed) {
    if (record.data.status !== 'completed') throw new Error(`Operation ${requestId} is ${String(record.data.status)}. Inspect conversation ${String(record.data.sessionId)} before issuing a new request.`)
    return json({ ...record.data, replayed: true })
  }
  const id = String(record.data.sessionId)
  try {
    signal?.throwIfAborted()
    let delivery: MemoryJsonValue = null
    if (operation === 'session-rename') delivery = json(await adapter.rename(id, memoryInputText(input.title, 'title', 300)!, scope, signal))
    else if (operation !== 'session-send') {
      await adapter.create(scope, { id, ...(nativeId ? { parentId: nativeId } : {}), ...(seq !== undefined ? { throughSeq: seq } : {}), ...(preset ? { preset } : {}), ...(provider && model ? { agentOptions: { provider, model, ...(reasoning ? { reasoningEffort: ReasoningEffortId(reasoning) } : {}) } } : {}), ...(signal ? { signal } : {}) })
    }
    if (text) delivery = json(await adapter.deliver(id, text, scope, { plugin: 'dsh-mnemon-source-sessions', wake: input.wake === true, steering: input.steering === true, ...(signal ? { signal } : {}) }))
    await store.change(undefined, records => { const current = records.find(value => value.id === key)!; current.data.status = 'completed'; current.data.delivery = delivery; current.updatedAt = new Date().toISOString(); record = current })
    return json(record.data)
  } catch (error) {
    await store.change(undefined, records => { const current = records.find(value => value.id === key)!; current.data.status = 'uncertain'; current.data.error = error instanceof Error ? error.message : String(error); current.updatedAt = new Date().toISOString() })
    throw error
  }
}
