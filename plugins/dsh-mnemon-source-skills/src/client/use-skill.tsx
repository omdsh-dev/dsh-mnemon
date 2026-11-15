import { useEffect, useRef } from 'react'

/**
 * "Use" puts `/name ` into the conversation's input, where DSH's own gesture
 * loads the skill when the message is sent. On DSH 0.2.1+, this uses the
 * official `ctx.conversation.input` and `ctx.sessions` contracts directly
 * without mounting a slot component or firing DOM events; on DSH 0.2.0-rc.2
 * (where `ctx.conversation` is absent), it falls back to the gated composer-row
 * event bridge.
 */
export const SKILL_USE_EVENT = 'dsh-mnemon:skill-use'

interface SkillUseDetail {
  name: string
  sessionId?: string
  handled: boolean
}

export interface SessionInputState {
  readonly draft: string
}

export interface SessionInputController {
  readonly state: {
    getSnapshot(): SessionInputState
  }
  setDraft(text: string): void
  focus?: () => void
}

export interface DraftInitializationOptions {
  readonly prompt?: string
  readonly clearPreviousDraft?: boolean
  readonly whenDraftExists?: 'replace' | 'append' | 'keep'
}

export type DraftInitializationResult = 'applied' | 'preserved' | 'blocked'

export interface RetainedSessionBinding {
  readonly sessionId: string
  readonly ctx: unknown
}

export interface SessionInputResolver {
  for?: (actx: unknown) => SessionInputController | undefined
  requestDraftInitialization?: (
    binding: RetainedSessionBinding,
    options: DraftInitializationOptions,
  ) => DraftInitializationResult
}

export interface SessionSummaryRow {
  readonly id: string
  readonly retainedBy?: Readonly<Partial<Record<string, number>>>
}

export interface SessionsRuntime {
  readonly list?: {
    getSnapshot(): {
      readonly ids?: readonly string[]
      readonly byId: Readonly<Record<string, SessionSummaryRow | undefined>>
    }
  }
  scope?: (sessionId: string) => unknown
  binding?: (sessionId: string) => RetainedSessionBinding | undefined
  retainInfo?: (sessionId: string) => {
    getSnapshot(): {
      readonly retainedBy: Readonly<Partial<Record<string, number>>>
    }
  }
}

export interface UiSessionRuntime {
  readonly adapter?: {
    readonly current?: {
      getSnapshot(): { readonly key?: string | undefined }
    }
  }
}

export interface UiWorkspaceRuntime {
  openSession?: (target: string) => void
  startSession?: (workspaceId?: string, options?: DraftInitializationOptions) => void
}

export interface SkillUseRuntimeContext {
  slots: unknown
  conversation?: { input?: SessionInputResolver | undefined } | undefined
  sessions?: SessionsRuntime | undefined
  uiSession?: UiSessionRuntime | undefined
  uiWorkspace?: UiWorkspaceRuntime | undefined
  layout?: { selectPanel?: (panelId: string | null) => void } | undefined
}

type DirectSkillUseHandler = (name: string, sessionId?: string) => boolean

let directHandler: DirectSkillUseHandler | undefined
let directModeActive = false

/** A request no composer has taken yet (0.2.0-rc.2 fallback): the next composer of its session to mount takes it. */
let pending: { detail: SkillUseDetail; at: number } | undefined
const PENDING_MS = 10_000

/** Whether DSH 0.2.1+ direct `ctx.conversation.input` mode is currently active (rather than the deferred 0.2.0-rc.2 bridge). */
export function isDirectSkillUseActive(): boolean {
  return directModeActive
}

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

function readOptionalService<K extends 'conversation' | 'sessions' | 'uiSession' | 'uiWorkspace' | 'layout'>(
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

function readMainSessionId(ctx: SkillUseRuntimeContext, sessions: SessionsRuntime | undefined): string | undefined {
  const currentKey = readOptionalService(ctx, 'uiSession')?.adapter?.current?.getSnapshot?.()?.key
  if (typeof currentKey === 'string' && currentKey !== '') return currentKey
  const byId = sessions?.list?.getSnapshot?.()?.byId
  if (byId !== undefined) {
    for (const candidate of Object.values(byId)) {
      if (candidate !== undefined && (candidate.retainedBy?.mainView ?? 0) > 0 && candidate.id !== '') {
        return candidate.id
      }
    }
  }
  return undefined
}

function applyDirectSkillUse(ctx: SkillUseRuntimeContext, input: SessionInputResolver, name: string, sessionId?: string): boolean {
  const layout = readOptionalService(ctx, 'layout')
  const sessions = readOptionalService(ctx, 'sessions')
  const uiWorkspace = readOptionalService(ctx, 'uiWorkspace')
  const mainSessionId = readMainSessionId(ctx, sessions)
  const requestedSessionId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  const targetSessionId = requestedSessionId ?? mainSessionId

  if (targetSessionId === undefined) {
    if (typeof uiWorkspace?.startSession === 'function') {
      try {
        uiWorkspace.startSession(undefined, { prompt: draftWithSkill('', name), whenDraftExists: 'replace' })
        return true
      } catch {
        return false
      }
    }
    return false
  }

  let binding = sessions?.binding?.(targetSessionId)
  if ((requestedSessionId !== undefined && requestedSessionId !== mainSessionId) || binding === undefined) {
    try {
      uiWorkspace?.openSession?.(targetSessionId)
      binding = sessions?.binding?.(targetSessionId)
    } catch {
      // Fall through and inspect whatever retained scope/binding is available.
    }
  }

  const actx = sessions?.scope?.(targetSessionId) ?? binding?.ctx
  if (actx !== undefined && typeof input.for === 'function') {
    try {
      const controller = input.for(actx)
      if (controller !== undefined) {
        const currentDraft = controller.state.getSnapshot().draft
        controller.setDraft(draftWithSkill(currentDraft, name))
        try { layout?.selectPanel?.(null) } catch { /* Conversation panel may already be active or unmanaged. */ }
        controller.focus?.()
        return true
      }
    } catch {
      // Fall through to requestDraftInitialization when a retained binding exists.
    }
  }

  if (binding !== undefined && typeof input.requestDraftInitialization === 'function') {
    try {
      const result = input.requestDraftInitialization(binding, {
        prompt: draftWithSkill('', name),
        whenDraftExists: 'replace',
      })
      if (result === 'blocked') return false
      try { layout?.selectPanel?.(null) } catch { /* Conversation panel may already be active or unmanaged. */ }
      return true
    } catch {
      return false
    }
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
    directModeActive = true
    return applyDirectSkillUse(ctx, input, name, sessionId)
  }
  const initialInput = readOptionalService(ctx, 'conversation')?.input
  if (initialInput !== undefined) {
    const handler: DirectSkillUseHandler = (name, sessionId) => {
      const currentInput = readOptionalService(ctx, 'conversation')?.input ?? initialInput
      return applyDirectSkillUse(ctx, currentInput, name, sessionId)
    }
    directHandler = handler
    directModeActive = true
    pending = undefined
    return () => {
      if (directHandler === handler) {
        directHandler = undefined
        directModeActive = false
      }
    }
  }
  const handler: DirectSkillUseHandler = (name, sessionId) => {
    const result = tryDirect(name, sessionId)
    if (result !== undefined) return result
    directModeActive = false
    const detail: SkillUseDetail = { name, ...(sessionId === undefined ? {} : { sessionId }), handled: false }
    window.dispatchEvent(new CustomEvent(SKILL_USE_EVENT, { detail }))
    pending = detail.handled ? undefined : { detail, at: Date.now() }
    return detail.handled
  }
  directHandler = handler
  directModeActive = false
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
    if (directHandler === handler) {
      directHandler = undefined
      directModeActive = false
    }
    disposeSlot?.()
  }
}
