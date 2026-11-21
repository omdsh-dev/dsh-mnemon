import { useEffect, useRef } from 'react'

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

let pending: { detail: SkillUseDetail; at: number } | undefined
const PENDING_MS = 10_000

export function isDirectSkillUseActive(): boolean {
  return directModeActive
}

export function requestSkillUse(name: string, sessionId?: string): boolean {
  if (directHandler !== undefined) return directHandler(name, sessionId)
  const detail: SkillUseDetail = { name, ...(sessionId === undefined ? {} : { sessionId }), handled: false }
  window.dispatchEvent(new CustomEvent(SKILL_USE_EVENT, { detail }))
  pending = detail.handled ? undefined : { detail, at: Date.now() }
  return detail.handled
}

export function draftWithSkill(draft: string, name: string): string {
  const token = `/${name}`
  if (new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(\\s|$)`, 'u').test(draft)) return draft
  const rest = draft.trimStart()
  return rest === '' ? `${token} ` : `${token} ${rest}`
}

interface ComposerInputActions {
  setDraft(text: string): void
}

export interface SkillUseBridgeProps {
  sessionId?: string
  inputActions?: ComposerInputActions
  useInput?: <T>(selector: (state: { draft: string }) => T) => T
}

const noDraft = <T,>(selector: (state: { draft: string }) => T): T => selector({ draft: '' })

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
    }
  }
  try {
    return ctx[key]
  } catch {
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
    }
  }

  const actx = sessions?.scope?.(targetSessionId) ?? binding?.ctx
  if (actx !== undefined && typeof input.for === 'function') {
    try {
      const controller = input.for(actx)
      if (controller !== undefined) {
        const currentDraft = controller.state.getSnapshot().draft
        controller.setDraft(draftWithSkill(currentDraft, name))
        try { layout?.selectPanel?.(null) } catch { }
        controller.focus?.()
        return true
      }
    } catch {
    }
  }

  if (binding !== undefined && typeof input.requestDraftInitialization === 'function') {
    try {
      const result = input.requestDraftInitialization(binding, {
        prompt: draftWithSkill('', name),
        whenDraftExists: 'replace',
      })
      if (result === 'blocked') return false
      try { layout?.selectPanel?.(null) } catch { }
      return true
    } catch {
      return false
    }
  }

  return false
}

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
