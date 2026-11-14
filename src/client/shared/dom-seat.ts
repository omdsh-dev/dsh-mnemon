import { ExternalStore } from './store.ts'

/**
 * Token-fenced single-owner seat: offering a newer value supersedes the old
 * one, and a late disposer from an older owner never clears the newer value.
 */
export class HeldSeat<T> extends ExternalStore<T | undefined> {
  private owner: symbol | undefined

  constructor() {
    super(undefined)
  }

  protected hold(value: T): () => void {
    const token = Symbol('held-seat')
    this.owner = token
    this.setSnapshot(value, true)
    return () => {
      if (this.owner !== token) return
      this.owner = undefined
      this.setSnapshot(undefined)
    }
  }
}

export interface RafCoalescer {
  /** Schedule `run` on the next animation frame; multiple calls in one frame coalesce into one. */
  schedule(): void
  /** Run immediately and clear any pending frame. */
  flush(): void
  /** Cancel any scheduled animation frame without running. */
  cancel(): void
  readonly pending: boolean
}

/**
 * Coalesces high-frequency DOM / resize callbacks onto a single animation frame
 * so streaming chat mutations never trigger redundant layout or DOM queries.
 */
export function createRafCoalescer(run: () => void): RafCoalescer {
  let frameId: number | undefined
  let microtaskToken: object | undefined

  const cancel = (): void => {
    if (frameId !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameId)
    }
    frameId = undefined
    microtaskToken = undefined
  }

  const flush = (): void => {
    cancel()
    run()
  }

  const schedule = (): void => {
    if (frameId !== undefined || microtaskToken !== undefined) return
    if (typeof requestAnimationFrame === 'function') {
      frameId = requestAnimationFrame(() => {
        frameId = undefined
        run()
      })
      return
    }
    const token = {}
    microtaskToken = token
    queueMicrotask(() => {
      if (microtaskToken !== token) return
      microtaskToken = undefined
      run()
    })
  }

  return {
    schedule,
    flush,
    cancel,
    get pending(): boolean {
      return frameId !== undefined || microtaskToken !== undefined
    },
  }
}
