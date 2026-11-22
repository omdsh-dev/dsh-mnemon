import type { Context } from '@deepseek-ai/cordis'
import * as sdk from 'dsh-mnemon/extension-sdk'
import { defineMemoryPlugin, defineMemoryViewExtension, installMemory, defineMemoryStrategyConfiguration, validateMemoryViewExtension } from 'dsh-mnemon/extension-sdk'

export interface Config { maxProjectionCharacters?: number }
export const name = 'dsh-mnemon-strategy-light-context'
export const inject = ['mnemonMemory']
export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Light context', 'zh-CN': '轻量上下文', ja: '軽量コンテキスト', es: 'Contexto ligero', fr: 'Contexte léger', de: 'Kompakter Kontext', ru: 'Лёгкий контекст', pt: 'Contexto leve' },
  description: { en: 'Reduce resident content while keeping on-demand reads available.', 'zh-CN': '减少常驻内容，同时保留按需读取能力。', ja: 'オンデマンド読み込みを維持しつつ、常駐コンテンツを削減します。', es: 'Reduce el contenido residente manteniendo disponibles las lecturas bajo demanda.', fr: 'Réduit le contenu résident tout en préservant les lectures à la demande.', de: 'Reduziert dauerhafte Inhalte, während bedarfsgesteuerte Lesezugriffe verfügbar bleiben.', ru: 'Уменьшает объём резидентного контекста, сохраняя чтение по запросу.', pt: 'Reduz o conteúdo residente mantendo disponíveis as leituras sob demanda.' },
  roles: ['strategy-extension'],
  provides: [{ id: 'strategy.projection', exclusive: true }],
  requires: ['strategy'],
})

export function createLightContextExtension(config: Config = {}) {
  const projection = validateMemoryViewExtension('projection', { maxProjectionCharacters: config.maxProjectionCharacters ?? 4_096 })
  return defineMemoryViewExtension({ typeId: 'light-context', packageName: name, slot: 'projection', contribute: () => projection })
}

export function apply(ctx: Context, config: Config = {}): void {
  const options = typeof sdk.memoryConfigurationDigest === 'function'
    ? { effectiveDigest: sdk.memoryConfigurationDigest(config) }
    : undefined
  installMemory(ctx, { plugin: memoryPlugin, strategyExtensions: [createLightContextExtension(config)] }, options)
}

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy-extension', typeId: 'light-context',
  label: memoryPlugin.label,
  description: { en: 'Narrow resident context while keeping on-demand reads.', 'zh-CN': '收窄常驻内容预算，保留按需读取。', ja: 'オンデマンド読み込みを残したまま常駐コンテキストの上限を絞ります。', es: 'Reduce el contexto residente manteniendo las lecturas bajo demanda.', fr: 'Réduit le contexte résident tout en conservant les lectures à la demande.', de: 'Verkleinert den dauerhaften Kontext und behält bedarfsgesteuerte Lesezugriffe bei.', ru: 'Сужает резидентный контекст при сохранении чтения по запросу.', pt: 'Restringe o contexto residente preservando leituras sob demanda.' },
  fields: [{ key: 'maxProjectionCharacters', input: 'number', defaultValue: 4096, minimum: 1, maximum: 10_000_000,
    label: { en: 'Resident character ceiling', 'zh-CN': '常驻内容上限（字符）', ja: '常駐文字数上限', es: 'Tope de caracteres residentes', fr: 'Plafond de caractères résidents', de: 'Zeichenobergrenze für dauerhafte Inhalte', ru: 'Предел символов резидентного контекста', pt: 'Limite de caracteres residentes' },
    description: { en: 'Capped by the Host, not a whole-request token budget. Runtime has no on-demand expansion route.', 'zh-CN': '不能超过 Host 上限，不是整个请求的 token 预算。运行时没有按需展开入口。', ja: 'ホストの上限を超えられません（リクエスト全体のトークン上限ではありません）。ランタイムにはオンデマンド展開経路がありません。', es: 'Limitado por el Host, no es un presupuesto de tokens de toda la solicitud. La memoria de ejecución no tiene ruta de expansión bajo demanda.', fr: 'Plafonné par l\'Hôte ; il ne s\'agit pas d\'un budget de tokens pour toute la requête. La Mémoire d\'exécution ne dispose pas d\'expansion à la demande.', de: 'Durch den Host begrenzt, kein Token-Budget für die gesamte Anfrage. Der Laufzeitspeicher hat keinen bedarfsgesteuerten Erweiterungspfad.', ru: 'Ограничивается Хостом, не является бюджетом токенов всего запроса. У Памяти выполнения нет маршрута расширения по запросу.', pt: 'Limitado pelo Host, não representa o orçamento total de tokens da solicitação. A execução não possui rota de expansão sob demanda.' } }],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [createLightContextExtension(config as Config)] }),
})
