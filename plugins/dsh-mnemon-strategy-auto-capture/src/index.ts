import type { Context } from '@deepseek-ai/cordis'
import * as sdk from 'dsh-mnemon/extension-sdk'
import { defineMemoryPlugin, defineMemoryViewExtension, installMemory, defineMemoryStrategyConfiguration, validateMemoryViewExtension } from 'dsh-mnemon/extension-sdk'

export interface Config { sourceKeys?: string[]; actionIds?: string[]; instruction?: string }
export const name = 'dsh-mnemon-strategy-auto-capture'
export const inject = ['mnemonMemory']
export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Active capture', 'zh-CN': '主动记录', ja: 'アクティブキャプチャ', es: 'Captura activa', fr: 'Capture active', de: 'Aktive Erfassung', ru: 'Активная фиксация', pt: 'Captura ativa' },
  description: { en: 'Identify and retain durable facts from the current conversation.', 'zh-CN': '在当前对话中识别并保存值得长期保留的事实。', ja: '現在の会話から長期的に残すべき事実を特定して記録します。', es: 'Identifica y conserva hechos duraderos de la conversación actual.', fr: 'Identifie et conserve les faits durables issus de la conversation en cours.', de: 'Dauerhafte Fakten aus der aktuellen Unterhaltung erkennen und festhalten.', ru: 'Выявляет и сохраняет устойчивые факты из текущего диалога.', pt: 'Identifica e retém fatos duráveis da conversa atual.' },
  roles: ['strategy-extension'],
  provides: [{ id: 'strategy.capture', exclusive: true }],
  requires: ['strategy', 'source.durable-evidence'],
})
const instruction = 'During the current conversation, consider recording at most one new durable user-supplied preference, correction, or established project fact that will help a future task. Compare existing memory first; skip duplicates, secrets, transient progress, guesses, assistant-authored claims and facts merely retrieved from memory. Respect a request not to remember. Prefer adding one concise fact to one eligible durable Source; do not copy the same fact into multiple layers. Continue without writing when no candidate qualifies.'

export function createAutoCaptureExtension(config: Config = {}) {
  const capture = validateMemoryViewExtension('capture', { instruction: config.instruction ?? instruction,
    actionIds: config.actionIds ?? ['remember'],
    ...(config.sourceKeys === undefined ? {} : { sourceKeys: config.sourceKeys }) })
  return defineMemoryViewExtension({ typeId: 'auto-capture', packageName: name, slot: 'capture',
    contribute: (_request, sources) => ({ ...capture, sourceKeys: capture.sourceKeys ?? sources
      .filter(source => source.role === 'durable-evidence').map(source => source.sourceInstanceKey).sort() }),
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  const options = typeof sdk.memoryConfigurationDigest === 'function'
    ? { effectiveDigest: sdk.memoryConfigurationDigest(config) }
    : undefined
  installMemory(ctx, { plugin: memoryPlugin, strategyExtensions: [createAutoCaptureExtension(config)] }, options)
}

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy-extension', typeId: 'auto-capture',
  label: memoryPlugin.label,
  description: { en: 'Guide the current LLM to retain durable user-supplied facts; no background Agent.', 'zh-CN': '引导当前 LLM 保留持久的用户事实，不启动后台 Agent。', ja: 'バックグラウンドエージェントを使わず、現在の LLM に永続的なユーザー事実を保持するよう促します。', es: 'Guía al LLM actual para conservar hechos duraderos aportados por el usuario; sin Agente en segundo plano.', fr: 'Guide le LLM actuel pour retenir les faits durables fournis par l\'utilisateur ; sans Agent en arrière-plan.', de: 'Leitet das aktuelle LLM an, dauerhafte Nutzerfakten festzuhalten; kein Hintergrund-Agent.', ru: 'Направляет текущую LLM на сохранение устойчивых фактов от пользователя; без фонового Агента.', pt: 'Orienta o LLM atual a reter fatos duráveis fornecidos pelo usuário; sem Agente em segundo plano.' },
  fields: [
    { key: 'sourceKeys', input: 'source-list', sourceRoles: ['durable-evidence'], label: { en: 'Recording targets', 'zh-CN': '记录目标', ja: '記録対象ソース', es: 'Destinos de registro', fr: 'Cibles d\'enregistrement', de: 'Erfassungsziele', ru: 'Цели записи', pt: 'Destinos de registro' } },
    { key: 'instruction', input: 'textarea', defaultValue: instruction, maximum: 4000, label: { en: 'Recording instruction', 'zh-CN': '记录指引', ja: '記録指示', es: 'Instrucción de registro', fr: 'Consigne d\'enregistrement', de: 'Erfassungsanweisung', ru: 'Инструкция записи', pt: 'Instrução de registro' } },
    { key: 'actionIds', input: 'string-list', defaultValue: ['remember'], label: { en: 'Recording operation IDs', 'zh-CN': '记录操作 ID', ja: '記録操作 ID', es: 'IDs de operación de registro', fr: 'IDs d\'opération d\'enregistrement', de: 'Erfassungs-Aktions-IDs', ru: 'ID операций записи', pt: 'IDs de operação de registro' }, description: { en: 'Source-local operation IDs; this does not grant write permission.', 'zh-CN': '填写 Source 内部的操作 ID；此配置不会授予写入权限。', ja: 'ソース固有の操作 ID を指定します。この設定で書き込み権限は付与されません。', es: 'IDs de operación locales de la Fuente; esto no concede permiso de escritura.', fr: 'IDs d\'opération locaux à la Source ; ce réglage n\'accorde aucun droit d\'écriture.', de: 'Quellinterne Aktions-IDs; dies erteilt keine Schreibberechtigung.', ru: 'Локальные ID операций Источника; эта настройка не предоставляет прав на запись.', pt: 'IDs de operação locais da Fonte; esta configuração não concede permissão de gravação.' } },
  ],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [createAutoCaptureExtension(config as Config)] }),
})
