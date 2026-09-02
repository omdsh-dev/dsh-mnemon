import { afterEach, describe, expect, it, vi } from 'vitest'

const { mountBetterSidebar } = vi.hoisted(() => ({
  mountBetterSidebar: vi.fn((
    _ctx: unknown,
    _translate: unknown,
    _seat: unknown,
  ) => vi.fn()),
}))
vi.mock('../src/client/better-sidebar.tsx', () => ({ mountBetterSidebarTab: mountBetterSidebar }))

import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { MnemonSettingsScope } from '../src/client/settings.ts'
import { MnemonBuiltinWorkspaceHost } from '../src/client/workspace-mount.tsx'
import type { Config } from '../src/host/protocol.ts'

const disposers: Array<() => void> = []
afterEach(() => {
  for (const stop of disposers.splice(0).reverse()) stop()
  vi.clearAllMocks()
})

function workspaceContext(initialValue: Record<string, unknown>, load: () => Promise<Record<string, unknown>> = async () => initialValue) {
  let value = initialValue
  let revision = 0
  let active: 'zh' | 'en' = 'zh'
  const slots: Record<string, unknown>[] = []
  const workspaceStops: ReturnType<typeof vi.fn>[] = []
  const context = {
    connection: { rpc: { call: vi.fn(async (_channel: string, endpoint: string, payload: { namespace?: string; ops?: Array<{ path: string[]; value?: unknown }> }) => {
      if (payload.namespace === 'mnemon') {
        if (endpoint === 'get') value = await load()
        else { value = { ...value, ...Object.fromEntries((payload.ops ?? []).map(op => [op.path[0], op.value])) }; revision += 1 }
      }
      return { ok: true, value: { status: 'ready', value: payload.namespace === 'mnemon-ui' ? {} : value, base: {}, user: value, revision, writable: true, mode: 'host' } }
    }) } },
    effect: vi.fn((callback: () => unknown) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }),
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (key: keyof typeof zh) => (active === 'zh' ? zh : en)[key]),
      getSnapshot: vi.fn(() => ({ active, locales: [], revision: 0 })),
      subscribe: vi.fn(() => () => {}),
    },
    slots: {
      inject: vi.fn((_name: string, factory: () => unknown) => factory()),
      register: vi.fn((options: Record<string, unknown>) => {
        slots.push(options)
        const stop = vi.fn()
        if (options.name === 'shell.overlay' || options.name === 'conversation.view') workspaceStops.push(stop)
        return stop
      }),
    },
  }
  apply(context)
  const settingsEntry = slots.find(options => options.name === 'settings.section')!
  const scope = (settingsEntry.inject as () => { scope: MnemonSettingsScope<Config> })().scope
  return { context, slots, scope, settingsEntry, workspaceStops, setLocale: (locale: 'zh' | 'en') => { active = locale } }
}

describe('Mnemon Web client composition', () => {
  it('keeps a locale-bound Sidebar with Source child-render authority and conversation actions', async () => {
    const { context, slots, scope, settingsEntry, setLocale } = workspaceContext({})
    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'connection', 'locale'])
    expect(context.locale.register).toHaveBeenCalledWith('mnemon', { zh, en })
    await vi.waitFor(() => expect(slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'shell.overlay', id: 'mnemon', children: { 'mnemon.source.page': { kind: 'list', scope: 'root' } } }),
      expect.objectContaining({ name: 'conversation.chat.assistant-actions', id: 'mnemon-save' }),
    ])))
    const props = (settingsEntry.inject as () => { t: (key: keyof typeof zh) => string })()
    expect(props.t('config.scope')).toBe('存储范围')
    expect((settingsEntry.label as () => string)()).toBe('记忆系统')
    const save = slots.find(options => options.name === 'conversation.chat.assistant-actions')!
    expect((save.inject as (id: string) => { settingsScope: unknown })('session-1').settingsScope).toBe(scope)
    setLocale('en')
    expect((settingsEntry.label as () => string)()).toBe('Memory System')
    expect(props.t('config.scope')).toBe('Storage scope')
    expect(slots.some(options => options.name === 'conversation.view')).toBe(false)
  })

  it.each([undefined, 'sidebar'])('keeps one complete Sidebar for displayMode=%s with live visibility', async displayMode => {
    const { slots, scope, workspaceStops } = workspaceContext({ displayMode })
    await vi.waitFor(() => expect(workspaceStops).toHaveLength(1))
    expect(mountBetterSidebar).toHaveBeenCalledTimes(1)
    const shellEntry = slots.find(options => options.name === 'shell.overlay')!
    const shellProps = (shellEntry.inject as () => Record<string, unknown>)()
    expect(mountBetterSidebar.mock.calls[0]![2]).toBe(shellProps.betterSidebarSeat)
    const firstBetterSidebarStop = mountBetterSidebar.mock.results[0]!.value
    await scope.setPath(['displayMode'], 'sidebar')
    expect(workspaceStops).toHaveLength(1)
    expect(workspaceStops[0]).not.toHaveBeenCalled()
    await scope.set('tabEnabled', false)
    await scope.set('tabEnabled', false)
    expect(workspaceStops[0]).toHaveBeenCalledOnce()
    expect(firstBetterSidebarStop).toHaveBeenCalledOnce()
    await scope.set('tabEnabled', true)
    expect(workspaceStops).toHaveLength(2)
    expect(mountBetterSidebar).toHaveBeenCalledTimes(2)
    expect(slots.some(options => options.name === 'conversation.view')).toBe(false)
  })

  it.each(['builtin', 'buildin'])('mounts displayMode=%s through the owning session and the same Source page slot', async displayMode => {
    const { context, slots, scope, workspaceStops } = workspaceContext({ displayMode })
    await vi.waitFor(() => expect(workspaceStops).toHaveLength(1))
    expect(slots.some(options => options.name === 'shell.overlay')).toBe(false)
    expect(mountBetterSidebar).not.toHaveBeenCalled()
    const entry = slots.find(options => options.name === 'conversation.view')!
    expect(entry).toMatchObject({ id: 'mnemon', order: 30, children: { 'mnemon.source.page': { kind: 'list', scope: 'root' } } })
    expect(context.slots.register).toHaveBeenCalledWith(entry, MnemonBuiltinWorkspaceHost)
    const props = (entry.inject as (sessionId: string) => Record<string, unknown>)('session-2')
    expect(props).toMatchObject({ connection: context.connection, settingsScope: scope, sessionId: 'session-2', localeRuntime: context.locale })
    for (const key of ['workspaceId', 'workspaceSelection', 'sessions', 'workspaces', 'onClose']) expect(props).not.toHaveProperty(key)

    await scope.set('displayMode', 'builtin')
    await scope.set('storageScope', 'workspace')
    expect(workspaceStops).toHaveLength(1)
    expect(workspaceStops[0]).not.toHaveBeenCalled()
    await scope.set('displayMode', 'sidebar')
    expect(workspaceStops[0]).toHaveBeenCalledOnce()
    expect(workspaceStops).toHaveLength(2)
    expect(mountBetterSidebar).toHaveBeenCalledTimes(1)
    expect(slots.at(-1)).toMatchObject({ name: 'shell.overlay' })
    await scope.set('displayMode', 'builtin')
    expect(workspaceStops[1]).toHaveBeenCalledOnce()
    expect(mountBetterSidebar.mock.results[0]!.value).toHaveBeenCalledOnce()
    expect(workspaceStops).toHaveLength(3)
    expect(slots.at(-1)).toMatchObject({ name: 'conversation.view' })
    await scope.set('tabEnabled', false)
    await scope.set('tabEnabled', false)
    expect(workspaceStops[2]).toHaveBeenCalledOnce()
    await scope.set('tabEnabled', true)
    expect(workspaceStops).toHaveLength(4)
    expect(slots.at(-1)).toMatchObject({ name: 'conversation.view' })
  })

  it('does not flash an entry while persisted visibility is loading', async () => {
    const ready = Promise.withResolvers<Record<string, unknown>>()
    const { scope, workspaceStops } = workspaceContext({}, () => ready.promise)
    expect(workspaceStops).toHaveLength(0)
    ready.resolve({ displayMode: 'buildin', tabEnabled: false })
    await vi.waitFor(() => expect(scope.getSnapshot().status).toBe('ready'))
    expect(workspaceStops).toHaveLength(0)
    await scope.set('tabEnabled', true)
    expect(workspaceStops).toHaveLength(1)
  })

  it('does not flash Sidebar before a saved Builtin preference loads', async () => {
    const ready = Promise.withResolvers<Record<string, unknown>>()
    const { slots, workspaceStops } = workspaceContext({}, () => ready.promise)
    expect(workspaceStops).toHaveLength(0)
    ready.resolve({ displayMode: 'builtin' })
    await vi.waitFor(() => expect(workspaceStops).toHaveLength(1))
    expect(slots.some(options => options.name === 'shell.overlay')).toBe(false)
    expect(slots.some(options => options.name === 'conversation.view')).toBe(true)
  })

  it('keeps the default Sidebar available when settings cannot be loaded', async () => {
    const { slots, scope, workspaceStops } = workspaceContext({}, async () => { throw new Error('offline') })
    await vi.waitFor(() => expect(scope.getSnapshot().status).toBe('unavailable'))
    expect(workspaceStops).toHaveLength(1)
    expect(slots.some(options => options.name === 'shell.overlay')).toBe(true)
  })
})
