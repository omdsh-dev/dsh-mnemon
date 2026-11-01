import { type ComponentProps, type JSX } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { RUNTIME_MEMORY_LIMIT_MAX_BYTES, RUNTIME_MEMORY_LIMITS } from 'dsh-mnemon-source-runtime/contracts'
import {
  DEFAULT_IDLE_REVIEW,
  type ClientConnectionHandle,
  type ClientSettingsScope,
  type Config,
  type ResolvedIdleReviewConfig,
  type SettingsOperation,
  type SkillsConfig,
} from '../host/protocol.ts'
import { installMemoryComponentFallbackUI, installMemoryComponentUI, type MemoryComponentSettingsProps, type MemoryComponentUIContext } from './component-ui.tsx'
import type { MnemonTranslate } from './locales.ts'
import { MemorySpacesSettings } from './memory-spaces-client.ts'
import css from './MnemonSettingsCard.module.css'
import { SelectRow, ToggleRow } from './settings-controls.tsx'
import { PanelActions, useLive, useScope, useStaged, WriteFailure } from './settings-panel.tsx'
import { SKILLS_PACKAGE, SkillsSettings } from './skills-settings.tsx'
import { TaskAgentModelRows, useTaskAgentModel } from './task-agent-model.tsx'

/** The packages whose own settings dsh-mnemon supplies, through the same region an installed component uses. */
export const RUNTIME_PACKAGE = 'dsh-mnemon-source-runtime'
export const MEMORY_SPACES_PACKAGE = 'dsh-mnemon-source-memory-spaces'
export const THREE_TIER_PACKAGE = 'dsh-mnemon-strategy-default-three-tier'

/** What a shipped component's settings read and write: dsh-mnemon's own settings and Host connection. */
export interface ShippedSettingsServices {
  scope: ClientSettingsScope<Config>
  /** 技能管理's own group of settings. */
  skillsScope?: ClientSettingsScope<SkillsConfig>
  connection?: ClientConnectionHandle
  t: MnemonTranslate
}

/**
 * Register the settings dsh-mnemon keeps for its shipped components, the way
 * an installed component registers its own: Runtime Memory carries where its
 * user profile lives and its capacities, the Layered strategy the background tasks it drives.
 * Memory Spaces brings its Providers and embedding itself. Its settings show
 * here, as a fallback, whenever its own client registers none: while it is
 * off, while its client loads, if that client fails, and beside a Memory
 * Spaces of 0.5.21 or earlier.
 */
export function installShippedComponentSettings(ctx: MemoryComponentUIContext & { locale?: ComponentProps<typeof MemorySpacesSettings>['locale'] }, services: ShippedSettingsServices): () => void {
  const { locale } = ctx
  const disposers = [
    installMemoryComponentUI(ctx, { packageName: RUNTIME_PACKAGE, settings: page => <RuntimeSettings {...services} page={page} /> }),
    installMemoryComponentFallbackUI(ctx, { packageName: MEMORY_SPACES_PACKAGE, settings: page => <MemorySpacesSettings {...page} {...(locale === undefined ? {} : { locale })} /> }),
    installMemoryComponentUI(ctx, { packageName: THREE_TIER_PACKAGE, settings: page => <ThreeTierSettings {...services} page={page} /> }),
    ...(services.skillsScope === undefined ? [] : [installMemoryComponentUI(ctx, { packageName: SKILLS_PACKAGE, settings: page => <SkillsSettings scope={services.skillsScope!} page={page} t={services.t} /> })]),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

// ---- Runtime Memory: user profile scope and file capacities ----

const RUNTIME_LIMITS = ['userLimitBytes', 'memoryLimitBytes'] as const
type RuntimeLimits = Record<typeof RUNTIME_LIMITS[number], string>

function runtimeLimitValue(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const value = Number(text)
  return Number.isInteger(value) && value >= 1 && value <= RUNTIME_MEMORY_LIMIT_MAX_BYTES ? value : undefined
}

/** Runtime Memory's scope applies immediately; its byte limits wait for Apply. */
export function RuntimeSettings(props: ShippedSettingsServices & { page: MemoryComponentSettingsProps }): JSX.Element {
  const { scope, page, t } = props
  const snapshot = useScope(scope)
  const saved: 'storage' | 'global' = snapshot.value?.runtimeUserScope === 'global' ? 'global' : 'storage'
  const profile = useLive(saved, async value => { await scope.mutate([{ op: 'set', path: ['runtimeUserScope'], value }]) })
  const disabled = !page.writable || snapshot.status === 'loading' || !snapshot.writable
  const configured = snapshot.value?.runtimeMemory
  const savedLimits: RuntimeLimits = {
    userLimitBytes: String(configured?.userLimitBytes ?? RUNTIME_MEMORY_LIMITS.user),
    memoryLimitBytes: String(configured?.memoryLimitBytes ?? RUNTIME_MEMORY_LIMITS.memory),
  }
  const limits = useStaged(savedLimits, async draft => {
    const changed = RUNTIME_LIMITS.filter(key => runtimeLimitValue(draft[key]) !== runtimeLimitValue(savedLimits[key]))
    if (changed.length > 0) await scope.mutate([{ op: 'set', path: ['runtimeMemory'], value: {
      ...configured, ...Object.fromEntries(changed.map(key => [key, runtimeLimitValue(draft[key])!])),
    } }])
  })
  const invalid = RUNTIME_LIMITS.find(key => runtimeLimitValue(limits.draft[key]) === undefined)
  return <><section className={css.panelSection} aria-label={t('config.runtimeUserScopeTitle')}>
    <div className={css.rows}>
      <SelectRow id="mnemon-runtime-user-scope" label={t('config.runtimeUserScopeTitle')} value={profile.value} disabled={disabled} onChange={profile.set} options={[
        { value: 'storage', label: t('config.runtimeUserScopeStorage'), detail: t('config.runtimeUserScopeStorageHint') },
        { value: 'global', label: t('config.runtimeUserScopeGlobal'), detail: t('config.runtimeUserScopeGlobalHint') },
      ]} />
    </div>
    <WriteFailure error={profile.failed} t={t} />
  </section>
  <section className={css.panelSection} aria-labelledby="mnemon-runtime-limits">
    <div className={css.panelHeading}>
      <h3 id="mnemon-runtime-limits">{t('config.runtimeLimitsTitle')}</h3>
      <p id="mnemon-runtime-limits-hint">{t('config.runtimeLimitsHint', { user: RUNTIME_MEMORY_LIMITS.user / 1024, memory: RUNTIME_MEMORY_LIMITS.memory / 1024 })}</p>
    </div>
    <div className={css.fieldGrid}>
      {RUNTIME_LIMITS.map(key => <label key={key}>{t(`config.runtime.${key}`)}
        <input type="number" min="1" max={RUNTIME_MEMORY_LIMIT_MAX_BYTES} step="1" inputMode="numeric"
          value={limits.draft[key]} disabled={disabled || limits.saving} aria-describedby="mnemon-runtime-limits-hint"
          aria-invalid={runtimeLimitValue(limits.draft[key]) === undefined}
          onChange={event => limits.edit({ [key]: event.target.value })} />
      </label>)}
    </div>
    <PanelActions dirty={limits.dirty} saving={limits.saving} applied={limits.applied} failed={limits.failed} disabled={disabled} t={t}
      note={t('config.runtimeLimitsApply')}
      invalid={invalid === undefined ? null : t('config.runtimeLimitInvalid', { field: t(`config.runtime.${invalid}`), max: RUNTIME_MEMORY_LIMIT_MAX_BYTES })}
      onDiscard={limits.discard} onApply={() => { void limits.apply() }} />
  </section></>
}

// ---- Layered strategy: the background tasks it drives ----

type ReviewChoice = Pick<ResolvedIdleReviewConfig, 'enabled' | 'runtimeMemory' | 'persistWatermark' | 'provider' | 'fallback' | 'agentTeams'>
type ReviewLimits = Pick<ResolvedIdleReviewConfig, 'minIntervalMs' | 'maxPerSession' | 'maxContextChars' | 'maxTokens'>

/** Each limit as the page shows it: the interval in seconds, the others as stored. */
const LIMITS: ReadonlyArray<{ key: keyof ReviewLimits; min: number; max: number; scale: number }> = [
  { key: 'minIntervalMs', min: 5_000, max: 86_400_000, scale: 1_000 },
  { key: 'maxPerSession', min: 0, max: 200, scale: 1 },
  { key: 'maxContextChars', min: 1_000, max: 1_000_000, scale: 1 },
  { key: 'maxTokens', min: 128, max: 131_072, scale: 1 },
]

function reviewOf(value: Config | undefined): ResolvedIdleReviewConfig {
  return { ...DEFAULT_IDLE_REVIEW, ...value?.idleReview }
}

const choiceOf = (review: ResolvedIdleReviewConfig): ReviewChoice => ({ enabled: review.enabled, runtimeMemory: review.runtimeMemory, persistWatermark: review.persistWatermark, provider: review.provider, fallback: review.fallback, agentTeams: review.agentTeams })
const limitsOf = (review: ResolvedIdleReviewConfig): Record<keyof ReviewLimits, string> =>
  Object.fromEntries(LIMITS.map(limit => [limit.key, String(review[limit.key] / limit.scale)])) as Record<keyof ReviewLimits, string>

/** The value a limit stores, or undefined when the Host would refuse it. */
function limitValue(limit: typeof LIMITS[number], text: string): number | undefined {
  if (text.trim() === '') return undefined
  const value = Math.round(Number(text) * limit.scale)
  return Number.isInteger(value) && value >= limit.min && value <= limit.max ? value : undefined
}

/**
 * The idle review is written whole, as the Host stores it: what is configured
 * now plus what changed, so a setting never set keeps inheriting its default.
 */
function reviewWrite<T extends Partial<ResolvedIdleReviewConfig>>(configured: Config['idleReview'], next: T, before: T): SettingsOperation[] {
  const changed = (Object.keys(next) as Array<keyof T & string>).filter(key => next[key] !== before[key])
  if (changed.length === 0) return []
  return [{ op: 'set', path: ['idleReview'], value: { ...configured, ...Object.fromEntries(changed.map(key => [key, next[key]])) } }]
}

/**
 * The Layered strategy's own settings: the model its background task Agents use,
 * and the idle review that keeps its layers in shape. Choices apply at once;
 * the review limits are typed and wait for their Apply.
 */
export function ThreeTierSettings(props: ShippedSettingsServices & { page: MemoryComponentSettingsProps }): JSX.Element {
  const { scope, connection, page, t } = props
  const snapshot = useScope(scope)
  const savedReview = reviewOf(snapshot.value)
  // The page belongs to one conversation, so the route it states is the one that conversation's tasks take.
  const taskAgent = useTaskAgentModel({ scope, connection, sessionId: page.sessionId, workspaceId: page.workspace?.id })
  const configured = snapshot.value?.idleReview
  const choice = useLive(choiceOf(savedReview), async next => {
    const operations = reviewWrite(configured, next, choiceOf(savedReview))
    if (operations.length > 0) await scope.mutate(operations)
  })
  const limits = useStaged(limitsOf(savedReview), async draft => {
    const next = Object.fromEntries(LIMITS.map(limit => [limit.key, limitValue(limit, draft[limit.key])!])) as ReviewLimits
    const before = Object.fromEntries(LIMITS.map(limit => [limit.key, savedReview[limit.key]])) as ReviewLimits
    const operations = reviewWrite(configured, next, before)
    if (operations.length > 0) await scope.mutate(operations)
  })
  const disabled = !page.writable || snapshot.status === 'loading' || !snapshot.writable
  return <section className={css.panelSection} aria-labelledby="mnemon-three-tier-background">
    <div className={css.panelHeading}>
      <h3 id="mnemon-three-tier-background">{t('config.backgroundTitle')}</h3>
      <p>{t('config.backgroundDescription')}</p>
      {taskAgent.catalog.state === 'loading' && <span className={css.miniSpinner} aria-hidden="true" />}
    </div>
    {!page.component.enabled && <p className={css.panelNote}>{t('threeTier.offNote')}</p>}
    <div className={css.rows}>
      <TaskAgentModelRows mode={taskAgent.choosing ? 'fixed' : taskAgent.route.mode} route={taskAgent.route} settled={taskAgent.settled} choosing={taskAgent.choosing}
        catalog={taskAgent.catalog.value} state={taskAgent.catalog.state} error={taskAgent.catalog.error} retry={taskAgent.retry}
        disabled={disabled} onMode={taskAgent.setMode} onRoute={taskAgent.setRoute} t={t} />
      <IdleReviewRows choice={choice.value} limits={limits} disabled={disabled} onChoice={next => choice.set({ ...choice.value, ...next })} t={t} />
    </div>
    <WriteFailure error={taskAgent.failed ?? choice.failed} t={t} />
  </section>
}

function IdleReviewRows(props: {
  choice: ReviewChoice
  limits: ReturnType<typeof useStaged<Record<keyof ReviewLimits, string>>>
  disabled: boolean
  onChoice: (next: Partial<ReviewChoice>) => void
  t: MnemonTranslate
}): JSX.Element {
  const { choice, limits, t } = props
  const invalid = LIMITS.find(limit => limitValue(limit, limits.draft[limit.key]) === undefined)
  return <>
    <ToggleRow id="mnemon-idle-review" label={t('config.reviewTitle')} ariaLabel={t('config.reviewEnabled')} hint={t('config.reviewDescription')} checked={choice.enabled} disabled={props.disabled} onChange={enabled => props.onChoice({ enabled })} />
    {choice.enabled && <>
      <ToggleRow id="mnemon-review-persist-watermark" label={t('config.reviewPersistWatermark')} hint={t('config.reviewPersistWatermarkHint')} checked={choice.persistWatermark} disabled={props.disabled} onChange={persistWatermark => props.onChoice({ persistWatermark })} />
      <ToggleRow id="mnemon-review-runtime-memory" label={t('config.reviewRuntimeMemory')} hint={t('config.reviewRuntimeMemoryHint')} checked={choice.runtimeMemory} disabled={props.disabled} onChange={runtimeMemory => props.onChoice({ runtimeMemory })} />
      <SelectRow id="mnemon-review-provider" label={t('config.reviewProvider')} value={choice.provider} disabled={props.disabled} onChange={provider => props.onChoice({ provider })} options={[
        { value: 'spawn', label: t('config.reviewSpawn'), detail: t('config.reviewSpawnHint') },
        { value: 'fork', label: t('config.reviewFork'), detail: t('config.reviewForkHint') },
      ]} />
      {/* Only a forked review can find its context unavailable and need another way to run. */}
      {choice.provider === 'fork' && <SelectRow id="mnemon-review-fallback" label={t('config.reviewFallback')} value={choice.fallback} disabled={props.disabled} onChange={fallback => props.onChoice({ fallback })} options={[
        { value: 'spawn', label: t('config.reviewSpawn') },
        { value: 'skip', label: t('config.reviewSkip') },
      ]} />}
      <SelectRow id="mnemon-review-teams" label={t('config.reviewAgentTeams')} value={choice.agentTeams} disabled={props.disabled} onChange={agentTeams => props.onChoice({ agentTeams })} options={[
        { value: 'pause', label: t('config.reviewTeamPause'), detail: t('config.reviewTeamPauseHint') },
        { value: 'scoped', label: t('config.reviewTeamScoped'), detail: t('config.reviewTeamScopedHint') },
      ]} />
      <details className={css.advanced}>
        <summary>{t('config.reviewLimits')}<IconChevronDownOutlineRegular size={12} /></summary>
        <div className={css.fieldGrid}>
          {LIMITS.map(limit => <label key={limit.key}>{t(`config.review.${limit.key}`)}
            <input type="number" step="1" inputMode="numeric" value={limits.draft[limit.key]} disabled={props.disabled}
              aria-invalid={limitValue(limit, limits.draft[limit.key]) === undefined}
              onChange={event => limits.edit({ [limit.key]: event.target.value })} />
          </label>)}
        </div>
        <PanelActions dirty={limits.dirty} saving={limits.saving} applied={limits.applied} failed={limits.failed} disabled={props.disabled} t={t}
          invalid={invalid === undefined ? null : t('config.reviewLimitInvalid', { field: t(`config.review.${invalid.key}`), min: invalid.min / invalid.scale, max: invalid.max / invalid.scale })}
          onDiscard={limits.discard} onApply={() => { void limits.apply() }} />
      </details>
    </>}
  </>
}
