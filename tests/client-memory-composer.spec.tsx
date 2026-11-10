// @vitest-environment jsdom
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMemoryComposer, MemoryComposer, MemoryComposerToggle, MEMORY_COMPOSER_PREFERENCE, useMemoryComposerInset } from '../src/client/memory-composer.tsx'
import { en, type MnemonTranslate } from '../src/client/locales.ts'

const t: MnemonTranslate = key => en[key]
const releases: Array<() => void> = []
afterEach(() => { cleanup(); for (const stop of releases.splice(0).reverse()) stop(); localStorage.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture(declared = true) {
  const core = new SlotCore()
  const declare = () => core.register({ name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session' } } } as never, (() => null) as never)
  let owner = declared ? declare() : undefined
  const slots = {
    register: core.register.bind(core), spec: core.spec.bind(core),
    inject(name: string, factory: () => () => void) {
      let stop: (() => void) | undefined
      const sync = () => {
        if (core.specDynamic(name) !== undefined) stop ??= factory()
        else { stop?.(); stop = undefined }
      }
      const unsubscribe = core.subscribeDeclaration(name, sync)
      sync()
      return () => { unsubscribe(); stop?.() }
    },
  }
  const installed = installMemoryComposer({ slots } as never, t)
  releases.push(() => { installed.dispose(); owner?.() })
  return { core, ...installed, declare: () => { owner = declare() }, withdraw: () => { owner?.(); owner = undefined } }
}

describe('Memory view composer', () => {
  it('collapses only a mounted Memory session, yields to pending interaction, and restores on leaving', () => {
    const { core, composer } = fixture()
    expect(core.entries('conversation.composer')).toHaveLength(0)
    const leave = composer.mount('memory-session')
    const entry = core.entries('conversation.composer')[0]!
    const select = entry.select!
    expect(entry.options.priority).toBe(Number.MAX_SAFE_INTEGER)
    expect(select({ sessionId: 'memory-session' } as never)).toBe(true)
    expect(select({ sessionId: 'other-session' } as never)).toBeNull()
    expect(select({ sessionId: undefined } as never)).toBeNull()
    for (const kind of ['approval', 'question', 'plan']) {
      expect(select({ sessionId: 'memory-session', pendingInteraction: { kind } } as never)).toBeNull()
    }
    leave()
    expect(core.entries('conversation.composer')).toHaveLength(0)
  })

  it('restores editors in split panes, including two views of the same session', async () => {
    const { core, composer } = fixture()
    releases.push(composer.mount('same-session'))
    expect(core.entries('conversation.composer')).toHaveLength(1)
    const pane = document.createElement('div'); pane.dataset.composerSeat = ''
    const other = pane.cloneNode() as HTMLElement
    await act(async () => { document.body.append(pane, other) })
    expect(composer.getSnapshot().available).toBe(false)
    expect(core.entries('conversation.composer')).toHaveLength(0)
    await act(async () => { other.remove() })
    expect(composer.getSnapshot().available).toBe(true)
    expect(core.entries('conversation.composer')).toHaveLength(1)
  })

  it('saves explicit expand/collapse choices without touching conversation data', () => {
    const { core, composer } = fixture()
    const leave = composer.mount('a'); releases.push(leave)
    render(<MemoryComposerToggle composer={composer} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show message input' }))
    expect(core.entries('conversation.composer')).toHaveLength(0)
    expect(localStorage.getItem(MEMORY_COMPOSER_PREFERENCE)).toBe('expanded')
    expect(new MemoryComposer().getSnapshot().collapsed).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse message input' }))
    expect(core.entries('conversation.composer')).toHaveLength(1)
    expect(new MemoryComposer().getSnapshot().collapsed).toBe(true)
  })

  it('reveals the retained editor for Use skill in its own session and follows another window preference', () => {
    const { core, composer } = fixture()
    releases.push(composer.mount('a'))
    window.dispatchEvent(new CustomEvent('dsh-mnemon:skill-use', { detail: { sessionId: 'b', name: 'test' } }))
    expect(core.entries('conversation.composer')).toHaveLength(1)
    window.dispatchEvent(new CustomEvent('dsh-mnemon:skill-use', { detail: { sessionId: 'a', name: 'test' } }))
    expect(core.entries('conversation.composer')).toHaveLength(0)
    window.dispatchEvent(new StorageEvent('storage', { key: MEMORY_COMPOSER_PREFERENCE, newValue: 'collapsed' }))
    expect(core.entries('conversation.composer')).toHaveLength(1)
  })

  it('tolerates unavailable browser storage and releases duplicate view leases independently', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const { core, composer } = fixture()
    const first = composer.mount('a'), second = composer.mount('a')
    first(); first()
    expect(core.entries('conversation.composer')).toHaveLength(1)
    expect(() => composer.setCollapsed(false)).not.toThrow()
    composer.setCollapsed(true)
    second()
    expect(core.entries('conversation.composer')).toHaveLength(0)
  })

  it('waits for the official chain and removes the controls when it is withdrawn', () => {
    const { core, composer, declare, withdraw } = fixture(false)
    releases.push(composer.mount('a'))
    render(<MemoryComposerToggle composer={composer} t={t} />)
    expect(screen.queryByRole('button')).toBeNull()
    act(declare)
    expect(screen.getByRole('button', { name: 'Show message input' })).toBeDefined()
    expect(core.entries('conversation.composer')).toHaveLength(1)
    act(withdraw)
    expect(screen.queryByRole('button')).toBeNull()
    act(declare)
    expect(core.entries('conversation.composer')).toHaveLength(1)
  })

  it('reserves the current composer height only in its owning Memory scrollport', () => {
    let height = 220
    const callbacks: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { callbacks.push(callback) } observe() {} unobserve() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return { height: this.hasAttribute('data-composer-seat') ? height : 0 } as DOMRect })
    function Memory() {
      const ref = useRef<HTMLElement>(null)
      useMemoryComposerInset(ref, true)
      return <main ref={ref} data-testid="memory" />
    }
    render(<><div data-conversation-scroll><Memory /><div data-composer-seat /></div><div data-conversation-scroll><main data-testid="other" /><div data-composer-seat /></div></>)
    expect(screen.getByTestId('memory').style.getPropertyValue('--mn-composer-inset')).toBe('236px')
    expect(screen.getByTestId('other').style.getPropertyValue('--mn-composer-inset')).toBe('')
    height = 460
    act(() => callbacks.forEach(callback => callback()))
    expect(screen.getByTestId('memory').style.getPropertyValue('--mn-composer-inset')).toBe('476px')
  })
})
