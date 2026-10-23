import { css, useT, type SourceKey } from './presentation.ts'
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { humanBytes, message, SidebarModal, useLocale } from 'dsh-mnemon/client'
import type { MemoryProviderChange, MemoryProviderDescriptor, MemoryProviderView, MemoryProviderViewEntry, MemoryProviderViewResult, MemorySpaceIntegration, MemorySpaceView } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'

type Translate = ReturnType<typeof useT>

function localized(t: Translate, key: string | undefined, fallback: string): string {
  if (key === undefined) return fallback
  const text = t(key as SourceKey)
  return text === key || text === '' ? fallback : text
}

/**
 * Whether the page suggests making the space read only for dsh-mnemon: the vendor's own plugin
 * captures into the same namespace on its own, and dsh-mnemon could still write there too.
 */
export function suggestsReadOnly(space: MemorySpaceView): boolean {
  const integration = space.integration
  return integration !== undefined && integration.sameNamespace === true && integration.automation.autoCapture !== false
    && integration.state !== 'unavailable' && space.writePolicy !== 'read-only' && space.provider.capabilities.remember
}

/** The suggestion and its one action; nothing changes until the user presses it. */
export function ReadOnlySuggestion(props: { onAccept: () => void; busy: boolean; error?: string | null }): JSX.Element {
  const t = useT()
  return <div className={css.integrationSuggestion} role="note">
    <p>{t('integration.suggestReadOnly')}</p>
    <button type="button" className={css.secondaryButton} disabled={props.busy} onClick={props.onAccept}>{props.busy ? t('integration.makingReadOnly') : t('integration.makeReadOnly')}</button>
    {props.error !== undefined && props.error !== null && <small role="alert">{props.error}</small>}
  </div>
}

function flag(t: Translate, value: boolean | undefined): string {
  return value === undefined ? t('integration.unknown') : value ? t('integration.on') : t('integration.off')
}

/** The vendor's own plugin, as the Provider reports it: what runs on its own, and where it connects. */
export function IntegrationCard(props: { integration: MemorySpaceIntegration; suggestion?: JSX.Element | undefined }): JSX.Element {
  const t = useT()
  const { integration } = props
  const connection = [integration.endpoint, [integration.account, integration.user].filter(Boolean).join(' / ')].filter(Boolean).join(' · ')
  return <section className={css.integrationCard} data-state={integration.state ?? 'active'} aria-label={t('integration.title', { label: integration.label })}>
    <header>
      <strong>{t('integration.title', { label: integration.label })}</strong>
      {integration.version !== undefined && <span className={css.categoryChip}>{integration.version}</span>}
      <code>{integration.packageName}</code>
    </header>
    <p>{integration.state === 'unavailable' ? t('integration.unavailable') : t('integration.runsOnItsOwn')}</p>
    <dl className={css.integrationFacts}>
      <div><dt>{t('integration.autoRecall')}</dt><dd>{flag(t, integration.automation.autoRecall)}</dd></div>
      <div><dt>{t('integration.autoCapture')}</dt><dd>{flag(t, integration.automation.autoCapture)}</dd></div>
      <div><dt>{t('integration.skipTaskAgents')}</dt><dd>{flag(t, integration.automation.skipSubagentSessions)}</dd></div>
      <div><dt>{t('integration.namespace')}</dt><dd>{integration.sameNamespace === undefined ? t('integration.unknown') : integration.sameNamespace ? t('integration.sameNamespace') : t('integration.otherNamespace')}</dd></div>
    </dl>
    {connection !== '' && <small className={css.integrationConnection}>{connection}</small>}
    {(integration.notes ?? []).map(note => <p key={note.id} className={css.integrationNote} data-tone={note.tone}>{localized(t, note.textI18nKey, note.text)}</p>)}
    {props.suggestion}
  </section>
}

/** One view read, again whenever what it depends on (`deps`, named by the caller) changes. */
function useViewLoad(load: () => Promise<MemoryProviderViewResult>, deps: readonly unknown[]): { result: MemoryProviderViewResult | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ result: MemoryProviderViewResult | null; error: string | null; loading: boolean }>({ result: null, error: null, loading: true })
  useEffect(() => {
    let active = true
    setState(current => ({ ...current, loading: true, error: null }))
    load().then(result => { if (active) setState({ result, error: null, loading: false }) })
      .catch(reason => { if (active) setState({ result: null, error: message(reason), loading: false }) })
    return () => { active = false }
  }, deps)
  return state
}

function when(locale: string, at: string | undefined): string | undefined {
  if (at === undefined) return undefined
  const time = new Date(at)
  return Number.isNaN(time.getTime()) ? at : time.toLocaleString(locale)
}

function FileEntry(props: { entry: MemoryProviderViewEntry; selected: boolean; onOpen: () => void }): JSX.Element {
  const locale = useLocale()
  const { entry } = props
  const meta = [entry.size === undefined ? undefined : humanBytes(entry.size), when(locale, entry.modifiedAt)].filter(Boolean).join(' · ')
  return <li><button type="button" className={css.providerViewEntry} data-directory={entry.directory || undefined} data-selected={props.selected || undefined} title={entry.uri} onClick={props.onOpen}>
    <span aria-hidden="true">{entry.directory ? '▸' : '·'}</span>
    <span><strong>{entry.name}</strong>{entry.summary !== undefined && <small>{entry.summary}</small>}</span>
    {meta !== '' && <em>{meta}</em>}
  </button></li>
}

function FilePreview(props: { file: Extract<MemoryProviderViewResult, { kind: 'file' }> }): JSX.Element {
  const t = useT()
  const { file } = props
  return <div className={css.providerViewPreview}>
    <header><strong>{file.name}</strong>{file.size !== undefined && <small>{humanBytes(file.size)}</small>}</header>
    {file.dataUrl !== undefined ? <img src={file.dataUrl} alt={file.name} />
      : file.text !== undefined ? <pre>{file.text}</pre>
        : <p>{file.truncated === true ? t('providerViews.previewTooLarge') : t('providerViews.previewUnavailable')}</p>}
    {file.text !== undefined && file.truncated === true && <small>{t('providerViews.truncated')}</small>}
  </div>
}

/** A hierarchy the Provider keeps: open a directory, preview a file, go back along the path. */
function FilesView(props: { load: (uri?: string) => Promise<MemoryProviderViewResult> }): JSX.Element {
  const t = useT()
  const [path, setPath] = useState<string[]>([])
  const [file, setFile] = useState<Extract<MemoryProviderViewResult, { kind: 'file' }> | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const location = path.at(-1)
  const listing = useViewLoad(() => props.load(location), [location, props.load])
  const opening = useRef(0)
  const open = async (entry: MemoryProviderViewEntry) => {
    if (entry.directory) { setFile(null); setFileError(null); setPath(current => [...current, entry.uri]); return }
    const request = ++opening.current
    setFileError(null)
    try {
      const result = await props.load(entry.uri)
      if (request !== opening.current) return
      if (result.kind === 'file') setFile(result)
      else if (result.kind === 'entries') setPath(current => [...current, entry.uri])
    } catch (reason) {
      if (request === opening.current) setFileError(message(reason))
    }
  }
  const entries = listing.result?.kind === 'entries' ? listing.result.entries : []
  return <div className={css.providerViewFiles}>
    <nav className={css.providerViewPath} aria-label={t('providerViews.path')}>
      <button type="button" disabled={path.length === 0} onClick={() => { setFile(null); setPath([]) }}>{t('providerViews.top')}</button>
      {path.map((uri, index) => <button type="button" key={uri} disabled={index === path.length - 1} title={uri} onClick={() => { setFile(null); setPath(current => current.slice(0, index + 1)) }}>{uri.split('/').pop() || uri}</button>)}
    </nav>
    <div className={css.providerViewBody} data-previewing={file !== null || undefined}>
      <div>
        {listing.error !== null && <div className={css.inlineError} role="alert">{listing.error}</div>}
        {listing.loading ? <p className={css.providerViewNote}>{t('providerViews.loading')}</p>
          : entries.length === 0 && listing.error === null ? <p className={css.providerViewNote}>{t('providerViews.empty')}</p>
            : <ul className={css.providerViewEntries}>{entries.map(entry => <FileEntry key={entry.uri} entry={entry} selected={file?.uri === entry.uri} onOpen={() => void open(entry)} />)}</ul>}
        {listing.result?.kind === 'entries' && listing.result.truncated === true && <p className={css.providerViewNote}>{t('providerViews.truncated')}</p>}
      </div>
      {fileError !== null && <div className={css.inlineError} role="alert">{fileError}</div>}
      {file !== null && <FilePreview file={file} />}
    </div>
  </div>
}

function operationLabel(t: Translate, action: MemoryProviderChange['operations'][number]['action']): string {
  return action === 'add' ? t('providerViews.changeAdd') : action === 'update' ? t('providerViews.changeUpdate') : t('providerViews.changeDelete')
}

/** What the Provider itself changed, newest first; each change opens to its before and after. */
function ChangesView(props: { load: () => Promise<MemoryProviderViewResult> }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const listing = useViewLoad(props.load, [props.load])
  const [open, setOpen] = useState<string | null>(null)
  const changes = listing.result?.kind === 'changes' ? listing.result.changes : []
  if (listing.loading) return <p className={css.providerViewNote}>{t('providerViews.loading')}</p>
  return <div className={css.providerViewChanges}>
    {listing.error !== null && <div className={css.inlineError} role="alert">{listing.error}</div>}
    {changes.length === 0 && listing.error === null && <p className={css.providerViewNote}>{t('providerViews.changesEmpty')}</p>}
    <ul>{changes.map(change => {
      const counts = (['add', 'update', 'delete'] as const).map(action => [action, change.operations.filter(operation => operation.action === action).length] as const).filter(([, count]) => count > 0)
      return <li key={change.id} data-open={open === change.id || undefined}>
        <button type="button" aria-expanded={open === change.id} onClick={() => setOpen(current => current === change.id ? null : change.id)}>
          <strong>{when(locale, change.at) ?? change.id}</strong>
          {change.origin !== undefined && <small title={change.id}>{t('providerViews.changeOrigin', { origin: change.origin })}</small>}
          <span>{counts.map(([action, count]) => <em key={action} data-action={action}>{operationLabel(t, action)} {count}</em>)}{change.skipped !== undefined && <em>{t('providerViews.changeSkipped', { count: change.skipped })}</em>}</span>
        </button>
        {open === change.id && <ol>{change.operations.map((operation, index) => <li key={`${operation.uri}-${index}`}>
          <header><em data-action={operation.action}>{operationLabel(t, operation.action)}</em><code title={operation.uri}>{operation.uri}</code></header>
          {operation.before !== undefined && <div><small>{t('providerViews.before')}</small><pre>{operation.before}</pre></div>}
          {operation.after !== undefined && <div><small>{t('providerViews.after')}</small><pre>{operation.after}</pre></div>}
        </li>)}</ol>}
      </li>
    })}</ul>
    {listing.result?.kind === 'changes' && listing.result.truncated === true && <p className={css.providerViewNote}>{t('providerViews.truncated')}</p>}
  </div>
}

/**
 * What a space's Provider keeps beyond its memories, in the views it declares, and the vendor's
 * own plugin when one runs beside it. Reads only; the one action is the read-only suggestion.
 */
export function ProviderViewsDialog(props: {
  client: MemorySpacesPageClient
  space: MemorySpaceView
  descriptor: MemoryProviderDescriptor | undefined
  suggestion?: JSX.Element | undefined
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const views = props.descriptor?.views ?? []
  const [viewId, setViewId] = useState<string | undefined>(views[0]?.id)
  const view: MemoryProviderView | undefined = views.find(candidate => candidate.id === viewId)
  const { client, space } = props
  const load = useCallback((uri?: string) => {
    if (client.providerView === undefined || view === undefined) return Promise.reject(new Error(t('providerViews.unavailable')))
    return client.providerView(space.id, { view: view.id, ...(uri === undefined ? {} : { uri }) })
  }, [client, space.id, view, t])
  return <SidebarModal title={space.name} description={t('providerViews.dialogDescription', { provider: space.provider.label })} wide onClose={props.onClose}>
    <div className={css.providerViews}>
      {space.integration !== undefined && <IntegrationCard integration={space.integration} suggestion={props.suggestion} />}
      {views.length > 0 && <div className={css.providerViewTabs} role="tablist" aria-label={t('providerViews.tabs')}>
        {views.map(candidate => <button key={candidate.id} type="button" role="tab" aria-selected={candidate.id === viewId} data-active={candidate.id === viewId || undefined} onClick={() => setViewId(candidate.id)}>{localized(t, candidate.labelI18nKey, candidate.label)}</button>)}
      </div>}
      {view?.kind === 'files' && <FilesView key={view.id} load={load} />}
      {view?.kind === 'changes' && <ChangesView key={view.id} load={load} />}
    </div>
  </SidebarModal>
}
