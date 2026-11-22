import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { HostContextShape, ToolExecution } from './dsh.ts'
import type { MnemonAgentRuntimeSource } from './runtime.ts'
import { memoryTool } from './memory-tools.ts'

export function registerMemoryWriteApproval(ctx: HostContextShape, runtime: MnemonAgentRuntimeSource): () => void {
  const stop = ctx.on('tools/pre-execute', (async (execution: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !runtime.config.confirmWrites || memoryTool(execution.name ?? '')?.kind !== 'write') return decision
    execution.signal.throwIfAborted()
    return {
      kind: 'ask',
      reason: 'Mnemon memory writes require confirmation.',
      displayReason: { en: 'Review this memory change before allowing it. Mnemon write confirmation is enabled.', zh: '请确认本次记忆修改后再允许执行。已开启记忆工具写入前确认。', 'zh-CN': '请确认本次记忆修改后再允许执行。已开启记忆工具写入前确认。', ja: '許可する前にこのメモリ変更を確認してください。Mnemon の書き込み確認が有効です。', es: 'Revisa este cambio de memoria antes de permitirlo. La confirmación de escritura de Mnemon está activada.', fr: 'Vérifiez cette modification mémoire avant de l\'autoriser. La confirmation d\'écriture Mnemon est activée.', de: 'Prüfen Sie diese Speicheränderung, bevor Sie sie zulassen. Die Mnemon-Schreibbestätigung ist aktiviert.', ru: 'Проверьте это изменение памяти перед разрешением. Включено подтверждение записи Mnemon.', pt: 'Revise esta alteração de memória antes de permiti-la. A confirmação de gravação do Mnemon está ativada.' },
    }
  }) as never, { prepend: true })
  if (typeof stop !== 'function') throw new Error('dsh-mnemon write approval registration did not return a disposer')
  return stop as () => void
}
