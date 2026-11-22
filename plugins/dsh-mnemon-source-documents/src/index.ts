import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { Config } from './config.ts'
import { createDocumentsMemorySource } from './source.ts'

export const name = 'dsh-mnemon-source-documents'
export const inject = ['mnemonMemory']
export { Config }

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Project Documents', 'zh-CN': '项目档案', ja: 'プロジェクトドキュメント', es: 'Documentos del proyecto', fr: 'Documents du projet', de: 'Projektdokumente', ru: 'Документы проекта', pt: 'Documentos do projeto' },
  description: { en: 'Versioned narrative documents searched first and read in full on demand.', 'zh-CN': '可版本化的叙事文档，先检索，再按需阅读全文。', ja: '先に検索し、必要に応じて全文を読み込むバージョン管理付きドキュメント。', es: 'Documentos narrativos versionados que se buscan primero y se leen completos bajo demanda.', fr: 'Documents narratifs versionnés, d\'abord recherchés puis lus intégralement à la demande.', de: 'Versionierte narrative Dokumente, die zuerst durchsucht und bei Bedarf vollständig gelesen werden.', ru: 'Версионируемые повествовательные документы: сначала поиск, затем чтение полного текста по запросу.', pt: 'Documentos narrativos versionados, pesquisados primeiro e lidos na íntegra sob demanda.' },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.narrative' }],
})

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { plugin: memoryPlugin, sources: [createDocumentsMemorySource(config)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}

export { createDocumentsMemorySource, DOCUMENTS_MEMORY_SOURCE } from './source.ts'
export type * from './contracts.ts'
