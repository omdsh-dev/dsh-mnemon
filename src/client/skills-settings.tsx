import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DEFAULT_SKILLS_CONFIG,
  namedToolInstance,
  validSkillsTimeZone,
  type ClientConnectionHandle,
  type ClientSettingsScope,
  type JsonValue,
  type MemorySourceManagementResult,
  type ResolvedSkillsConfig,
  type SettingsOperation,
  type SkillsConfig,
  type TaskAgentModelCatalog,
} from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MemoryComponentSettingsProps } from './component-ui.tsx'
import { ActionButton } from './feedback.tsx'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'
import { message } from './page-kit.tsx'
import type { MnemonDirectoryPicker } from './picker.ts'
import { AdvancedSection, SelectRow, SettingRow, ToggleRow, type SettingOption } from './settings-controls.tsx'
import { PanelActions, useLive, useScope, useStaged, WriteFailure } from './settings-panel.tsx'

/** The package 技能管理 ships as; its page under Plugins carries these settings. */
export const SKILLS_PACKAGE = 'dsh-mnemon-source-skills'
const SKILLS_MANAGEMENT_INSTANCE = 'skills/default'
const AUTO_MODEL = 'auto'

type SkillsModelSelection = {
  provider: string
  model: string
}

interface DraftPreferencesPayload {
  model?: SkillsModelSelection | null
  draftModel?: SkillsModelSelection | null
  runModel?: SkillsModelSelection | null
}

interface RawMarketRegistry {
  id?: string
  name?: string | { en?: string; 'zh-CN'?: string }
  label?: string
  location?: string
  url?: string
  builtin?: boolean
  enabled?: boolean
  entries?: number
  skillCount?: number
  error?: string
}

interface MarketPayload {
  registries?: RawMarketRegistry[]
}

interface MarketRegistryItem {
  id: string
  label: string
  url: string
  builtin: boolean
  enabled: boolean
  skillCount: number
  error?: string | undefined
}

function encodeModelChoice(selection: SkillsModelSelection | null | undefined): string {
  if (selection === null || selection === undefined) return AUTO_MODEL
  const provider = selection.provider?.trim() ?? ''
  const model = selection.model?.trim() ?? ''
  return provider === '' || model === '' ? AUTO_MODEL : `${provider}|${model}`
}

function decodeModelChoice(value: string): SkillsModelSelection | null {
  if (value === '' || value === AUTO_MODEL) return null
  const splitAt = value.indexOf('|')
  if (splitAt <= 0 || splitAt >= value.length - 1) return null
  return { provider: value.slice(0, splitAt), model: value.slice(splitAt + 1) }
}

function normalizeMarketRegistries(payload: MarketPayload | null | undefined, language: string): MarketRegistryItem[] {
  const rawList = Array.isArray(payload?.registries) ? payload.registries : []
  const isZh = language.toLowerCase().startsWith('zh')
  return rawList.flatMap(raw => {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    if (id === '') return []
    const localizedName = typeof raw.name === 'string'
      ? raw.name
      : raw.name !== undefined && raw.name !== null
        ? (isZh ? (raw.name['zh-CN'] ?? raw.name.en) : (raw.name.en ?? raw.name['zh-CN']))
        : undefined
    const label = (localizedName ?? raw.label ?? id).trim() || id
    const url = (raw.location ?? raw.url ?? '').trim()
    const skillCount = typeof raw.entries === 'number' ? raw.entries : typeof raw.skillCount === 'number' ? raw.skillCount : 0
    return [{
      id,
      label,
      url,
      builtin: raw.builtin === true,
      enabled: raw.enabled !== false,
      skillCount,
      ...(typeof raw.error === 'string' && raw.error.trim() !== '' ? { error: raw.error.trim() } : {}),
    }]
  })
}

/** 技能管理's settings as stored, every missing key at its default. */
export function resolvedSkills(value: SkillsConfig | undefined): ResolvedSkillsConfig {
  return { ...DEFAULT_SKILLS_CONFIG, ...value }
}

type Parameter = 'reviewThreshold' | 'idleSeconds' | 'cooldownSeconds' | 'minConfidence' | 'expiryDays' | 'maxPendingPerSession' | 'casesPerRun'
type DirectoryKey = 'dshHome' | 'agentsHome'

/** The review parameters, with the ranges the Host accepts. */
const PARAMETERS: ReadonlyArray<{ key: Parameter; min: number; max: number; integer: boolean }> = [
  { key: 'reviewThreshold', min: 1, max: 50, integer: true },
  { key: 'idleSeconds', min: 0, max: 3_600, integer: true },
  { key: 'cooldownSeconds', min: 0, max: 86_400, integer: true },
  { key: 'minConfidence', min: 0, max: 1, integer: false },
  { key: 'expiryDays', min: 1, max: 90, integer: true },
  { key: 'maxPendingPerSession', min: 1, max: 20, integer: true },
  { key: 'casesPerRun', min: 1, max: 20, integer: true },
]

const DRAFT_PARAMETERS = [
  { key: 'draftMaxTokens', min: 128, max: 131_072, integer: true },
  { key: 'draftRetryMaxTokens', min: 128, max: 131_072, integer: true },
] as const

const DIRECTORY_FIELDS: ReadonlyArray<{ key: DirectoryKey; placeholder: string }> = [
  { key: 'dshHome', placeholder: '~/.dsh' },
  { key: 'agentsHome', placeholder: '~/.agents' },
]

/** The value a parameter stores, or undefined when the Host would refuse it. */
function parameterValue(field: { min: number; max: number; integer: boolean }, text: string): number | undefined {
  if (text.trim() === '') return undefined
  const value = Number(text)
  if (!Number.isFinite(value) || value < field.min || value > field.max) return undefined
  return field.integer && !Number.isInteger(value) ? undefined : value
}

const parametersOf = (settings: ResolvedSkillsConfig): Record<Parameter, string> =>
  Object.fromEntries(PARAMETERS.map(field => [field.key, String(settings[field.key])])) as Record<Parameter, string>

function set(key: keyof ResolvedSkillsConfig, value: boolean | number | string): SettingsOperation {
  return { op: 'set', path: [key], value }
}

interface SkillsManagementHandle {
  read<T = JsonValue>(sourceInstanceKey: string, operation: string, input?: JsonValue): Promise<T>
  mutate<T = JsonValue>(sourceInstanceKey: string, operation: string, input?: JsonValue): Promise<T>
}

function unwrapManagementResult<T>(result: MemorySourceManagementResult): T {
  if (typeof result === 'object' && result !== null) {
    if ('value' in result) return result.value as T
    if ('payload' in (result as Record<string, unknown>)) return (result as unknown as { payload: T }).payload
  }
  return result as unknown as T
}

function createSkillsManagement(client: MnemonClient): SkillsManagementHandle {
  const revisions = new Map<string, string>()
  const aliases = new Map<string, string>()
  let catalogInflight: Promise<Awaited<ReturnType<MnemonClient['sourceManagementCatalog']>>> | undefined

  const refreshCatalog = async () => {
    catalogInflight ??= client.sourceManagementCatalog().finally(() => { catalogInflight = undefined })
    const catalog = await catalogInflight
    for (const instance of catalog.sources ?? []) revisions.set(instance.sourceInstanceKey, instance.revision)
    return catalog
  }

  const resolveAlias = async (sourceInstanceKey: string): Promise<string | undefined> => {
    const match = /^([a-z0-9-]+)\/default$/u.exec(sourceInstanceKey)
    if (match === null) return undefined
    try {
      const catalog = await refreshCatalog()
      const target = namedToolInstance((catalog.sources ?? []).filter(source => source.sourceTypeId === match[1]!), match[1]!)
      if (target === undefined) return undefined
      aliases.set(sourceInstanceKey, target.sourceInstanceKey)
      return target.sourceInstanceKey
    } catch {
      return undefined
    }
  }

  const resolveTargetKey = async (sourceInstanceKey: string): Promise<string> => {
    const cached = aliases.get(sourceInstanceKey)
    if (cached !== undefined) return cached
    if (/^([a-z0-9-]+)\/default$/u.test(sourceInstanceKey)) {
      const resolved = await resolveAlias(sourceInstanceKey)
      if (resolved !== undefined) return resolved
    }
    return sourceInstanceKey
  }

  const readRaw = async (targetKey: string, operation: string, input: JsonValue) => {
    const result = await client.readSourceManagement(targetKey, operation, input)
    if (typeof result?.revision === 'string') revisions.set(targetKey, result.revision)
    return result
  }

  const mutateRaw = async (targetKey: string, operation: string, input: JsonValue, revision: string) => {
    const result = await client.mutateSourceManagement(targetKey, operation, input, revision, true)
    if (typeof result?.revision === 'string') revisions.set(targetKey, result.revision)
    return result
  }

  return {
    async read<T = JsonValue>(sourceInstanceKey: string, operation: string, input: JsonValue = {}): Promise<T> {
      const targetKey = await resolveTargetKey(sourceInstanceKey)
      try {
        return unwrapManagementResult<T>(await readRaw(targetKey, operation, input))
      } catch (error) {
        if (!/does not expose management operations|unknown source instance/iu.test(error instanceof Error ? error.message : String(error))) throw error
        aliases.delete(sourceInstanceKey)
        const resolvedKey = await resolveAlias(sourceInstanceKey)
        if (resolvedKey === undefined || resolvedKey === targetKey) throw error
        return unwrapManagementResult<T>(await readRaw(resolvedKey, operation, input))
      }
    },
    async mutate<T = JsonValue>(sourceInstanceKey: string, operation: string, input: JsonValue = {}): Promise<T> {
      let targetKey = await resolveTargetKey(sourceInstanceKey)
      const resolveRevision = async (forceRefresh: boolean): Promise<string> => {
        if (!forceRefresh) {
          const cached = revisions.get(targetKey)
          if (cached !== undefined && cached !== '') return cached
        }
        try {
          const catalog = await refreshCatalog()
          const direct = (catalog.sources ?? []).find(instance => instance.sourceInstanceKey === targetKey)
          if (direct !== undefined) return direct.revision
          const match = /^([a-z0-9-]+)\/default$/u.exec(sourceInstanceKey)
          if (match !== null) {
            const aliased = namedToolInstance((catalog.sources ?? []).filter(source => source.sourceTypeId === match[1]!), match[1]!)
            if (aliased !== undefined) {
              targetKey = aliased.sourceInstanceKey
              aliases.set(sourceInstanceKey, targetKey)
              return aliased.revision
            }
          }
        } catch {
          return ''
        }
        return ''
      }
      const revision = await resolveRevision(false)
      try {
        return unwrapManagementResult<T>(await mutateRaw(targetKey, operation, input, revision))
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        if (/does not expose management operations|unknown source instance/iu.test(text)) {
          aliases.delete(sourceInstanceKey)
          const resolvedKey = await resolveAlias(sourceInstanceKey)
          if (resolvedKey !== undefined && resolvedKey !== targetKey) {
            targetKey = resolvedKey
            return unwrapManagementResult<T>(await mutateRaw(targetKey, operation, input, revisions.get(targetKey) ?? ''))
          }
        }
        if (!/revision/iu.test(text)) throw error
        const refreshed = await resolveRevision(true)
        if (refreshed === '' || refreshed === revision) throw error
        return unwrapManagementResult<T>(await mutateRaw(targetKey, operation, input, refreshed))
      }
    },
  }
}

/**
 * 技能管理's settings on its page under Plugins. Switches and default model
 * selections apply at once; directories, destination and folded review
 * parameters wait for their own Apply.
 */
export function SkillsSettings(props: {
  scope: ClientSettingsScope<SkillsConfig>
  page: MemoryComponentSettingsProps
  connection?: ClientConnectionHandle | undefined
  directoryPicker?: MnemonDirectoryPicker | undefined
  t: MnemonTranslate
}): JSX.Element {
  const { scope, page, connection, directoryPicker, t } = props
  const baseId = useId()
  const snapshot = useScope(scope)
  const saved = resolvedSkills(snapshot.value)
  const write = (key: keyof ResolvedSkillsConfig) => async (value: boolean): Promise<void> => { await scope.mutate([set(key, value)]) }
  const evolution = useLive(saved.evolution, write('evolution'))
  const allowCreate = useLive(saved.allowCreate, write('allowCreate'))
  const allowUpdate = useLive(saved.allowUpdate, write('allowUpdate'))
  const linkedUpdates = useLive(saved.allowLinkedUpdates, write('allowLinkedUpdates'))
  const autoBacktest = useLive(saved.autoBacktest, write('autoBacktest'))
  const autoAdopt = useLive(saved.autoAdopt, write('autoAdopt'))
  const hints = useLive(saved.hints, write('hints'))
  const sidebar = useLive(saved.sidebar, write('sidebar'))
  const destination = useStaged({ targetScope: saved.targetScope }, async draft => {
    await scope.mutate([set('targetScope', draft.targetScope)])
  })
  const savedDirectories = { dshHome: saved.dshHome ?? '', agentsHome: saved.agentsHome ?? '' }
  const directories = useStaged(savedDirectories, async draft => {
    const operations: SettingsOperation[] = []
    for (const { key } of DIRECTORY_FIELDS) {
      const next = draft[key].trim()
      const before = savedDirectories[key].trim()
      if (next !== before) {
        operations.push(next === '' ? { op: 'unset', path: [key] } : set(key, next))
      }
    }
    if (operations.length > 0) await scope.mutate(operations)
  })
  const parameters = useStaged(parametersOf(saved), async draft => {
    const changed = PARAMETERS.filter(field => parameterValue(field, draft[field.key]) !== saved[field.key])
    if (changed.length > 0) await scope.mutate(changed.map(field => set(field.key, parameterValue(field, draft[field.key])!)))
  })
  const draftBudgets = useStaged({ draftMaxTokens: String(saved.draftMaxTokens), draftRetryMaxTokens: String(saved.draftRetryMaxTokens) }, async draft => {
    const changed = DRAFT_PARAMETERS.filter(field => parameterValue(field, draft[field.key]) !== saved[field.key])
    if (changed.length > 0) await scope.mutate(changed.map(field => set(field.key, parameterValue(field, draft[field.key])!)))
  })
  const adoptionBudget = useStaged({ limit: String(saved.autoAdoptDailyLimit), timeZone: saved.autoAdoptTimeZone }, async draft => {
    await scope.mutate([set('autoAdoptDailyLimit', Number(draft.limit)), set('autoAdoptTimeZone', draft.timeZone.trim())])
  })
  const invalidAdoption = parameterValue({ min: 0, max: 100, integer: true }, adoptionBudget.draft.limit) === undefined
    || !validSkillsTimeZone(adoptionBudget.draft.timeZone.trim())
  const disabled = !page.writable || snapshot.status === 'loading' || !snapshot.writable
  const invalid = PARAMETERS.find(field => parameterValue(field, parameters.draft[field.key]) === undefined)
  const invalidDraft = DRAFT_PARAMETERS.find(field => parameterValue(field, draftBudgets.draft[field.key]) === undefined)

  // Directory chooser for DSH home and Shared Agents home.
  const canPickDirectory = directoryPicker?.available() === true
  const [pickingKey, setPickingKey] = useState<DirectoryKey | null>(null)
  const [pickerFailed, setPickerFailed] = useState(false)
  const pickSeq = useRef(0)
  useEffect(() => () => { pickSeq.current += 1 }, [])
  const pickDirectory = async (key: DirectoryKey): Promise<void> => {
    if (!canPickDirectory || disabled || directories.saving || pickingKey !== null) return
    const current = ++pickSeq.current
    setPickingKey(key)
    setPickerFailed(false)
    try {
      const picked = await directoryPicker!.pick()
      if (pickSeq.current === current && picked !== null) directories.edit({ [key]: picked })
    } catch {
      if (pickSeq.current === current) setPickerFailed(true)
    } finally {
      if (pickSeq.current === current) setPickingKey(null)
    }
  }

  // Live Skills Source management: default models and market registries.
  const client = useMemo(
    () => connection === undefined ? undefined : new MnemonClient(connection, page.sessionId, page.workspace?.id),
    [connection, page.sessionId, page.workspace?.id],
  )
  const management = useMemo(
    () => client === undefined ? undefined : createSkillsManagement(client),
    [client],
  )
  const [modelsState, setModelsState] = useState<{
    ready: boolean
    catalog: TaskAgentModelCatalog | null
    draft: string
    run: string
    savingSlot: 'draft' | 'run' | null
    error: string | null
  }>({ ready: false, catalog: null, draft: AUTO_MODEL, run: AUTO_MODEL, savingSlot: null, error: null })
  const [marketState, setMarketState] = useState<{
    ready: boolean
    registries: MarketRegistryItem[]
    busyAction: string | null
    addInput: string
    error: string | null
  }>({ ready: false, registries: [], busyAction: null, addInput: '', error: null })

  useEffect(() => {
    if (client === undefined || management === undefined) {
      setModelsState({ ready: false, catalog: null, draft: AUTO_MODEL, run: AUTO_MODEL, savingSlot: null, error: null })
      setMarketState({ ready: false, registries: [], busyAction: null, addInput: '', error: null })
      return
    }
    let active = true
    void Promise.all([
      client.taskAgentModels(true).catch(() => null),
      management.read<DraftPreferencesPayload>(SKILLS_MANAGEMENT_INSTANCE, 'draft-preferences', {}),
    ]).then(([catalog, prefs]) => {
      if (!active) return
      setModelsState({
        ready: true,
        catalog,
        draft: encodeModelChoice(prefs?.model ?? prefs?.draftModel),
        run: encodeModelChoice(prefs?.runModel),
        savingSlot: null,
        error: null,
      })
    }, () => {
      if (active) setModelsState(current => ({ ...current, ready: false }))
    })
    void management.read<MarketPayload>(SKILLS_MANAGEMENT_INSTANCE, 'market', {}).then(market => {
      if (!active) return
      setMarketState({
        ready: true,
        registries: normalizeMarketRegistries(market, page.language),
        busyAction: null,
        addInput: '',
        error: null,
      })
    }, () => {
      if (active) setMarketState(current => ({ ...current, ready: false }))
    })
    return () => { active = false }
  }, [client, management, page.language])

  const modelOptions = (selectedValue: string): SettingOption<string>[] => {
    const groups = modelsState.catalog?.groups ?? []
    const listed: SettingOption<string>[] = groups.flatMap(group =>
      group.models.map(model => ({
        value: `${group.id}|${model.id}`,
        label: `${group.name} / ${model.name}`,
      })),
    )
    const missingSelected = selectedValue !== AUTO_MODEL && !listed.some(option => option.value === selectedValue)
      ? [{ value: selectedValue, label: selectedValue.replace('|', ' / ') }]
      : []
    return [
      { value: AUTO_MODEL, label: t('skills.modelAuto') },
      ...missingSelected,
      ...listed,
    ]
  }

  const updateModelSlot = (slot: 'draft' | 'run', nextValue: string): void => {
    if (management === undefined) return
    const previous = modelsState[slot]
    setModelsState(current => ({ ...current, [slot]: nextValue, savingSlot: slot, error: null }))
    void management.mutate<DraftPreferencesPayload>(SKILLS_MANAGEMENT_INSTANCE, 'draft-preference', {
      slot,
      model: decodeModelChoice(nextValue),
    }).then(updated => {
      setModelsState(current => ({
        ...current,
        draft: updated !== undefined && ('model' in updated || 'draftModel' in updated) ? encodeModelChoice(updated.model ?? updated.draftModel) : (slot === 'draft' ? nextValue : current.draft),
        run: updated !== undefined && 'runModel' in updated ? encodeModelChoice(updated.runModel) : (slot === 'run' ? nextValue : current.run),
        savingSlot: current.savingSlot === slot ? null : current.savingSlot,
      }))
    }, reason => {
      setModelsState(current => ({
        ...current,
        [slot]: previous,
        savingSlot: current.savingSlot === slot ? null : current.savingSlot,
        error: message(reason),
      }))
    })
  }

  const runMarketMutation = (busyKey: string, operation: string, input: Record<string, string | boolean>, clearInput = false): void => {
    if (management === undefined) return
    setMarketState(current => ({ ...current, busyAction: busyKey, error: null }))
    void management.mutate<MarketPayload>(SKILLS_MANAGEMENT_INSTANCE, operation, input).then(updated => {
      if (Array.isArray(updated?.registries)) {
        setMarketState(current => ({
          ...current,
          registries: normalizeMarketRegistries(updated, page.language),
          busyAction: null,
          ...(clearInput ? { addInput: '' } : {}),
        }))
        return
      }
      return management.read<MarketPayload>(SKILLS_MANAGEMENT_INSTANCE, 'market', {}).then(reloaded => {
        setMarketState(current => ({
          ...current,
          registries: normalizeMarketRegistries(reloaded, page.language),
          busyAction: null,
          ...(clearInput ? { addInput: '' } : {}),
        }))
      })
    }).catch(reason => {
      setMarketState(current => ({ ...current, busyAction: null, error: message(reason) }))
    })
  }

  return <section className={css.panelSection} aria-label={t('skills.label')}>
    <div className={css.rows}>
      <ToggleRow id="mnemon-skills-hints" label={t('skills.hints')} hint={t('skills.hintsHint')} checked={hints.value} disabled={disabled} onChange={hints.set} />
      <ToggleRow id="mnemon-skills-sidebar" label={t('skills.sidebar')} hint={t('skills.sidebarHint')} checked={sidebar.value} disabled={disabled} onChange={sidebar.set} />
      <SelectRow id="mnemon-skills-target" label={t('skills.targetScope')} hint={t('skills.targetScopeHint')} value={destination.draft.targetScope}
        options={(['user', 'project', 'storage'] as const).map(value => ({ value, label: t(`skills.targetScope.${value}`) }))}
        disabled={disabled || destination.saving} onChange={targetScope => destination.edit({ targetScope })} />
      <PanelActions dirty={destination.dirty} saving={destination.saving} applied={destination.applied} failed={destination.failed} disabled={disabled} invalid={null} t={t}
        onDiscard={destination.discard} onApply={() => { void destination.apply() }} />
      <ToggleRow id="mnemon-skills-linked-updates" label={t('skills.allowLinkedUpdates')} hint={t('skills.allowLinkedUpdatesHint')} checked={linkedUpdates.value} disabled={disabled} onChange={linkedUpdates.set} />

      <ToggleRow id="mnemon-skills-evolution" label={t('skills.evolution')} hint={t('skills.evolutionHint')} checked={evolution.value} disabled={disabled} onChange={evolution.set} />
      {evolution.value && <div className={css.evolutionGroup}>
        <ToggleRow id="mnemon-skills-create" label={t('skills.allowCreate')} hint={t('skills.allowCreateHint')} checked={allowCreate.value} disabled={disabled} onChange={allowCreate.set} />
        <ToggleRow id="mnemon-skills-update" label={t('skills.allowUpdate')} hint={t('skills.allowUpdateHint')} checked={allowUpdate.value} disabled={disabled} onChange={allowUpdate.set} />
        <ToggleRow id="mnemon-skills-backtest" label={t('skills.autoBacktest')} hint={t('skills.autoBacktestHint')} checked={autoBacktest.value} disabled={disabled} onChange={autoBacktest.set} />
        <ToggleRow id="mnemon-skills-auto-adopt" label={t('skills.autoAdopt')} hint={t('skills.autoAdoptHint')} checked={autoAdopt.value} disabled={disabled || !autoBacktest.value} onChange={autoAdopt.set} />
        <SettingRow htmlFor={`${baseId}-adopt-limit`} title={t('skills.autoAdoptDailyLimit')} hint={t('skills.autoBudgetHint')}>
          <input id={`${baseId}-adopt-limit`} className={css.numberInput} type="number" min={0} max={100} step={1} inputMode="numeric"
            value={adoptionBudget.draft.limit} disabled={disabled || adoptionBudget.saving}
            aria-invalid={parameterValue({ min: 0, max: 100, integer: true }, adoptionBudget.draft.limit) === undefined}
            onChange={event => adoptionBudget.edit({ limit: event.target.value })} />
        </SettingRow>
        <SettingRow htmlFor={`${baseId}-adopt-tz`} title={t('skills.autoAdoptTimeZone')}>
          <input id={`${baseId}-adopt-tz`} className={css.compactTextInput} type="text" value={adoptionBudget.draft.timeZone}
            placeholder="local / Asia/Shanghai" disabled={disabled || adoptionBudget.saving}
            aria-invalid={!validSkillsTimeZone(adoptionBudget.draft.timeZone.trim())}
            onChange={event => adoptionBudget.edit({ timeZone: event.target.value })} />
        </SettingRow>
        <PanelActions dirty={adoptionBudget.dirty} saving={adoptionBudget.saving} applied={adoptionBudget.applied} failed={adoptionBudget.failed} disabled={disabled} t={t}
          invalid={invalidAdoption ? t('skills.autoBudgetInvalid') : null} onDiscard={adoptionBudget.discard} onApply={() => { void adoptionBudget.apply() }} />
        <AdvancedSection title={t('skills.parameters')} section="parameters" activeSection={page.section}>
          <div className={css.fieldGrid}>
            {PARAMETERS.map(field => <label key={field.key}>{t(`skills.${field.key}`)}
              <input type="number" step={field.integer ? 1 : 0.05} inputMode={field.integer ? 'numeric' : 'decimal'} value={parameters.draft[field.key]} disabled={disabled}
                aria-invalid={parameterValue(field, parameters.draft[field.key]) === undefined}
                onChange={event => parameters.edit({ [field.key]: event.target.value })} />
            </label>)}
          </div>
          <PanelActions dirty={parameters.dirty} saving={parameters.saving} applied={parameters.applied} failed={parameters.failed} disabled={disabled} t={t}
            invalid={invalid === undefined ? null : t('skills.invalid', { field: t(`skills.${invalid.key}`), min: invalid.min, max: invalid.max })}
            onDiscard={parameters.discard} onApply={() => { void parameters.apply() }} />
        </AdvancedSection>
      </div>}

      {modelsState.ready && <div className={css.skillsSubgroup} data-settings-section="models">
        <div className={css.panelHeading}>
          <h3>{t('skills.models')}</h3>
          <p>{t('skills.modelsHint')}</p>
        </div>
        <SelectRow id="mnemon-skills-draft-model" label={t('skills.draftModel')} hint={t('skills.draftModelHint')}
          value={modelsState.draft} options={modelOptions(modelsState.draft)}
          disabled={disabled || modelsState.savingSlot === 'draft'} onChange={value => updateModelSlot('draft', value)} />
        <SelectRow id="mnemon-skills-run-model" label={t('skills.runModel')} hint={t('skills.runModelHint')}
          value={modelsState.run} options={modelOptions(modelsState.run)}
          disabled={disabled || modelsState.savingSlot === 'run'} onChange={value => updateModelSlot('run', value)} />
        <WriteFailure error={modelsState.error} t={t} />
      </div>}

      <AdvancedSection title={t('skills.draftGeneration')} hint={t('skills.draftBudgetHint')} section="draft" activeSection={page.section}>
        <div className={css.rows}>
          {DRAFT_PARAMETERS.map(field => <SettingRow key={field.key} htmlFor={`${baseId}-${field.key}`} title={t(`skills.${field.key}`)}>
            <input id={`${baseId}-${field.key}`} className={css.numberInput} type="number" step={1} min={field.min} max={field.max} inputMode="numeric"
              value={draftBudgets.draft[field.key]} disabled={disabled || draftBudgets.saving}
              aria-invalid={parameterValue(field, draftBudgets.draft[field.key]) === undefined}
              onChange={event => draftBudgets.edit({ [field.key]: event.target.value })} />
          </SettingRow>)}
        </div>
        <PanelActions dirty={draftBudgets.dirty} saving={draftBudgets.saving} applied={draftBudgets.applied} failed={draftBudgets.failed} disabled={disabled} t={t}
          invalid={invalidDraft === undefined ? null : t('skills.invalid', { field: t(`skills.${invalidDraft.key}`), min: invalidDraft.min, max: invalidDraft.max })}
          onDiscard={draftBudgets.discard} onApply={() => { void draftBudgets.apply() }} />
      </AdvancedSection>

      {marketState.ready && <AdvancedSection title={t('skills.market')}
        badge={`${marketState.registries.filter(registry => registry.enabled).length}/${marketState.registries.length}`}
        section="market" activeSection={page.section}>
        <div className={css.marketHeader}>
          <p className={css.panelNote}>{t('skills.marketHint')}</p>
          <ActionButton label={t('skills.marketRefresh')} pendingLabel={t('skills.marketRefreshing')}
            pending={marketState.busyAction === 'refresh'} disabled={disabled || marketState.busyAction !== null}
            onClick={() => runMarketMutation('refresh', 'market-refresh', {})} />
        </div>
        {marketState.registries.length === 0
          ? <p className={css.panelNote}>{t('skills.marketEmpty')}</p>
          : <div className={css.marketList}>
            {marketState.registries.map(registry => <div key={registry.id} className={css.marketRow}>
              <div className={css.marketCopy}>
                <span className={css.marketTitle}>
                  <strong>{registry.label}</strong>
                  {registry.builtin && <Tag tone="neutral">{t('skills.marketBuiltin')}</Tag>}
                  <span className={css.marketCount}>{t('skills.marketSkillCount', { count: registry.skillCount })}</span>
                </span>
                {registry.url !== '' && <code>{registry.url}</code>}
                {registry.error !== undefined && <span className={css.panelError}>{registry.error}</span>}
              </div>
              <div className={css.marketControls}>
                {!registry.builtin && <Button variant="ghost" size="sm" disabled={disabled || marketState.busyAction !== null}
                  aria-label={`${t('skills.marketRemove')} · ${registry.label}`}
                  onClick={() => runMarketMutation(`remove:${registry.id}`, 'registry-remove', { id: registry.id })}>{t('skills.marketRemove')}</Button>}
                <Switch className={css.switch} checked={registry.enabled} label={registry.label}
                  disabled={disabled || marketState.busyAction !== null}
                  onChange={enabled => runMarketMutation(`toggle:${registry.id}`, 'registry-toggle', { id: registry.id, enabled })} />
              </div>
            </div>)}
          </div>}
        <div className={css.marketAddRow}>
          <input className={css.directoryInput} type="text" value={marketState.addInput}
            placeholder={t('skills.marketAddPlaceholder')} aria-label={t('skills.marketAddPlaceholder')}
            disabled={disabled || marketState.busyAction !== null} autoComplete="off" spellCheck={false}
            onChange={event => setMarketState(current => ({ ...current, addInput: event.target.value, error: null }))}
            onKeyDown={event => {
              const trimmed = marketState.addInput.trim()
              if (event.key === 'Enter' && trimmed !== '' && !disabled && marketState.busyAction === null) {
                event.preventDefault()
                runMarketMutation('add', 'registry-add', { location: trimmed }, true)
              }
            }} />
          <ActionButton primary label={t('skills.marketAdd')} pendingLabel={t('skills.marketAdding')}
            pending={marketState.busyAction === 'add'}
            disabled={disabled || marketState.busyAction !== null || marketState.addInput.trim() === ''}
            onClick={() => runMarketMutation('add', 'registry-add', { location: marketState.addInput.trim() }, true)} />
        </div>
        <WriteFailure error={marketState.error} t={t} />
      </AdvancedSection>}

      <div className={css.skillsSubgroup} data-settings-section="directories">
        <div className={css.panelHeading}>
          <h3>{t('skills.directories')}</h3>
          <p>{t('skills.directoriesHint')}</p>
        </div>
        <div className={`${css.fieldGrid} ${css.directoryFields}`}>
          {DIRECTORY_FIELDS.map(({ key, placeholder }) => <label key={key}>{t(`skills.${key}`)}
            {canPickDirectory ? <span className={css.directoryPickerRow}>
              <input className={css.directoryInput} type="text" value={directories.draft[key]} placeholder={placeholder}
                disabled={disabled || directories.saving} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
                onChange={event => directories.edit({ [key]: event.target.value })} />
              <Button variant="outline" size="sm" disabled={disabled || directories.saving || pickingKey !== null}
                aria-busy={pickingKey === key || undefined} aria-label={`${t('storage.chooseDirectory')} · ${t(`skills.${key}`)}`}
                onClick={() => { void pickDirectory(key) }}>{t('storage.chooseDirectory')}</Button>
            </span> : <input className={css.directoryInput} type="text" value={directories.draft[key]} placeholder={placeholder}
              disabled={disabled || directories.saving} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off"
              onChange={event => directories.edit({ [key]: event.target.value })} />}
          </label>)}
        </div>
        {pickerFailed && <p className={css.panelError} role="alert">{t('storage.pickFailed')}</p>}
        <PanelActions dirty={directories.dirty} saving={directories.saving} applied={directories.applied} failed={directories.failed}
          disabled={disabled} invalid={null} t={t} onDiscard={directories.discard} onApply={() => { void directories.apply() }} />
      </div>
    </div>
    <WriteFailure error={evolution.failed ?? allowCreate.failed ?? allowUpdate.failed ?? linkedUpdates.failed ?? autoBacktest.failed ?? autoAdopt.failed ?? hints.failed ?? sidebar.failed} t={t} />
  </section>
}
