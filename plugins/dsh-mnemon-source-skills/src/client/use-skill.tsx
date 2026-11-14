import { useEffect, useRef } from 'react'

/**
 * "Use" puts `/name ` into the conversation's input, where DSH's own gesture
 * loads the skill when the message is sent. On DSH 0.2.1+, this uses the
 * official `ctx.conversation.input` controller directly without mounting a slot
 * component or firing DOM events; on DSH 0.2.0-rc.2 (where `ctx.conversation`
 * is absent), it falls back to the gated composer-row event bridge.
 */
export const SKILL_USE_EVENT = 'dsh-mnemon:skill-use'

interface SkillUseDetail {
  name: string
  sessionId?: string
  handled: boolean
}

export interface SessionInputController {
  getSnapshot?: () => { draft?: string } | undefined
  setDraft(draft: string): void
  focus?: () => void
}

export interface SessionInputResolver {
  for?: (scope: unknown) => SessionInputController | undefined
  requestDraftInitialization?: (
    binding: unknown,
    init: { draft: string; cursor?: number; mode?: 'if-empty' | 'replace' },
  ) => void
}

export interface SessionsRuntime {
  selectedSessionId?:
    | string
    | null
    | {
        get?: () => string | null | undefined
        getSnapshot?: () => string | null | undefined
        value?: string | null | undefined
      }
  selectSession?: (sessionId: string | null) => void
  sessionScope?: ((sessionId: string) => unknown) | ReadonlyMap<string, unknown> | Record<string, unknown>
  getSessionScope?: (sessionId: string) => unknown
}

export interface SkillUseRuntimeContext {
  slots: unknown
  conversation?: { input?: SessionInputResolver | undefined } | undefined
  sessions?: SessionsRuntime | undefined
  layout?: { selectPanel?: (panelId: string | null) => void } | undefined
}

type DirectSkillUseHandler = (name: string, sessionId?: string) => boolean

let directHandler: DirectSkillUseHandler | undefined

/** A request no composer has taken yet (0.2.0-rc.2 fallback): the next composer of its session to mount takes it. */
let pending: { detail: SkillUseDetail; at: number } | undefined
const PENDING_MS = 10_000

/**
 * Ask the open composer to take `/name`. On DSH 0.2.1+ this writes directly
 * through `ctx.conversation.input`; on 0.2.0-rc.2 it dispatches to the gated
 * composer bridge.
 * @returns whether a composer or draft initializer accepted `/name`.
 */
export function requestSkillUse(name: string, sessionId?: string): boolean {
  if (directHandler !== undefined) return directHandler(name, sessionId)
  const detail: SkillUseDetail = { name, ...(sessionId === undefined ? {} : { sessionId }), handled: false }
  window.dispatchEvent(new CustomEvent(SKILL_USE_EVENT, { detail }))
  pending = detail.handled ? undefined : { detail, at: Date.now() }
  return detail.handled
}

/** Where `/name` goes in a draft: first, once, ahead of what is already typed. */
export function draftWithSkill(draft: string, name: string): string {
  const token = `/${name}`
  if (new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(\\s|$)`, 'u').test(draft)) return draft
  const rest = draft.trimStart()
  return rest === '' ? `${token} ` : `${token} ${rest}`
}

interface ComposerInputActions {
  setDraft(text: string): void
}

/** DSH 0.2.0-rc.2 session-scoped composer props: the input selector and its stable actions. */
export interface SkillUseBridgeProps {
  sessionId?: string
  inputActions?: ComposerInputActions
  useInput?: <T>(selector: (state: { draft: string }) => T) => T
}

const noDraft = <T,>(selector: (state: { draft: string }) => T): T => selector({ draft: '' })

/** Legacy 0.2.0-rc.2 fallback mounted in the composer row when `ctx.conversation.input` is absent. */
export function SkillUseBridge(props: SkillUseBridgeProps): null {
  const useInput = props.useInput ?? noDraft
  const draft = useInput(state => state.draft)
  const latest = useRef(draft)
  latest.current = draft
  useEffect(() => {
    const take = (detail: SkillUseDetail | undefined): void => {
      if (detail === undefined || detail.handled || props.inputActions === undefined) return
      if (detail.sessionId !== undefined && props.sessionId !== undefined && detail.sessionId !== props.sessionId) return
      props.inputActions.setDraft(draftWithSkill(latest.current ?? '', detail.name))
      detail.handled = true
      if (pending?.detail === detail) pending = undefined
    }
    // The page asked before this composer was on screen.
    if (pending !== undefined && Date.now() - pending.at < PENDING_MS) take(pending.detail)
    const listener = (event: Event) => take((event as CustomEvent<SkillUseDetail>).detail)
    window.addEventListener(SKILL_USE_EVENT, listener)
    return () => window.removeEventListener(SKILL_USE_EVENT, listener)
  }, [props.inputActions, props.sessionId])
  return null
}

interface SlotRegistry {
  inject(name: string, factory: () => () => void): () => void
  register(options: { name: string; id: string; order?: number }, component: (props: SkillUseBridgeProps) => null): () => void
}

export const SKILL_USE_SLOT = 'conversation.input.left'

function readSelectedSessionId(sessions: SessionsRuntime | undefined): string | undefined {
  const selected = sessions?.selectedSessionId
  if (typeof selected === 'string') return selected === '' ? undefined : selected
  if (typeof selected === 'object' && selected !== null) {
    const value = selected.getSnapshot?.() ?? selected.get?.() ?? selected.value
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  return undefined
}

function resolveSessionScope(sessions: SessionsRuntime | undefined, sessionId: string | undefined): unknown {
  if (sessions === undefined || sessionId === undefined) return undefined
  const scopeSource = sessions.sessionScope
  if (typeof scopeSource === 'function') return scopeSource.call(sessions, sessionId)
  if (scopeSource instanceof Map) return scopeSource.get(sessionId)
  if (typeof scopeSource === 'object' && scopeSource !== null) return (scopeSource as Record<string, unknown>)[sessionId]
  if (typeof sessions.getSessionScope === 'function') return sessions.getSessionScope(sessionId)
  return undefined
}

function resolveController(
  input: SessionInputResolver,
  sessions: SessionsRuntime | undefined,
  scope: unknown,
  fallbackTarget: unknown,
): SessionInputController | undefined {
  if (typeof input.for !== 'function') return undefined
  if (scope !== undefined) {
    try {
      const controller = input.for(scope)
      if (controller !== undefined) return controller
    } catch {
      // Fall through to draft initialization if the scope is not ready yet.
    }
  }
  if (sessions === undefined && fallbackTarget !== undefined && fallbackTarget !== scope) {
    try {
      return input.for(fallbackTarget)
    } catch {
      return undefined
    }
  }
  return undefined
}

function readOptionalService<K extends 'conversation' | 'sessions' | 'layout'>(
  ctx: SkillUseRuntimeContext,
  key: K,
): SkillUseRuntimeContext[K] {
  const getter = (ctx as { get?: (name: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const resolved = getter.call(ctx, key) as SkillUseRuntimeContext[K]
      if (resolved !== undefined) return resolved
    } catch {
      // Fall through to guarded property lookup.
    }
  }
  try {
    return ctx[key]
  } catch {
    // Cordis 4 context proxies throw when reading un-injected service properties.
    return undefined
  }
}

function applyDirectSkillUse(ctx: SkillUseRuntimeContext, input: SessionInputResolver, name: string, sessionId?: string): boolean {
  const layout = readOptionalService(ctx, 'layout')
  const sessions = readOptionalService(ctx, 'sessions')
  try { layout?.selectPanel?.(null) } catch { /* Conversation panel may already be active or unmanaged. */ }
  const selectedId = readSelectedSessionId(sessions)
  const targetSessionId = sessionId ?? selectedId
  if (sessionId !== undefined && sessionId !== selectedId) {
    try { sessions?.selectSession?.(sessionId) } catch { /* Ignore if session switching is unsupported. */ }
  }
  const sessionScope = resolveSessionScope(sessions, targetSessionId)
  const controller = resolveController(input, sessions, sessionScope, targetSessionId ?? ctx)
  if (controller !== undefined) {
    const nextDraft = draftWithSkill(controller.getSnapshot?.()?.draft ?? '', name)
    controller.setDraft(nextDraft)
    controller.focus?.()
    return true
  }
  const binding = sessionScope ?? targetSessionId
  if (binding !== undefined && typeof input.requestDraftInitialization === 'function') {
    const nextDraft = draftWithSkill('', name)
    input.requestDraftInitialization(binding, { draft: nextDraft, cursor: nextDraft.length, mode: 'replace' })
    return true
  }
  return false
}

/**
 * Connect "Use" to DSH's official `ctx.conversation.input` controller on 0.2.1+,
 * or register the gated composer-row fallback on DSH 0.2.0-rc.2.
 */
export function installSkillUseBridge(ctx: SkillUseRuntimeContext): () => void {
  const tryDirect = (name: string, sessionId?: string): boolean | undefined => {
    const input = readOptionalService(ctx, 'conversation')?.input
    if (input === undefined) return undefined
    return applyDirectSkillUse(ctx, input, name, sessionId)
  }
  const initialInput = readOptionalService(ctx, 'conversation')?.input
  if (initialInput !== undefined) {
    const handler: DirectSkillUseHandler = (name, sessionId) => {
      const currentInput = readOptionalService(ctx, 'conversation')?.input ?? initialInput
      return applyDirectSkillUse(ctx, currentInput, name, sessionId)
    }
    directHandler = handler
    pending = undefined
    return () => {
      if (directHandler === handler) directHandler = undefined
    }
  }
  const handler: DirectSkillUseHandler = (name, sessionId) => {
    const result = tryDirect(name, sessionId)
    if (result !== undefined) return result
    const detail: SkillUseDetail = { name, ...(sessionId === undefined ? {} : { sessionId }), handled: false }
    window.dispatchEvent(new CustomEvent(SKILL_USE_EVENT, { detail }))
    pending = detail.handled ? undefined : { detail, at: Date.now() }
    return detail.handled
  }
  directHandler = handler
  const slots = ctx.slots as SlotRegistry
  let disposeSlot: (() => void) | undefined
  try {
    disposeSlot = slots.inject(SKILL_USE_SLOT, () => {
      if (readOptionalService(ctx, 'conversation')?.input !== undefined) return () => undefined
      return slots.register({ name: SKILL_USE_SLOT, id: 'dsh-mnemon-skills/use', order: 1000 }, SkillUseBridge)
    })
  } catch {
    disposeSlot = undefined
  }
  return () => {
    if (directHandler === handler) directHandler = undefined
    disposeSlot?.()
  }
}
