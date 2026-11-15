import { useEffect, useState, type ReactNode } from 'react'
import type { MemoryProviderRuntimeStatus, StatusView, StorageAreaInventory, StorageScopeInventory, StorageScopeKind } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import { VersionDialog } from './VersionDialog.tsx'
import { clearStarterUpdate, pendingStarterUpdate } from './starter-update.ts'
import type { MnemonKey, MnemonTranslate } from './locales.ts'
import { NATIVE_PROVIDER_ID, ProviderIcon } from './memory-spaces-client.ts'
import { Button, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MnemonView.module.css'
import { useT, humanBytes, PageHeader } from './page-kit.tsx'

/** Which way a memory layer is not serving now, or that it is. */
export type LayerState = 'on' | 'off' | 'stopped' | 'memory-off'

/** A Source component's card on the Status page. */
export interface ComponentCard {
  key: string
  packageName: string
  label: string
  enabled: boolean
  state: LayerState
}

export function StatusPage(props: {
  client: MnemonClient
  status: StatusView | null
  loading: boolean
  writeEnabled: boolean
  attention: boolean
  /** One card per Source component, in the order the configuration lists its layers. */
  components: readonly ComponentCard[]
  /** What a running component's card says: what it contributed, or that it runs. */
  renderCard: (card: ComponentCard) => ReactNode
  /** A storage area's name, from the component that keeps its data there. */
  areaName: (kind: StorageAreaInventory['kind']) => string
  onRefresh: () => void
  /** Where Providers that are off can be turned on. */
  onOpenConfiguration?: (() => void) | undefined
}): JSX.Element {
  const t = useT()
  // DSH swapped this client in during a Starter update started here: show how it ended.
  const [resumedUpdate, setResumedUpdate] = useState(() => pendingStarterUpdate())
  const [versionsOpen, setVersionsOpen] = useState(false)
  const status = props.status
  const answered = status !== null || !props.loading
  useEffect(() => {
    if (resumedUpdate === undefined || !answered) return
    // A DSH that already restarted onto the update has nothing left to report.
    if (status !== null && status.restartPending === undefined && resumedUpdate.to !== undefined && status.dshMnemonVersion === resumedUpdate.to) {
      clearStarterUpdate()
      setResumedUpdate(undefined)
      return
    }
    setVersionsOpen(true)
  }, [answered])
  const reviewError = status?.lifecycle?.current?.lastError
  const storage = status?.storage
  const selectedScopeKind = storage?.activeKind ?? 'global'
  const selectedScope = storage?.scopes.find(scope => scope.kind === selectedScopeKind)
  // A component that is off, or whose Source is not running, has no reading to wait for.
  const idle = (state: LayerState): { title: string; detail: string } | undefined => state === 'on' ? undefined
    : state === 'off' ? { title: t('layers.disabledBadge'), detail: t('status.layerOffDetail') }
      : state === 'memory-off' ? { title: t('layers.memoryOffBadge'), detail: t('status.layerMemoryOffDetail') }
        : { title: t('layers.stoppedBadge'), detail: t('status.layerStoppedDetail') }
  return (
    <div className={css.page}>
      <PageHeader title={t('status.title')} description={t('status.description')} meta={status === null && props.loading ? t('common.loading') : status === null || reviewError !== undefined || props.attention ? t('status.checkRequired') : t('status.nominal')} {...(props.loading ? { loadingLabel: t('status.rechecking') } : {})} action={<div className={css.statusHeaderActions}><button type="button" className={css.secondaryButton} onClick={() => setVersionsOpen(true)}>{t('versions.checkAction')}</button></div>} />

      <section className={css.healthStrip} aria-label={t('status.aria')}>
        <article><span className={`${css.healthIndicator} ${status === null ? css.healthMuted : css.healthGood}`} /><div><small>{t('status.engine')}</small><strong>{status?.dshMnemonVersion === undefined ? 'dsh-mnemon' : `dsh-mnemon ${status.dshMnemonVersion}`}</strong><p>{status === null ? t('status.pluginChecking') : t('status.pluginReady')}</p></div></article>
        {props.components.map(card => {
          const note = idle(card.state)
          return <article key={card.key} data-component={card.packageName}>
            <span className={`${css.healthIndicator} ${note === undefined && status !== null ? css.healthGood : css.healthMuted}`} />
            <div><small>{card.label}</small>{note === undefined ? props.renderCard(card) : <><strong>{note.title}</strong><p>{note.detail}</p></>}</div>
          </article>
        })}
      </section>

      <div className={css.asyncStatusBlock}>{status !== null && (status.providerServices !== undefined || (status.memoryBodies !== undefined && nativeInUse(status))) && <ProviderHealth status={status} services={status.providerServices ?? []} onOpenConfiguration={props.onOpenConfiguration} />}</div>
      <div className={css.asyncStatusBlock}><StorageDomains catalog={storage} selected={selectedScope} selectedKind={selectedScopeKind} areaName={props.areaName} /></div>
      {versionsOpen && <VersionDialog client={props.client} writeEnabled={props.writeEnabled} resumedUpdate={resumedUpdate} onClose={() => { setResumedUpdate(undefined); setVersionsOpen(false) }} onRefreshStatus={props.onRefresh} />}
    </div>
  )
}

/** Mnemon Native is one Provider among peers: it has a health card once its CLI is installed or a space uses it. */
function nativeInUse(status: StatusView): boolean {
  return status.commandFound || (status.memoryBodies ?? []).some(body => body.provider.origin === 'native')
}

/** Mnemon Native as the first row of the Provider list; its health comes from the CLI and its own spaces. */
function NativeProviderRow({ status }: { status: StatusView }): JSX.Element {
  const t = useT()
  const bodies = (status.memoryBodies ?? []).filter(body => body.provider.origin === 'native')
  const active = bodies.filter(body => body.active)
  const pending = active.filter(body => body.statusLoading === true)
  const failed = active.filter(body => body.statusLoading !== true && !body.healthy)
  const state: MemoryProviderRuntimeStatus['status'] = !status.commandFound || failed.length > 0 ? 'unhealthy' : active.length === 0 || pending.length > 0 ? 'idle' : 'healthy'
  const error = !status.commandFound
    ? t('status.nativeCliMissing')
    : failed.map(body => `${body.name}: ${body.error ?? t('status.engineUnavailable')}`).join('; ')
  const version = status.version === undefined ? t('status.versionWaiting') : `Mnemon ${status.version}`
  return <article aria-label={t('status.nativeAria')} data-status={state} data-native="">
    <ProviderIcon providerId={NATIVE_PROVIDER_ID} icon={{ kind: 'brand', value: 'mnemon' }} className={css.providerHealthMark} />
    <div className={css.providerHealthCopy}>
      <strong>{t('config.nativeName')}</strong>
      <small>{t(`status.providerState.${state}` as MnemonKey)} · <span>{version}</span></small>
      {error !== '' && <p title={error}>{error}</p>}
    </div>
    <div className={css.providerHealthMeta}>
      <span className={css.providerHealthSignal} aria-hidden="true" />
      <small>{t('status.providerSpaces', { active: active.length, total: bodies.length })}</small>
    </div>
  </article>
}

/** The Providers that run, one row each; the ones that are off share one line saying where to turn them on. */
function ProviderHealth({ status, services, onOpenConfiguration }: { status: StatusView; services: MemoryProviderRuntimeStatus[]; onOpenConfiguration?: (() => void) | undefined }): JSX.Element {
  const t = useT()
  const native = status.memoryBodies !== undefined && nativeInUse(status)
  const running = services.filter(service => service.enabled)
  const off = services.length - running.length
  const enabled = running.length + (native && status.commandFound ? 1 : 0)
  const total = services.length + (native ? 1 : 0)
  return <section className={css.providerHealth} aria-label={t('status.providersAria')}>
    <div className={css.statusSectionHeader}>
      <div><h3>{t('status.providersTitle')}</h3><p>{t('status.providersDescription')}</p></div>
      <span className={css.phaseBadge}>{t('status.providersEnabled', { enabled, total })}</span>
    </div>
    <div className={css.providerHealthList}>
      {native && <NativeProviderRow status={status} />}
      {running.map(service => <article key={service.providerId} data-status={service.status}>
        <ProviderIcon providerId={service.providerId} icon={service.icon} className={css.providerHealthMark} />
        <div className={css.providerHealthCopy}>
          <strong>{service.label}</strong>
          <small>{t(`status.providerState.${service.status}` as MnemonKey)}</small>
          {service.error !== undefined && <p title={service.error}>{service.error}</p>}
        </div>
        <div className={css.providerHealthMeta}>
          <span className={css.providerHealthSignal} aria-hidden="true" />
          <small>{t('status.providerSpaces', { active: service.activeMemoryBodyCount, total: service.memoryBodyCount })}</small>
        </div>
      </article>)}
    </div>
    {off > 0 && <div className={css.providerHealthOff}>
      <span>{t('status.providersOff', { count: off })}</span>
      {onOpenConfiguration !== undefined && <Button variant="ghost" size="sm" onClick={onOpenConfiguration}>{t('common.openConfiguration')}</Button>}
    </div>}
  </section>
}

export function storageScopeLabel(t: MnemonTranslate, kind: StorageScopeKind): string {
  return t(kind === 'global' ? 'status.storageGlobal' : kind === 'workspace' ? 'status.storageWorkspace' : kind === 'workspaces' ? 'status.storageWorkspaces' : 'status.storageCustom')
}

function storageAreaDetails(t: MnemonTranslate, area: StorageAreaInventory): string {
  if (area.kind === 'runtime') return t('status.storageRuntimeDetail', { user: area.details.userEntries ?? 0, memory: area.details.memoryEntries ?? 0 })
  if (area.kind === 'memory-bodies') return t('status.storageSpacesDetail', { active: area.details.activeBodies ?? 0, databases: area.details.databases ?? 0 })
  if (area.kind === 'documents') return t('status.storageDocumentsDetail', { active: area.details.activeDocuments ?? 0, archived: area.details.archivedDocuments ?? 0 })
  return area.details.reviewLedger === true ? t('status.storageStateReady') : t('status.storageStateVolatile')
}

function StorageDomains(props: {
  catalog: StatusView['storage']
  selected: StorageScopeInventory | undefined
  selectedKind: StorageScopeKind
  areaName: (kind: StorageAreaInventory['kind']) => string
}): JSX.Element {
  const t = useT()
  const areaStatus = (status: StorageAreaInventory['status']) => t(status === 'ready' ? 'status.storageReady' : status === 'empty' ? 'status.storageEmpty' : status === 'missing' ? 'status.storageMissing' : 'status.storageInvalid')
  return (
    <section className={css.storageDomains} aria-label={t('status.storageDomains')}>
      <div className={css.statusSectionHeader}>
        <div><h3>{t('status.storageDomains')}</h3><p>{t('status.storageDomainsText')}</p></div>
        <span className={css.phaseBadge} title={t('status.storageFootnote')}>{storageScopeLabel(t, props.selectedKind)}</span>
      </div>
      {props.catalog === undefined ? <div className={css.storageUnavailable}>{t('status.storageWaiting')}</div> : props.selected?.root === undefined ? <div className={css.storageUnavailable}><strong>{storageScopeLabel(t, props.selectedKind)}</strong><p>{props.selectedKind === 'custom' ? t('status.storageCustomUnset') : t('status.storageWorkspaceUnavailable')}</p></div> : <>
        <div className={css.storageRoot}>
          <div><span>{storageScopeLabel(t, props.selectedKind)} · {t('status.storageActiveRoot')}</span><PathLabel path={props.selected.root} /></div>
          <div><strong>{humanBytes(props.selected.totalBytes)}</strong><small>{props.selected.available ? t('status.storageAvailable') : t('status.storageNotCreated')}</small></div>
        </div>
        <div className={css.storageAreaGrid}>
          {props.selected.areas.filter(area => area.kind !== 'state').map(area => <article key={area.kind} data-status={area.status}>
            <header><div><span /> <strong>{props.areaName(area.kind)}</strong></div><em>{areaStatus(area.status)}</em></header>
            <div className={css.storageAreaMetric}><strong>{area.itemCount}</strong><span>{t('status.storageItems')}</span><code>{humanBytes(area.bytes)}</code></div>
            <p>{storageAreaDetails(t, area)}</p>
            <span className={css.storagePath}><PathLabel path={area.path} /></span>
            {area.issue !== undefined && <small>{area.issue}</small>}
          </article>)}
        </div>
      </>}
    </section>
  )
}
