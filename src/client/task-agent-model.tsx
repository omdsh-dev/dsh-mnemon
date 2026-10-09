import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ClientConnectionHandle, type ClientSettingsScope, type Config, type TaskAgentModelCatalog } from '../host/protocol.ts'
import { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'
import { message } from './page-kit.tsx'
import { SelectRow, type SettingOption } from './settings-controls.tsx'
import { useScope } from './settings-panel.tsx'

/** Where the background task Agents run: the route of the conversation they serve, or a fixed Provider and model. */
export interface TaskAgentRoute {
  mode: 'inherit' | 'fixed'
  provider: string
  model: string
}

/** What the model directory answered, and whether every Provider's models were read. */
export interface TaskAgentCatalogState {
  state: 'unavailable' | 'loading' | 'ready' | 'error'
  value: TaskAgentModelCatalog | null
  error: string | null
  full: boolean
}

export function routeOf(value: Config | undefined): TaskAgentRoute {
  return {
    mode: value?.taskAgentModel?.mode === 'fixed' ? 'fixed' : 'inherit',
    provider: value?.taskAgentModel?.provider?.trim() ?? '',
    model: value?.taskAgentModel?.model?.trim() ?? '',
  }
}

/** The route choosing a fixed model starts from: the saved one, else DSH's default, else the first listed. */
export function startingRoute(catalog: TaskAgentModelCatalog, current: TaskAgentRoute): { provider: string; model: string } | undefined {
  const listed = (provider: string): boolean => catalog.groups.some(group => group.id === provider)
  const provider = (listed(current.provider) ? current.provider : '') || catalog.defaultSelection?.provider || catalog.groups[0]?.id || ''
  const models = catalog.groups.find(group => group.id === provider)?.models ?? []
  const model = (current.provider === provider ? current.model : '')
    || (catalog.defaultSelection?.provider === provider ? catalog.defaultSelection.model : '') || models[0]?.id || ''
  return provider === '' || model === '' ? undefined : { provider, model }
}

/**
 * The task Agent route a page shows and writes: the mode and Provider / model
 * the Host stored, the model directory they are chosen from, and the write that
 * applies a choice at once. A page belongs to one conversation, so the route it
 * reports is that conversation's, and a read that fails says why and can be
 * asked for again instead of quietly falling back.
 */
export function useTaskAgentModel(options: {
  scope: ClientSettingsScope<Config>
  connection?: ClientConnectionHandle | undefined
  sessionId?: string | undefined
  workspaceId?: string | undefined
}): {
  route: TaskAgentRoute
  catalog: TaskAgentCatalogState
  /** A fixed model was chosen and waits for the full catalog to pick its first route. */
  choosing: boolean
  /** The Host refused the last write, as the page shows it. */
  failed: string | null
  /** Read the model directory again after a read that failed. */
  retry: () => void
  setMode: (mode: TaskAgentRoute['mode']) => void
  setRoute: (route: { provider: string; model: string }) => void
} {
  const { scope, connection, sessionId, workspaceId } = options
  const snapshot = useScope(scope)
  // The route is held here rather than in a control, so every row of a page reads the same one.
  const [saved, setSaved] = useState<TaskAgentRoute>(() => routeOf(snapshot.value))
  const [failed, setFailed] = useState<string | null>(null)
  const write = useRef(0)
  const writeRoute = useCallback((next: TaskAgentRoute): void => {
    const current = ++write.current
    setSaved(next)
    setFailed(null)
    void scope.mutate([{
      op: 'set',
      path: ['taskAgentModel'],
      value: next.mode === 'inherit' ? { mode: 'inherit' } : { mode: 'fixed', provider: next.provider, model: next.model },
    }]).catch(reason => {
      if (write.current !== current) return
      // The Host kept its own value, so the page shows that one again.
      setSaved(routeOf(scope.getSnapshot().value))
      setFailed(message(reason))
    })
  }, [scope])

  const [catalog, setCatalog] = useState<TaskAgentCatalogState>(
    { state: connection === undefined ? 'unavailable' : 'loading', value: null, error: null, full: false })
  const request = useRef(0)
  // What the catalog read so far: DSH's route alone, or every Provider's models too.
  const loaded = useRef<'none' | 'route' | 'full'>('none')
  const client = useMemo(() => connection === undefined ? undefined : new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const load = useCallback((full: boolean): void => {
    if (client === undefined) return
    const current = ++request.current
    setCatalog(value => ({ ...value, state: 'loading', error: null }))
    void client.taskAgentModels(full).then(value => {
      if (request.current !== current) return
      loaded.current = full ? 'full' : 'route'
      setCatalog({ state: 'ready', value, error: null, full })
    }, reason => {
      if (request.current === current) setCatalog(value => ({ ...value, state: 'error', error: message(reason) }))
    })
  }, [client])
  useEffect(() => () => { request.current += 1 }, [])
  // A fixed route shows every Provider's models; what was read already is not read again.
  const configuredMode = snapshot.value?.taskAgentModel?.mode === 'fixed' ? 'fixed' : 'inherit'
  useEffect(() => {
    if (configuredMode === 'fixed' ? loaded.current === 'full' : loaded.current !== 'none') return
    load(configuredMode === 'fixed')
  }, [configuredMode, load])
  // Choosing a fixed model before the full catalog arrived takes its first choices once it does.
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    if (!choosing) return
    if (catalog.state === 'error') { setChoosing(false); return }
    if (!catalog.full || catalog.value === null) return
    setChoosing(false)
    const start = startingRoute(catalog.value, saved)
    if (start !== undefined) writeRoute({ mode: 'fixed', ...start })
  }, [choosing, catalog, saved, writeRoute])
  const setMode = (mode: TaskAgentRoute['mode']): void => {
    if (mode === 'inherit') { setChoosing(false); writeRoute({ mode: 'inherit', provider: '', model: '' }); return }
    const start = catalog.full && catalog.value !== null ? startingRoute(catalog.value, saved) : undefined
    if (start !== undefined) { writeRoute({ mode: 'fixed', ...start }); return }
    setChoosing(true)
    load(true)
  }
  return {
    route: saved,
    catalog,
    choosing,
    failed,
    retry: () => { load(loaded.current === 'full') },
    setMode,
    setRoute: next => { writeRoute({ mode: 'fixed', ...next }) },
  }
}

/**
 * The task Agent model rows: the mode, the Provider and model a fixed route
 * uses, and the route the background work will actually take. A read that fails
 * keeps the reason on the page and offers to read again.
 */
export function TaskAgentModelRows(props: {
  mode: TaskAgentRoute['mode']
  route: TaskAgentRoute
  /** A fixed model was chosen and waits for the catalog to pick its first route. */
  choosing?: boolean | undefined
  catalog: TaskAgentModelCatalog | null
  state: TaskAgentCatalogState['state']
  error?: string | null | undefined
  disabled: boolean
  onMode: (mode: TaskAgentRoute['mode']) => void
  onRoute: (route: { provider: string; model: string }) => void
  /** Read the model directory again; without it a failed read only states its reason. */
  retry?: (() => void) | undefined
  /** An extra line under the effective route, such as which conversation it belongs to. */
  note?: ReactNode
  t: MnemonTranslate
}): JSX.Element {
  const { route, t } = props
  // Reading a route never needs the full directory, so the page stays usable while
  // that read is still out or has failed.
  const groups = props.state === 'ready' ? props.catalog?.groups ?? [] : []
  const group = groups.find(candidate => candidate.id === route.provider)
  // An inherited route is the catalog's effective one: the conversation's own
  // model when the page was opened from one, the DSH new-session default
  // otherwise. That default stays only as a hint when no route resolves at all.
  const inherited = props.catalog?.effective?.source === 'fixed'
    ? undefined
    : props.catalog?.effective ?? props.catalog?.defaultSelection
  // The two choosers need the directory: while it is out or failed the mode still
  // reads as chosen, but empty selects would only be noise.
  const fixed = props.mode === 'fixed' && props.state === 'ready'
  const effective = props.mode === 'fixed'
    ? (!fixed || route.provider === '' || route.model === '' ? undefined : { provider: route.provider, model: route.model })
    : inherited
  // A saved route the catalog no longer lists stays selectable, so it can be read and changed.
  // Two Providers by the same name are told apart by their ids.
  const shared = (name: string): boolean => groups.filter(candidate => candidate.name === name).length > 1
  const providers: SettingOption<string>[] = [
    ...(route.provider !== '' && group === undefined ? [{ value: route.provider, label: route.provider }] : []),
    ...groups.map(candidate => ({ value: candidate.id, label: candidate.name, ...(shared(candidate.name) ? { detail: candidate.id } : {}) })),
  ]
  const models: SettingOption<string>[] = [
    ...(route.model !== '' && group?.models.some(model => model.id === route.model) !== true ? [{ value: route.model, label: route.model }] : []),
    ...(group?.models ?? []).map(model => ({ value: model.id, label: model.name, ...(model.inputModalities?.includes('image') === true ? { detail: t('config.taskAgentImageInput') } : {}) })),
  ]
  const chooseProvider = (provider: string): void => {
    const model = groups.find(candidate => candidate.id === provider)?.models[0]?.id
    if (model !== undefined) props.onRoute({ provider, model })
  }
  return <>
    <SelectRow id="mnemon-task-agent" label={t('config.taskAgentTitle')} value={props.mode} disabled={props.disabled} onChange={props.onMode}
      options={[
        { value: 'inherit', label: t('config.taskAgentInherit'), detail: t('config.taskAgentInheritHint') },
        { value: 'fixed', label: t('config.taskAgentFixed'), detail: t('config.taskAgentFixedHint'), ...(props.state === 'unavailable' ? { disabled: true } : {}) },
      ]} />
    {fixed && <>
      <SelectRow id="mnemon-task-agent-provider" label={t('config.taskAgentProvider')} value={route.provider} disabled={props.disabled || props.state !== 'ready'} options={providers} onChange={chooseProvider} />
      <SelectRow id="mnemon-task-agent-model" label={t('config.taskAgentModel')} value={route.model} disabled={props.disabled || props.state !== 'ready' || group === undefined} options={models}
        onChange={model => props.onRoute({ provider: route.provider, model })} />
    </>}
    <div className={css.rowDetail}>
      <span className={css.effectiveRoute}>
        <span>{t('config.taskAgentEffective')}</span>
        {effective === undefined
          ? <small>{props.state === 'loading' || props.choosing === true ? t('config.taskAgentLoading') : t('config.taskAgentUnavailable')}</small>
          : <code>{effective.provider} / {effective.model}</code>}
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
