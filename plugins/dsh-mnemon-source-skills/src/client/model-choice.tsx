import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FieldOption, TaskAgentModelCatalog } from 'dsh-mnemon/client'
import type { DraftPreferencesView, ModelRoute } from '../contracts.ts'
import { useT, type SkillsTranslate } from './presentation.ts'
import type { SkillsPageContext } from './ui.tsx'

export function modelOptionValue(model: ModelRoute | null | undefined): string {
  if (model === null || model === undefined) return 'auto'
  return `${model.provider}|${model.model}`
}

export function modelOptionPick(value: string): ModelRoute | null {
  const at = value.indexOf('|')
  if (at <= 0) return null
  return { provider: value.slice(0, at), model: value.slice(at + 1) }
}

export function modelOptionsFrom(models: TaskAgentModelCatalog | null, t: SkillsTranslate, autoKey: 'tests.modelAuto' | 'evolution.modelAuto'): FieldOption<string>[] {
  const label = models?.effective?.model ?? models?.inherited?.model ?? models?.defaultSelection?.model
  const options: FieldOption<string>[] = [{ value: 'auto', label: label ?? t(autoKey), detail: t('evolution.modelAutoHint') }]
  if (models === null) return options
  for (const group of models.groups) {
    for (const entry of group.models) options.push({ value: `${group.id}|${entry.id}`, label: entry.name, detail: group.name })
  }
  return options
}

export function modelCardOptionsFrom(
  modelOptions: readonly FieldOption<string>[],
  t: SkillsTranslate,
  autoKey: 'tests.modelAuto' | 'evolution.modelAuto',
  defaultModel?: ModelRoute | null,
): FieldOption<string>[] {
  const autoLabel = t(autoKey)
  let detail: string
  if (defaultModel !== null && defaultModel !== undefined) {
    const target = `${defaultModel.provider}|${defaultModel.model}`
    detail = modelOptions.slice(1).find(option => option.value === target)?.label ?? defaultModel.model
  } else if (modelOptions[0] !== undefined && modelOptions[0].label !== autoLabel) {
    detail = modelOptions[0].label
  } else {
    detail = t('evolution.modelAutoHint')
  }
  return [{ value: 'auto', label: autoLabel, detail }, ...modelOptions.slice(1)]
}

const NO_PREFERENCES: DraftPreferencesView = { suggestionModels: {}, skillRunModels: {} }

export interface ModelChoice {
  models: TaskAgentModelCatalog | null
  preferences: DraftPreferencesView
  options: FieldOption<string>[]
  cardOptions: FieldOption<string>[]
  saveDraftModel(model: ModelRoute | null): void
  saveSuggestionModel(id: string, model: ModelRoute | null): void
  saveRunModel(model: ModelRoute | null): void
  saveSkillRunModel(skillName: string, model: ModelRoute | null): void
}

export function useModelChoice(context: SkillsPageContext, autoKey: 'tests.modelAuto' | 'evolution.modelAuto'): ModelChoice {
  const t = useT()
  const [models, setModels] = useState<TaskAgentModelCatalog | null>(null)
  const [preferences, setPreferences] = useState<DraftPreferencesView>(NO_PREFERENCES)
  useEffect(() => {
    let active = true
    void context.client.models().then(value => { if (active) setModels(value) }).catch(() => undefined)
    return () => { active = false }
  }, [context.client])
  const configRevision = context.configRevision ?? 0
  useEffect(() => {
    let active = true
    void context.client.draftPreferences().then(value => { if (active) setPreferences(value) }).catch(() => undefined)
    return () => { active = false }
  }, [context.client, configRevision])
  const write = useCallback((apply: (current: DraftPreferencesView) => DraftPreferencesView, operation: () => Promise<DraftPreferencesView>) => {
    setPreferences(current => apply(current))
    void operation().then(next => {
      setPreferences(next)
    }).catch((error: unknown) => {
      context.fail(error)
      context.client.invalidatePreferences?.()
      void context.client.draftPreferences().then(setPreferences).catch(() => undefined)
    })
  }, [context])
  const defaultModel = autoKey === 'tests.modelAuto' ? preferences.runModel : preferences.model
  const options = useMemo(() => modelOptionsFrom(models, t, autoKey), [models, t, autoKey])
  const cardOptions = useMemo(() => modelCardOptionsFrom(options, t, autoKey, defaultModel), [options, t, autoKey, defaultModel])
  return {
    models,
    preferences,
    options,
    cardOptions,
    saveDraftModel: model => write(
      current => model === null ? omit(current, 'model') : { ...current, model },
      () => context.client.saveDraftModel(model),
    ),
    saveSuggestionModel: (id, model) => write(
      current => {
        const suggestionModels = { ...current.suggestionModels }
        if (model === null) delete suggestionModels[id]
        else suggestionModels[id] = model
        return { ...current, suggestionModels }
      },
      () => context.client.saveSuggestionModel(id, model),
    ),
    saveRunModel: model => write(
      current => model === null ? omit(current, 'runModel') : { ...current, runModel: model },
      () => context.client.saveRunModel(model),
    ),
    saveSkillRunModel: (skillName, model) => write(
      current => {
        const skillRunModels = { ...current.skillRunModels }
        if (model === null) delete skillRunModels[skillName]
        else skillRunModels[skillName] = model
        return { ...current, skillRunModels }
      },
      () => context.client.saveSkillRunModel(skillName, model),
    ),
  }
}

function omit(preferences: DraftPreferencesView, key: 'model' | 'runModel'): DraftPreferencesView {
  if (preferences[key] === undefined) return preferences
  const next = { ...preferences }
  delete next[key]
  return next
}
