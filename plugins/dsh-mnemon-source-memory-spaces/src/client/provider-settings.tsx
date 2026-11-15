import { css as pageCss, SafeReveal, useT, type SourceKey } from './presentation.ts'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { GlobalLocationSetting, memorySettingsStyles, message, useRequestVersion } from 'dsh-mnemon/client'
// Each function reads memorySettingsStyles where it draws, never at load: dsh-mnemon 0.5.31 lacks it and never draws
// these settings, and this bundle's pages must still load beside it.
import type { MemoryProviderConfigField, MemoryProviderConnection, MemoryProviderDescriptor, MemoryProviderServiceCatalog, MemoryProviderServiceView } from '../contracts.ts'
import { ProviderField } from './provider-field.tsx'
import { ProviderIcon } from './ProviderIcon.tsx'
import { providerSummary } from './provider-presentation.ts'
import type { MemorySpacesSettingsClient } from './settings-client.ts'

interface ProviderSettingsSectionProps {
  /** Absent while the page has no Host connection: nothing is read or written then. */
  client?: MemorySpacesSettingsClient | undefined
  /** Where the list keeps the Providers it last read or saved: the host's store, which outlives a mount. */
  retained: Map<string, unknown>
  workspaceLabel?: string
  activeScope: 'global' | 'workspace'
  refreshKey: number
  disabled: boolean
  scopeChanging: boolean
  /** Rendered first in the list; Settings puts Mnemon Native here as a peer of the others. */
  leading?: ReactNode
  /** Why the other Providers cannot be listed now; they are not read while it is set. */
  blocked?: ReactNode
  /** Whether it is not yet known if the Providers can be listed; they are read once it is. */
  pending?: boolean
  /** Why the listed Providers cannot be switched; rendered above them. */
  notice?: ReactNode
  /** A Provider was saved or switched, so pages that list Providers re-read them. */
  onChanged?: () => void
  /** Latest Provider catalog as loaded or mutated, so sibling policy controls reuse it without a second RPC. */
  onCatalog?: (catalog: MemoryProviderServiceCatalog) => void
}

interface ServiceDraft {
  settings: MemoryProviderConnection
}

const EMPTY_PROVIDER_CATALOG: MemoryProviderServiceCatalog = {
  providers: [],
  items: [],
  generatedAt: '',
}

// The last catalog read or saved, under a name every Memory Spaces version reads alike: a list mounted again,
// on a page opened again or in the settings that replace dsh-mnemon's, shows it while it is read anew.
const RETAINED_PROVIDERS = 'provider-services'
const retainedCatalog = (retained: Map<string, unknown>): MemoryProviderServiceCatalog | undefined => retained.get(RETAINED_PROVIDERS) as MemoryProviderServiceCatalog | undefined

function stabilizeProviderCard(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView
  let scrollContainer: HTMLElement | undefined

  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const overflowY = view?.getComputedStyle(ancestor).overflowY ?? ancestor.style.overflowY
    if (scrollContainer !== undefined && overflowY === 'hidden' && ancestor.scrollTop !== 0) ancestor.scrollTop = 0
    if (scrollContainer === undefined && (overflowY === 'auto' || overflowY === 'scroll') && ancestor.scrollHeight > ancestor.clientHeight) {
      scrollContainer = ancestor
    }
    if (ancestor.getAttribute('role') === 'dialog') break
  }

  if (scrollContainer === undefined) return
  const header = element.firstElementChild instanceof HTMLElement ? element.firstElementChild : element
  const headerRect = header.getBoundingClientRect()
  const containerRect = scrollContainer.getBoundingClientRect()
  if (headerRect.top < containerRect.top) scrollContainer.scrollTop -= containerRect.top - headerRect.top
  else if (headerRect.bottom > containerRect.bottom) scrollContainer.scrollTop += headerRect.bottom - containerRect.bottom
}

function serviceFields(provider: MemoryProviderDescriptor): MemoryProviderConfigField[] {
  return provider.fields.filter(field => field.scope === 'service')
}

function globalLocationFields(provider: MemoryProviderDescriptor): MemoryProviderConfigField[] {
  return serviceFields(provider).filter(field => field.role === 'global-location')
}

function serviceDefaults(provider: MemoryProviderDescriptor): MemoryProviderConnection {
  return Object.fromEntries(serviceFields(provider).flatMap(field => field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]]))
}

function draftFor(provider: MemoryProviderDescriptor, service: MemoryProviderServiceView): ServiceDraft {
  return { settings: { ...serviceDefaults(provider), ...service.settings, ...service.secretValues } }
}

function configurationComplete(provider: MemoryProviderDescriptor, draft: ServiceDraft, service: MemoryProviderServiceView): boolean {
  return serviceFields(provider).every(field => {
    if (!field.required) return true
    if (field.input === 'secret' && service.configuredSecrets.includes(field.key)) return true
    const value = draft.settings[field.key]
    return field.input === 'boolean' ? typeof value === 'boolean' : String(value ?? '').trim() !== ''
  })
}

function ProviderServiceForm(props: {
  provider: MemoryProviderDescriptor
  service: MemoryProviderServiceView
  activeScope: 'global' | 'workspace'
  disabled: boolean
  onSave: (provider: MemoryProviderDescriptor, draft: ServiceDraft) => Promise<void>
}): JSX.Element {
  const t = useT()
  const css = memorySettingsStyles
  const [draft, setDraft] = useState<ServiceDraft>(() => draftFor(props.provider, props.service))
  const [customLocations, setCustomLocations] = useState<Set<string>>(() => new Set(globalLocationFields(props.provider).filter(field => String(props.service.settings[field.key] ?? '').trim() !== '').map(field => field.key)))
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const stabilizeAfterLocationLayout = useRef(false)

  useEffect(() => {
    setDraft(draftFor(props.provider, props.service))
    setCustomLocations(new Set(globalLocationFields(props.provider).filter(field => String(props.service.settings[field.key] ?? '').trim() !== '').map(field => field.key)))
  }, [props.provider, props.service])

  useLayoutEffect(() => {
    if (!stabilizeAfterLocationLayout.current || formRef.current === null) return
    stabilizeAfterLocationLayout.current = false
    stabilizeProviderCard(formRef.current.closest<HTMLElement>('[data-provider]') ?? formRef.current)
  }, [customLocations])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const locationsComplete = props.activeScope === 'workspace' || globalLocationFields(props.provider).every(field => !customLocations.has(field.key) || String(draft.settings[field.key] ?? '').trim() !== '')
    if (!configurationComplete(props.provider, draft, props.service) || !locationsComplete || saving || props.disabled) return
    setSaving(true); setFailed(null); setSaved(false)
    const settings = { ...draft.settings }
    for (const field of globalLocationFields(props.provider)) {
      if (props.activeScope === 'workspace' || !customLocations.has(field.key)) settings[field.key] = ''
    }
    try { await props.onSave(props.provider, { settings }); setSaved(true) } catch (reason) { setFailed(message(reason)) } finally { setSaving(false) }
  }

  const update = (key: string, value: string | number | boolean): void => {
    setDraft(current => ({ ...current, settings: { ...current.settings, [key]: value } }))
    setFailed(null); setSaved(false)
  }

  const useCustomLocation = (field: MemoryProviderConfigField, custom: boolean): void => {
    stabilizeAfterLocationLayout.current = true
    setCustomLocations(current => {
      const next = new Set(current)
      if (custom) next.add(field.key)
      else next.delete(field.key)
      return next
    })
    setFailed(null); setSaved(false)
  }

  const stabilizeLocationCard = (): void => {
    if (formRef.current === null) return
    stabilizeProviderCard(formRef.current.closest<HTMLElement>('[data-provider]') ?? formRef.current)
  }

  const locations = globalLocationFields(props.provider)
  const regularFields = serviceFields(props.provider).filter(field => field.role !== 'global-location')
  const locationsComplete = props.activeScope === 'workspace' || locations.every(field => !customLocations.has(field.key) || String(draft.settings[field.key] ?? '').trim() !== '')
  const formComplete = configurationComplete(props.provider, draft, props.service) && locationsComplete
  const field = (descriptor: MemoryProviderConfigField): JSX.Element => <ProviderField key={descriptor.key} field={descriptor} value={draft.settings[descriptor.key]} layout="settings"
    saved={props.service.configuredSecrets.includes(descriptor.key)} disabled={props.disabled || saving} onChange={value => update(descriptor.key, value)} />

  return <form ref={formRef} className={css.providerServiceForm} onSubmit={event => void submit(event)} data-provider={props.provider.id}>
    <p className={css.providerServicePrompt}>{t(props.service.configured ? 'config.providerServiceHint' : 'config.providerEnableHint')}</p>
    {locations.map(location => <GlobalLocationSetting
      key={location.key}
      className={css.providerServiceLocation}
      name={`${props.provider.id}-${location.key}-location`}
      ariaLabel={`${props.provider.label} ${t('config.providerGlobalLocation')}`}
      label={t('config.providerGlobalLocation')}
      hint={t(props.activeScope === 'workspace' ? 'config.providerGlobalLocationWorkspaceHint' : 'config.providerGlobalLocationHint', { provider: props.provider.label })}
      defaultLabel={t('config.providerDefaultLocation')}
      customLabel={t('config.custom')}
      custom={customLocations.has(location.key)}
      workspace={props.activeScope === 'workspace'}
      disabled={props.disabled || saving}
      onInteract={stabilizeLocationCard}
      onChange={custom => useCustomLocation(location, custom)}
    >
      <div className={css.providerLocationField}>{field(location)}</div>
    </GlobalLocationSetting>)}
    <div className={css.providerSettingsGrid}>
      {regularFields.map(field)}
    </div>
    <div className={`${css.memoryConfigFooter} ${css.providerServiceFooter}`}>
      <div className={css.configFeedback} aria-live="polite">{failed !== null && <span className={css.error}>{t('config.providerSaveFailed', { error: failed })}</span>}{saved && <span className={css.packSuccess}>{t('config.providerServiceSaved')}</span>}</div>
      <Button type="submit" variant="primary" size="sm" disabled={props.disabled || saving || !formComplete}>{saving ? t('config.saving') : t(props.service.configured ? 'config.saveProviderService' : 'config.enableProvider')}</Button>
    </div>
  </form>
}

function ProviderPanel(props: {
  provider: MemoryProviderDescriptor
  service: MemoryProviderServiceView
  disabled: boolean
  onSave: (provider: MemoryProviderDescriptor, draft: ServiceDraft) => Promise<void>
  onToggle: (provider: MemoryProviderDescriptor, enabled: boolean) => Promise<MemoryProviderServiceView>
  activeScope: 'global' | 'workspace'
}): JSX.Element {
  const t = useT()
  const css = memorySettingsStyles
  const [enabled, setEnabled] = useState(props.service.enabled)
  const [expanded, setExpanded] = useState(props.service.enabled && !props.service.configured)
  const [toggling, setToggling] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const stabilizeAfterLayout = useRef(false)

  useLayoutEffect(() => {
    if (!stabilizeAfterLayout.current || rowRef.current === null) return
    stabilizeAfterLayout.current = false
    stabilizeProviderCard(rowRef.current)
  }, [enabled, expanded])

  useEffect(() => {
    if (toggling) return
    setEnabled(props.service.enabled)
    if (!props.service.enabled) setExpanded(false)
  }, [props.service.enabled, toggling])

  const toggle = async (next: boolean): Promise<void> => {
    setFailed(null)
    stabilizeAfterLayout.current = true
    if (next && !props.service.configured) {
      setEnabled(true)
      setExpanded(true)
      return
    }
    if (!next && !props.service.enabled) {
      setEnabled(false)
      setExpanded(false)
      return
    }
    const restoreEnabled = enabled
    const restoreExpanded = expanded
    setEnabled(next)
    if (!next && expanded) setExpanded(false)
    setToggling(true)
    try {
      const updated = await props.onToggle(props.provider, next)
      setEnabled(updated.enabled)
      if (!next) setExpanded(false)
    } catch (reason) {
      setEnabled(restoreEnabled)
      if (restoreExpanded) setExpanded(true)
      setFailed(message(reason))
    } finally {
      setToggling(false)
    }
  }

  const stateKey: SourceKey = enabled
    ? props.service.configured ? 'config.providerEnabled' : 'config.providerNeedsConfiguration'
    : props.service.configured ? 'config.providerDisabledConfigured' : 'config.providerDisabled'
  const providerScope = props.provider.workspaceBinding === 'provider-global' ? 'global' : props.activeScope
  const controlDisabled = props.disabled || toggling
  const toggleExpanded = (): void => {
    stabilizeAfterLayout.current = true
    setExpanded(value => !value)
  }
  return <div
    ref={rowRef}
    className={css.providerRow}
    data-provider={props.provider.id}
    data-enabled={enabled || undefined}
    data-expanded={expanded || undefined}
    role="group"
    aria-label={`${props.provider.label} ${t('config.providerServiceTitle')}`}
  >
    <div className={css.providerRowHeader}>
      <button type="button" className={css.providerDisclosure} aria-expanded={expanded} disabled={!enabled || controlDisabled} onClick={toggleExpanded}>
        <span className={css.providerIdentity}><ProviderIcon providerId={props.provider.id} icon={props.provider.icon} className={css.providerMark} /><span><strong>{props.provider.label}</strong><small>{providerSummary(t, props.provider)}</small></span></span>
        {enabled && <IconChevronDownOutlineRegular className={`${css.providerChevron} ${pageCss.smoothChevron}`} size={14} />}
      </button>
      <div className={css.providerEnableControl}>
        <span className={css.providerScopeTag} data-scope={providerScope}>{t(`config.${providerScope}`)}</span>
        <span className={css.providerState} data-enabled={enabled || undefined}>{t(stateKey)}</span>
        <Switch className={css.providerToggle} checked={enabled} label={t('config.providerToggleAria', { provider: props.provider.label })} disabled={controlDisabled} onChange={next => void toggle(next)} />
      </div>
    </div>
    <SafeReveal>{failed !== null ? <p className={css.providerToggleError} role="alert">{t('config.providerToggleFailed', { error: failed })}</p> : null}</SafeReveal>
    {enabled && expanded && <div className={`${css.providerInlineBody} ${pageCss.inlineExpand}`}><ProviderServiceForm provider={props.provider} service={props.service} activeScope={props.activeScope} disabled={controlDisabled} onSave={props.onSave} /></div>}
  </div>
}

/** The Providers that store Memory Spaces, one card each, with what their services need. */
export function ProviderSettingsSection(props: ProviderSettingsSectionProps): JSX.Element {
  const t = useT()
  const css = memorySettingsStyles
  const { client, retained, onCatalog } = props
  const initialCatalog = client === undefined ? undefined : retainedCatalog(retained)
  const [catalog, setCatalog] = useState<MemoryProviderServiceCatalog>(() => initialCatalog ?? EMPTY_PROVIDER_CATALOG)
  const [loading, setLoading] = useState(client !== undefined && initialCatalog === undefined)
  const [failed, setFailed] = useState<string | null>(null)
  const loadRequests = useRequestVersion()

  const load = useCallback(async (quiet = false) => {
    if (client === undefined) return
    const request = loadRequests.begin()
    if (!quiet) setLoading(true)
    setFailed(null)
    try {
      const next = await client.providerServices()
      if (!loadRequests.isCurrent(request)) return
      retained.set(RETAINED_PROVIDERS, next)
      setCatalog(next)
      onCatalog?.(next)
    } catch (reason) {
      if (!loadRequests.isCurrent(request)) return
      setFailed(message(reason))
    } finally {
      if (!quiet && loadRequests.isCurrent(request)) setLoading(false)
    }
  }, [client, loadRequests, onCatalog, retained])

  const blocked = props.blocked !== undefined
  const pending = props.pending === true
  useEffect(() => {
    if (blocked || pending) {
      loadRequests.begin()
      setLoading(pending)
      setFailed(null)
      return
    }
    const cached = client === undefined ? undefined : retainedCatalog(retained)
    setCatalog(cached ?? EMPTY_PROVIDER_CATALOG)
    if (cached !== undefined) onCatalog?.(cached)
    setLoading(client !== undefined && cached === undefined)
    void load(cached !== undefined)
  }, [blocked, client, load, loadRequests, onCatalog, pending, props.refreshKey, retained])

  const acceptService = useCallback((service: MemoryProviderServiceView): void => {
    setCatalog(current => {
      const items = current.items.some(item => item.providerId === service.providerId)
        ? current.items.map(item => item.providerId === service.providerId ? service : item)
        : [...current.items, service]
      const next = { ...current, items, generatedAt: new Date().toISOString() }
      if (client !== undefined) retained.set(RETAINED_PROVIDERS, next)
      onCatalog?.(next)
      return next
    })
  }, [client, onCatalog, retained])

  const save = async (provider: MemoryProviderDescriptor, draft: ServiceDraft): Promise<void> => {
    if (client === undefined) throw new Error(t('config.providerUnavailable'))
    const settings = Object.fromEntries(Object.entries(draft.settings).filter(([key, value]) => serviceFields(provider).find(field => field.key === key)?.input !== 'secret' || String(value).trim() !== ''))
    acceptService(await client.updateProviderService({ providerId: provider.id, settings, enabled: true }))
    props.onChanged?.()
  }

  const toggle = async (provider: MemoryProviderDescriptor, enabled: boolean): Promise<MemoryProviderServiceView> => {
    if (client === undefined) throw new Error(t('config.providerUnavailable'))
    const updated = await client.updateProviderService({ providerId: provider.id, settings: {}, enabled })
    acceptService(updated)
    props.onChanged?.()
    return updated
  }

  const disabled = props.disabled || props.scopeChanging || client === undefined || loading || catalog.generatedAt === ''
  // Explanations slide in and out, so the list does not jump when a dependency changes.
  if (blocked) return <><SafeReveal>{props.blocked}</SafeReveal><div className={css.providerList}>{props.leading}</div></>
  return <>
    <SafeReveal>{props.notice ?? null}</SafeReveal>
    {props.scopeChanging && <p className={css.scopeChanging} role="status">{t('config.saveScopeBeforeProviders')}</p>}
    {props.workspaceLabel !== undefined && <p className={css.providerTarget}>{t('config.providerTargetWorkspace', { workspace: props.workspaceLabel })}</p>}
    {loading && <span className={css.visuallyHidden} role="status">{t('config.loadingProviders')}</span>}
    {failed !== null && <div className={css.providerLoadError}><span className={css.error}>{t('config.providerLoadFailed', { error: failed })}</span><Button variant="ghost" size="sm" onClick={() => void load()}>{t('config.retryProviders')}</Button></div>}
    <div className={css.providerList} aria-busy={loading}>{props.leading}{catalog.providers.map(provider => {
      const service = catalog.items.find(item => item.providerId === provider.id) ?? { providerId: provider.id, enabled: false, configured: false, settings: {}, configuredSecrets: [] }
      return <ProviderPanel key={provider.id} provider={provider} service={service} disabled={disabled} activeScope={props.activeScope} onSave={save} onToggle={toggle} />
    })}</div>
  </>
}
