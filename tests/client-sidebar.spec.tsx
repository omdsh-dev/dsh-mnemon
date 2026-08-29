// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'

vi.mock('../src/client/MnemonView.tsx', () => ({
  MnemonView: ({ sessionId, workspaceId, workspaceSelection, t, locale, onClose }: {
    sessionId?: string
    workspaceId?: string
    t?: (key: string) => string
    locale?: 'zh' | 'en'
    onClose?: () => void
    workspaceSelection?: {
      options: Array<{ id: string; title: string }>
      selectedWorkspaceId?: string
      effectiveWorkspaceId?: string
      onSelect(id: string): void
      onAlign(): void
    }
  }) => <div data-testid="mnemon-canonical-content" data-workspace-id={workspaceId} data-effective-workspace-id={workspaceSelection?.effectiveWorkspaceId} data-surface={surface} data-locale={locale}>
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
  createMnemonWorkspaceNavigation,
  MnemonWorkspaceHost,
  mountMnemonWorkspace,
} from '../src/client/workspace-mount.tsx'

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
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('mounts after the official panel family and opens the canonical DSH tab', () => {
    const memoryTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'Memory')!
    const clicked = vi.fn()
    memoryTab.addEventListener('click', clicked)
    currentDispose = mountMnemonWorkspace(context() as never, settings, t as never)

    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    expect(entry.previousElementSibling?.hasAttribute('data-dsh-ssh-entry')).toBe(true)
    fireEvent.click(entry)
    expect(clicked).toHaveBeenCalledOnce()
    expect(memoryTab.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-chat-content]')?.textContent).toBe('Chat stays mounted')
    expect(document.querySelector('[data-dsh-mnemon-view]')).toBeNull()
  })

  it('returns to the previously selected DSH tab without a second page host', () => {
    const navigation = createMnemonWorkspaceNavigation(t as never)
    navigation.open()
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Memory')
    navigation.close()
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Chat')
  })

  it('self-heals its sidebar launcher after a React-style row replacement', async () => {
    currentDispose = mountMnemonWorkspace(context() as never, settings, t as never)
    document.querySelector('[data-dsh-mnemon-entry]')?.remove()
    await waitFor(() => expect(document.querySelector('[data-dsh-mnemon-entry]')).not.toBeNull())
    currentDispose()
    currentDispose = undefined
    expect(document.querySelector('[data-dsh-mnemon-entry]')).toBeNull()
  })

  it('mounts the launcher in the DSH advanced frame without replacing conversation content', () => {
    renderShell(true)
    currentDispose = mountMnemonWorkspace(context() as never, settings, t as never)
    const entry = document.querySelector<HTMLButtonElement>('[data-dsh-mnemon-entry]')!
    fireEvent.click(entry)
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Memory')
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
      localeRuntime={ctx.locale as never} sourcePageDirectory={sourcePageDirectory} navigation={createMnemonWorkspaceNavigation(t as never)}
      surface="sidebar" t={t as never} renderSlot={() => null} SessionProvider={({ children }) => children('session-1' as never)} sessionId="session-1"
    />)

    await waitFor(() => expect(document.querySelector('[data-testid="mnemon-canonical-content"]')?.getAttribute('data-workspace-id')).toBe('workspace-1'))
    expect(sessions.reads).toBeGreaterThan(0)
    expect(workspaces.reads).toBeGreaterThan(0)
    fireEvent.change(document.querySelector('[aria-label="workspace-test-selector"]')!, { target: { value: 'workspace-2' } })
    await waitFor(() => expect(document.querySelector('[data-testid="mnemon-canonical-content"]')?.getAttribute('data-workspace-id')).toBe('workspace-2'))
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'align-test-workspace')!)
    await waitFor(() => expect(document.querySelector('[data-testid="mnemon-canonical-content"]')?.getAttribute('data-workspace-id')).toBe('workspace-1'))
  })

  it('updates the launcher label with the DSH locale', async () => {
    let active: 'zh' | 'en' = 'zh'
    let snapshot: { active: 'zh' | 'en'; locales: readonly never[]; revision: number } = { active, locales: [], revision: 0 }
    const listeners = new Set<() => void>()
    const locale = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
    const translate = (key: string) => key === 'tab.label' ? active === 'zh' ? '记忆系统' : 'Memory System' : key
    currentDispose = mountMnemonWorkspace(context(locale) as never, settings, translate as never)
    expect(document.querySelector('[data-dsh-mnemon-entry]')?.textContent).toBe('记忆系统')
    active = 'en'
    snapshot = { active, locales: [] as const, revision: 1 }
    for (const listener of listeners) listener()
    await waitFor(() => expect(document.querySelector('[data-dsh-mnemon-entry]')?.textContent).toBe('Memory System'))
  })
})
