export class ExternalStore<T> {
  protected snapshot: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) {
    this.snapshot = initial
  }

  readonly getSnapshot = (): T => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  protected get listenerCount(): number {
    return this.listeners.size
  }

  protected setSnapshot(next: T, force = false): void {
    if (!force && Object.is(this.snapshot, next)) return
    this.snapshot = next
    this.notify()
  }

  protected notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export class ChangeSignal extends ExternalStore<number> {
  private pending: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly settleMs = 100) {
    super(0)
  }

  readonly bump = (): void => {
    if (this.pending !== undefined) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      this.setSnapshot(this.snapshot + 1)
    }, this.settleMs)
  }
}

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

class DocumentVisibilityStore {
  private readonly listeners = new Set<() => void>()
  private listening = false

  private readonly handleVisibilityChange = (): void => {
    for (const listener of [...this.listeners]) listener()
  }

  readonly getSnapshot = (): boolean => isDocumentVisible()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.listening && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
      this.listening = true
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.listening && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.handleVisibilityChange)
        this.listening = false
      }
    }
  }
}

export const documentVisibilityStore = new DocumentVisibilityStore()
