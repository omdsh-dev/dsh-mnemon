// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContext, createElement, useContext, useSyncExternalStore, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const workbenchMock = vi.hoisted(() => ({ mode: 'canonical' as 'canonical' | 'native' }))

vi.mock('../src/client/MnemonWorkbench.tsx', () => ({
  MnemonWorkbench: ({ sessionId, workspaceId, workspaceSelection, t, locale, onClose, surface, active, titleBar, renderSlot }: {
    sessionId?: string
    workspaceId?: string
    t?: (key: string) => string
    locale?: 'zh' | 'en'
    surface?: 'sidebar' | 'builtin'
    active?: boolean
    titleBar?: boolean
    onClose?: () => void
    renderSlot?: (name: string, props: unknown, options: unknown) => ReactNode
    workspaceSelection?: {
      options: Array<{ id: string; title: string }>
      selectedWorkspaceId?: string
      effectiveWorkspaceId?: string
      onSelect(id: string): void
      onAlign(): void
    }
  }) => workbenchMock.mode === 'native'
    ? <div data-testid="native-memory" data-active={active} data-title-bar={titleBar}>
        <input aria-label="Retained editor" defaultValue="draft" />
        <button onClick={onClose}>Return to conversation</button>
        {renderSlot?.('mnemon.source.page', {}, {})}
      </div>
    : <div data-testid="mnemon-canonical-content" data-active={active} data-session-id={sessionId} data-workspace-id={workspaceId} data-effective-workspace-id={workspaceSelection?.effectiveWorkspaceId} data-locale={locale} data-surface={surface} data-has-workspace-picker={workspaceSelection !== undefined} data-has-back-action={onClose !== undefined} data-has-source-renderer={renderSlot !== undefined}>
        <h1>{t?.('tab.label')}</h1>
        <span>{sessionId ?? 'no-session'}</span>
        <select aria-label="workspace-test-selector" value={workspaceSelection?.selectedWorkspaceId ?? ''} onChange={event => workspaceSelection?.onSelect(event.target.value)}>
          {workspaceSelection?.options.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
        </select>
        <button type="button" onClick={workspaceSelection?.onAlign}>align-test-workspace</button>
        <button type="button" aria-label={t?.('header.backToConversation')} onClick={onClose}>back-test-conversation</button>
        {renderSlot?.('mnemon.source.page', {}, {})}
      </div>,
}))

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MnemonWorkspaceHost,
  MnemonSidebarWorkspaceHost,
  MnemonBuiltinWorkspaceHost,
} from '../src/client/workspace-mount.tsx'
import { MNEMON_BETTER_SIDEBAR_TAB_ID, mountBetterSidebarTab } from '../src/client/better-sidebar.tsx'
import { inject } from '../src/client/index.ts'
import { MNEMON_MAIN_PANEL_ID, mountMnemonSidebarNavigation } from '../src/client/native-sidebar.tsx'
import { MnemonNativeSidebarSeat } from '../src/client/native-sidebar-seat.ts'
import type { MnemonTranslate } from '../src/client/locales.ts'

import { MnemonWorkspaceController } from '../src/client/workspace-controller.ts'
import { MnemonBetterSidebarSeat } from '../src/client/better-sidebar-seat.ts'
import type { Config } from '../src/host/protocol.ts'
import { settingsScope } from './helpers/settings-scope.ts'

let currentDispose: (() => void) | undefined
const siblingDisposers: Array<() => void> = []

/** The released Web UI panels only close for each other's legacy event names. */
function mountSiblingPanel(name: 'taskboard' | 'ssh', announce = true) {
  const attribute = `data-dsh-${name}-active`
  const sibling = name === 'taskboard' ? 'ssh' : 'taskboard'
  const entry = document.querySelector<HTMLButtonElement>(`[data-dsh-${name}-entry]`)!
  let open = false
  const refresh = () => {
    if (open) {
      document.documentElement.removeAttribute(`data-dsh-${sibling}-active`)
      document.documentElement.setAttribute(attribute, '')
      if (announce) document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: name }))
    } else document.documentElement.removeAttribute(attribute)
  }
  const onClick = () => { open = !open; refresh() }
  const onActivate = (event: Event) => {
    if ((event as CustomEvent<unknown>).detail === sibling && open) { open = false; refresh() }
  }
  entry.addEventListener('click', onClick)
  document.addEventListener('dsh-panel-activate', onActivate)
  siblingDisposers.push(() => {
    entry.removeEventListener('click', onClick)
    document.removeEventListener('dsh-panel-activate', onActivate)
  })
  return { entry, refresh, isOpen: () => open }
}

function wireTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  for (const tab of tabs) tab.addEventListener('click', () => {
    for (const candidate of tabs) candidate.setAttribute('aria-selected', String(candidate === tab))
  })
}

function renderShell(advanced = false): void {
  document.body.innerHTML = advanced
    ? `<div class="dshDesktopFrame">
        <aside class="dshDesktopUpstreamSidebar"><div class="logoRow"><button class="newSession">New</button></div><button data-dsh-taskboard-entry>Tasks</button><button data-dsh-ssh-entry>SSH</button></aside>
        <main class="dshDesktopConversationSurface"><div role="tablist"><button role="tab" aria-selected="true">Chat</button><button role="tab" aria-selected="false">Memory</button></div><div data-chat-content>Chat stays mounted</div></main>
      </div>`
    : `<div data-dsh-frame>
        <aside data-pane="sidebar"><div class="sidebarRoot"><div class="logoRow"><button class="newSession">New</button></div><button data-dsh-taskboard-entry>Tasks</button><button data-dsh-ssh-entry>SSH</button><button class="sessionRow">Session</button></div></aside>
        <main data-pane="conversation"><div role="tablist"><button role="tab" aria-selected="true">Chat</button><button role="tab" aria-selected="false">Memory</button></div><div data-chat-content>Chat stays mounted</div></main>
      </div>`
  wireTabs()
}

function context(locale?: { getSnapshot(): { active: 'zh' | 'en'; locales: readonly never[]; revision: number }; subscribe(listener: () => void): () => void }) {
  const fallbackLocale = { active: 'zh' as const, locales: [] as const, revision: 0 }
  const snapshot = {
    ids: ['session-1'],
    byId: { 'session-1': { cwd: '/tmp/workspace-one' } },
    current: 'session-1',
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
  const workspaceSnapshot = {
    items: [
      { workspaceId: 'workspace-1', title: 'Workspace One', path: '/tmp/workspace-one' },
      { workspaceId: 'workspace-2', title: 'Workspace Two', path: '/tmp/workspace-two' },
    ],
  }
  return {
    connection: { rpc: { call: vi.fn() } },
    locale: locale ?? { getSnapshot: () => fallbackLocale, subscribe: () => () => {} },
    sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } },
    currentSession: { getSnapshot: () => ({ key: 'session-1', hooks: {}, keyedHooks: {}, props: {} }), subscribe: () => () => {} },
    workspaces: { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } },
    // A shell that never declares DSH's native panel seats: navigation falls back to Mnemon's own entry.
    slots: { inject: () => () => {} },
  }
}

/** The sidebar entry the product mounts where the layout offers no native panel seat. */
function mountFallbackEntry(ctx: unknown, t: MnemonTranslate, controller: MnemonWorkspaceController): () => void {
  return mountMnemonSidebarNavigation(ctx as never, t as never, controller, new MnemonNativeSidebarSeat()).dispose
}

function receiverSensitiveStore<T>(snapshot: T) {
  let reads = 0
  const store = {
    get reads(): number { return reads },
    getSnapshot(): T {
      if (this !== store) throw new Error('store receiver was lost')
      reads += 1
      return snapshot
    },
    subscribe(_listener?: () => void): () => void {
      if (this !== store) throw new Error('store receiver was lost')
      return () => {}
    },
  }
  return store
}

const settings = settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' })
const sourcePageDirectory = { getSnapshot: () => [] as const, subscribe: () => () => {} }
const t = (key: string) => key === 'tab.label' ? 'Memory' : key
const slotOwnerContext = createContext('outside-owner')

function SlotOwnerProbe(): JSX.Element {
  return <span data-testid="slot-owner-probe">{useContext(slotOwnerContext)}</span>
}

describe('Mnemon canonical workspace launcher', () => {
  beforeEach(() => {
    workbenchMock.mode = 'canonical'
    renderShell()
  })
  afterEach(() => {
    currentDispose?.()
    currentDispose = undefined
    for (const stop of siblingDisposers.splice(0)) stop()
    for (const name of ['mnemon', 'taskboard', 'ssh']) document.documentElement.removeAttribute(`data-dsh-${name}-active`)
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('mounts after the official panel family without hijacking the current conversation tab', () => {
    const memoryTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'Memory')!
    const clicked = vi.fn()
    memoryTab.addEventListener('click', clicked)
    currentDispose = mountFallbackEntry(context() as never, t as never, new MnemonWorkspaceController())

    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    expect(entry.previousElementSibling?.hasAttribute('data-dsh-ssh-entry')).toBe(true)
    fireEvent.click(entry)
    expect(clicked).not.toHaveBeenCalled()
    expect(entry.dataset.active).toBe('true')
    expect(memoryTab.getAttribute('aria-selected')).toBe('false')
    expect(document.querySelector('[data-chat-content]')?.textContent).toBe('Chat stays mounted')
    expect(document.querySelector('[data-dsh-mnemon-view]')).toBeNull()
  })

  it('participates in the shared skin entry contract without becoming an official New Session button', () => {
    const sidebar = document.querySelector('[data-pane="sidebar"]')!
    sidebar.setAttribute('data-slot', 'sidebar')
    const newSession = sidebar.querySelector('button.newSession')!
    sidebar.querySelector('.logoRow')!.after(newSession)
    currentDispose = mountFallbackEntry(context() as never, t as never, new MnemonWorkspaceController())
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    // ORCA LINK applies its hidden New Session artwork to this exact selector.
    const artworkTargets = sidebar.querySelectorAll(":scope > :first-child > button:not([data-dsh-part='sidebar-entry'])")
    expect([...artworkTargets]).toContain(newSession)
    expect([...artworkTargets]).not.toContain(entry)
    expect(sidebar.querySelector('[data-dsh-plugin="dsh-mnemon"][data-dsh-part="sidebar-entry"]')).toBe(entry)
    expect(entry.getAttribute('aria-label')).toBe('Memory')
    fireEvent.click(entry)
    expect(entry.dataset.active).toBe('true')
  })

  it('portals the Better Sidebar workspace through the shell-owned Source renderer tree', async () => {
    const ctx = context()
    const controller = new MnemonWorkspaceController()
    const betterSidebarSeat = new MnemonBetterSidebarSeat()
    const target = document.createElement('div')
    document.body.append(target)
    const detach = betterSidebarSeat.attach(target, { sessionId: 'session-portaled', cwd: '/tmp/workspace-two' }, true)
    const renderSlot = vi.fn(() => <SlotOwnerProbe />)
    const view = render(<slotOwnerContext.Provider value="dsh-renderer-owner"><MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never} currentSession={ctx.currentSession}
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory}
      navigation={{ open: () => controller.open(), close: () => controller.close() }} t={t as never}
      renderSlot={renderSlot as never} controller={controller} betterSidebarSeat={betterSidebarSeat}
    /></slotOwnerContext.Provider>)

    await waitFor(() => expect(within(target).getByTestId('slot-owner-probe').textContent).toBe('dsh-renderer-owner'))
    const content = within(target).getByTestId('mnemon-canonical-content')
    expect(content.dataset.sessionId).toBe('session-portaled')
    expect(content.dataset.workspaceId).toBe('workspace-2')
    expect(content.dataset.hasBackAction).toBe('false')
    expect(content.dataset.hasSourceRenderer).toBe('true')
    detach()
    await waitFor(() => expect(target.childElementCount).toBe(0))
    view.unmount()
  })

  it('opens the DSH sidebar seat before a session exists and restores the conversation on close', async () => {
    document.querySelector('[role="tablist"]')?.remove()
    const ctx = context()
    const emptySessions = { byId: {} }
    const sessions = { list: { getSnapshot: () => emptySessions, subscribe: () => () => {} } }
    const controller = new MnemonWorkspaceController()
    const navigation = { open: () => controller.open(), close: () => controller.close() }
    const column = document.querySelector<HTMLElement>('[data-pane="conversation"]')!
    column.inert = false
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue({ left: 280, top: 0, width: 1_000, height: 720 } as DOMRect)
    currentDispose = mountFallbackEntry(ctx as never, t as never, controller)
    const view = render(<MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={sessions as never} workspaces={ctx.workspaces as never} currentSession={{ getSnapshot: () => ({ key: undefined, hooks: {}, keyedHooks: {}, props: {} }), subscribe: () => () => {} }}
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory} navigation={navigation}
      t={t as never} renderSlot={() => null} controller={controller}
    />)
    expect(document.querySelector('[data-testid="mnemon-canonical-content"]')).toBeNull()
    fireEvent.click(document.querySelector('[data-dsh-mnemon-entry]')!)
    await waitFor(() => expect(view.getByText('no-session')).not.toBeNull())
    expect(column.inert).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-dsh-mnemon-view]')?.style.width).toBe('1000px')
    expect(document.querySelector('[data-chat-content]')?.textContent).toBe('Chat stays mounted')
    fireEvent.click(view.getByText('back-test-conversation'))
    expect(column.inert).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-dsh-mnemon-view]')?.hidden).toBe(true)
    act(() => controller.open())
    await waitFor(() => expect(view.getByText('no-session')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(column.inert).toBe(false)
    view.unmount()
  })

  it('covers only the center column of the DSH frame', async () => {
    document.body.innerHTML = `<div class="dsh_frame">
      <aside class="dsh_sidebarCol"><div class="sidebarRoot"><div class="logoRow"><button class="newSession">New</button></div></div></aside>
      <main class="dsh_centerCol"><div data-chat-content>Chat stays mounted</div></main>
      <aside class="dsh_rightbarCol"><button>Right bar stays usable</button></aside>
    </div>`
    const center = document.querySelector<HTMLElement>('.dsh_centerCol')!
    const rightbar = document.querySelector<HTMLElement>('.dsh_rightbarCol')!
    center.inert = false
    rightbar.inert = false
    vi.spyOn(center, 'getBoundingClientRect').mockReturnValue({ left: 280, top: 0, width: 430, height: 900 } as DOMRect)
    const ctx = context()
    const controller = new MnemonWorkspaceController()
    const view = render(<MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never} currentSession={ctx.currentSession}
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory}
      navigation={{ open: () => controller.open(), close: () => controller.close() }} t={t as never} renderSlot={() => null} controller={controller}
    />)

    act(() => controller.open())
    await waitFor(() => expect(view.getByTestId('mnemon-canonical-content')).not.toBeNull())
    const panel = document.querySelector<HTMLElement>('[data-dsh-mnemon-view]')!
    expect(panel.style.left).toBe('280px')
    expect(panel.style.top).toBe('0px')
    expect(panel.style.width).toBe('430px')
    expect(panel.style.height).toBe('900px')
    expect(center.inert).toBe(true)
    expect(rightbar.inert).toBe(false)
    expect(document.querySelector('[data-chat-content]')?.textContent).toBe('Chat stays mounted')

    act(() => controller.close())
    expect(center.inert).toBe(false)
    view.unmount()
  })

  it('retains the workspace subtree when a peer panel takes over and the user returns', async () => {
    const ctx = context()
    const controller = new MnemonWorkspaceController()
    currentDispose = mountFallbackEntry(ctx as never, t as never, controller)
    const view = render(<MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never} currentSession={ctx.currentSession}
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory}
      navigation={{ open: () => controller.open(), close: () => controller.close() }} t={t as never} renderSlot={() => null} controller={controller}
    />)
    const entry = document.querySelector('[data-dsh-mnemon-entry]')!
    fireEvent.click(entry)
    const content = await view.findByTestId('mnemon-canonical-content')
    expect(content.getAttribute('data-active')).toBe('true')
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'workspace-2' } })
    fireEvent.click(document.querySelector('[data-dsh-taskboard-entry]')!)
    expect(content.closest<HTMLElement>('[data-dsh-mnemon-view]')?.hidden).toBe(true)
    expect(content.getAttribute('data-active')).toBe('false')
    fireEvent.click(entry)
    expect(view.getByTestId('mnemon-canonical-content')).toBe(content)
    expect(content.getAttribute('data-active')).toBe('true')
    expect(content.getAttribute('data-workspace-id')).toBe('workspace-2')
    view.unmount()
  })

  it('attaches after a delayed conversation column and restores replaced columns', async () => {
    document.querySelector('[data-pane="conversation"]')!.remove()
    const ctx = context()
    const controller = new MnemonWorkspaceController()
    const view = render(<MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never} currentSession={ctx.currentSession}
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory}
      navigation={{ open: () => controller.open(), close: () => controller.close() }} t={t as never} renderSlot={() => null} controller={controller}
    />)
    act(() => controller.open())
    const column = document.createElement('main')
    column.dataset.pane = 'conversation'
    column.inert = false
    document.body.append(column)
    await waitFor(() => expect(column.inert).toBe(true))
    const replacement = document.createElement('main')
    replacement.dataset.pane = 'conversation'
    replacement.inert = false
    column.replaceWith(replacement)
    await waitFor(() => expect(replacement.inert).toBe(true))
    expect(column.inert).toBe(false)
    act(() => controller.close())
    expect(replacement.inert).toBe(false)
    view.unmount()
  })

  it.each(['taskboard', 'ssh'] as const)('returns in one click after %s takes over without an activation announcement', name => {
    const panel = mountSiblingPanel(name, false)
    currentDispose = mountFallbackEntry(context() as never, key => String(key), new MnemonWorkspaceController())
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!

    fireEvent.click(entry)
    fireEvent.click(panel.entry)
    expect(panel.isOpen()).toBe(true)
    expect(entry.hasAttribute('data-active')).toBe(false)
    fireEvent.click(entry)

    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(document.documentElement.hasAttribute(`data-dsh-${name}-active`)).toBe(false)
    expect(panel.isOpen()).toBe(false)
    // A subsequent store/transport refresh must not bring the old panel back.
    panel.refresh()
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(document.documentElement.hasAttribute(`data-dsh-${name}-active`)).toBe(false)
  })

  it('reclaims a hidden workspace even before DOM-state synchronization has run', () => {
    currentDispose = mountFallbackEntry(context() as never, key => String(key), new MnemonWorkspaceController())
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    fireEvent.click(entry)
    document.documentElement.removeAttribute('data-dsh-mnemon-active')
    document.documentElement.setAttribute('data-dsh-taskboard-active', '')
    fireEvent.click(entry)

    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-taskboard-active')).toBe(false)
    expect(entry.getAttribute('data-active')).toBe('true')
  })

  it.each(['taskboard', 'ssh'] as const)('synchronizes its entry when %s takes over programmatically without an event', async name => {
    currentDispose = mountFallbackEntry(context() as never, key => String(key), new MnemonWorkspaceController())
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    fireEvent.click(entry)
    document.documentElement.setAttribute(`data-dsh-${name}-active`, '')

    await waitFor(() => expect(entry.hasAttribute('data-active')).toBe(false))
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)
    fireEvent.click(entry)
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(document.documentElement.hasAttribute(`data-dsh-${name}-active`)).toBe(false)
  })

  it('treats the sidebar entry as navigation and retains an already active workspace', () => {
    const controller = new MnemonWorkspaceController()
    currentDispose = mountFallbackEntry(context() as never, key => String(key), controller)
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    expect(entry.hasAttribute('aria-current')).toBe(false)
    fireEvent.click(entry)
    fireEvent.click(entry)
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(entry.getAttribute('data-active')).toBe('true')
    // As on DSH's own panel rows, the open workspace is the current page (#318).
    expect(entry.getAttribute('aria-current')).toBe('page')
    controller.close()
    expect(entry.hasAttribute('data-active')).toBe(false)
    expect(entry.hasAttribute('aria-current')).toBe(false)
  })

  it.each([true, false])('round-trips with the released legacy panel protocol (Mnemon mounted first: %s)', mnemonFirst => {
    const mount = () => { currentDispose = mountFallbackEntry(context() as never, key => String(key), new MnemonWorkspaceController()) }
    if (mnemonFirst) mount()
    const board = mountSiblingPanel('taskboard')
    const ssh = mountSiblingPanel('ssh')
    if (!mnemonFirst) mount()
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    fireEvent.click(entry)
    for (let round = 0; round < 3; round += 1) {
      for (const panel of [board, ssh]) {
        expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
        fireEvent.click(panel.entry)
        expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)
        fireEvent.click(entry)
        expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
        expect(board.isOpen()).toBe(false)
        expect(ssh.isOpen()).toBe(false)
        board.refresh()
        ssh.refresh()
        expect(document.documentElement.hasAttribute('data-dsh-taskboard-active')).toBe(false)
        expect(document.documentElement.hasAttribute('data-dsh-ssh-active')).toBe(false)
      }
    }
  })

  it('self-heals its sidebar launcher after a React-style row replacement', async () => {
    currentDispose = mountFallbackEntry(context() as never, t as never, new MnemonWorkspaceController())
    document.querySelector('[data-dsh-mnemon-entry]')?.remove()
    await waitFor(() => expect(document.querySelector('[data-dsh-mnemon-entry]')).not.toBeNull())
    currentDispose()
    currentDispose = undefined
    expect(document.querySelector('[data-dsh-mnemon-entry]')).toBeNull()
  })

  it('mounts beside a nested DSH Desktop new-session row without using a foreign anchor', async () => {
    document.body.innerHTML = `<div data-dsh-frame>
      <aside data-pane="sidebar">
        <div class="dshp-root" data-dshp-panel-sidebar>
          <div class="dshp-logoRow"><button>Brand</button></div>
          <div class="dshp-panelArea"><button class="dshp-menuItem dshp-newSession">New</button><div data-slot></div></div>
          <div class="dshp-regionArea"></div>
        </div>
      </aside>
      <main data-pane="conversation"><div data-chat-content>Chat stays mounted</div></main>
    </div>`
    const panelArea = document.querySelector<HTMLElement>('.dshp-panelArea')!
    const slot = panelArea.querySelector<HTMLElement>('[data-slot]')!

    currentDispose = mountFallbackEntry(context() as never, t as never, new MnemonWorkspaceController())

    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    expect(entry.parentElement).toBe(panelArea)
    expect(entry.nextElementSibling).toBe(slot)

    entry.remove()
    await waitFor(() => expect(document.querySelector('[data-dsh-mnemon-entry]')?.parentElement).toBe(panelArea))
  })

  it('mounts the launcher in the DSH advanced frame without replacing conversation content', () => {
    renderShell(true)
    currentDispose = mountFallbackEntry(context() as never, t as never, new MnemonWorkspaceController())
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    fireEvent.click(entry)
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Chat')
    expect(entry.dataset.active).toBe('true')
    expect(document.querySelector('[data-chat-content]')).not.toBeNull()
    expect(document.querySelector('[data-dsh-mnemon-view]')).toBeNull()
  })

  it('keeps receiver-sensitive stores bound inside the canonical host and preserves workspace selection', async () => {
    const ctx = context()
    const sessions = receiverSensitiveStore(ctx.sessions.list.getSnapshot())
    const workspaces = receiverSensitiveStore(ctx.workspaces.list.getSnapshot())
    ctx.sessions.list = sessions
    ctx.workspaces.list = workspaces
    render(<MnemonWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never} currentSession={ctx.currentSession}
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory} navigation={{ open() {}, close() {} }}
      t={t as never} renderSlot={() => null} sessionId="session-1"
    />)

    await waitFor(() => expect(document.querySelector('[data-testid="mnemon-canonical-content"]')?.getAttribute('data-workspace-id')).toBe('workspace-1'))
    expect(sessions.reads).toBeGreaterThan(0)
    expect(workspaces.reads).toBeGreaterThan(0)
    fireEvent.change(document.querySelector('[aria-label="workspace-test-selector"]')!, { target: { value: 'workspace-2' } })
    await waitFor(() => expect(document.querySelector('[data-testid="mnemon-canonical-content"]')?.getAttribute('data-workspace-id')).toBe('workspace-2'))
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'align-test-workspace')!)
    await waitFor(() => expect(document.querySelector('[data-testid="mnemon-canonical-content"]')?.getAttribute('data-workspace-id')).toBe('workspace-1'))
  })

  it('renders Builtin with only its owning session and releases a receiver-sensitive locale subscription', () => {
    let snapshot: { active: 'zh' | 'en'; locales: readonly never[]; revision: number } = { active: 'zh', locales: [], revision: 0 }
    const listeners = new Set<() => void>()
    const locale = {
      getSnapshot() { expect(this).toBe(locale); return snapshot },
      subscribe(listener: () => void) {
        expect(this).toBe(locale)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const ctx = context(locale)
    const translate = (key: string) => key === 'tab.label' ? snapshot.active === 'zh' ? '记忆系统' : 'Memory System' : key
    const props = {
      connection: ctx.connection as never,
      settingsScope: settings,
      localeRuntime: locale as never,
      sourcePageDirectory,
      renderSlot: () => null,
      t: translate as never,
    }
    // No global sessions/workspaces stores, picker or navigation are supplied.
    const view = render(<MnemonBuiltinWorkspaceHost {...props} sessionId="owning-session" />)
    const content = view.getByTestId('mnemon-canonical-content')
    expect(content.dataset.surface).toBe('builtin')
    expect(content.dataset.hasWorkspacePicker).toBe('false')
    expect(content.dataset.hasBackAction).toBe('false')
    expect(content.hasAttribute('data-workspace-id')).toBe(false)
    expect(view.getByText('owning-session')).not.toBeNull()
    expect(view.getByRole('heading').textContent).toBe('记忆系统')
    expect(listeners.size).toBe(1)
    act(() => {
      snapshot = { active: 'en', locales: [], revision: 1 }
      for (const listener of listeners) listener()
    })
    expect(content.dataset.locale).toBe('en')
    expect(view.getByRole('heading').textContent).toBe('Memory System')
    view.rerender(<MnemonBuiltinWorkspaceHost {...props} sessionId="another-owning-session" />)
    expect(view.queryByText('owning-session')).toBeNull()
    expect(view.getByText('another-owning-session')).not.toBeNull()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('updates the launcher label with the DSH locale', async () => {
    let active: 'zh' | 'en' = 'zh'
    let snapshot: { active: 'zh' | 'en'; locales: readonly never[]; revision: number } = { active, locales: [], revision: 0 }
    const listeners = new Set<() => void>()
    const locale = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
    const translate = (key: string) => key === 'tab.label' ? active === 'zh' ? '记忆系统' : 'Memory System' : key
    currentDispose = mountFallbackEntry(context(locale) as never, translate as never, new MnemonWorkspaceController())
    expect(document.querySelector('[data-dsh-mnemon-entry]')?.textContent).toBe('记忆系统')
    active = 'en'
    snapshot = { active, locales: [] as const, revision: 1 }
    for (const listener of listeners) listener()
    await waitFor(() => expect(document.querySelector('[data-dsh-mnemon-entry]')?.textContent).toBe('Memory System'))
  })
})

describe('Better Sidebar integration', () => {
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

  function betterContext() {
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
      locale: { getSnapshot: () => localeSnapshot, subscribe: () => () => {} },
      sessions: { list: { getSnapshot: () => sessionSnapshot, subscribe: () => () => {} } },
      workspaces: { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } },
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

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('registers across either activation order and follows service replacement lifetime', () => {
    const ctx = betterContext()
    const first = service()
    const second = service()
    const dispose = mountBetterSidebarTab(ctx.value as never, key => key === 'tab.label' ? '记忆系统' : key, new MnemonBetterSidebarSeat())

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

  it('publishes only the tab DOM seat, scope, and visibility to the DSH renderer', async () => {
    const ctx = betterContext()
    const sidebar = service()
    const seat = new MnemonBetterSidebarSeat()
    ctx.setService(sidebar)
    const dispose = mountBetterSidebarTab(ctx.value as never, key => String(key), seat)
    const descriptor = sidebar.registerTab.mock.calls[0]![0]
    const view = render(descriptor.component({
      scope: { sessionId: 'session-target', cwd: 'C:\\workspace\\target\\' },
      visible: true,
    }) as ReactElement)

    await waitFor(() => expect(seat.getSnapshot()?.scope).toEqual({ sessionId: 'session-target', cwd: 'C:\\workspace\\target\\' }))
    expect(seat.getSnapshot()?.visible).toBe(true)
    expect(seat.getSnapshot()?.target).toBe(view.container.querySelector('[data-dsh-mnemon-better-sidebar-seat]'))
    expect(view.container.querySelector('[data-testid="mnemon-better-sidebar-view"]')).toBeNull()

    view.rerender(descriptor.component({ scope: { sessionId: 'session-target', cwd: 'C:\\workspace\\target\\' }, visible: false }) as ReactElement)
    await waitFor(() => expect(seat.getSnapshot()?.visible).toBe(false))
    view.unmount()
    expect(seat.getSnapshot()).toBeUndefined()
    dispose()
  })
})

describe('native Sidebar panel integration', () => {
  const releases: Array<() => void> = []
  beforeEach(() => { workbenchMock.mode = 'native' })
  afterEach(() => {
    act(() => { for (const release of releases.splice(0).reverse()) release() })
    cleanup()
    document.body.replaceChildren()
    for (const name of ['mnemon', 'ssh', 'taskboard']) document.documentElement.removeAttribute(`data-dsh-${name}-active`)
  })

  const sourceOwner = createContext('missing-owner')
  function SourceProbe() { return <span>{useContext(sourceOwner)}</span> }

  function nativeFixture(initiallyDeclared = true) {
    const core = new SlotCore()
    const controller = new MnemonWorkspaceController()
    const seat = new MnemonNativeSidebarSeat()
    let activePanel: string | null = null
    let label = 'Memory System'
    const panelListeners = new Set<() => void>()
    const subscribePanel = (listener: () => void) => { panelListeners.add(listener); return () => panelListeners.delete(listener) }
    const getPanel = () => activePanel
    const selectPanel = vi.fn((id: string | null) => {
      if (id !== null && !core.entriesOfSlot('main').some(entry => entry.options.key === id)) throw new Error('Unknown main panel')
      activePanel = id
      for (const listener of panelListeners) listener()
    })
    const layout = { selectPanel }
    const register = core.register.bind(core)
    const declare = () => register({ name: 'root', children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    } } as never, (() => null) as never)
    let stopOwner = initiallyDeclared ? declare() : undefined
    const ctx = {
      layout,
      slots: {
        register,
        inject: (name: string, factory: () => () => void) => {
          let stop: (() => void) | undefined
          const sync = () => {
            if (core.specDynamic(name) !== undefined) stop ??= factory()
            else { const previous = stop; stop = undefined; previous?.() }
          }
          const unsubscribe = core.subscribeDeclaration(name, sync)
          try { sync() } catch (error) { unsubscribe(); throw error }
          return () => { unsubscribe(); stop?.() }
        },
      },
      locale: { subscribe: () => () => {} },
    }
    const mount = () => mountMnemonSidebarNavigation(ctx as never, () => label, controller, seat)
    const navigation = mount()
    releases.push(() => { navigation.dispose(); stopOwner?.() })

    function NativeFrame({ collapsed = false }: { collapsed?: boolean }) {
      useSyncExternalStore(listener => core.subscribe('sidebar.panellist', listener), () => core.getVersion('sidebar.panellist'))
      useSyncExternalStore(listener => core.subscribe('main', listener), () => core.getVersion('main'))
      const selected = useSyncExternalStore(subscribePanel, getPanel)
      const main = core.entriesOfSlot('main').find(entry => entry.options.key === selected)
      return <>
        <nav aria-label="Native panels">
          <button onClick={() => selectPanel(null)}>New Session</button>
          {core.entriesOfSlot('sidebar.panellist').map(entry => {
            const title = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
            const Icon = entry.component as ComponentType<{ size: number; active: boolean }>
            return <button key={entry.options.id} aria-label={title as string} aria-current={selected === entry.options.id ? 'page' : undefined} onClick={() => selectPanel(entry.options.id!)}>
              <Icon size={collapsed ? 18 : 16} active={selected === entry.options.id} />
              {!collapsed && <span>{title as string}</span>}
            </button>
          })}
        </nav>
        <main data-testid="native-main">
          {main === undefined ? <p>Conversation</p> : createElement(main.component as ComponentType, { key: selected, ...main.inject?.() })}
        </main>
      </>
    }
    const locale = { active: 'en', locales: [], revision: 0 }
    const sessions = { byId: {} }
    const workspaces = { items: [] }
    const current = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    function Host() {
      return <sourceOwner.Provider value="shell-source-owner"><MnemonSidebarWorkspaceHost
        controller={controller} nativeSidebarSeat={seat} navigation={navigation}
        connection={{} as never} settingsScope={{} as never}
        sessions={{ list: { getSnapshot: () => sessions, subscribe: () => () => {} } } as never}
        workspaces={{ list: { getSnapshot: () => workspaces, subscribe: () => () => {} } } as never}
        currentSession={{ getSnapshot: () => current, subscribe: () => () => {} }}
        localeRuntime={{ getSnapshot: () => locale, subscribe: () => () => {} } as never}
        sourcePageDirectory={{ getSnapshot: () => [], subscribe: () => () => {} }}
        renderSlot={() => <SourceProbe />} t={() => label}
      /></sourceOwner.Provider>
    }
    const registerPeer = (id = 'plugins') => {
      const stopMain = register({ name: 'main', key: id }, () => <p>{id} panel</p>)
      const stopIcon = register({ name: 'sidebar.panellist', id, label: id, order: 0 }, () => <svg />)
      return () => { stopIcon(); stopMain() }
    }
    return {
      core, ctx, controller, seat, navigation, mount, selectPanel, getPanel, NativeFrame, Host, registerPeer,
      rename: (value: string) => { label = value },
      declare: () => { stopOwner = declare() },
      removeOwner: () => { stopOwner?.(); stopOwner = undefined },
    }
  }

  it('authorizes native layout access through the real Cordis Client inject contract', async () => {
    const f = nativeFixture()
    f.navigation.dispose()
    const root = new Context()
    let navigation: ReturnType<typeof mountMnemonSidebarNavigation> | undefined
    const failures: unknown[] = []
    for (const name of inject) root.provide(name, {})
    root.set('slots', f.ctx.slots)
    root.set('locale', f.ctx.locale)
    if (inject.includes('layout')) root.set('layout', f.ctx.layout)
    else root.provide('layout', f.ctx.layout)
    try {
      await root.plugin({ inject, apply(ctx: Context) {
        try { navigation = mountMnemonSidebarNavigation(ctx as never, () => 'Memory System', f.controller, f.seat) }
        catch (error) { failures.push(error) }
      } })
      expect(failures).toEqual([])
      expect(f.core.entriesOfSlot('sidebar.panellist')).toHaveLength(1)
      expect(navigation).toBeDefined()
      act(() => navigation!.open())
      expect(f.selectPanel).toHaveBeenCalledWith(MNEMON_MAIN_PANEL_ID)
    } finally {
      navigation?.dispose()
      await root.fiber.dispose()
    }
  })

  it('adds a native panel beside Plugins, follows native icon sizes and locale labels, and retains Source ownership and editor state', () => {
    const f = nativeFixture()
    releases.push(f.registerPeer())
    const view = render(<><f.NativeFrame /><f.Host /></>)
    const entry = screen.getByRole('button', { name: 'Memory System' })
    expect(document.querySelector('[data-dsh-mnemon-entry]')).toBeNull()
    expect(entry.querySelector('svg')?.getAttribute('width')).toBe('16')
    expect(entry.querySelector('svg')?.getAttribute('height')).toBe('16')
    expect(f.core.entriesOfSlot('main').map(item => item.options.key)).toEqual([MNEMON_MAIN_PANEL_ID, 'plugins'])
    fireEvent.click(entry)
    const content = screen.getByTestId('native-memory')
    expect(entry.getAttribute('aria-current')).toBe('page')
    const band = document.querySelector('[data-dsh-mnemon-main-seat] > [data-window-drag]')
    expect(band?.getAttribute('aria-hidden')).toBe('true')
    expect(content.getAttribute('data-title-bar')).toBe('true')
    expect(within(screen.getByTestId('native-main')).getByText('shell-source-owner')).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Retained editor'), { target: { value: 'unsaved draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'plugins' }))
    expect(screen.queryByTestId('native-memory')).toBeNull()
    expect(screen.getByText('plugins panel')).not.toBeNull()
    expect(entry.hasAttribute('aria-current')).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)
    fireEvent.click(entry)
    expect(screen.getByTestId('native-memory')).toBe(content)
    expect((screen.getByLabelText('Retained editor') as HTMLInputElement).value).toBe('unsaved draft')
    fireEvent.click(entry)
    expect(screen.getByTestId('native-memory')).toBe(content)
    f.rename('记忆系统')
    view.rerender(<><f.NativeFrame collapsed /><f.Host /></>)
    const collapsedEntry = screen.getByRole('button', { name: '记忆系统' })
    expect(collapsedEntry.textContent).toBe('')
    expect(collapsedEntry.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(collapsedEntry.getAttribute('aria-current')).toBe('page')
  })

  it.each(['Return to conversation', 'New Session', 'Escape'])('returns native selection and the current main panel to Conversation with %s', action => {
    const f = nativeFixture()
    render(<><f.NativeFrame /><f.Host /></>)
    act(() => f.navigation.open())
    expect(screen.getByTestId('native-memory')).not.toBeNull()
    if (action === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: action }))
    expect(f.getPanel()).toBeNull()
    expect(screen.queryByTestId('native-memory')).toBeNull()
    expect(screen.getByText('Conversation')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Memory System' }).hasAttribute('aria-current')).toBe(false)
  })

  it('relies on native layout.selectPanel without legacy DOM click or attribute scraping while keeping 0.2.0-rc.2 fallback coordination', () => {
    const f = nativeFixture()
    const sessionRow = document.createElement('button')
    sessionRow.className = 'sessionRow'
    document.body.append(sessionRow)
    render(<><f.NativeFrame /><f.Host /></>)
    const entry = screen.getByRole('button', { name: 'Memory System' })
    fireEvent.click(entry)
    expect(f.getPanel()).toBe(MNEMON_MAIN_PANEL_ID)
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)
    // Native 0.2.1+ ignores legacy DOM panel events, root attributes, and session-row capture clicks.
    act(() => document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'taskboard' })))
    expect(f.getPanel()).toBe(MNEMON_MAIN_PANEL_ID)
    document.documentElement.setAttribute('data-dsh-ssh-active', '')
    fireEvent.click(sessionRow)
    expect(f.getPanel()).toBe(MNEMON_MAIN_PANEL_ID)
    expect(document.documentElement.hasAttribute('data-dsh-ssh-active')).toBe(true)
    document.documentElement.removeAttribute('data-dsh-ssh-active')
    expect(screen.getByTestId('native-memory')).not.toBeNull()

    // Removing native slots falls back to 0.2.0-rc.2 where coordinateSidebarPanels still runs.
    document.body.innerHTML = '<aside data-pane="sidebar"><div><button class="newSession">New</button></div></aside>'
    act(() => f.removeOwner())
    const fallbackEntry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    expect(fallbackEntry).not.toBeNull()
    act(() => f.navigation.open())
    expect(f.controller.getSnapshot().open).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    act(() => document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'taskboard' })))
    expect(f.controller.getSnapshot().open).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)
  })

  it('disconnects document.body waitObserver once placed so chat streaming mutations schedule zero syncs, re-arming only on root disconnect', async () => {
    document.body.innerHTML = '<div data-dsh-frame><aside data-pane="sidebar"><div class="sidebarRoot"><div class="logoRow"><button class="newSession">New</button></div></div></aside><main data-pane="conversation"><div data-chat-stream></div></main></div>'
    const controller = new MnemonWorkspaceController()
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    const disposeEntry = mountFallbackEntry(context(), (() => 'Memory System') as never, controller)
    releases.push(disposeEntry)

    expect(document.querySelector('[data-dsh-mnemon-entry]')).not.toBeNull()
    rafSpy.mockClear()

    const chatStream = document.querySelector('[data-chat-stream]')!
    await act(async () => {
      for (let index = 0; index < 10; index += 1) {
        const token = document.createElement('span')
        token.textContent = `token-${index}`
        chatStream.append(token)
      }
    })
    expect(rafSpy).not.toHaveBeenCalled()

    // Disconnecting the sidebar root re-arms waitObserver so a remounted sidebar gets the entry back.
    const aside = document.querySelector('aside[data-pane="sidebar"]')!
    await act(async () => { aside.remove() })
    await act(async () => {
      const replacement = document.createElement('aside')
      replacement.setAttribute('data-pane', 'sidebar')
      replacement.innerHTML = '<div class="sidebarRoot"><div class="logoRow"><button class="newSession">New</button></div></div>'
      document.querySelector('[data-dsh-frame]')!.prepend(replacement)
    })
    await waitFor(() => expect(document.querySelectorAll('[data-dsh-mnemon-entry]')).toHaveLength(1))
  })

  it('pads main-panel titleBar headers by --dsh-frame-leading-clearance for macOS traffic lights', () => {
    const viewCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/MnemonView.module.css'), 'utf8')
    expect(viewCss).toContain('.masthead[data-window-drag]')
    expect(viewCss).toContain('calc(24px + var(--dsh-frame-leading-clearance, 0px))')
    expect(viewCss).toContain('calc(16px + var(--dsh-frame-leading-clearance, 0px))')
  })

  it('replaces only its fallback when native seats arrive, and restores it when a replacement layout removes them', () => {
    document.body.innerHTML = '<aside data-pane="sidebar"><div><button class="newSession">New</button></div></aside>'
    const f = nativeFixture(false)
    expect(document.querySelectorAll('[data-dsh-mnemon-entry]')).toHaveLength(1)
    act(() => f.declare())
    expect(document.querySelector('[data-dsh-mnemon-entry]')).toBeNull()
    expect(f.core.entriesOfSlot('sidebar.panellist')).toHaveLength(1)
    act(() => f.removeOwner())
    expect(document.querySelectorAll('[data-dsh-mnemon-entry]')).toHaveLength(1)
    f.navigation.dispose()
    expect(document.querySelector('[data-dsh-mnemon-entry]')).toBeNull()
  })

  it('rejects an occupied native panel id without replacing the peer or leaking a launcher', () => {
    const f = nativeFixture()
    const peers = f.core.entriesOfSlot('main')
    expect(() => f.mount()).toThrow()
    expect(f.core.entriesOfSlot('main')).toEqual(peers)
    expect(f.core.entriesOfSlot('sidebar.panellist')).toHaveLength(1)
    expect(document.querySelector('[data-dsh-mnemon-entry]')).toBeNull()
  })
})
