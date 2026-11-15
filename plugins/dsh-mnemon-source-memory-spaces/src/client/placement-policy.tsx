import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import { SelectField, TaskAgentTag } from 'dsh-mnemon/client'
import {
  NATIVE_PROVIDER_ID,
  type MemoryPersistenceStrategy,
  type MemoryPlacementCapability,
  type MemoryPlacementPreference,
  type MemoryProviderDescriptor,
  type MemoryProviderId,
} from '../contracts.ts'
import { ProviderIcon } from './ProviderIcon.tsx'
import { providerSummary } from './provider-presentation.ts'
import {
  ProviderMemoryFields,
  mergeProviderDefaults,
  providerDraftComplete,
  providerUnavailableKey,
  readyFirst,
  readyProviderId,
  type ProviderDrafts,
} from './widgets.tsx'

export type MemoryPlacementMode = 'manual' | 'automatic'

export interface PlacementPolicyDraft {
  mode: MemoryPlacementMode
  providerId: MemoryProviderId
  prompt: string
  dataBoundary: 'allow-remote' | 'local-only'
  preference: MemoryPlacementPreference
  requiredCapabilities: MemoryPlacementCapability[]
  allowedProviderIds: MemoryProviderId[]
  providerConnections: ProviderDrafts
}

type Translate = ReturnType<typeof useT>

export function cleanJson(value: unknown): MemoryJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : cleanJson(item))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, MemoryJsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = cleanJson(entry)
    }
    return out
  }
  return null
}

/** Graceful Mnemon Native descriptor used while the Host directory loads or when operations are absent. */
export function nativeFallbackProvider(t: Translate, serviceConfigured = true): MemoryProviderDescriptor {
  return {
    id: NATIVE_PROVIDER_ID,
    label: t('config.nativeName'),
    icon: { kind: 'brand', value: 'mnemon' },
    kind: 'local',
    workspaceBinding: 'automatic',
    summary: t('config.nativeSummary'),
    summaryI18nKey: 'overview.providerSummary.mnemon-native',
    origin: 'native',
    capabilities: {
      search: true,
      browse: true,
      graph: true,
      entities: true,
      related: true,
      remember: true,
      link: true,
      forget: true,
      writeMode: 'exact',
      deletionMode: 'soft',
    },
    fields: [],
    serviceConfigured,
  }
}

export function createPlacementPolicyDraft(
  configured: MemoryPersistenceStrategy | undefined,
  providers: readonly MemoryProviderDescriptor[],
): PlacementPolicyDraft {
  const mode: MemoryPlacementMode = configured?.mode === 'automatic' ? 'automatic' : 'manual'
  const configuredProviderId = configured?.providerId ?? NATIVE_PROVIDER_ID
  const providerId = providers.length > 0
    ? (readyProviderId(providers, configuredProviderId) ?? configuredProviderId)
    : configuredProviderId
  let allowedProviderIds: MemoryProviderId[]
  if (configured?.rules?.allowedProviderIds !== undefined) {
    allowedProviderIds = [...configured.rules.allowedProviderIds]
  } else if (providers.length > 0) {
    const ready = [NATIVE_PROVIDER_ID].filter(id => providers.some(provider => provider.id === id && provider.serviceConfigured !== false))
    const first = readyProviderId(providers)
    allowedProviderIds = ready.length > 0 || first === undefined ? ready : [first]
  } else {
    allowedProviderIds = [NATIVE_PROVIDER_ID]
  }
  return {
    mode,
    providerId,
    prompt: configured?.prompt ?? '',
    dataBoundary: configured?.rules?.dataBoundary === 'local-only' ? 'local-only' : 'allow-remote',
    preference: configured?.rules?.preference === 'local-first' || configured?.rules?.preference === 'shared-first'
      ? configured.rules.preference
      : 'balanced',
    requiredCapabilities: [...(configured?.rules?.requiredCapabilities ?? [])],
    allowedProviderIds,
    providerConnections: mergeProviderDefaults(providers, configured?.providerConnections ?? {}),
  }
}

export function placementPolicyProblem(
  draft: PlacementPolicyDraft,
  providers: readonly MemoryProviderDescriptor[],
  t: Translate,
): string | null {
  if (draft.mode === 'manual') {
    const selected = providers.find(provider => provider.id === draft.providerId)
    if (selected === undefined) return t('config.policyConnectionIncomplete')
    if (selected.serviceConfigured === false) return t(providerUnavailableKey(selected))
    if (!providerDraftComplete(selected, draft.providerConnections[draft.providerId])) return t('config.policyConnectionIncomplete')
    return null
  }
  if (draft.prompt.length > 4000) return t('config.policyPromptInvalid')
  if (draft.allowedProviderIds.length === 0) return t('config.policyCandidatesEmpty')
  const selected = draft.allowedProviderIds
    .map(id => providers.find(provider => provider.id === id))
    .filter((provider): provider is MemoryProviderDescriptor => provider !== undefined)
  if (selected.length !== draft.allowedProviderIds.length) return t('config.policyConnectionIncomplete')
  for (const provider of selected) {
    if (provider.serviceConfigured === false) return t(providerUnavailableKey(provider))
    if (draft.dataBoundary === 'local-only' && provider.kind === 'remote') return t('config.policyBoundaryMismatch')
    if (!providerDraftComplete(provider, draft.providerConnections[provider.id])) return t('config.policyConnectionIncomplete')
  }
  return null
}

export function serializePlacementPolicy(
  draft: PlacementPolicyDraft,
  providers: readonly MemoryProviderDescriptor[],
): MemoryPersistenceStrategy {
  const selectedIds = draft.mode === 'manual' ? [draft.providerId] : draft.allowedProviderIds
  const connections = Object.fromEntries(
    selectedIds
      .filter(id => {
        const provider = providers.find(candidate => candidate.id === id)
        return provider !== undefined ? provider.origin !== 'native' : id !== NATIVE_PROVIDER_ID
      })
      .map(id => [id, draft.providerConnections[id] ?? {}]),
  ) as ProviderDrafts
  return {
    mode: draft.mode,
    providerId: draft.providerId,
    prompt: draft.prompt,
    rules: {
      allowedProviderIds: draft.allowedProviderIds,
      dataBoundary: draft.dataBoundary,
      requiredCapabilities: draft.requiredCapabilities,
      preference: draft.preference,
    },
    providerConnections: connections,
  }
}

export function PlacementModeFieldset(props: {
  mode: MemoryPlacementMode
  radioGroupName: string
  autoFocusSelected?: boolean
  disabled?: boolean
  onChange: (mode: MemoryPlacementMode) => void
}): JSX.Element {
  const t = useT()
  return <fieldset className={css.placementMode} disabled={props.disabled}><legend>{t('overview.placementMode')}</legend>
    <label data-selected={props.mode === 'manual' || undefined} data-disabled={props.disabled || undefined}><input type="radio" name={props.radioGroupName} value="manual" checked={props.mode === 'manual'} disabled={props.disabled} data-autofocus={props.autoFocusSelected && props.mode === 'manual' ? true : undefined} onChange={() => props.onChange('manual')} /><i className={css.choiceControl} data-kind="radio" aria-hidden="true" /><span><strong>{t('overview.placementManual')}</strong><small>{t('strategy.manualHint')}</small></span></label>
    <label data-selected={props.mode === 'automatic' || undefined} data-disabled={props.disabled || undefined}><input type="radio" name={props.radioGroupName} value="automatic" checked={props.mode === 'automatic'} disabled={props.disabled} data-autofocus={props.autoFocusSelected && props.mode === 'automatic' ? true : undefined} onChange={() => props.onChange('automatic')} /><i className={css.choiceControl} data-kind="radio" aria-hidden="true" /><span><strong>{t('overview.placementAutomatic')} <em>{t('overview.recommended')}</em></strong><small>{t('strategy.automaticHint')}</small></span></label>
  </fieldset>
}

export function PlacementTargetControls(props: {
  draft: PlacementPolicyDraft
  providers: readonly MemoryProviderDescriptor[]
  providerRadioGroupName: string
  fieldLayout?: 'settings' | 'dialog'
  disabled?: boolean
  agentAvailable?: boolean
  onChange: (patch: Partial<PlacementPolicyDraft>) => void
}): JSX.Element {
  const t = useT()
  const { draft, providers } = props
  const fieldLayout = props.fieldLayout ?? 'dialog'
  const selectedProvider = providers.find(provider => provider.id === draft.providerId)
  const updateConnection = (id: MemoryProviderId, key: string, value: string | number | boolean) => {
    props.onChange({
      providerConnections: {
        ...draft.providerConnections,
        [id]: { ...(draft.providerConnections[id] ?? {}), [key]: value },
      },
    })
  }
  const toggleCapability = (capability: MemoryPlacementCapability) => {
    props.onChange({
      requiredCapabilities: draft.requiredCapabilities.includes(capability)
        ? draft.requiredCapabilities.filter(value => value !== capability)
        : [...draft.requiredCapabilities, capability],
    })
  }
  const toggleProvider = (id: MemoryProviderId, selected: boolean) => {
    props.onChange({
      allowedProviderIds: selected
        ? [...new Set([...draft.allowedProviderIds, id])]
        : draft.allowedProviderIds.filter(value => value !== id),
    })
  }

  if (draft.mode === 'manual') {
    return <>
      <fieldset className={css.providerChoice} disabled={props.disabled}><legend>{t('overview.providerLabel')}</legend>{readyFirst(providers).map(provider => {
        const unavailable = provider.serviceConfigured === false
        const itemDisabled = props.disabled === true || unavailable
        return <label key={provider.id} data-selected={draft.providerId === provider.id || undefined} data-native={provider.origin === 'native' || undefined} data-disabled={itemDisabled || undefined}>
          <input type="radio" name={props.providerRadioGroupName} value={provider.id} checked={draft.providerId === provider.id} disabled={itemDisabled} onChange={() => props.onChange({ providerId: provider.id })} />
          <ProviderIcon providerId={provider.id} icon={provider.icon} className={css.providerChoiceIcon} />
          <span><strong>{provider.label}{provider.origin === 'native' && <em>{t('overview.nativeOfficial')}</em>}</strong><small>{unavailable ? t(providerUnavailableKey(provider)) : `${t(`overview.workspaceBinding.${provider.workspaceBinding}`)} · ${providerSummary(t, provider)}`}</small></span>
          <i className={css.choiceControl} data-kind="radio" aria-hidden="true" />
        </label>
      })}</fieldset>
      {selectedProvider !== undefined && selectedProvider.origin !== 'native' && <ProviderMemoryFields provider={selectedProvider} connection={draft.providerConnections[selectedProvider.id] ?? {}} layout={fieldLayout} {...(props.disabled === undefined ? {} : { disabled: props.disabled })} onChange={(key, value) => updateConnection(selectedProvider.id, key, value)} />}
    </>
  }

  return <section className={css.placementPolicy} aria-label={t('overview.placementPolicy')}>
    <div className={css.placementPolicyHeading}><div><strong>{t('overview.placementPolicy')}</strong><small>{t('overview.placementPolicyHint')}</small></div>{props.agentAvailable !== undefined && <TaskAgentTag available={props.agentAvailable} />}</div>
    <label className={css.placementPromptField}>{t('overview.placementPrompt')}<textarea aria-label={t('overview.placementPrompt')} value={draft.prompt} disabled={props.disabled} onChange={event => props.onChange({ prompt: event.target.value })} placeholder={t('overview.placementPromptPlaceholder')} rows={3} maxLength={4000} /></label>
    <div className={css.placementRuleGrid}>
      <SelectField label={t('overview.dataBoundary')} value={draft.dataBoundary} disabled={props.disabled} options={[{ value: 'allow-remote', label: t('overview.dataBoundaryRemote') }, { value: 'local-only', label: t('overview.dataBoundaryLocal') }]} onChange={value => {
        props.onChange({
          dataBoundary: value,
          ...(value === 'local-only' ? { allowedProviderIds: draft.allowedProviderIds.filter(id => providers.find(provider => provider.id === id)?.kind === 'local') } : {}),
        })
      }} />
      <SelectField label={t('overview.preference')} value={draft.preference} disabled={props.disabled} options={[{ value: 'balanced', label: t('overview.preferenceBalanced') }, { value: 'local-first', label: t('overview.preferenceLocal') }, { value: 'shared-first', label: t('overview.preferenceShared') }]} onChange={preference => props.onChange({ preference })} />
    </div>
    <fieldset className={css.capabilityRules} disabled={props.disabled}><legend>{t('overview.requiredCapabilities')}</legend>{(['graph', 'exact-write', 'forget'] as const).map(capability => {
      const selected = draft.requiredCapabilities.includes(capability)
      return <label key={capability} data-selected={selected || undefined} data-disabled={props.disabled || undefined}><input type="checkbox" checked={selected} disabled={props.disabled} onChange={() => toggleCapability(capability)} /><i className={css.choiceControl} data-kind="check" aria-hidden="true" /><span>{t(`overview.capability.${capability}`)}</span></label>
    })}</fieldset>
    <div className={css.placementCandidates}>{readyFirst(providers).map(provider => {
      const selected = draft.allowedProviderIds.includes(provider.id)
      // A saved candidate that is no longer ready can still be cleared.
      const itemDisabled = props.disabled === true || (provider.serviceConfigured === false && !selected) || (draft.dataBoundary === 'local-only' && provider.kind === 'remote')
      return <label key={provider.id} data-selected={selected || undefined} data-disabled={itemDisabled || undefined}><input type="checkbox" checked={selected} disabled={itemDisabled} onChange={event => toggleProvider(provider.id, event.target.checked)} /><ProviderIcon providerId={provider.id} icon={provider.icon} className={css.candidateIcon} /><span><strong>{provider.label}</strong><small>{provider.serviceConfigured === false ? t(providerUnavailableKey(provider)) : provider.origin === 'native' ? t('overview.candidateNativeReady') : provider.kind === 'local' ? t('overview.candidateLocal') : t('overview.candidateRemote')}</small></span><i className={css.choiceControl} data-kind="check" aria-hidden="true" /></label>
    })}</div>
    {draft.allowedProviderIds.map(id => {
      const provider = providers.find(candidate => candidate.id === id)
      return provider === undefined || provider.origin === 'native'
        ? null
        : <ProviderMemoryFields key={id} provider={provider} connection={draft.providerConnections[id] ?? {}} layout={fieldLayout} {...(props.disabled === undefined ? {} : { disabled: props.disabled })} onChange={(key, value) => updateConnection(id, key, value)} />
    })}
  </section>
}
