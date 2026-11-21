import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ClientConnectionHandle, type ClientSettingsScope, type Config, type TaskAgentModelCatalog, type TaskAgentModelConfig } from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MnemonKey, MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'
import { message } from './page-kit.tsx'
import { SelectRow, type SettingOption } from './settings-controls.tsx'
import { useLive, useScope } from './settings-panel.tsx'

export interface TaskAgentRoute {
  mode: 'inherit' | 'conversation' | 'fixed'
  provider: string
  model: string
}

export type TaskAgentRouteSource = NonNullable<TaskAgentModelCatalog['effective']>['source']

export interface TaskAgentCatalogState {
  state: 'unavailable' | 'loading' | 'ready' | 'error'
  value: TaskAgentModelCatalog | null
  error: string | null
  full: boolean
}

export function routeOf(value: Config | undefined): TaskAgentRoute {
  const configured = value?.taskAgentModel
  return {
    mode: configured?.mode === 'fixed' ? 'fixed' : configured?.followConversation === true ? 'conversation' : 'inherit',
    provider: configured?.provider?.trim() ?? '',
    model: configured?.model?.trim() ?? '',
  }
}

function stored(route: TaskAgentRoute): TaskAgentModelConfig {
  return route.mode === 'fixed' ? { mode: 'fixed', provider: route.provider, model: route.model }
    : route.mode === 'conversation' ? { mode: 'inherit', followConversation: true }
    : { mode: 'inherit' }
}

export function startingRoute(catalog: TaskAgentModelCatalog, current: TaskAgentRoute): { provider: string; model: string } | undefined {
  const listed = (provider: string): boolean => catalog.groups.some(group => group.id === provider)
  const provider = (listed(current.provider) ? current.provider : '') || catalog.defaultSelection?.provider || catalog.groups[0]?.id || ''
  const models = catalog.groups.find(group => group.id === provider)?.models ?? []
  const model = (current.provider === provider ? current.model : '')
    || (catalog.defaultSelection?.provider === provider ? catalog.defaultSelection.model : '') || models[0]?.id || ''
  return provider === '' || model === '' ? undefined : { provider, model }
}

export function effectiveRoute(route: TaskAgentRoute, catalog: TaskAgentModelCatalog | null, settled = true): { provider: string; model: string; source: TaskAgentRouteSource } | undefined {
  if (!settled) return catalog?.effective
  if (route.mode === 'fixed') return route.provider === '' || route.model === '' ? undefined : { provider: route.provider, model: route.model, source: 'fixed' }
  if (route.mode === 'conversation' && catalog?.session !== undefined) return { ...catalog.session, source: 'session' }
  return catalog?.inherited ?? (catalog?.defaultSelection === undefined ? undefined : { ...catalog.defaultSelection, source: 'dsh-default' })
}

function routeSourceKey(source: TaskAgentRouteSource): MnemonKey {
  return `config.taskAgentSource.${source}`
}

export function useTaskAgentModel(options: {
  scope: ClientSettingsScope<Config>
  connection?: ClientConnectionHandle | undefined
  sessionId?: string | undefined
  workspaceId?: string | undefined
}): {
  route: TaskAgentRoute
  settled: boolean
  catalog: TaskAgentCatalogState
  choosing: boolean
  failed: string | null
  retry: () => void
  setMode: (mode: TaskAgentRoute['mode']) => void
  setRoute: (route: { provider: string; model: string }) => void
} {
  const { scope, connection, sessionId, workspaceId } = options
  const snapshot = useScope(scope)
  const saved = routeOf(snapshot.value)
  const route = useLive(saved, async next => {
    await scope.mutate([{ op: 'set', path: ['taskAgentModel'], value: stored(next) }])
  })

  const [catalog, setCatalog] = useState<TaskAgentCatalogState>(
    { state: connection === undefined ? 'unavailable' : 'loading', value: null, error: null, full: false })
  const request = useRef(0)
  const client = useMemo(() => connection === undefined ? undefined : new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const loaded = useRef<{ client: MnemonClient | undefined; level: 'none' | 'route' | 'full' }>({ client: undefined, level: 'none' })
  const level = (): 'none' | 'route' | 'full' => loaded.current.client === client ? loaded.current.level : 'none'
  const load = useCallback((full: boolean): void => {
    if (client === undefined) return
    const current = ++request.current
    setCatalog(value => ({ ...value, state: 'loading', error: null }))
    void client.taskAgentModels(full).then(value => {
      if (request.current !== current) return
      loaded.current = { client, level: full ? 'full' : 'route' }
      setCatalog({ state: 'ready', value, error: null, full })
    }, reason => {
      if (request.current === current) setCatalog(value => ({ ...value, state: 'error', error: message(reason) }))
    })
  }, [client])
  useEffect(() => () => { request.current += 1 }, [])
  const fullFixed = saved.mode === 'fixed'
  useEffect(() => {
    if (fullFixed ? level() === 'full' : level() !== 'none') return
    load(fullFixed)
  }, [fullFixed, load])
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    if (!choosing) return
    if (catalog.state === 'error') { setChoosing(false); return }
    if (!catalog.full || catalog.value === null) return
    setChoosing(false)
    const start = startingRoute(catalog.value, route.value)
    if (start !== undefined) route.set({ mode: 'fixed', ...start })
  }, [choosing, catalog])
  const setMode = (mode: TaskAgentRoute['mode']): void => {
    if (mode !== 'fixed') {
      setChoosing(false)
      if (route.value.mode === mode) return
      route.set({ mode, provider: '', model: '' })
      return
    }
    const start = catalog.full && catalog.value !== null ? startingRoute(catalog.value, route.value) : undefined
    if (start !== undefined) { route.set({ mode: 'fixed', ...start }); return }
    setChoosing(true)
    load(true)
  }
  return {
    route: route.value,
    settled: snapshot.status === 'ready',
    catalog,
    choosing,
    failed: route.failed,
    retry: () => { load(fullFixed || choosing || level() === 'full') },
    setMode,
    setRoute: next => { route.set({ mode: 'fixed', ...next }) },
  }
}

function EffectiveRoute(props: { route: TaskAgentRoute; settled?: boolean | undefined; choosing?: boolean | undefined; catalog: TaskAgentModelCatalog | null; state: TaskAgentCatalogState['state']; t: MnemonTranslate }): JSX.Element {
  const { t } = props
  const effective = props.choosing === true ? undefined : effectiveRoute(props.route, props.catalog, props.settled !== false)
  return <span className={css.routeValue}>
    {effective === undefined
      ? <small>{props.state === 'loading' || props.choosing === true ? t('config.taskAgentLoading') : t('config.taskAgentUnavailable')}</small>
      : <><code>{effective.provider} / {effective.model}</code><small>{t(routeSourceKey(effective.source))}</small></>}
  </span>
}

export function TaskAgentModelRows(props: {
  idPrefix?: string | undefined
  mode: TaskAgentRoute['mode']
  route: TaskAgentRoute
  settled?: boolean | undefined
  choosing?: boolean | undefined
  catalog: TaskAgentModelCatalog | null
  state: TaskAgentCatalogState['state']
  error?: string | null | undefined
  disabled: boolean
  onMode: (mode: TaskAgentRoute['mode']) => void
  onRoute: (route: { provider: string; model: string }) => void
  retry?: (() => void) | undefined
  note?: ReactNode
  t: MnemonTranslate
}): JSX.Element {
  const { route, t } = props
  const groups = props.state === 'ready' ? props.catalog?.groups ?? [] : []
  const group = groups.find(candidate => candidate.id === route.provider)
  const fixed = props.mode === 'fixed' && props.state === 'ready'
  const shared = (name: string): boolean => groups.filter(candidate => candidate.name === name).length > 1
  const providers: SettingOption<string>[] = [
    ...(route.provider !== '' && group === undefined ? [{ value: route.provider, label: route.provider }] : []),
    ...groups.map(candidate => ({ value: candidate.id, label: candidate.name, ...(shared(candidate.name) ? { detail: candidate.id } : {}) })),
  ]
  const models: SettingOption<string>[] = [
    ...(route.model !== '' && group?.models.some(model => model.id === route.model) !== true ? [{ value: route.model, label: route.model }] : []),
    ...(group?.models ?? []).map(model => ({ value: model.id, label: model.name, ...(model.inputModalities?.includes('image') === true ? { detail: t('config.taskAgentImageInput') } : {}) })),
  ]
  const prefix = props.idPrefix ?? 'mnemon-task-agent'
  const chooseProvider = (provider: string): void => {
    const model = groups.find(candidate => candidate.id === provider)?.models[0]?.id
    if (model !== undefined) props.onRoute({ provider, model })
  }
  return <>
    <SelectRow id={prefix} label={t('config.taskAgentTitle')} value={props.mode} disabled={props.disabled} onChange={props.onMode}
      options={[
        { value: 'inherit', label: t('config.taskAgentInherit'), detail: t('config.taskAgentInheritHint') },
        { value: 'conversation', label: t('config.taskAgentConversation'), detail: t('config.taskAgentConversationHint') },
        { value: 'fixed', label: t('config.taskAgentFixed'), detail: t('config.taskAgentFixedHint'), ...(props.state === 'unavailable' ? { disabled: true } : {}) },
      ]} />
    {fixed && <>
      <SelectRow id={`${prefix}-provider`} label={t('config.taskAgentProvider')} value={route.provider} disabled={props.disabled || props.state !== 'ready'} options={providers} onChange={chooseProvider} />
      <SelectRow id={`${prefix}-model`} label={t('config.taskAgentModel')} value={route.model} disabled={props.disabled || props.state !== 'ready' || group === undefined} options={models}
        onChange={model => props.onRoute({ provider: route.provider, model })} />
    </>}
    <div className={css.rowDetail}>
      <span className={css.effectiveRoute}>
        <span>{t('config.taskAgentEffective')}</span>
        <EffectiveRoute route={route} settled={props.settled} choosing={props.choosing} catalog={props.catalog} state={props.state} t={t} />
      </span>
      {props.note}
      {props.state === 'error' && <p className={css.warning}>
        {t('config.taskAgentLoadFailed', { error: props.error ?? '' })}
        {props.retry !== undefined && <Button variant="ghost" size="sm" onClick={props.retry}>{t('config.taskAgentRetry')}</Button>}
      </p>}
      {(props.catalog?.failures?.length ?? 0) > 0 && groups.length > 0 && <p className={css.warning}>{t('config.taskAgentPartial', { count: props.catalog!.failures.length })}</p>}
    </div>
  </>
}
