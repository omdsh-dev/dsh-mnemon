import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { Config } from './config.ts'
import { createRuntimeMemorySource } from './source.ts'

export const name = 'dsh-mnemon-source-runtime'
export const inject = ['mnemonMemory']
export { Config }

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Runtime memory', 'zh-CN': '运行时记忆', ja: 'ランタイムメモリ', es: 'Memoria de ejecución', fr: 'Mémoire d\'exécution', de: 'Laufzeitspeicher', ru: 'Память выполнения', pt: 'Memória de execução' },
  description: { en: 'Bounded, deterministic hot memory injected directly into every eligible turn.', 'zh-CN': '有界且确定的热记忆，在每个符合条件的回合中直接注入。', ja: '対象となる毎ターンに直接注入される、有界かつ決定的なホットメモリ。', es: 'Memoria activa acotada y determinista inyectada directamente en cada turno elegible.', fr: 'Mémoire vive bornée et déterministe injectée directement dans chaque tour éligible.', de: 'Begrenzter, deterministischer Direktspeicher, der direkt in jede geeignete Runde eingefügt wird.', ru: 'Ограниченная детерминированная горячая память, напрямую подставляемая в каждый подходящий ход.', pt: 'Memória ativa limitada e determinística, injetada diretamente em cada turno elegível.' },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.working-context' }],
})

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { plugin: memoryPlugin, sources: [createRuntimeMemorySource(config)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}

export { createRuntimeMemorySource, RUNTIME_MEMORY_SOURCE } from './source.ts'
export type * from './contracts.ts'
