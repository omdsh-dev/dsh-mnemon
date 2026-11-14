import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import type { MnemonClientContext } from './dsh-context.ts'
import type { MnemonTranslate } from './locales.ts'
import { ExternalStore } from './shared/store.ts'
import css from './MnemonView.module.css'

export const MEMORY_COMPOSER_PREFERENCE = 'dsh-mnemon:memory-composer'
type Register = (sessionId: string) => () => void

export interface MemoryComposerState {
  available: boolean
  collapsed: boolean
}

function readSavedCollapsed(): boolean {
  try { return localStorage.getItem(MEMORY_COMPOSER_PREFERENCE) !== 'expanded' } catch { return true }
}

const PANE_CONTAINER_SELECTOR = '#root, .dsh_frame, [data-dsh-frame], .dsh_centerCol, .dsh_rightbarCol, [data-pane="conversation"], [data-conversation-scroll]'

/** Register only while a Memory view owns the session; selectors read owner props only. */
export class MemoryComposer extends ExternalStore<MemoryComposerState> {
  private readonly views = new Map<string, number>()
  private readonly entries = new Map<string, () => void>()
  private register: Register | undefined
  private multiplePanes = false

  constructor() {
    super({ available: false, collapsed: readSavedCollapsed() })
  }

  connect(register: Register | undefined): void {
    for (const stop of this.entries.values()) stop()
    this.entries.clear()
    this.register = register
    const available = register !== undefined && !this.multiplePanes
    const next = this.snapshot.available === available ? this.snapshot : { ...this.snapshot, available }
    this.snapshot = next
    this.sync()
    this.notify()
  }

  setMultiplePanes(multiple: boolean): void {
    if (this.multiplePanes === multiple) return
    this.multiplePanes = multiple
    const available = this.register !== undefined && !multiple
    this.snapshot = { ...this.snapshot, available }
    this.sync()
    this.notify()
  }

  private sync(): void {
    for (const [id, stop] of this.entries) {
      if (!this.snapshot.available || !this.snapshot.collapsed || !this.views.has(id)) { stop(); this.entries.delete(id) }
    }
    if (this.snapshot.available && this.snapshot.collapsed && this.register !== undefined) {
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
    if (this.snapshot.collapsed === collapsed) return
    this.snapshot = { ...this.snapshot, collapsed }
    if (persist) { try { localStorage.setItem(MEMORY_COMPOSER_PREFERENCE, collapsed ? 'collapsed' : 'expanded') } catch { /* The in-memory preference still works. */ } }
    this.sync()
    this.notify()
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
  // Composer owners expose a session, not a pane. Observe only structural layout
  // containers with `subtree: false` (never chat message subtrees) and coalesce microtasks.
  let paneScheduled = false
  let paneDisposed = false
  let stopSlotSubscription: (() => void) | undefined
  const observedContainers = new Set<Element>()
  const panes = typeof document === 'undefined' ? undefined : new MutationObserver(() => {
    schedulePaneSync()
  })
  const syncPanes = (): void => {
    if (paneDisposed || typeof document === 'undefined') return
    const seats = document.querySelectorAll('[data-composer-seat]')
    composer.setMultiplePanes(seats.length > 1)
    if (panes === undefined) return
    const nextTargets = new Set<Element>([document.body])
    for (const container of document.querySelectorAll(PANE_CONTAINER_SELECTOR)) nextTargets.add(container)
    for (const seat of seats) {
      let ancestor = seat.parentElement
      while (ancestor !== null && ancestor !== document.documentElement) {
        nextTargets.add(ancestor)
        ancestor = ancestor.parentElement
      }
    }
    let changed = nextTargets.size !== observedContainers.size
    if (!changed) {
      for (const element of nextTargets) {
        if (!observedContainers.has(element)) { changed = true; break }
      }
    }
    if (changed) {
      panes.disconnect()
      observedContainers.clear()
      for (const element of nextTargets) {
        observedContainers.add(element)
        panes.observe(element, { childList: true, subtree: false })
      }
    }
  }
  const schedulePaneSync = (): void => {
    if (paneScheduled || paneDisposed) return
    paneScheduled = true
    queueMicrotask(() => {
      paneScheduled = false
      syncPanes()
    })
  }
  if (typeof document !== 'undefined') {
    syncPanes()
  }
  const slotsWithSubscribe = ctx.slots as { subscribe?(name: string, listener: () => void): () => void }
  if (typeof slotsWithSubscribe.subscribe === 'function') {
    stopSlotSubscription = slotsWithSubscribe.subscribe('conversation.composer', schedulePaneSync)
  }
  const skill = (event: Event) => composer.revealSkill(event)
  const preference = (event: StorageEvent) => { if (event.key === MEMORY_COMPOSER_PREFERENCE) composer.setCollapsed(event.newValue !== 'expanded', false) }
  if (typeof window !== 'undefined') {
    // The Skills Source's existing browser bridge also fills the retained editor.
    window.addEventListener('dsh-mnemon:skill-use', skill)
    window.addEventListener('storage', preference)
  }
  return { composer, dispose: () => {
    paneDisposed = true
    if (typeof window !== 'undefined') { window.removeEventListener('dsh-mnemon:skill-use', skill); window.removeEventListener('storage', preference) }
    stopSlotSubscription?.()
    panes?.disconnect()
    observedContainers.clear()
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
    let frameId: number | undefined
    let dirty = false
    const applyInset = (): void => {
      if (seat !== null) {
        shell.dataset.mnemonComposer = ''
        shell.style.setProperty('--mn-composer-inset', `${Math.ceil(seat.getBoundingClientRect().height) + 16}px`)
      }
    }
    const scheduleInset = (): void => {
      if (frameId !== undefined) {
        dirty = true
        return
      }
      applyInset()
      if (typeof requestAnimationFrame === 'function') {
        frameId = requestAnimationFrame(() => {
          frameId = undefined
          if (dirty) {
            dirty = false
            applyInset()
          }
        })
      }
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleInset)
    resize?.observe(scroll)
    const connect = (): void => {
      const next = scroll.querySelector(':scope > [data-composer-seat]')
      if (seat !== next) {
        if (seat !== null) resize?.unobserve(seat)
        seat = next
        if (seat !== null) resize?.observe(seat)
      }
      if (seat === null) {
        delete shell.dataset.mnemonComposer
        shell.style.removeProperty('--mn-composer-inset')
      } else {
        applyInset()
      }
    }
    connect()
    const children = new MutationObserver(connect)
    children.observe(scroll, { childList: true, subtree: false })
    return () => {
      if (frameId !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId)
      children.disconnect()
      resize?.disconnect()
      delete shell.dataset.mnemonComposer
      shell.style.removeProperty('--mn-composer-inset')
    }
  }, [root, enabled])
}
