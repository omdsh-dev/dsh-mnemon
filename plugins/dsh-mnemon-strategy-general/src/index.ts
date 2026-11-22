import type { Context } from '@deepseek-ai/cordis'
import * as sdk from 'dsh-mnemon/extension-sdk'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory } from 'dsh-mnemon/extension-sdk'
import { createGeneralStrategy, GENERAL_STRATEGY_TYPE_ID, GENERAL_VIEW_STRATEGY, type GeneralStrategyConfig } from './strategy.ts'

export type Config = GeneralStrategyConfig
export const name = 'dsh-mnemon-strategy-general'
export const inject = ['mnemonMemory']

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'General strategy', 'zh-CN': '通用策略', ja: '汎用戦略', es: 'Estrategia general', fr: 'Stratégie générale', de: 'Allgemeine Strategie', ru: 'Общая стратегия', pt: 'Estratégia geral' },
  description: { en: 'Every source available; the model decides how to use each one.', 'zh-CN': '全部来源可用，由模型决定如何使用每一个。', ja: 'すべてのソースを利用可能にし、使い分けをモデルに委ねます。', es: 'Todas las fuentes disponibles; el modelo decide cómo usar cada una.', fr: 'Toutes les Sources sont disponibles ; le modèle décide comment utiliser chacune.', de: 'Jede Quelle ist verfügbar; das Modell entscheidet, wie es jede einzelne nutzt.', ru: 'Доступны все источники; модель сама решает, как использовать каждый из них.', pt: 'Todas as fontes disponíveis; o modelo decide como usar cada uma.' },
  roles: ['strategy'],
  provides: [{ id: 'strategy' }, { id: 'strategy.general' }],
  requires: ['source'],
})

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy', typeId: GENERAL_STRATEGY_TYPE_ID,
  label: memoryPlugin.label,
  description: { en: 'Model-driven use of every admitted Source. No automatic background review or Runtime capacity maintenance.', 'zh-CN': '由模型自主使用每个已接入的 Source；不启用自动后台审查或运行时容量维护。', ja: 'モデル主導ですべての接続済みソースを使用します。自動バックグラウンドレビューとランタイム容量保守は実行されません。', es: 'Uso dirigido por el modelo de cada Fuente admitida. Sin revisión automática en segundo plano ni mantenimiento de capacidad en ejecución.', fr: 'Utilisation pilotée par le modèle de chaque Source admise. Sans révision automatique en arrière-plan ni maintenance de capacité d\'exécution.', de: 'Modellgesteuerte Nutzung jeder zugelassenen Quelle. Keine automatische Hintergrundprüfung oder Kapazitätswartung des Laufzeitspeichers.', ru: 'Использование каждого подключённого Источника под управлением модели. Без автоматической фоновой проверки и обслуживания объёма Памяти выполнения.', pt: 'Uso conduzido pelo modelo de cada Fonte admitida. Sem revisão automática em segundo plano nem manutenção de capacidade de execução.' },
  fields: [
    { key: 'residentSourceKeys', input: 'source-list',
      label: { en: 'Resident Sources', 'zh-CN': '常驻 Source', ja: '常駐ソース', es: 'Fuentes residentes', fr: 'Sources résidentes', de: 'Dauerhafte Quellen', ru: 'Резидентные Источники', pt: 'Fontes residentes' },
      description: { en: 'Projected into every turn. Unset keeps working-context Sources resident; the others stay on demand.', 'zh-CN': '每轮直接投影到上下文。未设置时常驻工作上下文类 Source，其余按需读取。', ja: '毎ターンに投影されます。未設定の場合は作業コンテキスト系ソースのみ常駐し、他はオンデマンドになります。', es: 'Se proyectan en cada turno. Sin definir mantiene residentes las Fuentes de contexto de trabajo; las demás quedan bajo demanda.', fr: 'Projetées dans chaque tour. Non défini, conserve résidentes les Sources de contexte de travail ; les autres restent à la demande.', de: 'Wird in jede Runde projiziert. Ohne Festlegung bleiben Arbeitskontext-Quellen dauerhaft aktiv; die übrigen bleiben bedarfsgesteuert.', ru: 'Проецируются в каждый ход. Если не задано, резидентными остаются Источники рабочего контекста, остальные работают по запросу.', pt: 'Projetadas em cada turno. Quando não definido, mantém residentes as Fontes de contexto de trabalho; as demais ficam sob demanda.' } },
    { key: 'instruction', input: 'textarea', maximum: 4000,
      label: { en: 'Additional guidance', 'zh-CN': '附加指引', ja: '追加ガイドライン', es: 'Orientación adicional', fr: 'Consignes supplémentaires', de: 'Zusätzliche Hinweise', ru: 'Дополнительные указания', pt: 'Orientação adicional' },
      description: { en: 'Optional guidance appended to the memory protocol for every turn.', 'zh-CN': '可选，每轮追加到记忆协议的指引。', ja: '任意。毎ターンのメモリプロトコルに追記される指示です。', es: 'Orientación opcional añadida al protocolo de memoria en cada turno.', fr: 'Consignes facultatives ajoutées au protocole mémoire à chaque tour.', de: 'Optionale Hinweise, die in jeder Runde an das Speicherprotokoll angehängt werden.', ru: 'Необязательные указания, добавляемые к протоколу памяти на каждом ходе.', pt: 'Orientação opcional anexada ao protocolo de memória em cada turno.' } },
  ],
  create: config => ({ plugin: memoryPlugin, strategies: [createGeneralStrategy(config as GeneralStrategyConfig)] }),
})

export function apply(ctx: Context, config: Config = {}): void {
  const options = typeof sdk.memoryConfigurationDigest === 'function'
    ? { effectiveDigest: sdk.memoryConfigurationDigest(config) }
    : undefined
  installMemory(ctx, memoryStrategyConfiguration.create(config as never), options)
}

export { createGeneralStrategy, GENERAL_STRATEGY_TYPE_ID, GENERAL_VIEW_STRATEGY }
