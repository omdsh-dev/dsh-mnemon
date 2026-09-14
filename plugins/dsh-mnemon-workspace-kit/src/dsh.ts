import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Agent, AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk'

export interface VisibleMessage { seq: number; role: 'user' | 'assistant'; text: string; at: string; truncated?: boolean }
/** Human transcript only: no replacement summaries, injected context, thoughts or tool blocks. */
export function visibleMessages(events: readonly SessionEvent[], maxCharacters = 200_000): { messages: VisibleMessage[]; truncated: boolean } {
  let remaining = maxCharacters
  const messages: VisibleMessage[] = []
  for (const event of events.slice().reverse()) {
    if (!isAppendSurfaceEvent(event) || event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (event.type === 'user/message' && event.data.source.kind !== 'user') continue
    const message = event.type === 'user/message' ? event.data : event.data.message
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (!text.trim()) continue
    if (remaining < text.length) return { messages: messages.reverse(), truncated: true }
    remaining -= text.length
    messages.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text, at: new Date(event.time).toISOString() })
  }
  return { messages: messages.reverse(), truncated: false }
}
export function assertSessionScope(header: SessionHeader, scope: MemoryOperationScope): void {
  if (!scope.workspaceId || !header.cwd || resolve(header.cwd) !== resolve(scope.workspaceId)) throw new Error('Session is outside the selected workspace')
}

/** Public DSH services only. Callers own all authorization, intent and domain state. */
export class DshWorkspaceAdapter {
  constructor(readonly services: { sessionQuery: SessionQueryEngine; agents: AgentRegistry; workspaceRegistry?: WorkspaceRegistry; attachments?: AttachmentStore; agentPresets?: AgentPresets; sessionTitle?: SessionTitleService }) {}
  async describe(id: string, scope: MemoryOperationScope, signal?: AbortSignal) {
    const observation = await this.observe(id, scope, signal)
    try {
      const request = observation.events.findLast(event => event.type === 'request/header'), title = observation.events.findLast(event => event.type === 'session/title')
      const config = request?.type === 'request/header' ? request.data.header.config : undefined
      return { sessionId: id, workspaceId: observation.header.cwd, preset: observation.header.agentPreset ?? null, parentId: observation.header.parentSession ?? null,
        status: this.services.agents.get(SessionId(id))?.status ?? 'closed', title: title?.type === 'session/title' ? title.data.title : null,
        createdAt: new Date(observation.header.createdAt).toISOString(), lastActiveAt: new Date(observation.events.at(-1)?.time ?? observation.header.createdAt).toISOString(),
        model: config ? { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort ?? null } : null }
    } finally { observation[Symbol.dispose]() }
  }
  async rename(id: string, title: string, scope: MemoryOperationScope, signal?: AbortSignal) {
    if (!this.services.sessionTitle) throw new Error('The native title service is unavailable')
    const agent = await this.live(id, scope, signal)
    signal?.throwIfAborted()
    return this.services.sessionTitle.rename(agent.session, title)
  }
  async list(scope: MemoryOperationScope, signal?: AbortSignal) {
    if (!scope.workspaceId) return []
    const rows = await this.services.sessionQuery.listSessions(signal)
    return rows.filter(row => row.header.cwd && resolve(row.header.cwd) === resolve(scope.workspaceId!)).map(row => ({
      id: String(row.header.id), cwd: row.header.cwd!, createdAt: new Date(row.header.createdAt).toISOString(), status: this.services.agents.get(row.header.id)?.status ?? 'closed',
      live: row.live, ...(row.header.parentSession ? { parentId: String(row.header.parentSession) } : {}),
    }))
  }
  async observe(id: string, scope: MemoryOperationScope, signal?: AbortSignal) {
    const observation = await this.services.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none', ...(signal ? { signal } : {}) })
    try { assertSessionScope(observation.header, scope); signal?.throwIfAborted(); return observation }
    catch (error) { observation[Symbol.dispose](); throw error }
  }
  async transcript(id: string, scope: MemoryOperationScope, signal?: AbortSignal, maxCharacters = 200_000) {
    const observation = await this.observe(id, scope, signal)
    try { return { ...visibleMessages(observation.events, maxCharacters), turns: observation.events.flatMap(event => event.type === 'turn/end' ? [{ turn: event.data.turn, seq: Number(event.seq) }] : []) } }
    finally { observation[Symbol.dispose]() }
  }
  /** Locate the exact visible message before applying a character budget, including old bookmarks. */
  async conversationWindow(id: string, scope: MemoryOperationScope, seq: number | undefined, radius = 3, signal?: AbortSignal) {
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > 10 || seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) throw new Error('Invalid conversation window')
    const observation = await this.observe(id, scope, signal)
    try {
      const isVisible = (event: SessionEvent) => isAppendSurfaceEvent(event) && (event.type === 'assistant/message' || event.type === 'user/message' && event.data.source.kind === 'user')
      const exact = seq === undefined ? undefined : observation.events.find(event => event.seq === seq)
      const boundary = exact?.type === 'turn/end' ? observation.events.indexOf(exact) : undefined
      const target = seq === undefined ? observation.events.findLast(isVisible) : boundary !== undefined ? observation.events.slice(0, boundary).findLast(isVisible) : exact && isVisible(exact) ? exact : undefined
      if (!target) throw new Error('The exact visible message is no longer available')
      const index = observation.events.indexOf(target), before: SessionEvent[] = [], after: SessionEvent[] = []
      for (let i = index - 1; i >= 0 && before.length < radius; i--) if (isVisible(observation.events[i]!)) before.unshift(observation.events[i]!)
      for (let i = index + 1; i < observation.events.length && after.length < radius; i++) if (isVisible(observation.events[i]!)) after.push(observation.events[i]!)
      const selected = [...before, target, ...after]
      const messages = selected.flatMap(event => {
        const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : undefined
        if (!message) return []
        const body = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        return [{ seq: Number(event.seq), role: (event.type === 'user/message' ? 'user' : 'assistant') as VisibleMessage['role'], text: body.slice(0, 4000), at: new Date(event.time).toISOString(), ...(body.length > 4000 ? { truncated: true } : {}) }]
      })
      const turn = observation.events.slice(index).find(event => event.type === 'turn/end')
      return { messages, targetSeq: Number(target.seq), ...(turn?.type === 'turn/end' ? { turn: turn.data.turn, throughSeq: Number(turn.seq) } : {}), truncated: messages.some(message => message.truncated) || before.length === radius || after.length === radius }
    } finally { observation[Symbol.dispose]() }
  }
  async images(scope: MemoryOperationScope, signal?: AbortSignal) {
    if (!scope.sessionId) throw new Error('Select a session to inspect its images')
    const observation = await this.observe(scope.sessionId, scope, signal)
    try {
      const images = new Map<string, { reference: ImageAttachmentRef; seq: number; at: string }>()
      for (const event of observation.events) {
        if (!isAppendSurfaceEvent(event) || event.type !== 'user/message' || event.data.source.kind !== 'user') continue
        for (const block of event.data.content) if (block.type === 'image') {
          images.delete(String(block.attachment.attachmentId))
          images.set(String(block.attachment.attachmentId), { reference: block.attachment, seq: Number(event.seq), at: new Date(event.time).toISOString() })
        }
      }
      return [...images.values()].slice(-100)
    } finally { observation[Symbol.dispose]() }
  }
  async readSessionImage(id: string | undefined, scope: MemoryOperationScope, signal?: AbortSignal) {
    if (!this.services.attachments) throw new Error('Native session image storage is unavailable')
    const images = await this.images(scope, signal), image = id ? images.find(value => String(value.reference.attachmentId) === id) : images.at(-1)
    if (!image) throw new Error('The image is not referenced by a visible user message in this session')
    const stored = await this.services.attachments.readImage(image.reference, signal)
    return { data: stored.data, name: image.reference.name || String(image.reference.attachmentId).slice(0, 16) + '.image' }
  }
  async live(id: string, scope: MemoryOperationScope, signal?: AbortSignal): Promise<Agent> {
    const observation = await this.observe(id, scope, signal)
    let agentOptions: AgentOptions | undefined
    const preset = observation.header.agentPreset
    try {
      const header = observation.events.findLast(event => event.type === 'request/header')
      if (header?.type === 'request/header') {
        const config = header.data.header.config
        agentOptions = { provider: config.provider, model: config.model,
          ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
          ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        }
      }
    } finally { observation[Symbol.dispose]() }
    // Two independent Sources may target the same cold session concurrently.
    return withMemoryStorageLock('dsh-session-resume:' + id, async () => {
      signal?.throwIfAborted()
      const current = this.services.agents.get(SessionId(id))
      if (current) { assertSessionScope(current.session.header, scope); return current }
      const handle = await this.services.agents.resume({ resumeSessionId: SessionId(id),
        ...(this.services.agentPresets ? { setup: async ctx => { await this.services.agentPresets!.mount(ctx, preset) } } : {}),
        ...(agentOptions ? { agentOptions } : {}), ...(signal ? { signal } : {}),
      })
      assertSessionScope(handle.agent.session.header, scope)
      return handle.agent
    })
  }
  async create(scope: MemoryOperationScope, options: { id?: string; parentId?: string; throughSeq?: number; preset?: string; agentOptions?: AgentOptions; signal?: AbortSignal } = {}): Promise<AgentHandle> {
    if (!scope.workspaceId) throw new Error('Select a workspace before creating a session')
    const parentId = options.parentId ?? scope.sessionId
    const parent = parentId ? this.services.agents.get(SessionId(parentId)) : undefined
    if (parent) assertSessionScope(parent.session.header, scope)
    let seed: readonly SessionEvent[] | undefined
    let preset = options.preset ?? parent?.session.header.agentPreset
    let inheritedOptions = parent?.options
    if (options.throughSeq !== undefined && (!parentId || !Number.isSafeInteger(options.throughSeq) || options.throughSeq < 0)) throw new Error('A valid parent and completed-turn boundary are required')
    if (parentId) {
      const observation = await this.observe(parentId, scope, options.signal)
      try {
        if (options.throughSeq !== undefined) {
          const index = observation.events.findIndex(event => event.seq === options.throughSeq && event.type === 'turn/end')
          if (index < 0) throw new Error('Choose the end of a completed turn for a fork')
          seed = observation.events.slice(0, index + 1)
        }
        preset ??= observation.header.agentPreset
        const header = observation.events.findLast(event => event.type === 'request/header')
        if (header?.type === 'request/header') {
          const config = header.data.header.config
          inheritedOptions = { provider: config.provider, model: config.model, ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}), ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}) }
        }
      } finally { observation[Symbol.dispose]() }
    }
    const workspace = await this.services.workspaceRegistry?.resolveByPath(scope.workspaceId)
    if (this.services.agentPresets) preset = (await this.services.agentPresets.resolve(preset)).id
    const handle = await this.services.agents.create({ sessionId: SessionId(options.id ?? randomUUID()), meta: { cwd: resolve(scope.workspaceId), ...(parentId ? { parentSession: SessionId(parentId) } : {}), ...(preset ? { agentPreset: preset } : {}), ...(seed ? { isSeeded: true } : {}) },
      ...(this.services.agentPresets ? { setup: async ctx => { await this.services.agentPresets!.mount(ctx, preset) } } : {}),
      ...(seed ? { seed, inheritedEventCount: SessionLogOffset(seed.length) } : {}), ...(options.agentOptions ?? inheritedOptions ? { agentOptions: options.agentOptions ?? inheritedOptions! } : {}), ...(options.signal ? { signal: options.signal } : {}) })
    if (workspace) {
      try { await workspace.attachSession(handle.agent.session.id) }
      catch (error) { throw new Error(`Session ${handle.agent.session.id} was created but could not be attached to its workspace: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return handle
  }
  async deliver(id: string, text: string, scope: MemoryOperationScope, options: { plugin: string; wake?: boolean; steering?: boolean; signal?: AbortSignal; images?: readonly SaveImageAttachment[] }): Promise<{ status: string; delivery: string }> {
    if (!text.trim() || text.length > 100_000) throw new Error('Message must contain 1–100000 characters')
    const agent = await this.live(id, scope, options.signal)
    options.signal?.throwIfAborted()
    if (options.images?.length && !this.services.attachments) throw new Error('Native session image storage is unavailable')
    const images = options.images?.length ? await this.services.attachments!.saveImages(options.images) : []
    options.signal?.throwIfAborted()
    const message = createUserMessage({ content: [{ type: 'text', text }, ...images.map(attachment => ({ type: 'image' as const, attachment }))], source: { kind: 'plugin', plugin: options.plugin, form: 'relay' } })
    if (options.steering) agent.steer(message)
    else if (options.wake) agent.followup(message)
    else agent.inject(message)
    return { status: agent.status, delivery: options.steering ? 'steering' : options.wake ? 'followup' : 'context' }
  }
}

export interface AgentHooks {
  beforeStep?(input: { agent: Agent; turn: number; step: number; messages: import('@deepseek-ai/dsh-llm').UserMessage[]; signal: AbortSignal }): Promise<import('@deepseek-ai/dsh-llm').UserMessage[]>
  event?(agent: Agent, event: SessionEvent, signal: AbortSignal): Promise<void>
  error?(error: unknown): void
}
/** Scoped public hooks, serialized per agent and drained on Source disposal. */
export function installAgentHooks(ctx: import('@deepseek-ai/cordis').Context, hooks: AgentHooks): () => Promise<void> {
  const controller = new AbortController(), owners = new Map<Agent, { stops: Array<() => unknown>; pending: Promise<void> }>()
  const attach = (agent: Agent) => {
    if (owners.has(agent) || controller.signal.aborted) return
    const owner = { stops: [] as Array<() => unknown>, pending: Promise.resolve() }
    owners.set(agent, owner)
    owner.stops.push(agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || !hooks.event || controller.signal.aborted) return
      owner.pending = owner.pending.then(() => hooks.event!(agent, event, controller.signal)).catch(error => { if (!controller.signal.aborted) hooks.error?.(error) })
    }))
    owner.stops.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || controller.signal.aborted || payload.signal.aborted || !hooks.beforeStep) return decision
      await owner.pending
      const signal = AbortSignal.any([controller.signal, payload.signal])
      const messages = await hooks.beforeStep({ ...payload, messages: decision.messages, signal })
      signal.throwIfAborted()
      return { ...decision, messages: [...decision.messages, ...messages] }
    }))
  }
  const stopCreated = ctx.on('agent/created', ({ agent }) => attach(agent))
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => { const owner = owners.get(agent); if (owner) { for (const stop of owner.stops) stop(); void owner.pending.finally(() => owners.delete(agent)) } })
  for (const agent of ctx.agents.roots()) attach(agent)
  return async () => { controller.abort(new Error('Source unloaded')); stopCreated(); stopDisposed(); for (const owner of owners.values()) for (const stop of owner.stops) stop(); await Promise.allSettled([...owners.values()].map(owner => owner.pending)); owners.clear() }
}
export const agentMemoryScope = (agent: Agent): MemoryOperationScope => ({ storage: 'custom', sessionId: String(agent.session.id), ...(agent.session.header.cwd ? { workspaceId: agent.session.header.cwd } : {}) })
