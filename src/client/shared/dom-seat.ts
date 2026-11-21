import { ExternalStore } from './store.ts'

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
  schedule(): void
  flush(): void
  cancel(): void
  readonly pending: boolean
}

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
