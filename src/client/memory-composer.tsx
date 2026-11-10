import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import type { MnemonClientContext } from './dsh-context.ts'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonView.module.css'

export const MEMORY_COMPOSER_PREFERENCE = 'dsh-mnemon:memory-composer'
type Register = (sessionId: string) => () => void

/** Register only while a Memory view owns the session; selectors read owner props only. */
export class MemoryComposer {
  private readonly listeners = new Set<() => void>()
  private readonly views = new Map<string, number>()
  private readonly entries = new Map<string, () => void>()
  private register: Register | undefined
  private multiplePanes = false
  private state = { available: false, collapsed: this.savedPreference() }

  private savedPreference(): boolean {
    try { return localStorage.getItem(MEMORY_COMPOSER_PREFERENCE) !== 'expanded' } catch { return true }
  }
  readonly getSnapshot = () => this.state
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { for (const listener of this.listeners) listener() }
  connect(register: Register | undefined): void {
    for (const stop of this.entries.values()) stop()
    this.entries.clear()
    this.register = register
    this.state = { ...this.state, available: register !== undefined && !this.multiplePanes }
    this.sync()
    this.changed()
  }
  setMultiplePanes(multiple: boolean): void {
    if (this.multiplePanes === multiple) return
    this.multiplePanes = multiple
    this.state = { ...this.state, available: this.register !== undefined && !multiple }
    this.sync()
    this.changed()
  }
  private sync(): void {
    for (const [id, stop] of this.entries) {
      if (!this.state.available || !this.state.collapsed || !this.views.has(id)) { stop(); this.entries.delete(id) }
    }
    if (this.state.available && this.state.collapsed && this.register !== undefined) {
      for (const id of this.views.keys()) if (!this.entries.has(id)) this.entries.set(id, this.register(id))
    }
  }
  mount(sessionId: string): () => void {
    this.views.set(sessionId, (this.views.get(sessionId) ?? 0) + 1)
    this.sync()
    let live = true
    return () => {
      if (!live) return
      live = false
      const count = this.views.get(sessionId) ?? 0
      if (count <= 1) this.views.delete(sessionId)
      else this.views.set(sessionId, count - 1)
      this.sync()
    }
  }
  setCollapsed(collapsed: boolean, persist = true): void {
    if (this.state.collapsed === collapsed) return
    this.state = { ...this.state, collapsed }
    if (persist) { try { localStorage.setItem(MEMORY_COMPOSER_PREFERENCE, collapsed ? 'collapsed' : 'expanded') } catch { /* The in-memory preference still works. */ } }
    this.sync()
    this.changed()
  }
  revealSkill(event: Event): void {
    const detail: unknown = (event as CustomEvent).detail
    if (typeof detail !== 'object' || detail === null || !('sessionId' in detail) || typeof detail.sessionId !== 'string' || !this.views.has(detail.sessionId)) return
    this.setCollapsed(false)
  }
}

export function MemoryComposerToggle({ composer, t }: { composer: MemoryComposer; t: MnemonTranslate }): JSX.Element | null {
  const state = useSyncExternalStore(composer.subscribe, composer.getSnapshot, composer.getSnapshot)
  if (!state.available) return null
  return <button type="button" className={css.composerToggle} aria-expanded={!state.collapsed}
    onClick={() => composer.setCollapsed(!state.collapsed)}>{t(state.collapsed ? 'composer.expand' : 'composer.collapse')}</button>
}

function CollapsedComposer({ composer, t }: { composer: MemoryComposer; t: MnemonTranslate }): JSX.Element {
  return <div className={css.composerNotice}><span>{t('composer.collapsed')}</span><MemoryComposerToggle composer={composer} t={t} /></div>
}

/** DSH's overlay chain retains the resident editor, attachments and draft DOM. */
export function installMemoryComposer(ctx: MnemonClientContext, t: MnemonTranslate): { composer: MemoryComposer; dispose(): void } {
  const composer = new MemoryComposer()
  const stop = ctx.slots.inject('conversation.composer', () => {
    if (ctx.slots.spec?.('conversation.composer')?.kind !== 'chain') return () => {}
    composer.connect(sessionId => ctx.slots.register({
      name: 'conversation.composer',
      // All business-owned takeovers get their turn before this cosmetic one.
      priority: Number.MAX_SAFE_INTEGER,
      select: owner => owner.sessionId === sessionId && owner.pendingInteraction === undefined ? true : null,
      locale: 'mnemon',
      inject: () => ({ composer, t }),
    }, CollapsedComposer))
    return () => composer.connect(undefined)
  })
  // Composer owners expose a session, not a pane. The same session can be
  // open twice, so leave all editors available when ownership is ambiguous.
  const panes = typeof document === 'undefined' ? undefined : new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
      node instanceof Element && (node.matches('[data-composer-seat]') || node.querySelector('[data-composer-seat]') !== null)))) {
      composer.setMultiplePanes(document.querySelectorAll('[data-composer-seat]').length > 1)
    }
  })
  if (typeof document !== 'undefined') {
    composer.setMultiplePanes(document.querySelectorAll('[data-composer-seat]').length > 1)
    panes?.observe(document.body, { childList: true, subtree: true })
  }
  const skill = (event: Event) => composer.revealSkill(event)
  const preference = (event: StorageEvent) => { if (event.key === MEMORY_COMPOSER_PREFERENCE) composer.setCollapsed(event.newValue !== 'expanded', false) }
  if (typeof window !== 'undefined') {
    // The Skills Source's existing browser bridge also fills the retained editor.
    window.addEventListener('dsh-mnemon:skill-use', skill)
    window.addEventListener('storage', preference)
  }
  return { composer, dispose: () => {
    if (typeof window !== 'undefined') { window.removeEventListener('dsh-mnemon:skill-use', skill); window.removeEventListener('storage', preference) }
    panes?.disconnect()
    stop()
    composer.connect(undefined)
  } }
}

/** Reserve the actual owning composer height, including multiline drafts and approvals. */
export function useMemoryComposerInset(root: RefObject<HTMLElement>, enabled: boolean): void {
  useEffect(() => {
    const shell = root.current
    const scroll = enabled ? shell?.closest('[data-conversation-scroll]') : undefined
    if (shell === null || scroll === undefined || scroll === null) return
    let seat: Element | null = null
    const update = () => {
      if (seat !== null) { shell.dataset.mnemonComposer = ''; shell.style.setProperty('--mn-composer-inset', `${Math.ceil(seat.getBoundingClientRect().height) + 16}px`) }
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    const connect = () => {
      const next = scroll.querySelector(':scope > [data-composer-seat]')
      if (seat !== next) { if (seat !== null) resize?.unobserve(seat); seat = next; if (seat !== null) resize?.observe(seat) }
      if (seat === null) { delete shell.dataset.mnemonComposer; shell.style.removeProperty('--mn-composer-inset') }
      else update()
    }
    connect()
    const children = new MutationObserver(connect)
    children.observe(scroll, { childList: true })
    window.addEventListener('resize', update)
    return () => { children.disconnect(); resize?.disconnect(); window.removeEventListener('resize', update); delete shell.dataset.mnemonComposer; shell.style.removeProperty('--mn-composer-inset') }
  }, [root, enabled])
}
