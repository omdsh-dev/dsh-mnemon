// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'

vi.mock('../src/client/MnemonView.tsx', () => ({
  MnemonView: ({ sessionId, workspaceId, workspaceSelection, t, locale, onClose, surface, active }: {
    sessionId?: string
    workspaceId?: string
    t?: (key: string) => string
    locale?: 'zh' | 'en'
    surface?: 'sidebar' | 'builtin'
    active?: boolean
    onClose?: () => void
    workspaceSelection?: {
      options: Array<{ id: string; title: string }>
      selectedWorkspaceId?: string
      effectiveWorkspaceId?: string
      onSelect(id: string): void
      onAlign(): void
    }
  }) => <div data-testid="mnemon-canonical-content" data-active={active} data-workspace-id={workspaceId} data-effective-workspace-id={workspaceSelection?.effectiveWorkspaceId} data-locale={locale} data-surface={surface} data-has-workspace-picker={workspaceSelection !== undefined} data-has-back-action={onClose !== undefined}>
    <h1>{t?.('tab.label')}</h1>
    <span>{sessionId ?? 'no-session'}</span>
    <select aria-label="workspace-test-selector" value={workspaceSelection?.selectedWorkspaceId ?? ''} onChange={event => workspaceSelection?.onSelect(event.target.value)}>
      {workspaceSelection?.options.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
    </select>
    <button type="button" onClick={workspaceSelection?.onAlign}>align-test-workspace</button>
    <button type="button" aria-label={t?.('header.backToConversation')} onClick={onClose}>back-test-conversation</button>
  </div>,
}))

import {
  MnemonWorkspaceHost,
  MnemonSidebarWorkspaceHost,
  MnemonBuiltinWorkspaceHost,
  mountMnemonSidebarLauncher,
} from '../src/client/workspace-mount.tsx'

import { MnemonWorkspaceController } from '../src/client/workspace-controller.ts'
import { MnemonSourcePageOutlet } from '../src/client/source-page-outlet.ts'

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
    workspaces: { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } },
  }
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

const settings = {
  getSnapshot: () => ({ status: 'ready' as const, value: {}, writable: true, mode: 'host' as const }),
  subscribe: () => () => {}, set: async () => {}, unset: async () => {}, setPath: async () => {}, unsetPath: async () => {},
}
const sourcePageDirectory = { getSnapshot: () => [] as const, subscribe: () => () => {} }
const t = (key: string) => key === 'tab.label' ? 'Memory' : key

describe('Mnemon canonical workspace launcher', () => {
  beforeEach(() => { renderShell() })
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
    currentDispose = mountMnemonSidebarLauncher(context() as never, t as never, new MnemonWorkspaceController())

    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    expect(entry.previousElementSibling?.hasAttribute('data-dsh-ssh-entry')).toBe(true)
    fireEvent.click(entry)
    expect(clicked).not.toHaveBeenCalled()
    expect(entry.dataset.active).toBe('true')
    expect(memoryTab.getAttribute('aria-selected')).toBe('false')
    expect(document.querySelector('[data-chat-content]')?.textContent).toBe('Chat stays mounted')
    expect(document.querySelector('[data-dsh-mnemon-view]')).toBeNull()
  })

  it('publishes and releases the shell-owned Source child renderer', async () => {
    const ctx = context()
    const controller = new MnemonWorkspaceController()
    const sourcePageOutlet = new MnemonSourcePageOutlet()
    const renderSlot = vi.fn(() => null)
    const view = render(<MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never}
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory}
      navigation={{ open: () => controller.open(), close: () => controller.close() }} t={t as never}
      renderSlot={renderSlot as never} controller={controller} sourcePageOutlet={sourcePageOutlet}
    />)

    await waitFor(() => expect(sourcePageOutlet.getSnapshot()).toBe(renderSlot))
    view.unmount()
    expect(sourcePageOutlet.getSnapshot()).toBeUndefined()
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
    currentDispose = mountMnemonSidebarLauncher(ctx as never, t as never, controller)
    const view = render(<MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={sessions as never} workspaces={ctx.workspaces as never}
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

  it('covers both center and details columns in the released three-column DSH frame', async () => {
    document.body.innerHTML = `<div class="released_frame">
      <aside data-pane="sidebar"><div class="sidebarRoot"><div class="logoRow"><button class="newSession">New</button></div></div></aside>
      <main class="released_centerCol"><div data-chat-content>Chat stays mounted</div></main>
      <aside class="released_detailsCol"><button>Details stay mounted</button></aside>
      <div class="released_overlayLayer"></div>
    </div>`
    const frame = document.querySelector<HTMLElement>('.released_frame')!
    const center = document.querySelector<HTMLElement>('.released_centerCol')!
    const details = document.querySelector<HTMLElement>('.released_detailsCol')!
    center.inert = false
    details.inert = false
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1_080, height: 900 } as DOMRect)
    vi.spyOn(center, 'getBoundingClientRect').mockReturnValue({ left: 280, top: 0, width: 430, height: 900 } as DOMRect)
    vi.spyOn(details, 'getBoundingClientRect').mockReturnValue({ left: 710, top: 0, width: 370, height: 900 } as DOMRect)
    const ctx = context()
    const controller = new MnemonWorkspaceController()
    const view = render(<MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never}
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory}
      navigation={{ open: () => controller.open(), close: () => controller.close() }} t={t as never} renderSlot={() => null} controller={controller}
    />)

    act(() => controller.open())
    await waitFor(() => expect(view.getByTestId('mnemon-canonical-content')).not.toBeNull())
    const panel = document.querySelector<HTMLElement>('[data-dsh-mnemon-view]')!
    expect(panel.style.left).toBe('280px')
    expect(panel.style.top).toBe('0px')
    expect(panel.style.width).toBe('800px')
    expect(panel.style.height).toBe('900px')
    expect(center.inert).toBe(true)
    expect(details.inert).toBe(true)
    expect(document.querySelector('[data-chat-content]')?.textContent).toBe('Chat stays mounted')
    expect(details.textContent).toContain('Details stay mounted')

    act(() => controller.close())
    expect(center.inert).toBe(false)
    expect(details.inert).toBe(false)
    view.unmount()
  })

  it('retains the workspace subtree when a peer panel takes over and the user returns', async () => {
    const ctx = context()
    const controller = new MnemonWorkspaceController()
    currentDispose = mountMnemonSidebarLauncher(ctx as never, t as never, controller)
    const view = render(<MnemonSidebarWorkspaceHost
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never}
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
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never}
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
    currentDispose = mountMnemonSidebarLauncher(context() as never, key => String(key), new MnemonWorkspaceController())
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
    currentDispose = mountMnemonSidebarLauncher(context() as never, key => String(key), new MnemonWorkspaceController())
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
    currentDispose = mountMnemonSidebarLauncher(context() as never, key => String(key), new MnemonWorkspaceController())
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
    currentDispose = mountMnemonSidebarLauncher(context() as never, key => String(key), new MnemonWorkspaceController())
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    fireEvent.click(entry)
    fireEvent.click(entry)
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(entry.getAttribute('data-active')).toBe('true')
  })

  it.each([true, false])('round-trips with the released legacy panel protocol (Mnemon mounted first: %s)', mnemonFirst => {
    const mount = () => { currentDispose = mountMnemonSidebarLauncher(context() as never, key => String(key), new MnemonWorkspaceController()) }
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
    currentDispose = mountMnemonSidebarLauncher(context() as never, t as never, new MnemonWorkspaceController())
    document.querySelector('[data-dsh-mnemon-entry]')?.remove()
    await waitFor(() => expect(document.querySelector('[data-dsh-mnemon-entry]')).not.toBeNull())
    currentDispose()
    currentDispose = undefined
    expect(document.querySelector('[data-dsh-mnemon-entry]')).toBeNull()
  })

  it('mounts the launcher in the DSH advanced frame without replacing conversation content', () => {
    renderShell(true)
    currentDispose = mountMnemonSidebarLauncher(context() as never, t as never, new MnemonWorkspaceController())
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
      connection={ctx.connection as never} settingsScope={settings} sessions={ctx.sessions as never} workspaces={ctx.workspaces as never}
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
    currentDispose = mountMnemonSidebarLauncher(context(locale) as never, translate as never, new MnemonWorkspaceController())
    expect(document.querySelector('[data-dsh-mnemon-entry]')?.textContent).toBe('记忆系统')
    active = 'en'
    snapshot = { active, locales: [] as const, revision: 1 }
    for (const listener of listeners) listener()
    await waitFor(() => expect(document.querySelector('[data-dsh-mnemon-entry]')?.textContent).toBe('Memory System'))
  })
})
