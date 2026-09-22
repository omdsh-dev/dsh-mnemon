// @vitest-environment jsdom
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
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

function makeCtx(initialValue: unknown, coreValue: Record<string, unknown> = {}, turnTailKind: 'chain' | 'list' = 'chain') {
  const core = new SlotCore()
  // Exercise the published registry with each host declaration, without
  // changing the pinned RC declarations in the production type boundary.
  const registerSlot = (options: SlotOptions, component: unknown = () => null): (() => void) =>
    (core.register as (options: SlotOptions, component: unknown) => () => void)(options, component)
  const disposeOwner = registerSlot({
    name: 'root',
    children: {
      'conversation.chat.turnTail': { kind: turnTailKind, scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.view': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  })
  const injects: string[] = []
  /** Registrations that have not been disposed yet. */
  const active = new Set<SlotOptions>()
  const registeredOptions: SlotOptions[] = []
  let uiValue = initialValue as Record<string, unknown>
  let revision = 1
  const localeSnapshot = { active: 'zh' as const, locales: [] as const, revision: 0 }

  const ctx = {
    get: vi.fn(() => undefined),
    on: vi.fn(() => () => {}),
    sessions: { list: { getSnapshot: () => ({ current: 'session-a', byId: {} }) } },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'session-a' }), subscribe: () => () => {} } } },
    slots: {
      inject: (slot: string, factory: () => unknown) => {
        injects.push(slot)
        let dispose: (() => void) | undefined
        dispose = factory() as (() => void) | undefined
        const disposer = () => { dispose?.(); dispose = undefined }
        injectDisposers.add(disposer)
        return disposer
      },
      register: (options: SlotOptions, component: unknown) => {
        const dispose = registerSlot(options, component)
        registeredOptions.push(options)
        active.add(options)
        return () => { dispose(); active.delete(options) }
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
      if (typeof dispose === 'function') {
        effectDisposers.push(dispose as () => void)
      }
      return () => {}
    }),
  }

  // Each injection owns a lifetime, even when several target the same slot.
  const injectDisposers = new Set<() => void>()
  const effectDisposers: Array<() => void> = []
  const activeRegistrations = () => [...active].map(options => options.key ?? options.id ?? options.name)
  const dispose = () => {
    for (const cleanup of effectDisposers.splice(0).reverse()) cleanup()
    for (const cleanup of [...injectDisposers.values()].reverse()) cleanup()
    injectDisposers.clear()
  }
  mountedEffects.push(() => { dispose(); disposeOwner() })
  return { ctx, core, registerSlot, dispose, injects, injectDisposers, registeredOptions, activeRegistrations, effectDisposers }
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

  it.each(['chain', 'list'] as const)('keeps a stable turn-tail registration across settings and client reload in a %s slot', async kind => {
    const { ctx, core, registerSlot, registeredOptions, dispose } = makeCtx({}, {}, kind)
    const slot = 'conversation.chat.turnTail'
    const peerIds = ['other-plugin/first-tail', 'other-plugin/second-tail']
    for (const id of peerIds) registerSlot({ name: slot, id, select: () => ({}), priority: 1 })
    const peers = [...core.entriesOfSlot(slot)]
    const ids = () => core.entriesOfSlot(slot).map(entry => entry.options.id)

    apply(ctx)
    // The default-on entry must wait for the Host settings snapshot.
    expect(core.entriesOfSlot(slot)).toEqual(peers)
    await waitFor(() => expect(ids()).toEqual(['dsh-mnemon/turn-tail', ...peerIds]))
    const entry = core.entriesOfSlot(slot)[0]!
    expect(entry.select).toBe(selectMnemonTurnTail)
    expect(entry.select?.({ turn: { status: 'open' } } as never)).toBeNull()
    expect(entry.select?.({ turn: { status: 'closed' } } as never)).toEqual({})

    const settings = registeredOptions.find(options => options.name === 'settings.section')?.inject?.() as {
      interactionScope: { mutate: (ops: unknown[]) => Promise<void> }
    }
    await settings.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: false }])
    expect(core.entriesOfSlot(slot)).toEqual(peers)
    await settings.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: true }])
    expect(ids()).toEqual(['dsh-mnemon/turn-tail', ...peerIds])
    expect(core.entries(slot)).toHaveLength(3)

    dispose()
    expect(core.entriesOfSlot(slot)).toEqual(peers)
    expect(core.entriesOfSlot('shell.overlay')).toHaveLength(0)
    apply(ctx)
    await waitFor(() => expect(ids()).toEqual(['dsh-mnemon/turn-tail', ...peerIds]))
    expect(core.entries(slot)).toHaveLength(3)
    dispose()
    expect(core.entriesOfSlot(slot)).toEqual(peers)
    expect(core.entriesOfSlot('shell.overlay')).toHaveLength(0)
  })

  it('registers both remaining interaction surfaces by default', async () => {
    const { ctx, injects, activeRegistrations } = makeCtx({})
    apply(ctx)
    // Sidebar has a DSH-owned seat even before any session exists.
    expect(injects).toContain('settings.section')
    await waitFor(() => expect(injects).toContain('shell.overlay'))
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['dsh-mnemon/turn-tail', 'mnemon-save'])))
    expect(activeRegistrations()).not.toEqual(expect.arrayContaining(TOOLVIEW_KEYS))
  })

  it('registers explicitly enabled surfaces after settings load', async () => {
    const { ctx, activeRegistrations } = makeCtx({ toolviews: true, turnBar: true, saveAction: true })
    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['dsh-mnemon/turn-tail', 'mnemon-save'])))
    expect(activeRegistrations()).toEqual(expect.arrayContaining(['dsh-mnemon/turn-tail', 'mnemon-save']))
    expect(activeRegistrations()).not.toEqual(expect.arrayContaining(TOOLVIEW_KEYS))
  })

  it('registers only the enabled surfaces when toggles are mixed', async () => {
    const { ctx, activeRegistrations } = makeCtx({ toolviews: true, turnBar: false, saveAction: true })
    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['mnemon-save'])))
    expect(activeRegistrations()).toEqual(expect.arrayContaining(['mnemon-save']))
    expect(activeRegistrations()).not.toEqual(expect.arrayContaining(TOOLVIEW_KEYS))
    expect(activeRegistrations()).not.toContain('dsh-mnemon/turn-tail')
  })

  it('opens the default sidebar for a conversation anchor', async () => {
    const { ctx, injects, activeRegistrations } = makeCtx({})
    const tab = document.createElement('button')
    tab.setAttribute('role', 'tab')
    tab.textContent = 'tab.label'
    const clicked = vi.fn()
    tab.addEventListener('click', clicked)
    const conversation = document.createElement('div')
    conversation.dataset.slot = 'main.conversation'
    conversation.append(tab)
    document.body.append(conversation)

    apply(ctx)
    await waitFor(() => expect(injects).toContain('shell.overlay'))
    dispatchMnemonAnchor({ page: 'documents/library', sessionId: 'session-a' })

    expect(clicked).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(injects).not.toContain('conversation.view')
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'documents/library' })
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
    const conversation = document.createElement('div')
    conversation.dataset.slot = 'main.conversation'
    conversation.append(tab)
    document.body.append(conversation)
    apply(ctx)
    await waitFor(() => expect(injects).toContain('conversation.view'))
    expect(activeRegistrations().filter(id => id === 'mnemon')).toHaveLength(2)

    dispatchMnemonAnchor({ page: 'documents/library', sessionId: 'session-b' })
    expect(clicked).not.toHaveBeenCalled()
    expect(consumeMnemonAnchor('session-b')).toMatchObject({ page: 'documents/library' })
    dispatchMnemonAnchor({ page: 'memory-spaces/remember', seed: 'Scoped candidate', sessionId: 'session-a' })
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'memory-spaces/remember', seed: 'Scoped candidate' })
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)

    label = 'Memory System'
    tab.textContent = label
    dispatchMnemonAnchor({ page: 'runtime/entries', sessionId: 'session-a' })
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
    dispatchMnemonAnchor({ page: 'documents/library', sessionId: 'session-a' })
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'documents/library' })
  })

  it('registers and disposes interaction surfaces when mnemon-ui changes live', async () => {
    const { ctx, registeredOptions, activeRegistrations } = makeCtx({})
    apply(ctx)
    await waitFor(() => expect(registeredOptions.some(options => options.name === 'settings.section')).toBe(true))
    const settingsEntry = registeredOptions.find(options => options.name === 'settings.section')
    const injected = settingsEntry?.inject?.() as { interactionScope?: { mutate: (ops: unknown[]) => Promise<void> } } | undefined
    if (injected?.interactionScope === undefined) throw new Error('mnemon-ui settings scope was not injected')

    await injected.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: true }])
    await waitFor(() => expect(activeRegistrations()).toContain('dsh-mnemon/turn-tail'))

    await injected.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: false }])
    await waitFor(() => expect(activeRegistrations()).not.toContain('dsh-mnemon/turn-tail'))
  })
})
