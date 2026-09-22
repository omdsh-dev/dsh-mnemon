import type { Context } from '@deepseek-ai/cordis'
import type { MemoryOperationObserver } from '../core/contracts/index.ts'

/** Bind an optional metadata observer to the installing plugin's Fiber. */
export function observeMemoryOperations(ctx: Context, observer: MemoryOperationObserver): void {
  const subscribe = ctx.mnemonMemory.observeOperations
  if (!subscribe) throw new Error('This Core does not support memory operation observations')
  ctx.effect(() => subscribe(observer), 'dsh-mnemon: observe operation metadata')
}
