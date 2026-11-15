import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import {
  Button, IconChecklistOutlineRegular, IconCodeOutlineRegular, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular, IconGlobeOutlineRegular,
  IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SearchField, SelectField, SidebarModal, useLocale } from 'dsh-mnemon/client'
import { SKILL_ROOT_KINDS, type LocalizedText, type MarketAudit, type MarketItem, type MarketPreview, type MarketRegistry, type MarketSearchResult, type MarketView, type SkillRootKind } from '../contracts.ts'
import { splitFrontmatter } from '../fence.ts'
import { detectSource, type DetectedSource } from '../source-kind.ts'
import { compactCount, css, errorText, relative, supportsSettingsSection, useT, type SkillsTranslate } from './presentation.ts'
import { Busy, Clamp, Empty, MoreMenu, SkillIcon, SkillMarkdown } from './shared.tsx'
import type { SkillsLocation, SkillsPageContext } from './ui.tsx'

function text(value: LocalizedText | undefined, language: string): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return (language.startsWith('zh') ? value['zh-CN'] ?? value.en : value.en ?? value['zh-CN']) ?? ''
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** One field of a `SKILL.md` frontmatter, plain or folded, without a YAML parser in the page. */
function frontmatterField(content: string, key: string): string | undefined {
  const split = splitFrontmatter(content)
  if (split === undefined) return undefined
  const lines = split.frontmatter.split(/\r?\n/u)
  const index = lines.findIndex(line => line.startsWith(`${key}:`))
  if (index === -1) return undefined
  const first = lines[index]!.slice(key.length + 1).trim()
  if (/^[>|][+-]?$/u.test(first)) {
    const block: string[] = []
    for (const line of lines.slice(index + 1)) { if (!/^\s/u.test(line)) break; block.push(line.trim()) }
    return block.join(' ').trim() || undefined
  }
  return first.replace(/^(['"])(.*)\1$/u, '$2').trim() || undefined
}

const STATE_TONE = { installed: 'success', update: 'info', modified: 'warning', conflict: 'quiet', available: 'outline' } as const
const SEARCH_DELAY_MS = 300

/** The id a market skill is previewed and installed by: its index id when a search found it. */
function itemKey(item: MarketItem): string {
  return item.source.type === 'indexed' ? item.source.id : item.name
}

interface RemoteState {
  query: string
  result?: MarketSearchResult
  loading: boolean
}

export function MarketPage(props: { context: SkillsPageContext; location: SkillsLocation }): JSX.Element {
  const t = useT()
  const language = useLocale()
  const { context } = props
  const [view, setView] = useState<MarketView | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [open, setOpen] = useState<MarketItem | null>(null)
  const [remote, setRemote] = useState<RemoteState>({ query: '', loading: false })
  const [adding, setAdding] = useState(false)
  const refreshed = useRef(false)
  useEffect(() => {
    let active = true
    void context.client.market().then(value => {
      if (!active) return
      setView(value)
      // A source copy older than the refresh window is fetched once per visit.
      if (!refreshed.current && value.stale.length > 0 && context.writable) {
        refreshed.current = true
        setRefreshing(true)
        void context.client.refreshMarket(value.stale).then(() => context.client.market()).then(next => { if (active) setView(next) }).catch(() => undefined).finally(() => { if (active) setRefreshing(false) })
      }
    }).catch(context.fail)
    return () => { active = false }
  }, [context.client, context.revision])
  const needle = query.trim()
  const index = view?.registries.find(registry => registry.kind === 'search' && registry.enabled)
  // The search index answers as the user types, a moment after they stop.
  useEffect(() => {
    if (needle.length < 2 || index === undefined) { setRemote({ query: '', loading: false }); return }
    let active = true
    setRemote(current => ({ ...current, loading: true }))
    const timer = setTimeout(() => {
      void context.client.searchMarket(needle)
        .then(result => { if (active) setRemote({ query: needle, result, loading: false }) })
        .catch(reason => { if (active) setRemote({ query: needle, result: { query: needle, items: [], error: errorText(reason) }, loading: false }) })
    }, SEARCH_DELAY_MS)
    return () => { active = false; clearTimeout(timer) }
  }, [needle, index?.id, context.client, context.revision])
  const items = useMemo(() => {
    const lower = needle.toLowerCase()
    return (view?.items ?? []).filter(item => (category === '' || item.category === category)
      && (lower === '' || [item.name, text(item.title, language), text(item.description, language), item.author ?? ''].some(value => value.toLowerCase().includes(lower))))
  }, [view, needle, category, language])
  // A pasted repository, URL or path can become a source right from the search box.
  const detected = useMemo(() => {
    const found = detectSource(query)
    if (found === undefined || (found.kind !== 'github' && !/^(?:https?:\/\/|\/|[A-Za-z]:[\\/])/u.test(needle))) return undefined
    return view?.registries.some(registry => registry.location === found.location) === true ? undefined : found
  }, [query, needle, view])
  if (view === null) return <Busy label={t('common.loading')} />
  const registryName = (id: string) => sourceName(view.registries.find(registry => registry.id === id), language, t) || id
  const refresh = async () => {
    setRefreshing(true)
    try { await context.client.refreshMarket(); context.refresh() } catch (error) { context.fail(error) } finally { setRefreshing(false) }
  }
  const addDetected = async (source: DetectedSource) => {
    setAdding(true)
    try {
      const added = await context.client.addRegistry(source.location)
      context.notice(t('sources.added', { name: sourceName(added, language, t), count: added.entries }))
      setQuery('')
      context.refresh()
    } catch (error) { context.fail(error) } finally { setAdding(false) }
  }
  const searching = needle.length >= 2 && index !== undefined
  const remoteItems = remote.result?.items ?? []
  const card = (item: MarketItem, position: number) => <MarketCard key={`${item.registryId}/${itemKey(item)}`} item={item} position={position} language={language} writable={context.writable}
    footnote={item.source.type === 'indexed' ? undefined : item.author ?? registryName(item.registryId)} onOpen={() => setOpen(item)} />
  return <div className={css.skMarket}>
    <header className={css.skMarketBar}>
      <SearchField label={t('market.search')} placeholder={t('market.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
      {view.categories.length > 0 && <SelectField size="sm" hideLabel label={t('market.category')} value={category} onChange={setCategory} options={[{ value: '', label: t('market.allCategories') }, ...view.categories.map(entry => ({ value: entry.id, label: text(entry.label, language) }))]} />}
      <Button variant="ghost" size="sm" onClick={() => { if (context.openSettings !== undefined && supportsSettingsSection('market')) context.openSettings('market'); else setSourcesOpen(true) }}>{t('market.sources', { count: view.registries.filter(registry => registry.enabled).length })}</Button>
      <button type="button" className={css.skIconButton} disabled={refreshing || !context.writable} data-busy={refreshing ? '' : undefined} onClick={() => void refresh()} aria-label={t('market.refresh')} title={t('market.refresh')}><IconRefreshOutlineRegular size={16} /></button>
    </header>
    {detected !== undefined && <div className={css.skMarketAdd}>
      <SourceIcon kind={detected.kind} />
      <span>{t('market.addAsSource', { kind: t(`sources.detected.${detected.kind}`), label: detected.label })}</span>
      <Button variant="primary" size="sm" disabled={adding || !context.writable} onClick={() => void addDetected(detected)}>{adding ? t('sources.adding') : t('sources.addAs')}</Button>
    </div>}
    {searching
      ? <>
          {items.length > 0 && <section className={css.skMarketSection}>
            <h6 className={css.skCaption}>{t('market.listed', { count: items.length })}</h6>
            <div className={css.skMarketGrid}>{items.map(card)}</div>
          </section>}
          <section className={css.skMarketSection} aria-busy={remote.loading || undefined}>
            <h6 className={css.skCaption}>{t('market.indexed', { count: remoteItems.length })}</h6>
            {remote.result === undefined
              ? <Busy label={t('market.searching')} />
              : remote.result.error !== undefined
                ? <p className={css.skMuted}>{t('market.searchFailed', { error: remote.result.error })}</p>
                : remoteItems.length === 0
                  ? <p className={css.skMuted}>{t('market.indexEmpty')}</p>
                  : <div className={css.skMarketGrid} data-busy={remote.loading ? '' : undefined}>{remoteItems.map(card)}</div>}
          </section>
        </>
      : items.length === 0
        ? <Empty glyph="⌕" title={t('market.empty')}>{t('market.emptyBody')}</Empty>
        : <div className={css.skMarketGrid}>{items.map(card)}</div>}
    {open !== null && <MarketDetail context={context} item={open} registryName={registryName(open.registryId)} onClose={() => setOpen(null)} />}
    {sourcesOpen && <SourcesDialog context={context} view={view} onClose={() => setSourcesOpen(false)} />}
  </div>
}

/** One skill of the market: what it is, where it comes from, and installing it or its state. */
function MarketCard(props: { item: MarketItem; position: number; language: string; writable: boolean; footnote: string | undefined; onOpen: () => void }): JSX.Element {
  const t = useT()
  const { item } = props
  const indexed = item.source.type === 'indexed'
  const title = text(item.title, props.language) || item.name
  return <article className={css.skMarketCard} data-state={item.state} data-indexed={indexed ? '' : undefined} style={{ animationDelay: `${Math.min(props.position, 12) * 18}ms` }}>
    <button type="button" className={css.skMarketOpen} onClick={props.onOpen} aria-label={t('market.preview', { name: item.name })}>
      <header>
        <SkillIcon name={item.name} category={item.category} />
        <div><strong>{title}</strong><code>{indexed ? item.origin : item.name}</code></div>
      </header>
      {!indexed && <p>{text(item.description, props.language)}</p>}
    </button>
    <footer>
      {indexed
        ? <span className={css.skMarketStat}><IconDownloadOutlineRegular size={12} />{t('market.installs', { count: compactCount(item.installs ?? 0, props.language) })}</span>
        : <span>{props.footnote}</span>}
      {item.state === 'available'
        ? <Button variant="outline" size="sm" disabled={!props.writable} onClick={props.onOpen}>{t('market.install')}</Button>
        : <Tag tone={STATE_TONE[item.state]}>{t(`market.state.${item.state}`)}</Tag>}
    </footer>
  </article>
}

/** Reviewers' verdicts on a skill, worst first, each a dot and the reviewer's name. */
function Audits(props: { audits: readonly MarketAudit[] }): JSX.Element | null {
  const t = useT()
  if (props.audits.length === 0) return null
  const rank = { fail: 0, warn: 1, pass: 2 } as const
  const sorted = [...props.audits].sort((a, b) => rank[a.status] - rank[b.status])
  const concern = sorted.find(audit => audit.status !== 'pass' && audit.summary !== undefined)
  return <div className={css.skAudits}>
    <div>
      <span className={css.skAuditsLabel}>{t('market.audits')}</span>
      {sorted.map(audit => <span key={audit.provider} className={css.skAudit} data-status={audit.status} title={audit.summary}>{t(`market.audit.${audit.status}`)}<small>{audit.provider}</small></span>)}
    </div>
    {concern?.summary !== undefined && <Clamp text={concern.summary} lines={2} />}
  </div>
}

function MarketDetail(props: { context: SkillsPageContext; item: MarketItem; registryName: string; onClose: () => void }): JSX.Element {
  const t = useT()
  const language = useLocale()
  const { context, item } = props
  const indexed = item.source.type === 'indexed'
  const [preview, setPreview] = useState<MarketPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [root, setRoot] = useState<SkillRootKind>('user-dsh')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void context.client.marketPreview(item.registryId, itemKey(item)).then(value => { if (active) setPreview(value) }).catch(reason => { if (active) setPreviewError(errorText(reason)) })
    return () => { active = false }
  }, [context.client, item.registryId, item.name])
  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await context.client.installMarket({ registryId: item.registryId, name: itemKey(item), root, ...(item.state === 'modified' ? { overwrite: true } : {}) })
      context.notice(t(result.updated ? 'market.updated' : 'market.installed', { name: result.skill.name }))
      context.refresh()
      props.onClose()
    } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  const canInstall = item.state === 'available' || item.state === 'update' || item.state === 'modified'
  const body = preview === null ? undefined : splitFrontmatter(preview.content)?.body ?? preview.content
  const description = text(item.description, language) || (preview === null ? '' : frontmatterField(preview.content, 'description') ?? '')
  const license = item.license ?? (preview === null ? undefined : frontmatterField(preview.content, 'license'))
  const meta: ReactNode[] = [
    <span key="from">{indexed ? item.origin : props.registryName}</span>,
    ...(item.version === undefined ? [] : [<span key="version">{t('market.version', { version: item.version })}</span>]),
    ...(item.installedVersion === undefined ? [] : [<span key="installed">{t('market.installedVersion', { version: item.installedVersion })}</span>]),
    <span key="license">{license ?? t('market.upstreamLicense')}</span>,
    ...(item.installs === undefined ? [] : [<span key="installs">{t('market.installs', { count: compactCount(item.installs, language) })}</span>]),
  ]
  const homepage = preview?.homepage ?? item.homepage
  return <SidebarModal wide title={text(item.title, language) || item.name} description={description} busy={busy} onClose={props.onClose} footer={<>
    {error !== null && <span className={css.skFormError}>{error}</span>}
    {item.state === 'available' && <SelectField size="sm" inline label={t('market.installTo')} value={root} onChange={setRoot} options={SKILL_ROOT_KINDS.map(kind => ({ value: kind, label: t(`root.${kind}`) }))} />}
    {item.skillKey !== undefined && <Button variant="ghost" onClick={() => { props.onClose(); context.navigate({ tab: 'skills', skillKey: item.skillKey! }) }}>{t('market.open')}</Button>}
    <Button variant="ghost" onClick={props.onClose}>{t('common.close')}</Button>
    {canInstall && <Button variant="primary" disabled={busy || !context.writable || (preview === null && previewError === null)} onClick={() => void install()}>
      {busy ? t('market.installing') : t(item.state === 'modified' ? 'market.overwrite' : item.state === 'update' ? 'market.update' : 'market.install')}
    </Button>}
  </>}>
    <div className={css.skMarketDetail}>
      <div className={css.skMarketMeta}>
        <span className={css.skMeta}>{meta}</span>
        {homepage !== undefined && <a className={css.skLink} href={homepage} target="_blank" rel="noreferrer">{t('market.viewSource')} ↗</a>}
      </div>
      {preview?.audits !== undefined && <Audits audits={preview.audits} />}
      <p className={css.skWarn}>{item.state === 'modified' ? t('market.overwriteHint') : t('market.trust')}</p>
      {previewError !== null && <p className={css.inlineError}>{previewError}</p>}
      {preview === null && previewError === null && <Busy label={t('common.loading')} />}
      {preview !== null && <>
        {preview.partial === true && <p className={css.skMuted}>{t('market.partial')}</p>}
        {preview.files.length > 1 && <details className={css.skProblems}>
          <summary>{t('market.files', { count: preview.files.length, size: size(preview.totalBytes) })}</summary>
          <div className={css.skResources}>{preview.files.slice(0, 40).map(file => <code key={file.path}>{file.path}</code>)}</div>
        </details>}
        <SkillMarkdown body={body ?? ''} />
      </>}
    </div>
  </SidebarModal>
}

const KIND_ICON: Record<DetectedSource['kind'] | MarketRegistry['kind'], (size: number) => JSX.Element> = {
  catalog: size => <IconChecklistOutlineRegular size={size} />,
  json: size => <IconFolderOpenOutlineRegular size={size} />,
  github: size => <IconCodeOutlineRegular size={size} />,
  'well-known': size => <IconGlobeOutlineRegular size={size} />,
  search: size => <IconSearchOutlineRegular size={size} />,
}

function SourceIcon(props: { kind: DetectedSource['kind'] | MarketRegistry['kind'] }): JSX.Element {
  return <span className={css.skSourceIcon} aria-hidden="true">{KIND_ICON[props.kind](16)}</span>
}

/** How the page names a source: the built-in ones by role, the rest by what they call themselves, else where they live. */
function sourceName(registry: MarketRegistry | undefined, language: string, t: SkillsTranslate): string {
  if (registry === undefined) return ''
  if (registry.kind === 'search') return 'skills.sh'
  if (registry.builtin) return t('sources.featured')
  return text(registry.name, language) || registry.location.replace(/^https?:\/\/(?:github\.com\/)?/u, '')
}

/** One line on a source: what kind it is, how many skills, how fresh; or why it failed. */
function sourceMeta(t: SkillsTranslate, registry: MarketRegistry): string {
  if (registry.kind === 'search') return t('sources.searchMeta')
  return [
    t(`sources.kind.${registry.kind}`),
    t('sources.entries', { count: registry.entries }),
    ...(registry.fetchedAt === undefined ? [] : [t('sources.updated', { time: relative(t, registry.fetchedAt) })]),
  ].join(' · ')
}

/**
 * The market's sources: the built-in catalog and search index, and the ones
 * added — each with a switch, refreshed or removed from its menu — and one
 * field that adds a repository, a site or a JSON file, saying what it read.
 */
function SourcesDialog(props: { context: SkillsPageContext; view: MarketView; onClose: () => void }): JSX.Element {
  const t = useT()
  const language = useLocale()
  const { context } = props
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const detected = useMemo(() => detectSource(input), [input])
  const duplicate = detected !== undefined && props.view.registries.some(registry => registry.location === detected.location)
  const act = async (key: string, operation: () => Promise<unknown>, after?: () => void) => {
    setBusy(key)
    setError(null)
    try { await operation(); after?.(); context.refresh() } catch (reason) { setError(errorText(reason)) } finally { setBusy(null) }
  }
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (detected === undefined || duplicate) return
    void act('add', async () => {
      const added = await context.client.addRegistry(detected.location)
      context.notice(t('sources.added', { name: sourceName(added, language, t), count: added.entries }))
    }, () => setInput(''))
  }
  const hint = input.trim() === '' ? t('sources.hint')
    : detected === undefined ? t('sources.unknown')
      : duplicate ? t('sources.duplicate')
        : `${t(`sources.detected.${detected.kind}`)} · ${detected.label}`
  return <SidebarModal wide title={t('sources.title')} busy={busy !== null} onClose={props.onClose} footer={<>
    {error !== null && <span className={css.skFormError}>{error}</span>}
    <Button variant="primary" onClick={props.onClose}>{t('sources.done')}</Button>
  </>}>
    <div className={css.skSources}>
      <ul className={css.skSourceList}>
        {props.view.registries.map(registry => <li key={registry.id} data-off={registry.enabled ? undefined : ''}>
          <SourceIcon kind={registry.kind} />
          <div className={css.skSourceText}>
            <strong title={registry.location}><span>{sourceName(registry, language, t)}</span>{registry.builtin && <Tag tone="quiet">{t('sources.builtin')}</Tag>}</strong>
            {registry.error !== undefined ? <em title={registry.error}>{registry.error}</em> : <small>{sourceMeta(t, registry)}</small>}
          </div>
          <div className={css.skSourceActions}>
            {registry.kind !== 'search' && <MoreMenu label={t('common.more')} disabled={busy !== null || !context.writable}
              items={[{ id: 'refresh', label: t('sources.refresh') }, ...(registry.builtin ? [] : [{ id: 'remove', label: t('sources.remove'), danger: true }])]}
              onSelect={id => void act(registry.id, () => id === 'refresh' ? context.client.refreshMarket([registry.id]) : context.client.removeRegistry(registry.id))} />}
            <Switch checked={registry.enabled} label={t('sources.enabled', { name: sourceName(registry, language, t) })} disabled={busy !== null || !context.writable}
              onChange={next => void act(registry.id, () => context.client.toggleRegistry(registry.id, next))} />
          </div>
        </li>)}
      </ul>
      <form className={css.skSourceAdd} onSubmit={add}>
        <label htmlFor="skills-source-input">{t('sources.addTitle')}</label>
        <div className={css.skInline}>
          <Input id="skills-source-input" value={input} placeholder={t('sources.placeholder')} autoComplete="off" spellCheck={false} disabled={!context.writable}
            {...(detected === undefined ? {} : { icon: KIND_ICON[detected.kind](16) })} onChange={event => setInput(event.target.value)} />
          <Button type="submit" variant="primary" size="sm" disabled={detected === undefined || duplicate || busy !== null || !context.writable}>{busy === 'add' ? t('sources.adding') : t('sources.add')}</Button>
        </div>
        <p className={css.skSourceHint} data-state={input.trim() === '' ? undefined : detected === undefined || duplicate ? 'warn' : 'ok'} aria-live="polite">{hint}</p>
      </form>
      <details className={css.skFormat}>
        <summary>{t('sources.formats')}</summary>
        <ul>
          {(['github', 'well-known', 'catalog'] as const).map(kind => <li key={kind}><SourceIcon kind={kind} /><div><strong>{t(`sources.kind.${kind}`)}</strong><span>{t(`sources.format.${kind}`)}</span></div></li>)}
        </ul>
      </details>
    </div>
  </SidebarModal>
}
