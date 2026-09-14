import type { LlmRuntime, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { memoryInputInteger, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { json, type LookupResult } from 'dsh-mnemon/source-sdk'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'

/** Publish only provider-owned display metadata. Credentials and transport configuration stay private. */
export function publicModel(model: LlmResolvedModelInfo) {
  return { provider: model.provider, id: model.id, name: model.name, description: model.description ?? '',
    inputModalities: model.inputModalities ?? null,
    imageInput: model.inputModalities === undefined ? null : model.inputModalities.includes('image'),
    contextWindow: model.context?.contextWindow ?? null, defaultMaxTokens: model.defaultMaxTokens ?? null,
    reasoning: model.reasoning ? { efforts: model.reasoning.efforts.map(value => ({ id: value.id, name: value.name, description: value.description ?? '' })), defaultEffort: model.reasoning.defaultEffort ?? null } : null }
}
export async function modelCatalog(llm: Pick<LlmRuntime, 'listProviders' | 'listModels' | 'resolveModelInfo'> | undefined, input: Record<string, MemoryJsonValue>, signal: AbortSignal): Promise<LookupResult> {
  if (!llm) throw new Error('The native model catalog is unavailable')
  const provider = memoryInputText(input.provider, 'provider', 200, false), model = memoryInputText(input.model, 'model', 300, false), query = (memoryInputText(input.query, 'query', 1000, false) ?? '').toLocaleLowerCase()
  if (model && !provider) throw new Error('An exact model lookup requires its provider')
  const limit = memoryInputInteger(input.limit, 30, 1, 100)
  if (model) {
    const value = publicModel(await llm.resolveModelInfo(provider!, model, signal))
    return { items: [{ id: value.provider + '/' + value.id, text: JSON.stringify(value, null, 2), provenance: json(value) }] }
  }
  const providers = llm.listProviders().filter(value => !provider || value.id === provider), items: LookupResult['items'] = []
  let truncated = providers.length > 32
  for (const value of providers.slice(0, 32)) {
    signal.throwIfAborted()
    const models = await llm.listModels(value.id)
    for (const item of models) {
      const metadata = publicModel(item)
      if (query && !(item.name + '\n' + item.id + '\n' + (item.description ?? '')).toLocaleLowerCase().includes(query)) continue
      if (items.length >= limit) { truncated = true; break }
      items.push({ id: value.id + '/' + item.id, text: JSON.stringify(metadata, null, 2), provenance: json(metadata) })
    }
  }
  return { items, truncated, summary: 'Catalog membership is advisory. Null means unknown; use an exact provider/model query for reasoning and context capacity.' }
}
