import type { MemoryCompositionDiagnostic } from './contracts/index.ts'

type SourceReadPhase = 'facts' | 'project'

export class SourceReadFailure extends Error {
  readonly diagnostic: MemoryCompositionDiagnostic

  constructor(sourceInstanceKey: string, phase: SourceReadPhase, timeout: boolean) {
    super(`Memory Source ${sourceInstanceKey} ${phase}() ${timeout ? 'timed out' : 'failed'}`)
    this.diagnostic = {
      code: `source-${phase}-${timeout ? 'timeout' : 'failed'}`,
      message: this.message,
      contributionInstanceKey: sourceInstanceKey,
    }
  }
}

export async function readSource<T>(
  sourceInstanceKey: string,
  phase: SourceReadPhase,
  timeoutMs: number,
  execute: (signal: AbortSignal) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  let interrupt!: (reason: unknown) => void
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject })
  const cancel = (reason: unknown) => {
    interrupt(reason)
    controller.abort(reason)
  }
  const abort = () => cancel(signal!.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => cancel(new SourceReadFailure(sourceInstanceKey, phase, true)), timeoutMs)
  try {
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return execute(controller.signal)
    }).catch(() => {
      if (controller.signal.aborted) throw controller.signal.reason
      throw new SourceReadFailure(sourceInstanceKey, phase, false)
    })
    return await Promise.race([operation, interrupted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
