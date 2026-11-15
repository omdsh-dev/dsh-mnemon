import { css, sidebarCss, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useState } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Insight, MemorySpaceProvider, MemorySpaceView, MemoryProviderConfigField, MemoryProviderConnection, MemoryProviderDescriptor, MemoryProviderId, MemoryReadSource } from '../contracts.ts'
import { ProviderIcon } from './ProviderIcon.tsx'
import { providerSummary } from './provider-presentation.ts'
import { ProviderField } from './provider-field.tsx'
import { type MnemonKey, type MnemonTranslate, appearanceClass, SidebarModal } from 'dsh-mnemon/client'

export type ProviderDrafts = Partial<Record<MemoryProviderId, MemoryProviderConnection>>

function memoryProviderFields(provider: MemoryProviderDescriptor): MemoryProviderConfigField[] {
  return provider.fields.filter(field => field.scope !== 'service')
}

function providerDefaults(provider: MemoryProviderDescriptor): MemoryProviderConnection {
  return Object.fromEntries(memoryProviderFields(provider).flatMap(field => field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]]))
}

export function mergeProviderDefaults(providers: readonly MemoryProviderDescriptor[], current: ProviderDrafts): ProviderDrafts {
  return Object.fromEntries(providers.map(provider => [provider.id, { ...providerDefaults(provider), ...(current[provider.id] ?? {}) }]))
}

export function providerDraftComplete(provider: MemoryProviderDescriptor | undefined, connection: MemoryProviderConnection | undefined): boolean {
  if (provider === undefined || provider.serviceConfigured === false) return false
  return provider.origin === 'native' || memoryProviderFields(provider).every(field => !field.required || String(connection?.[field.key] ?? '').trim() !== '')
}

/** Keep a ready provider; otherwise Mnemon Native while its CLI is available, then the first other ready one. */
export function readyProviderId(providers: readonly MemoryProviderDescriptor[], current?: MemoryProviderId): MemoryProviderId | undefined {
  const ready = providers.filter(provider => provider.serviceConfigured !== false)
  return ready.find(provider => provider.id === current)?.id ?? (ready.find(provider => provider.origin === 'native') ?? ready[0])?.id
}

/** Ready Providers first, in catalog order, so the choices that work lead the list. */
export function readyFirst(providers: readonly MemoryProviderDescriptor[]): MemoryProviderDescriptor[] {
  return [...providers].sort((left, right) => Number(left.serviceConfigured === false) - Number(right.serviceConfigured === false))
}

/** Why a provider cannot be chosen: Mnemon Native needs its CLI, the others a service configured on the dsh-mnemon page under Plugins. */
export function providerUnavailableKey(provider: MemoryProviderDescriptor): 'overview.nativeCliRequired' | 'overview.providerServiceRequired' {
  return provider.origin === 'native' ? 'overview.nativeCliRequired' : 'overview.providerServiceRequired'
}

export function nativeSpaceProvider(provider: MemorySpaceProvider): boolean {
  return provider.origin === 'native'
}

/** Shared memory-level Provider form used by manual creation, editing, and distillation policy. */
export function ProviderMemoryFields(props: {
  provider: MemoryProviderDescriptor
  connection: MemoryProviderConnection
  onChange: (key: string, value: string | number | boolean) => void
  body?: MemorySpaceView
  clearSecrets?: string[]
  onClearSecretsChange?: (keys: string[]) => void
  layout?: 'settings' | 'dialog'
  disabled?: boolean
}): JSX.Element {
  const t = useT()
  const layout = props.layout ?? 'dialog'
  return <div className={css.providerFields} data-provider={props.provider.id}>
    <div className={css.providerFieldHeading}><div className={css.providerFieldIdentity}><ProviderIcon providerId={props.provider.id} icon={props.provider.icon} className={css.providerFieldIcon} /><div><strong>{props.provider.label}</strong><small>{providerSummary(t, props.provider)}</small></div></div><span>{props.provider.kind === 'local' ? t('overview.providerKindLocal') : t('overview.providerKindRemote')} · {t(`overview.workspaceBinding.${props.provider.workspaceBinding}`)}</span></div>
    <div className={css.providerAdvancedGrid}>{memoryProviderFields(props.provider).map(field => {
      const saved = props.body?.provider.configuredSecrets.includes(field.key) === true
      const clearSecrets = props.clearSecrets ?? []
      return <ProviderField key={field.key} field={field} value={props.connection[field.key]} layout={layout} saved={saved} clearing={clearSecrets.includes(field.key)}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        onChange={value => props.onChange(field.key, value)}
        {...(props.body === undefined || props.onClearSecretsChange === undefined ? {} : {
          onClearChange: (clearing: boolean) => props.onClearSecretsChange!(clearing ? [...new Set([...clearSecrets, field.key])] : clearSecrets.filter(key => key !== field.key)),
        })} />
    })}</div>
    <small className={css.providerWriteHint}>{props.provider.capabilities.writeMode === 'exact' ? t('overview.providerWriteExact') : t('overview.providerWriteAsync')} · {props.provider.capabilities.graph ? t('overview.providerGraphReady') : t('overview.providerSearchReady')}</small>
  </div>
}

const CATEGORY_KEYS: Record<string, MnemonKey> = {
  decision: 'category.decision',
  preference: 'category.preference',
  fact: 'category.fact',
  insight: 'category.insight',
  context: 'category.context',
  general: 'category.general',
}

export function categoryLabel(t: MnemonTranslate, category: string): string { return CATEGORY_KEYS[category] === undefined ? category : t(CATEGORY_KEYS[category]!) }

export function insightKey(insight: Insight): string {
  return `${insight.memoryBodyId ?? 'memory'}:${insight.id}`
}

export function MemoryProviderBadge(props: { providerId: MemoryProviderId; label: string }): JSX.Element {
  return <span className={css.providerBadge} data-provider={props.providerId} title={props.label}>{props.label}</span>
}

export function ReadSourcePanel(props: {
  title: string
  hint?: string
  sources: readonly MemoryReadSource[]
  selectedBodyId?: string | undefined
  onSelect?: (memoryBodyId: string | undefined) => void
}): JSX.Element | null {
  const t = useT()
  if (props.sources.length === 0) return null
  const content = (source: MemoryReadSource) => <>
    <span className={css.readSourceSignal} aria-hidden="true" />
    <span className={css.readSourceIdentity}><strong>{source.memoryBodyName}</strong><span className={css.readSourceMeta}><MemoryProviderBadge providerId={source.providerId} label={source.providerLabel} /><small>{t(`readSources.model.${source.providerId}` as MnemonKey)}</small></span></span>
    <span className={css.readSourceState}><em>{t(`readSources.mode.${source.mode}` as MnemonKey)}</em><small>{source.mode === 'entities' && source.status === 'ready'
      ? t(source.complete === false ? 'entities.sourcePartial' : 'entities.sourceReady', { count: source.itemCount })
      : t(`readSources.status.${source.status}` as MnemonKey, { count: source.itemCount })}{source.edgeCount === undefined || source.edgeCount === 0 ? '' : ` · ${t('readSources.edges', { count: source.edgeCount })}`}</small></span>
  </>
  return <section className={css.readSources} aria-label={props.title}>
    <header><div><strong>{props.title}</strong>{props.hint !== undefined && <p>{props.hint}</p>}</div>{props.onSelect !== undefined && <button type="button" aria-pressed={props.selectedBodyId === undefined} data-selected={props.selectedBodyId === undefined ? '' : undefined} onClick={() => props.onSelect?.(undefined)}>{t('readSources.all')}</button>}</header>
    <div>{props.sources.map(source => props.onSelect === undefined
      ? <article key={source.memoryBodyId} className={css.readSourceCard} data-provider={source.providerId} data-mode={source.mode} data-status={source.status} title={source.hint}>{content(source)}</article>
      : <button key={source.memoryBodyId} type="button" className={css.readSourceCard} data-provider={source.providerId} data-mode={source.mode} data-status={source.status} aria-pressed={props.selectedBodyId === source.memoryBodyId} data-selected={props.selectedBodyId === source.memoryBodyId || undefined} title={source.hint} onClick={() => props.onSelect?.(props.selectedBodyId === source.memoryBodyId ? undefined : source.memoryBodyId)}>{content(source)}</button>,
    )}</div>
  </section>
}

export function InsightCard(props: {
  insight: Insight
  writeEnabled: boolean
  onForget: (insight: Insight) => Promise<void>
  onRelated?: (insight: Insight) => void
  onClone?: (insight: Insight) => void
}): JSX.Element {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const { insight } = props
  const neutralActionClass = appearanceClass(css.ghostButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemEditAction))
  const forgetActionClass = appearanceClass(css.dangerButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemDangerAction))
  const providerLabel = insight.memoryProviderLabel ?? insight.memoryProviderId
  const supportsRelated = insight.memoryCapabilities?.related === true
  const supportsForget = insight.memoryCapabilities?.forget === true
  const meta = [
    insight.memoryBodyName,
    providerLabel,
    insight.category !== undefined ? categoryLabel(t, insight.category) : undefined,
    insight.importance !== undefined ? t('common.importance', { value: insight.importance }) : undefined,
    insight.score !== undefined ? t('common.score', { value: insight.score.toFixed(2) }) : undefined,
    insight.depth !== undefined ? t('common.hops', { count: insight.depth }) : undefined,
  ].filter((entry): entry is string => entry !== undefined)

  const forget = async () => {
    setForgetting(true)
    try {
      await props.onForget(insight)
    } finally {
      setForgetting(false)
      setConfirming(false)
    }
  }

  return (
    <>
    <article className={css.insightCard}>
      <div className={css.cardTop}>
        <div className={css.badges}>{meta.map(entry => <span key={entry} className={css.badge}>{entry}</span>)}</div>
      </div>
      <p className={css.content}>{insight.content}</p>
      {(insight.tags?.length ?? 0) > 0 && <div className={css.tags}>{insight.tags!.map(tag => <span key={tag}>#{tag}</span>)}</div>}
      {(insight.entities?.length ?? 0) > 0 && <div className={css.entities}>{insight.entities!.map(entity => <span key={entity}>{entity}</span>)}</div>}
      <div className={css.cardActions}>
        {(
          <>
            {props.onRelated !== undefined && supportsRelated && <button type="button" className={neutralActionClass} onClick={() => props.onRelated?.(insight)}>{t('card.related')}</button>}
            {props.onClone !== undefined && <button type="button" className={neutralActionClass} onClick={() => props.onClone?.(insight)}>{t('card.clone')}</button>}
            <button type="button" className={neutralActionClass} onClick={() => void writeClipboard(insight.id)}>{t('common.copyId')}</button>
            {props.writeEnabled && supportsForget && <button type="button" className={forgetActionClass} onClick={() => setConfirming(true)}>{t('card.forget')}</button>}
          </>
        )}
      </div>
    </article>
    {confirming && <SidebarModal title={t('card.confirmText')} description={`${insight.memoryBodyName ?? insight.memoryBodyId ?? ''}${insight.memoryBodyName === undefined && insight.memoryBodyId === undefined ? '' : ' · '}${insight.id}`} busy={forgetting} onClose={() => setConfirming(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.secondaryButton} disabled={forgetting} onClick={() => setConfirming(false)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} disabled={forgetting} onClick={() => void forget()}>{forgetting ? t('card.processing') : t('card.confirmForget')}</button></div>}><div className={css.bodyDeleteConfirm}><div className={css.bodyDeleteSummary}><p className={css.bodyDeleteContent}>{insight.content}</p><span>{meta.join(' · ')}</span></div></div></SidebarModal>}
    </>
  )
}

/** @deprecated Use nativeSpaceProvider. */
export const nativeBodyProvider = nativeSpaceProvider
