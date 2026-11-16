import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { HostContextShape, ToolExecution } from './dsh.ts'
import type { MnemonAgentRuntimeSource } from './runtime.ts'
import { memoryTool } from './memory-tools.ts'

/** Ask through the Host's native/PTC pipeline before any memory tool body runs.
 * Existing denials and asks survive; the Host still applies its monotonic guards.
 * The live preference also covers calls from an already-pinned View or child.
 */
export function registerMemoryWriteApproval(ctx: HostContextShape, runtime: MnemonAgentRuntimeSource): () => void {
  const stop = ctx.on('tools/pre-execute', (async (execution: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !runtime.config.confirmWrites || memoryTool(execution.name ?? '')?.kind !== 'write') return decision
    execution.signal.throwIfAborted()
    return {
      kind: 'ask',
      reason: 'Mnemon memory writes require confirmation.',
      displayReason: {
        en: 'Review this memory change before allowing it. Mnemon write confirmation is enabled.',
        zh: '请确认本次记忆修改后再允许执行。已开启记忆工具写入前确认。',
        'zh-CN': '请确认本次记忆修改后再允许执行。已开启记忆工具写入前确认。',
      },
    }
  }) as never, { prepend: true })
  if (typeof stop !== 'function') throw new Error('dsh-mnemon write approval registration did not return a disposer')
  return stop as () => void
}
