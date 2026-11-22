import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, defineMemoryStrategyConfiguration } from 'dsh-mnemon/extension-sdk'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from './strategy.ts'

export const name = 'dsh-mnemon-strategy-default-three-tier'
export const inject = ['mnemonMemory']

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Layered strategy', 'zh-CN': '分层策略', ja: '階層戦略', es: 'Estrategia por capas', fr: 'Stratégie en couches', de: 'Schichtstrategie', ru: 'Многоуровневая стратегия', pt: 'Estratégia em camadas' },
  description: { en: 'Resident runtime memory, on-demand documents and durable memory.', 'zh-CN': '运行时记忆常驻，档案与长期记忆按需读取。', ja: 'ランタイムメモリを常駐させ、ドキュメントと長期メモリをオンデマンドで読み込みます。', es: 'Memoria de ejecución residente, documentos bajo demanda y memoria duradera.', fr: 'Mémoire d\'exécution résidente, documents à la demande et mémoire durable.', de: 'Dauerhafter Laufzeitspeicher sowie bedarfsgesteuerte Dokumente und Langzeitspeicher.', ru: 'Постоянная память выполнения, документы и долгосрочная память по запросу.', pt: 'Memória de execução residente, documentos sob demanda e memória durável.' },
  roles: ['strategy'],
  provides: [{ id: 'strategy' }, { id: 'strategy.default-three-tier' }],
  requires: ['source'],
})

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy', typeId: 'default-three-tier',
  label: memoryPlugin.label,
  description: { en: 'Compose runtime context, documents and durable memory.', 'zh-CN': '组合运行时、档案与长期记忆。', ja: 'ランタイムコンテキスト、ドキュメント、長期メモリを組み合わせて構成します。', es: 'Compone contexto de ejecución, documentos y memoria duradera.', fr: 'Compose le contexte d\'exécution, les documents et la mémoire durable.', de: 'Kombiniert Laufzeitkontext, Dokumente und Langzeitspeicher.', ru: 'Объединяет контекст выполнения, документы и долгосрочную память.', pt: 'Compõe contexto de execução, documentos e memória durável.' },
  fields: [], create: () => ({ plugin: memoryPlugin, strategies: [DEFAULT_THREE_TIER_VIEW_STRATEGY] }),
})

export function apply(ctx: Context): void {
  installMemory(ctx, memoryStrategyConfiguration.create({}))
}

export { DEFAULT_THREE_TIER_VIEW_STRATEGY }
