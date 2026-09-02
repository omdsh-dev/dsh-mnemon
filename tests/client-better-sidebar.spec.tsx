// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/MnemonView.tsx', () => ({
  MnemonView: ({ sessionId, workspaceId, locale, onClose, active, renderSlot, sourcePageDirectory }: {
    sessionId?: string
    workspaceId?: string
    locale?: string
    onClose?: () => void
    active?: boolean
    renderSlot?: unknown
    sourcePageDirectory?: { getSnapshot(): readonly unknown[] }
  }) => <div
    data-testid="mnemon-better-sidebar-view"
    data-session-id={sessionId}
    data-workspace-id={workspaceId}
    data-locale={locale}
    data-active={String(active)}
    data-has-close={String(onClose !== undefined)}
    data-has-source-renderer={String(renderSlot !== undefined)}
    data-source-pages={String(sourcePageDirectory?.getSnapshot().length ?? 0)}
  />,
}))

import { MNEMON_BETTER_SIDEBAR_TAB_ID, mountBetterSidebarTab } from '../src/client/better-sidebar.tsx'
import { MnemonSourcePageOutlet } from '../src/client/source-page-outlet.ts'

interface Descriptor {
  id: string
  title: string | (() => string)
  order?: number
  single?: boolean
  icon?: ReactNode | ((size: number) => ReactNode)
  component: (props: { scope: { sessionId: string; cwd?: string }; visible: boolean }) => ReactNode
}

function service() {
  const dispose = vi.fn()
  const registerTab = vi.fn((_descriptor: Descriptor) => dispose)
  return { registerTab, dispose }
}

function context() {
  let currentService: ReturnType<typeof service> | undefined
  let serviceListener: ((name: string) => void) | undefined
  const unsubscribe = vi.fn()
  const localeSnapshot = { active: 'zh' as const, locales: [] as const, revision: 0 }
  const sessionSnapshot = { current: 'session-current', byId: { 'session-current': { cwd: '/workspace/current' } } }
  const workspaceSnapshot = { items: [
    { workspaceId: 'workspace-current', title: 'Current', path: '/workspace/current' },
    { workspaceId: 'workspace-target', title: 'Target', path: 'C:\\workspace\\target' },
  ] }
  const value = {
    connection: { rpc: { call: vi.fn() } },
    get: vi.fn((name: string) => name === 'betterSidebar' ? currentService : undefined),
    on: vi.fn((_name: string, listener: (name: string) => void) => {
      serviceListener = listener
      return unsubscribe
    }),
    locale: {
      getSnapshot: () => localeSnapshot,
      subscribe: () => () => {},
    },
    sessions: {
      list: {
        getSnapshot: () => sessionSnapshot,
        subscribe: () => () => {},
      },
    },
    workspaces: {
      list: {
        getSnapshot: () => workspaceSnapshot,
        subscribe: () => () => {},
      },
    },
  }
  return {
    value,
    setService(next: ReturnType<typeof service> | undefined) {
      currentService = next
      serviceListener?.('betterSidebar')
    },
    notifyOtherService() { serviceListener?.('unrelated') },
    unsubscribe,
  }
}

const settings = {
  getSnapshot: () => ({ status: 'ready' as const, value: {}, writable: true, mode: 'host' as const }),
  subscribe: () => () => {}, set: async () => {}, unset: async () => {}, setPath: async () => {}, unsetPath: async () => {},
}
const sourcePages = { getSnapshot: () => [{ id: 'runtime/entries' }] as const, subscribe: () => () => {} }

afterEach(() => vi.restoreAllMocks())

describe('Better Sidebar integration', () => {
  it('registers across either activation order and follows service replacement lifetime', () => {
    const ctx = context()
    const first = service()
    const second = service()
    const dispose = mountBetterSidebarTab(ctx.value as never, settings as never, key => key === 'tab.label' ? '记忆系统' : key, sourcePages as never, new MnemonSourcePageOutlet())

    expect(first.registerTab).not.toHaveBeenCalled()
    ctx.setService(first)
    expect(first.registerTab).toHaveBeenCalledTimes(1)
    ctx.notifyOtherService()
    expect(first.registerTab).toHaveBeenCalledTimes(1)

    const descriptor = first.registerTab.mock.calls[0]![0]
    expect(descriptor).toMatchObject({ id: MNEMON_BETTER_SIDEBAR_TAB_ID, order: 55, single: true })
    expect(typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title).toBe('记忆系统')
    expect(descriptor.icon).toBeTypeOf('function')

    ctx.setService(second)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.registerTab).toHaveBeenCalledTimes(1)
    ctx.setService(undefined)
    expect(second.dispose).toHaveBeenCalledTimes(1)

    dispose()
    expect(ctx.unsubscribe).toHaveBeenCalledTimes(1)
    expect(second.dispose).toHaveBeenCalledTimes(1)
  })

  it('uses the tab scope, visibility, and the existing DSH Source-page outlet', async () => {
    const ctx = context()
    const sidebar = service()
    const sourcePageOutlet = new MnemonSourcePageOutlet()
    ctx.setService(sidebar)
    const dispose = mountBetterSidebarTab(ctx.value as never, settings as never, key => String(key), sourcePages as never, sourcePageOutlet)
    const descriptor = sidebar.registerTab.mock.calls[0]![0]
    const view = render(descriptor.component({
      scope: { sessionId: 'session-target', cwd: 'C:\\workspace\\target\\' },
      visible: true,
    }) as ReactElement)

    await waitFor(() => expect(screen.getByTestId('mnemon-better-sidebar-view').getAttribute('data-workspace-id')).toBe('workspace-target'))
    const content = screen.getByTestId('mnemon-better-sidebar-view')
    expect(content.getAttribute('data-session-id')).toBe('session-target')
    expect(content.getAttribute('data-locale')).toBe('zh')
    expect(content.getAttribute('data-active')).toBe('true')
    expect(content.getAttribute('data-has-close')).toBe('false')
    expect(content.getAttribute('data-source-pages')).toBe('1')
    expect(content.getAttribute('data-has-source-renderer')).toBe('false')

    const renderSlot = vi.fn(() => null)
    let detach = () => {}
    act(() => { detach = sourcePageOutlet.attach(renderSlot as never) })
    expect(content.getAttribute('data-has-source-renderer')).toBe('true')

    view.rerender(descriptor.component({ scope: { sessionId: 'session-target', cwd: 'C:\\workspace\\target\\' }, visible: false }) as ReactElement)
    expect(content.getAttribute('data-active')).toBe('false')
    act(() => detach())
    expect(content.getAttribute('data-has-source-renderer')).toBe('false')
    dispose()
  })
})
