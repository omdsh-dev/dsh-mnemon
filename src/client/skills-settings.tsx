import type { JSX } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_SKILLS_CONFIG, type ClientSettingsScope, type ResolvedSkillsConfig, type SkillsConfig, type SettingsOperation } from '../host/protocol.ts'
import type { MemoryComponentSettingsProps } from './component-ui.tsx'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'
import { SelectRow, ToggleRow } from './settings-controls.tsx'
import { PanelActions, useLive, useScope, useStaged, WriteFailure } from './settings-panel.tsx'

/** The package 技能管理 ships as; its page under Plugins carries these settings. */
export const SKILLS_PACKAGE = 'dsh-mnemon-source-skills'

/** 技能管理's settings as stored, every missing key at its default. */
export function resolvedSkills(value: SkillsConfig | undefined): ResolvedSkillsConfig {
  return { ...DEFAULT_SKILLS_CONFIG, ...value }
}

type Parameter = 'reviewThreshold' | 'idleSeconds' | 'cooldownSeconds' | 'minConfidence' | 'expiryDays' | 'maxPendingPerSession' | 'casesPerRun'

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

/**
 * 技能管理's settings on its page under Plugins. Switches apply at once; the
 * destination and folded review parameters wait for their own Apply. The
 * destination also applies to manual drafts while evolution is off.
 */
export function SkillsSettings(props: { scope: ClientSettingsScope<SkillsConfig>; page: MemoryComponentSettingsProps; t: MnemonTranslate }): JSX.Element {
  const { scope, page, t } = props
  const snapshot = useScope(scope)
  const saved = resolvedSkills(snapshot.value)
  const write = (key: keyof ResolvedSkillsConfig) => async (value: boolean): Promise<void> => { await scope.mutate([set(key, value)]) }
  const evolution = useLive(saved.evolution, write('evolution'))
  const allowCreate = useLive(saved.allowCreate, write('allowCreate'))
  const allowUpdate = useLive(saved.allowUpdate, write('allowUpdate'))
  const autoBacktest = useLive(saved.autoBacktest, write('autoBacktest'))
  const autoAdopt = useLive(saved.autoAdopt, write('autoAdopt'))
  const hints = useLive(saved.hints, write('hints'))
  const sidebar = useLive(saved.sidebar, write('sidebar'))
  const destination = useStaged({ targetScope: saved.targetScope }, async draft => {
    await scope.mutate([set('targetScope', draft.targetScope)])
  })
  const parameters = useStaged(parametersOf(saved), async draft => {
    const changed = PARAMETERS.filter(field => parameterValue(field, draft[field.key]) !== saved[field.key])
    if (changed.length > 0) await scope.mutate(changed.map(field => set(field.key, parameterValue(field, draft[field.key])!)))
  })
  const draftBudgets = useStaged({ draftMaxTokens: String(saved.draftMaxTokens), draftRetryMaxTokens: String(saved.draftRetryMaxTokens) }, async draft => {
    const changed = DRAFT_PARAMETERS.filter(field => parameterValue(field, draft[field.key]) !== saved[field.key])
    if (changed.length > 0) await scope.mutate(changed.map(field => set(field.key, parameterValue(field, draft[field.key])!)))
  })
  const disabled = !page.writable || snapshot.status === 'loading' || !snapshot.writable
  const invalid = PARAMETERS.find(field => parameterValue(field, parameters.draft[field.key]) === undefined)
  const invalidDraft = DRAFT_PARAMETERS.find(field => parameterValue(field, draftBudgets.draft[field.key]) === undefined)
  return <section className={css.panelSection} aria-label={t('skills.label')}>
    <div className={css.rows}>
      <ToggleRow id="mnemon-skills-evolution" label={t('skills.evolution')} hint={t('skills.evolutionHint')} checked={evolution.value} disabled={disabled} onChange={evolution.set} />
      {evolution.value && <ToggleRow id="mnemon-skills-create" label={t('skills.allowCreate')} hint={t('skills.allowCreateHint')} checked={allowCreate.value} disabled={disabled} onChange={allowCreate.set} />}
      {evolution.value && <ToggleRow id="mnemon-skills-update" label={t('skills.allowUpdate')} hint={t('skills.allowUpdateHint')} checked={allowUpdate.value} disabled={disabled} onChange={allowUpdate.set} />}
      <SelectRow id="mnemon-skills-target" label={t('skills.targetScope')} hint={t('skills.targetScopeHint')} value={destination.draft.targetScope}
        options={(['user', 'project', 'storage'] as const).map(value => ({ value, label: t(`skills.targetScope.${value}`) }))}
        disabled={disabled || destination.saving} onChange={targetScope => destination.edit({ targetScope })} />
      <PanelActions dirty={destination.dirty} saving={destination.saving} applied={destination.applied} failed={destination.failed} disabled={disabled} invalid={null} t={t}
        onDiscard={destination.discard} onApply={() => { void destination.apply() }} />
      <details className={css.advanced}>
        <summary>{t('skills.draftGeneration')}<IconChevronDownOutlineRegular size={12} /></summary>
        <p className={css.panelNote}>{t('skills.draftBudgetHint')}</p>
        <div className={css.fieldGrid}>
          {DRAFT_PARAMETERS.map(field => <label key={field.key}>{t(`skills.${field.key}`)}
            <input type="number" step={1} min={field.min} max={field.max} inputMode="numeric" value={draftBudgets.draft[field.key]} disabled={disabled || draftBudgets.saving}
              aria-invalid={parameterValue(field, draftBudgets.draft[field.key]) === undefined}
              onChange={event => draftBudgets.edit({ [field.key]: event.target.value })} />
          </label>)}
        </div>
        <PanelActions dirty={draftBudgets.dirty} saving={draftBudgets.saving} applied={draftBudgets.applied} failed={draftBudgets.failed} disabled={disabled} t={t}
          invalid={invalidDraft === undefined ? null : t('skills.invalid', { field: t(`skills.${invalidDraft.key}`), min: invalidDraft.min, max: invalidDraft.max })}
          onDiscard={draftBudgets.discard} onApply={() => { void draftBudgets.apply() }} />
      </details>
      {evolution.value && <ToggleRow id="mnemon-skills-backtest" label={t('skills.autoBacktest')} hint={t('skills.autoBacktestHint')} checked={autoBacktest.value} disabled={disabled} onChange={autoBacktest.set} />}
      {evolution.value && <ToggleRow id="mnemon-skills-auto-adopt" label={t('skills.autoAdopt')} hint={t('skills.autoAdoptHint')} checked={autoAdopt.value} disabled={disabled || !autoBacktest.value} onChange={autoAdopt.set} />}
      {evolution.value && <details className={css.advanced}>
        <summary>{t('skills.parameters')}<IconChevronDownOutlineRegular size={12} /></summary>
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
      </details>}
      <ToggleRow id="mnemon-skills-hints" label={t('skills.hints')} hint={t('skills.hintsHint')} checked={hints.value} disabled={disabled} onChange={hints.set} />
      <ToggleRow id="mnemon-skills-sidebar" label={t('skills.sidebar')} hint={t('skills.sidebarHint')} checked={sidebar.value} disabled={disabled} onChange={sidebar.set} />
    </div>
    <WriteFailure error={evolution.failed ?? allowCreate.failed ?? allowUpdate.failed ?? autoBacktest.failed ?? autoAdopt.failed ?? hints.failed ?? sidebar.failed} t={t} />
  </section>
}
