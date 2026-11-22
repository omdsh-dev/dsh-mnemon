import type { Context } from '@deepseek-ai/cordis'
import * as sdk from 'dsh-mnemon/extension-sdk'
import { defineMemoryPlugin, defineMemoryViewExtension, installMemory, defineMemoryStrategyConfiguration, validateMemoryViewExtension } from 'dsh-mnemon/extension-sdk'

export interface Config { sourceKeys?: string[]; writableSourceKeys?: string[] }
export const name = 'dsh-mnemon-strategy-scoped'
export const inject = ['mnemonMemory']
export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Scoped composition', 'zh-CN': '范围组合', ja: 'スコープ構成', es: 'Composición acotada', fr: 'Composition ciblée', de: 'Bereichsbezogene Zusammensetzung', ru: 'Ограниченный состав', pt: 'Composição por escopo' },
  description: { en: 'Compose the available memory sources in a stable order.', 'zh-CN': '按稳定顺序组合当前可用的记忆来源。', ja: '利用可能なメモリソースを安定した優先順で構成します。', es: 'Compone las fuentes de memoria disponibles en un orden estable.', fr: 'Compose les Sources de mémoire disponibles dans un ordre stable.', de: 'Setzt die verfügbaren Speicherquellen in einer stabilen Reihenfolge zusammen.', ru: 'Объединяет доступные источники памяти в стабильном порядке.', pt: 'Compõe as fontes de memória disponíveis em ordem estável.' },
  roles: ['strategy-extension'],
  provides: [{ id: 'strategy.selection', exclusive: true }],
  requires: ['strategy'],
})
const roles = ['working-context', 'narrative', 'durable-evidence']
const roleRank = (role: string): number => {
  const index = roles.indexOf(role)
  return index === -1 ? roles.length : index
}

export function createScopedExtension(config: Config = {}) {
  const selection = config.sourceKeys === undefined ? undefined : validateMemoryViewExtension('selection', {
    sourceKeys: config.sourceKeys, ...(config.writableSourceKeys === undefined ? {} : { writableSourceKeys: config.writableSourceKeys }),
  })
  const writable = config.writableSourceKeys === undefined ? undefined : validateMemoryViewExtension('selection', {
    sourceKeys: config.writableSourceKeys, writableSourceKeys: config.writableSourceKeys,
  }).writableSourceKeys
  return defineMemoryViewExtension({ typeId: 'scoped', packageName: name, slot: 'selection',
    contribute: (_request, sources) => selection ?? {
      sourceKeys: [...sources]
        .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.sourceInstanceKey.localeCompare(b.sourceInstanceKey))
        .map(source => source.sourceInstanceKey),
      ...(writable === undefined ? {} : { writableSourceKeys: writable }),
    },
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  const options = typeof sdk.memoryConfigurationDigest === 'function'
    ? { effectiveDigest: sdk.memoryConfigurationDigest(config) }
    : undefined
  installMemory(ctx, { plugin: memoryPlugin, strategyExtensions: [createScopedExtension(config)] }, options)
}

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy-extension', typeId: 'scoped',
  label: memoryPlugin.label,
  description: { en: 'Select and order existing Source instances; optionally narrow writes.', 'zh-CN': '选择并排序已有 Source 实例，可进一步收窄写入范围。', ja: '既存のソースインスタンスを選択して順序付けし、必要に応じて書き込み先も絞り込みます。', es: 'Selecciona y ordena instancias de Fuente existentes; opcionalmente restringe las escrituras.', fr: 'Sélectionne et ordonne les instances de Source existantes ; restreint éventuellement les écritures.', de: 'Wählt vorhandene Quellinstanzen aus, ordnet sie und schränkt optional Schreibzugriffe ein.', ru: 'Выбирает и упорядочивает существующие экземпляры Источников; при необходимости сужает запись.', pt: 'Seleciona e ordena instâncias de Fonte existentes; opcionalmente restringe gravações.' },
  fields: [
    { key: 'sourceKeys', input: 'source-list', label: { en: 'Sources, in priority order', 'zh-CN': '参与 Source（按优先顺序）', ja: '対象ソース（優先順）', es: 'Fuentes, en orden de prioridad', fr: 'Sources, par ordre de priorité', de: 'Quellen nach Priorität', ru: 'Источники в порядке приоритета', pt: 'Fontes, em ordem de prioridade' }, description: { en: 'Unset uses all eligible instances. An explicit empty list selects none.', 'zh-CN': '未设置时使用全部适用实例；明确留空则不选择任何实例。', ja: '未設定の場合は対象となる全インスタンスを使用します。明示的に空リストにすると 1 件も選択されません。', es: 'Sin definir usa todas las instancias elegibles. Una lista explícitamente vacía no selecciona ninguna.', fr: 'Non défini, utilise toutes les instances éligibles. Une liste explicitement vide n\'en sélectionne aucune.', de: 'Ohne Festlegung werden alle geeigneten Instanzen verwendet. Eine explizit leere Liste wählt keine aus.', ru: 'Если не задано, используются все подходящие экземпляры. Явно пустой список не выбирает ни одного.', pt: 'Quando não definido, usa todas as instâncias elegíveis. Uma lista explicitamente vazia não seleciona nenhuma.' } },
    { key: 'writableSourceKeys', input: 'source-list', label: { en: 'Writable Sources', 'zh-CN': '允许写入的 Source', ja: '書き込み可能なソース', es: 'Fuentes escribibles', fr: 'Sources accessibles en écriture', de: 'Beschreibbare Quellen', ru: 'Источники с правом записи', pt: 'Fontes graváveis' }, description: { en: 'Unset preserves existing permissions. An empty list makes this View read-only.', 'zh-CN': '未设置时保留已有权限；明确留空使此 View 只读。', ja: '未設定の場合は既存の権限を維持します。空リストにするとこのビューは読み取り専用になります。', es: 'Sin definir conserva los permisos existentes. Una lista vacía convierte esta Vista en solo lectura.', fr: 'Non défini, conserve les permissions existantes. Une liste vide rend cette Vue en lecture seule.', de: 'Ohne Festlegung bleiben bestehende Berechtigungen erhalten. Eine leere Liste macht diese Ansicht schreibgeschützt.', ru: 'Если не задано, сохраняются текущие права. Пустой список делает это Представление доступным только для чтения.', pt: 'Quando não definido, preserva as permissões existentes. Uma lista vazia torna esta Visão somente leitura.' } },
  ],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [createScopedExtension(config as Config)] }),
})
