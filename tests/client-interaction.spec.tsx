// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { apply } from '../src/client/index.ts'
import { selectMnemonTurnTail } from '../src/client/MnemonTurnTail.tsx'
import { consumeMnemonAnchor, dispatchMnemonAnchor } from '../src/client/anchor.ts'

const mountedEffects: Array<() => void> = []

interface SlotOptions {
  name: string
  key?: string
  id?: string
  select?: unknown
  order?: number
  priority?: number
  label?: unknown
  locale?: string
  children?: Record<string, unknown>
  inject?: (...args: unknown[]) => Record<string, unknown>
}

function makeCtx(initialValue: unknown, coreValue: Record<string, unknown> = {}) {
  const injects: string[] = []
  /** Registrations that have not been disposed yet. */
  let active: string[] = []
  const effects: Array<() => unknown> = []
  const registeredOptions: SlotOptions[] = []
  let uiValue = initialValue as Record<string, unknown>
  let revision = 1
  const localeSnapshot = { active: 'zh' as const, locales: [] as const, revision: 0 }

  const ctx = {
    sessions: { list: { getSnapshot: () => ({ current: 'session-a', byId: {} }) } },
    slots: {
      inject: (slot: string, factory: () => unknown) => {
        injects.push(slot)
        let dispose: (() => void) | undefined
        dispose = factory() as (() => void) | undefined
        const disposer = () => { dispose?.(); dispose = undefined }
        injectDisposers.set(slot, disposer)
        return disposer
      },
      register: (options: SlotOptions) => {
        registeredOptions.push(options)
        const key = options.key ?? options.id ?? options.name
        active.push(key)
        return () => { active = active.filter(candidate => candidate !== key) }
      },
    },
    connection: {
      rpc: {
        call: vi.fn(async (channel: string, endpoint: string, rawPayload: unknown) => {
          if (channel === '/dsh-mnemon-settings') {
            const payload = rawPayload as { namespace?: string; ops?: Array<{ op: string; path: string[]; value?: unknown }> }
            const namespace = payload.namespace
            if (endpoint === 'mutate' && namespace === 'mnemon-ui') {
              for (const op of payload.ops ?? []) {
                if (op.op === 'set') uiValue = { ...uiValue, [op.path[0]!]: op.value }
                else {
                  uiValue = { ...uiValue }
                  delete uiValue[op.path[0]!]
                }
              }
              revision += 1
            }
            return { ok: true, value: { status: 'ready', value: namespace === 'mnemon-ui' ? uiValue : coreValue, base: {}, user: namespace === 'mnemon-ui' ? uiValue : coreValue, revision, writable: true, mode: 'host' } }
          }
          return { ok: false, error: { code: 'internal', message: 'unexpected', details: {} } }
        }),
      },
    },
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (key: string) => key),
      getSnapshot: vi.fn(() => localeSnapshot),
      subscribe: vi.fn(() => () => {}),
    },
    effect: vi.fn((callback: () => unknown) => {
      const dispose = callback()
      effects.push(callback)
      if (typeof dispose === 'function') {
        effectDisposers.push(dispose as () => void)
        mountedEffects.push(dispose as () => void)
      }
      return () => {}
    }),
  }

  const injectDisposers = new Map<string, () => void>()
  const effectDisposers: Array<() => void> = []
  const activeRegistrations = () => active
  return { ctx, injects, injectDisposers, registeredOptions, activeRegistrations, effectDisposers }
}

const TOOLVIEW_KEYS = ['mnemon_memory_bodies', 'mnemon_recall', 'mnemon_related', 'mnemon_status', 'mnemon_document_search', 'mnemon_document_manage', 'mnemon_runtime_memory', 'mnemon_remember', 'mnemon_link', 'mnemon_forget', 'mnemon_memory_body_create', 'mnemon_memory_body_update', 'mnemon_memory_body_merge']

describe('interaction surfaces binding', () => {
  afterEach(() => {
    for (const dispose of mountedEffects.splice(0).reverse()) dispose()
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('declines an unsettled turn with the DSH chain-slot null sentinel', () => {
    const owner = (status: string) => ({ turn: { status }, seq: 1, openFile: vi.fn() })
    expect(selectMnemonTurnTail(owner('open') as never)).toBeNull()
    expect(selectMnemonTurnTail(owner('closed') as never)).toEqual({})
  })

  it('registers both remaining interaction surfaces by default', async () => {
    const { ctx, injects, activeRegistrations } = makeCtx({})
    apply(ctx)
    // The standalone sidebar workspace does not occupy conversation.view; the
    // Both supported interaction surfaces register from the ready default.
    expect(injects).toContain('settings.section')
    expect(injects).not.toContain('conversation.view')
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['conversation.chat.turnTail', 'mnemon-save'])))
    expect(activeRegistrations()).not.toEqual(expect.arrayContaining(TOOLVIEW_KEYS))
  })

  it('registers explicitly enabled surfaces after settings load', async () => {
    const { ctx, activeRegistrations } = makeCtx({ toolviews: true, turnBar: true, saveAction: true })
    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['conversation.chat.turnTail', 'mnemon-save'])))
    expect(activeRegistrations()).toEqual(expect.arrayContaining(['conversation.chat.turnTail', 'mnemon-save']))
    expect(activeRegistrations()).not.toEqual(expect.arrayContaining(TOOLVIEW_KEYS))
  })

  it('registers only the enabled surfaces when toggles are mixed', async () => {
    const { ctx, activeRegistrations } = makeCtx({ toolviews: true, turnBar: false, saveAction: true })
    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['mnemon-save'])))
    expect(activeRegistrations()).toEqual(expect.arrayContaining(['mnemon-save']))
    expect(activeRegistrations()).not.toEqual(expect.arrayContaining(TOOLVIEW_KEYS))
    expect(activeRegistrations()).not.toContain('conversation.chat.turnTail')
  })

  it('opens the default sidebar for a conversation anchor', async () => {
    const { ctx, injects, activeRegistrations } = makeCtx({})
    const tab = document.createElement('button')
    tab.setAttribute('role', 'tab')
    tab.textContent = 'tab.label'
    const clicked = vi.fn()
    tab.addEventListener('click', clicked)
    document.body.append(tab)

    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toContain('mnemon-save'))
    dispatchMnemonAnchor({ page: 'documents', sessionId: 'session-a' })

    expect(clicked).not.toHaveBeenCalled()
    expect(injects).not.toContain('conversation.view')
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'documents' })
  })

  it('opens the Builtin tab only for the current session, follows locale labels, and removes its listener on disposal', async () => {
    const { ctx, injects, activeRegistrations, effectDisposers } = makeCtx({}, { displayMode: 'builtin' })
    let label = '记忆系统'
    ctx.locale.bind.mockImplementation(() => () => label)
    const tab = document.createElement('button')
    tab.setAttribute('role', 'tab')
    tab.textContent = label
    const clicked = vi.fn()
    tab.addEventListener('click', clicked)
    document.body.append(tab)
    apply(ctx)
    await waitFor(() => expect(injects).toContain('conversation.view'))
    expect(activeRegistrations().filter(id => id === 'mnemon')).toHaveLength(2)

    dispatchMnemonAnchor({ page: 'documents', sessionId: 'session-b' })
    expect(clicked).not.toHaveBeenCalled()
    expect(consumeMnemonAnchor('session-b')).toMatchObject({ page: 'documents' })
    dispatchMnemonAnchor({ page: 'remember', seed: 'Scoped candidate', sessionId: 'session-a' })
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'remember', seed: 'Scoped candidate' })
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)

    label = 'Memory System'
    tab.textContent = label
    dispatchMnemonAnchor({ page: 'runtime', sessionId: 'session-a' })
    expect(clicked).toHaveBeenCalledTimes(2)
    consumeMnemonAnchor('session-a')
    for (const dispose of effectDisposers) dispose()
    dispatchMnemonAnchor({ page: 'status', sessionId: 'session-a' })
    expect(clicked).toHaveBeenCalledTimes(2)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'status' })
  })

  it('keeps Builtin anchors pending without mounting or opening a hidden entry', async () => {
    const { ctx, activeRegistrations } = makeCtx({}, { displayMode: 'builtin', tabEnabled: false })
    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toContain('mnemon-save'))
    expect(activeRegistrations().filter(id => id === 'mnemon')).toHaveLength(1) // settings only
    dispatchMnemonAnchor({ page: 'documents', sessionId: 'session-a' })
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'documents' })
  })

  it('registers and disposes interaction surfaces when mnemon-ui changes live', async () => {
    const { ctx, registeredOptions, activeRegistrations } = makeCtx({})
    apply(ctx)
    await waitFor(() => expect(registeredOptions.some(options => options.name === 'settings.section')).toBe(true))
    const settingsEntry = registeredOptions.find(options => options.name === 'settings.section')
    const injected = settingsEntry?.inject?.() as { interactionScope?: { mutate: (ops: unknown[]) => Promise<void> } } | undefined
    if (injected?.interactionScope === undefined) throw new Error('mnemon-ui settings scope was not injected')

    await injected.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: true }])
    await waitFor(() => expect(activeRegistrations()).toContain('conversation.chat.turnTail'))

    await injected.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: false }])
    await waitFor(() => expect(activeRegistrations()).not.toContain('conversation.chat.turnTail'))
  })
})
