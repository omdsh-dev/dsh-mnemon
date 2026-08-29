import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { MnemonSettingsScope } from '../src/client/settings.ts'
import { MnemonView } from '../src/client/MnemonView.tsx'
import type { Config } from '../src/shared/contracts.ts'

const { mountWorkspace, mountBetterSidebar } = vi.hoisted(() => ({
  mountWorkspace: vi.fn(() => vi.fn()),
  mountBetterSidebar: vi.fn(() => vi.fn()),
}))
vi.mock('../src/client/workspace-mount.tsx', () => ({ mountMnemonWorkspace: mountWorkspace }))
vi.mock('../src/client/better-sidebar.tsx', () => ({ mountBetterSidebarTab: mountBetterSidebar }))
afterEach(() => vi.clearAllMocks())

function workspaceContext(initialValue: Record<string, unknown>, load: () => Promise<Record<string, unknown>> = async () => initialValue) {
  let value = initialValue
  let revision = 0
  const slots: Record<string, unknown>[] = []
  const slotDisposers = new Map<Record<string, unknown>, ReturnType<typeof vi.fn>>()
  const disposers: Array<() => void> = []
  const context = {
    connection: { rpc: { call: vi.fn(async (_channel: string, endpoint: string, payload: { namespace?: string; ops?: Array<{ path: string[]; value?: unknown }> }) => {
      if (payload.namespace === 'mnemon') {
        if (endpoint === 'get') value = await load()
        else {
          value = { ...value, ...Object.fromEntries((payload.ops ?? []).map(op => [op.path[0], op.value])) }
          revision += 1
        }
      }
      return { ok: true, value: { status: 'ready', value: payload.namespace === 'mnemon-ui' ? {} : value, base: {}, user: value, revision, writable: true, mode: 'host' } }
    }) } },
    effect: vi.fn((callback: () => unknown) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }),
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (key: keyof typeof zh) => zh[key]),
      getSnapshot: vi.fn(() => ({ active: 'zh' as const, locales: [], revision: 0 })),
      subscribe: vi.fn(() => () => {}),
    },
    slots: {
      inject: vi.fn((_name: string, factory: () => unknown) => factory()),
      register: vi.fn((options: Record<string, unknown>, _component?: unknown) => {
        slots.push(options)
        const dispose = vi.fn()
        slotDisposers.set(options, dispose)
        return dispose
      }),
    },
  }
  apply(context)
  const settingsEntry = slots.find(options => options.name === 'settings.section')!
  const scope = (settingsEntry.inject as () => { scope: MnemonSettingsScope<Config> })().scope
  return { context, slots, slotDisposers, scope, dispose: () => { for (const dispose of disposers.splice(0).reverse()) dispose() } }
}

describe('Mnemon Web client composition', () => {
  it('registers locale dictionaries and keeps one canonical default workspace locale-bound', async () => {
    let active: 'zh' | 'en' = 'zh'
    const slots: Record<string, unknown>[] = []
    const registerLocale = vi.fn(() => () => {})
    const context = {
      connection: { rpc: { call: vi.fn(async () => ({ ok: true, value: { status: 'ready', value: {}, writable: true, mode: 'host' } })) } },
      effect: vi.fn((callback: () => unknown) => callback()),
      locale: {
        register: registerLocale,
        bind: vi.fn(() => (key: keyof typeof zh) => (active === 'zh' ? zh : en)[key]),
        getSnapshot: vi.fn(() => ({ active, locales: [], revision: 0 })),
        subscribe: vi.fn(() => () => {}),
      },
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => factory()),
        register: vi.fn((options: Record<string, unknown>) => { slots.push(options); return () => {} }),
      },
    }

    apply(context)

    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'connection', 'locale'])
    expect(registerLocale).toHaveBeenCalledWith('mnemon', { zh, en })
    await vi.waitFor(() => expect(slots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'conversation.view', id: 'mnemon',
        children: { 'mnemon.source.page': { kind: 'list', scope: 'session' } },
      }),
    ])))
    expect(slots).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'settings.section', id: 'mnemon', order: 20 })]))
    const settingsEntry = slots.find(options => options.name === 'settings.section')
    const settingsInject = settingsEntry?.inject as (() => { scope: unknown; t: (key: keyof typeof zh) => string }) | undefined
    expect(settingsInject?.().t('config.scope')).toBe('存储范围')
    expect((settingsEntry?.label as () => string)()).toBe('记忆系统')
    await vi.waitFor(() => expect(slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'conversation.chat.assistant-actions', id: 'mnemon-save' }),
    ])))
    const saveEntry = slots.find(options => options.name === 'conversation.chat.assistant-actions')
    const saveProps = (saveEntry?.inject as (sessionId: string) => { settingsScope: unknown })('session-1')
    expect(saveProps.settingsScope).toBe(settingsInject?.().scope)
    active = 'en'
    expect((settingsEntry?.label as () => string)()).toBe('Memory System')
    expect(settingsInject?.().t('config.scope')).toBe('Storage scope')
  })

  it('atomically remounts the canonical workspace appearance when display mode changes', async () => {
    let displayMode: 'sidebar' | 'buildin' = 'buildin'
    const slots: Record<string, unknown>[] = []
    const conversationDisposer = vi.fn()
    const call = vi.fn(async (_channel: string, endpoint: string, payload: { namespace?: string; ops?: Array<{ path: string[]; value?: unknown }> }) => {
      if (endpoint === 'mutate' && payload.namespace === 'mnemon') {
        const edit = payload.ops?.find(op => op.path[0] === 'displayMode')
        if (edit?.value === 'sidebar' || edit?.value === 'buildin') displayMode = edit.value
      }
      return {
        ok: true,
        value: {
          status: 'ready', value: payload.namespace === 'mnemon-ui' ? {} : { displayMode },
          base: {}, user: { displayMode }, revision: 1, writable: true, mode: 'host',
        },
      }
    })
    const context = {
      connection: { rpc: { call } },
      effect: vi.fn((callback: () => unknown) => callback()),
      locale: {
        register: vi.fn(() => () => {}),
        bind: vi.fn(() => (key: keyof typeof zh) => zh[key]),
        getSnapshot: vi.fn(() => ({ active: 'zh' as const, locales: [], revision: 0 })),
        subscribe: vi.fn(() => () => {}),
      },
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => factory()),
        register: vi.fn((options: Record<string, unknown>) => {
          slots.push(options)
          return options.name === 'conversation.view' ? conversationDisposer : () => {}
        }),
      },
    }

    await scope.set('tabEnabled', false)
    await scope.set('tabEnabled', false)
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(mountBetterSidebar.mock.results[0]!.value).toHaveBeenCalledTimes(1)
    expect(mountWorkspace).toHaveBeenCalledTimes(1)
    await scope.set('tabEnabled', true)
    expect(mountWorkspace).toHaveBeenCalledTimes(2)
    expect(mountBetterSidebar).toHaveBeenCalledTimes(2)
    expect(slots.some(options => options.name === 'conversation.view')).toBe(false)
    dispose()
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(mountWorkspace.mock.results[1]!.value).toHaveBeenCalledTimes(1)
    expect(mountBetterSidebar.mock.results[1]!.value).toHaveBeenCalledTimes(1)
  })

  it.each(['builtin', 'buildin'] as const)('reuses MnemonView for %s and switches either entry live without duplicates', async displayMode => {
    const { context, slots, slotDisposers, scope, dispose } = workspaceContext({ displayMode })
    await vi.waitFor(() => expect(slots.some(options => options.name === 'conversation.view')).toBe(true))
    expect(mountWorkspace).not.toHaveBeenCalled()
    expect(mountBetterSidebar).not.toHaveBeenCalled()
    const entry = slots.find(options => options.name === 'conversation.view')!
    expect(entry).toMatchObject({ id: 'mnemon', order: 30 })
    expect(context.slots.register).toHaveBeenCalledWith(entry, MnemonView)
    const props = (entry.inject as (sessionId: string) => Record<string, unknown>)('session-2')
    expect(props).toMatchObject({ connection: context.connection, settingsScope: scope, sessionId: 'session-2', surface: 'builtin', locale: 'zh' })
    expect(props).not.toHaveProperty('workspaceId')
    expect(props).not.toHaveProperty('workspaceSelection')
    expect(props).not.toHaveProperty('onClose')

    expect(conversationDisposer).toHaveBeenCalledTimes(1)
    expect(slots.filter(options => options.name === 'conversation.view')).toHaveLength(2)
    const sidebarEntry = slots.filter(options => options.name === 'conversation.view').at(-1)
    expect((sidebarEntry?.inject as () => { surface: string })().surface).toBe('sidebar')
    expect(sidebarEntry?.children).toEqual({ 'mnemon.source.page': { kind: 'list', scope: 'session' } })
  })
})
