import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import type { MemoryPersistenceStrategy, MemoryProviderDescriptor } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'
import { appearanceClass, message, SectionSpinner, SidebarModal } from 'dsh-mnemon/client'
import { mergeProviderDefaults, readyProviderId } from './widgets.tsx'
import {
  PlacementModeFieldset,
  PlacementTargetControls,
  createPlacementPolicyDraft,
  placementPolicyProblem,
  serializePlacementPolicy,
  type PlacementPolicyDraft,
} from './placement-policy.tsx'

export interface MemoryPlacementSettings { setPath(path: string[], value: unknown): Promise<void> }
export interface MemoryPlacementPageConfig { persistenceStrategy?: MemoryPersistenceStrategy }

export function PersistenceStrategyDialog(props: {
  client: MemorySpacesPageClient
  settingsScope: MemoryPlacementSettings
  config: MemoryPlacementPageConfig | undefined
  writable: boolean
  agentAvailable: boolean
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const strategyFormId = useId()
  const configured = props.config?.persistenceStrategy
  const [draft, setDraft] = useState<PlacementPolicyDraft>(() => createPlacementPolicyDraft(configured, []))
  const [providers, setProviders] = useState<MemoryProviderDescriptor[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void props.client.bodyDirectory().then(catalog => {
      if (!current) return
      const next = catalog.providers
      setProviders(next)
      setDraft(previous => {
        const nextProviderId = readyProviderId(next, previous.providerId) ?? previous.providerId
        let nextAllowed = previous.allowedProviderIds
        if (configured?.rules?.allowedProviderIds === undefined) {
          const ready = previous.allowedProviderIds.filter(id => next.some(provider => provider.id === id && provider.serviceConfigured !== false))
          const first = readyProviderId(next)
          nextAllowed = ready.length > 0 || first === undefined ? ready : [first]
        }
        return {
          ...previous,
          providerId: nextProviderId,
          allowedProviderIds: nextAllowed,
          providerConnections: mergeProviderDefaults(next, previous.providerConnections),
        }
      })
    }).catch(reason => { if (current) setError(message(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [props.client])

  const selectedProvidersValid = placementPolicyProblem(draft, providers, t) === null

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (loading || saving || !props.writable || !selectedProvidersValid) return
    setSaving(true); setError(null)
    try {
      await props.settingsScope.setPath(['persistenceStrategy'], serializePlacementPolicy(draft, providers))
      props.onClose()
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  return <SidebarModal title={t('strategy.title')} description={t('strategy.description')} busy={saving} contentReady={!loading} wide onClose={props.onClose} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={saving} onClick={props.onClose}>{t('common.cancel')}</button><button type="submit" form={strategyFormId} className={css.primaryButton} disabled={loading || saving || !props.writable || !selectedProvidersValid}>{saving ? t('strategy.saving') : t('strategy.save')}</button></div>}>
    <form id={strategyFormId} className={appearanceClass(css.bodyEdit, css.strategyForm)} onSubmit={event => void save(event)}>
      {loading && <div className={css.strategyLoading}><SectionSpinner label={t('strategy.loading')} /><span>{t('strategy.loading')}</span></div>}
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {!loading && <>
        <section className={css.createSection}>
          <div className={css.createSectionHeading}><span>01</span><div><strong>{t('strategy.modeTitle')}</strong><small>{t('strategy.modeHint')}</small></div></div>
          <PlacementModeFieldset mode={draft.mode} radioGroupName="persistence-mode" autoFocusSelected onChange={mode => setDraft(current => ({ ...current, mode }))} />
        </section>
        <section className={css.createSection}>
          <div className={css.createSectionHeading}><span>02</span><div><strong>{t(draft.mode === 'manual' ? 'strategy.manualTitle' : 'strategy.automaticTitle')}</strong><small>{t(draft.mode === 'manual' ? 'strategy.manualDescription' : 'strategy.automaticDescription')}</small></div></div>
          <PlacementTargetControls draft={draft} providers={providers} providerRadioGroupName="strategy-provider" fieldLayout="dialog" agentAvailable={props.agentAvailable} onChange={patch => setDraft(current => ({ ...current, ...patch }))} />
        </section>
      </>}
    </form>
  </SidebarModal>
}
