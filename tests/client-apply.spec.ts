import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { MnemonSettingsScope } from '../src/client/settings.ts'
import { MnemonView } from '../src/client/MnemonView.tsx'
import type { Config } from '../src/shared/contracts.ts'

const { mountWorkspace } = vi.hoisted(() => ({ mountWorkspace: vi.fn(() => vi.fn()) }))
vi.mock('../src/client/workspace-mount.tsx', () => ({ mountMnemonWorkspace: mountWorkspace }))
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
  it('registers locale dictionaries and keeps settings locale-bound without a conversation tab', async () => {
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
    expect(slots.find(options => options.name === 'conversation.view')).toBeUndefined()
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

  it.each([undefined, 'sidebar'])('mounts sidebar with displayMode=%s and honors live visibility', async displayMode => {
    const { slots, scope, dispose } = workspaceContext({ displayMode })
    await vi.waitFor(() => expect(mountWorkspace).toHaveBeenCalledTimes(1))
    expect(slots.some(options => options.name === 'conversation.view')).toBe(false)
    const firstDispose = mountWorkspace.mock.results[0]!.value
    await scope.set('storageScope', 'workspace')
    expect(mountWorkspace).toHaveBeenCalledTimes(1)
    expect(firstDispose).not.toHaveBeenCalled()

    await scope.set('tabEnabled', false)
    await scope.set('tabEnabled', false)
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(mountWorkspace).toHaveBeenCalledTimes(1)
    await scope.set('tabEnabled', true)
    expect(mountWorkspace).toHaveBeenCalledTimes(2)
    expect(slots.some(options => options.name === 'conversation.view')).toBe(false)
    dispose()
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(mountWorkspace.mock.results[1]!.value).toHaveBeenCalledTimes(1)
  })

  it.each(['builtin', 'buildin'] as const)('reuses MnemonView for %s and switches either entry live without duplicates', async displayMode => {
    const { context, slots, slotDisposers, scope, dispose } = workspaceContext({ displayMode })
    await vi.waitFor(() => expect(slots.some(options => options.name === 'conversation.view')).toBe(true))
    expect(mountWorkspace).not.toHaveBeenCalled()
    const entry = slots.find(options => options.name === 'conversation.view')!
    expect(entry).toMatchObject({ id: 'mnemon', order: 30 })
    expect(context.slots.register).toHaveBeenCalledWith(entry, MnemonView)
    const props = (entry.inject as (sessionId: string) => Record<string, unknown>)('session-2')
    expect(props).toMatchObject({ connection: context.connection, settingsScope: scope, sessionId: 'session-2', surface: 'builtin', locale: 'zh' })
    expect(props).not.toHaveProperty('workspaceId')
    expect(props).not.toHaveProperty('workspaceSelection')
    expect(props).not.toHaveProperty('onClose')

    await scope.set('displayMode', 'builtin')
    expect(slotDisposers.get(entry)).not.toHaveBeenCalled()
    expect(slots.filter(options => options.name === 'conversation.view')).toHaveLength(1)

    await scope.set('storageScope', 'workspace')
    expect(slotDisposers.get(entry)).not.toHaveBeenCalled()
    expect(slots.filter(options => options.name === 'conversation.view')).toHaveLength(1)
    await scope.set('displayMode', 'sidebar')
    expect(slotDisposers.get(entry)).toHaveBeenCalledTimes(1)
    expect(mountWorkspace).toHaveBeenCalledTimes(1)
    await scope.set('displayMode', 'sidebar')
    expect(mountWorkspace).toHaveBeenCalledTimes(1)
    await scope.set('displayMode', 'builtin')
    expect(mountWorkspace.mock.results[0]!.value).toHaveBeenCalledTimes(1)
    const secondEntry = slots.filter(options => options.name === 'conversation.view')[1]!
    expect(secondEntry).toBeTruthy()

    await scope.set('tabEnabled', false)
    expect(slotDisposers.get(secondEntry)).toHaveBeenCalledTimes(1)
    await scope.set('displayMode', 'sidebar')
    expect(mountWorkspace).toHaveBeenCalledTimes(1)
    await scope.set('tabEnabled', true)
    expect(mountWorkspace).toHaveBeenCalledTimes(2)
    dispose()
    expect(mountWorkspace.mock.results[1]!.value).toHaveBeenCalledTimes(1)
    expect(slotDisposers.get(entry)).toHaveBeenCalledTimes(1)
    expect(slotDisposers.get(secondEntry)).toHaveBeenCalledTimes(1)
  })

  it('does not flash an entry while a persisted hidden workspace is loading', async () => {
    let ready!: (value: Record<string, unknown>) => void
    const loading = new Promise<Record<string, unknown>>(resolve => { ready = resolve })
    const { scope, slots, dispose } = workspaceContext({}, () => loading)
    expect(mountWorkspace).not.toHaveBeenCalled()
    ready({ displayMode: 'builtin', tabEnabled: false })
    await vi.waitFor(() => expect(scope.getSnapshot().status).toBe('ready'))
    expect(mountWorkspace).not.toHaveBeenCalled()
    expect(slots.some(options => options.name === 'conversation.view')).toBe(false)
    await scope.set('tabEnabled', true)
    expect(mountWorkspace).not.toHaveBeenCalled()
    expect(slots.some(options => options.name === 'conversation.view')).toBe(true)
    dispose()
  })

  it.each(['builtin', 'buildin'] as const)('does not flash the default sidebar while persisted %s is loading', async displayMode => {
    let ready!: (value: Record<string, unknown>) => void
    const { slots, slotDisposers, dispose } = workspaceContext({}, () => new Promise(resolve => { ready = resolve }))
    expect(mountWorkspace).not.toHaveBeenCalled()
    expect(slots.some(options => options.name === 'conversation.view')).toBe(false)
    ready({ displayMode })
    await vi.waitFor(() => expect(slots.some(options => options.name === 'conversation.view')).toBe(true))
    expect(mountWorkspace).not.toHaveBeenCalled()
    const entry = slots.find(options => options.name === 'conversation.view')!
    dispose()
    expect(slotDisposers.get(entry)).toHaveBeenCalledTimes(1)
  })

  it('keeps the sidebar available when the settings service is unavailable', async () => {
    const { scope, dispose } = workspaceContext({}, async () => { throw new Error('offline') })
    await vi.waitFor(() => expect(scope.getSnapshot().status).toBe('unavailable'))
    expect(mountWorkspace).toHaveBeenCalledTimes(1)
    dispose()
  })
})
