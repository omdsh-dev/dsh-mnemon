import { useEffect, useMemo, useState, type JSX } from 'react'
import { Button, DiffBlock, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { SearchField, SelectField, SidebarModal } from 'dsh-mnemon/client'
import { SKILL_ROOT_KINDS, type CatalogView, type SkillDocument, type SkillInvocation, type SkillRootKind, type SkillSummary, type SkillVersion } from '../contracts.ts'
import { css, errorText, points, stamp, useT } from './presentation.ts'
import { Busy, Confirm, diffLabels, Empty, Field, Fold, FoldLink, MoreMenu, SkillIcon, SkillMarkdown, useLink } from './shared.tsx'
import type { SkillsLocation, SkillsPageContext } from './ui.tsx'

type Stats = CatalogView['stats'][string] | undefined

export function SkillsPage(props: { context: SkillsPageContext; location: SkillsLocation }): JSX.Element {
  const t = useT()
  const { context, location } = props
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | undefined>(location.skillKey)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    let active = true
    void context.client.catalog().then(value => {
      if (!active) return
      setCatalog(value)
      setSelected(current => current !== undefined && value.skills.some(skill => skill.key === current) ? current : value.skills.find(skill => skill.shadowedBy === undefined)?.key)
    }).catch(context.fail)
    return () => { active = false }
  }, [context.client, context.revision])
  // A link names a skill by key, or by name for the one DSH loads.
  useLink(location.nonce, catalog !== null, () => {
    if (location.skillKey !== undefined) setSelected(location.skillKey)
    else if (location.skillName !== undefined) {
      const named = catalog?.skills.find(skill => skill.name === location.skillName && skill.shadowedBy === undefined)
      if (named !== undefined) setSelected(named.key)
    }
  })
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (catalog?.skills ?? []).filter(skill => needle === '' || skill.name.includes(needle) || skill.description.toLowerCase().includes(needle))
  }, [catalog, query])
  if (catalog === null) return <Busy label={t('common.loading')} />
  const groups = catalog.roots.map(root => ({ root, skills: visible.filter(skill => skill.root === root.kind) }))
  const current = catalog.skills.find(skill => skill.key === selected)
  return <div className={`${css.skSplit} ${css.skSkillsSplit}`}>
    <aside className={css.skList}>
      <header className={css.skListBar}>
        <SearchField label={t('skills.search')} placeholder={t('skills.search')} value={query} onChange={event => setQuery(event.target.value)} />
        <Button variant="outline" size="sm" disabled={!context.writable} onClick={() => setCreating(true)}>{t('skills.new')}</Button>
      </header>
      {catalog.skills.length > 0 && visible.length === 0 && <p className={css.skListNote}>{t('skills.noMatch')}</p>}
      {groups.filter(group => group.skills.length > 0).map(group => <section key={group.root.kind} className={css.skListGroup}>
        <h5 title={group.root.path}>{t(`root.${group.root.kind}`)}</h5>
        {group.skills.map(skill => <SkillRow key={skill.key} context={context} skill={skill} stats={catalog.stats[skill.name]} selected={selected === skill.key} onSelect={() => setSelected(skill.key)} />)}
      </section>)}
      {catalog.problems.length > 0 && <details className={css.skProblems}>
        <summary>{t('skills.problems', { count: catalog.problems.length })}</summary>
        <ul>{catalog.problems.map(problem => <li key={problem.path}><code title={problem.path}>{problem.path.split(/[\\/]/u).slice(-2).join('/')}</code><span>{problem.reason}</span></li>)}</ul>
      </details>}
    </aside>
    <div className={css.skPane} key={current?.key ?? 'empty'}>
      {catalog.skills.length === 0
        ? <Empty glyph="✦" title={t('skills.empty')} action={<>
            <Button variant="primary" size="sm" disabled={!context.writable} onClick={() => setCreating(true)}>{t('skills.new')}</Button>
            <Button variant="outline" size="sm" onClick={() => context.navigate({ tab: 'market' })}>{t('skills.browseMarket')}</Button>
          </>}>{t('skills.emptyBody')}</Empty>
        : current === undefined
          ? <Empty glyph="✦" title={t('skills.select')}>{t('skills.selectBody')}</Empty>
          : <SkillDetail key={current.key} context={context} skillKey={current.key} stats={catalog.stats[current.name]} onDeleted={() => setSelected(undefined)} />}
    </div>
    {creating && <CreateDialog context={context} roots={catalog.roots.map(root => root.kind)} onClose={() => setCreating(false)} onCreated={skill => { setCreating(false); setSelected(skill.key); context.refresh() }} />}
  </div>
}

/** What a skill's two DSH switches allow, as one choice. */
type Invocation = 'both' | 'slash' | 'model' | 'off'

function invocationOf(value: SkillInvocation): Invocation {
  return value.modelInvocable && value.userInvocable ? 'both' : value.userInvocable ? 'slash' : value.modelInvocable ? 'model' : 'off'
}

function switchesOf(value: Invocation): SkillInvocation {
  return { modelInvocable: value === 'both' || value === 'model', userInvocable: value === 'both' || value === 'slash' }
}

/**
 * One skill: its icon, name and description open it; "Use" (on hover or
 * focus) brings it into the conversation; the switch turns it on or off for
 * both the model and the / menu.
 */
function SkillRow(props: { context: SkillsPageContext; skill: SkillSummary; stats: Stats; selected: boolean; onSelect: () => void }): JSX.Element {
  const t = useT()
  const { skill, stats, context } = props
  const [busy, setBusy] = useState(false)
  const invocation = invocationOf(skill.invocation)
  const on = invocation !== 'off'
  const toggle = async (next: boolean) => {
    setBusy(true)
    try { await context.client.setInvocation(skill.key, switchesOf(next ? 'both' : 'off'), skill.hash); context.refresh() } catch (error) { context.fail(error) } finally { setBusy(false) }
  }
  const usable = on && skill.shadowedBy === undefined && skill.invocation.userInvocable
  return <div className={css.skRow} data-selected={props.selected ? '' : undefined} data-shadowed={skill.shadowedBy === undefined ? undefined : ''} data-off={on ? undefined : ''}>
    <button type="button" className={css.skRowMain} onClick={props.onSelect}>
      <SkillIcon name={skill.name} />
      <span className={css.skRowText}>
        <strong>
          <span>{skill.name}</span>
          {skill.shadowedBy === undefined && (stats?.open ?? 0) > 0 && <i className={css.skDot} title={t('skills.waitingCount', { count: stats!.open })} />}
          {skill.readOnly && <Tag tone="quiet">{t('skills.linked')}</Tag>}
          {skill.shadowedBy !== undefined ? <Tag tone="quiet">{t('skills.shadowed')}</Tag> : on && invocation !== 'both' && <Tag tone="outline">{t(`invocation.${invocation}Short`)}</Tag>}
        </strong>
        <small>{skill.description}</small>
      </span>
    </button>
    <div className={css.skRowActions}>
      {usable && <Button variant="outline" size="sm" className={css.skUse} title={t('skills.useHint', { name: skill.name })} onClick={() => context.useSkill(skill.name)}>{t('skills.use')}</Button>}
      <Switch checked={on} label={t('skills.toggle', { name: skill.name })} disabled={busy || !context.writable || skill.readOnly === true} onChange={next => void toggle(next)} />
    </div>
  </div>
}

function SkillDetail(props: { context: SkillsPageContext; skillKey: string; stats: Stats; onDeleted: () => void }): JSX.Element {
  const t = useT()
  const { context, stats } = props
  const [skill, setSkill] = useState<(SkillDocument & { versions: SkillVersion[] }) | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [improving, setImproving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [comparing, setComparing] = useState<{ version: SkillVersion; content: string } | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    void context.client.skill(props.skillKey).then(value => { if (active) setSkill(value) }).catch(context.fail)
    return () => { active = false }
  }, [context.client, props.skillKey, context.revision, reload])
  if (skill === null) return <Busy label={t('common.loading')} />
  const write = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    try { await operation(); setReload(value => value + 1); context.refresh() } catch (error) { context.fail(error) } finally { setBusy(false) }
  }
  const invocation = invocationOf(skill.invocation)
  const usable = invocation !== 'off' && skill.shadowedBy === undefined && skill.invocation.userInvocable
  const testsMeta = [t('tests.count', { count: stats?.cases ?? 0 }), ...(stats?.lastScore === undefined ? [] : [t('tests.lastScore', { score: points(stats.lastScore) })])].join(' · ')
  const more = [
    ...(context.client.canAssist('skill-draft') ? [{ id: 'improve', label: t('skills.improve'), disabled: !context.writable || skill.readOnly === true }] : []),
    { id: 'remove', label: t('skills.remove'), danger: true, disabled: !context.writable },
  ]
  return <article className={css.skDetail}>
    <header className={css.skDetailHead}>
      <div>
        <h3>{skill.name}</h3>
        <p>{skill.description}</p>
        <span className={css.skMeta}><span>{t(`root.${skill.root}`)}</span><code title={skill.path}>{skill.path}</code></span>
      </div>
      <div className={css.skDetailActions}>
        {usable && <Button variant="outline" size="sm" onClick={() => context.useSkill(skill.name)}>{t('skills.use')}</Button>}
        <Button variant="outline" size="sm" disabled={!context.writable || busy || skill.readOnly === true} onClick={() => setEditing(skill.content)}>{t('common.edit')}</Button>
        <MoreMenu label={t('common.more')} items={more} onSelect={id => id === 'improve' ? setImproving(true) : setDeleting(true)} />
      </div>
    </header>
    {skill.readOnly && <p className={css.skWarn}>{t('skills.linkedReadOnly')}</p>}
    {skill.shadowedBy === undefined && (stats?.open ?? 0) > 0 && <button type="button" className={css.skCallout} onClick={() => context.navigate({ tab: 'evolution', filter: 'pending', skillName: skill.name })}>
      <span>{t('skills.waitingCount', { count: stats!.open })}</span><b>{t('common.view')} ›</b>
    </button>}
    {skill.shadowedBy !== undefined && <p className={css.skWarn}>{t('skills.shadowedBy', { key: skill.shadowedBy })}</p>}
    <div className={css.skInvocation}>
      <SelectField inline size="sm" label={t('invocation.label')} value={invocation} disabled={!context.writable || busy || skill.readOnly === true}
        options={(['both', 'slash', 'model', 'off'] as const).map(value => ({ value, label: t(`invocation.${value}`) }))}
        onChange={value => void write(() => context.client.setInvocation(skill.key, switchesOf(value), skill.hash))} />
    </div>
    {skill.whenToUse !== undefined && <p className={css.skWhen}>{skill.whenToUse}</p>}
    <SkillMarkdown body={skill.body} />
    <div className={css.skFolds}>
      <FoldLink title={t('tests.title')} meta={testsMeta} onOpen={() => context.navigate({ tab: 'evals', skillName: skill.name })} />
      <Fold title={t('versions.title')} meta={String(skill.versions.length)}>
        {skill.versions.length === 0 ? <p className={css.skMuted}>{t('versions.empty')}</p> : <ul className={css.skVersions}>{skill.versions.map(version => <li key={version.id}>
          <Tag tone={version.reason === 'evolution' ? 'success' : 'outline'}>{t(`versions.reason.${version.reason}`)}</Tag>
          <time title={version.createdAt}>{stamp(version.createdAt)}</time>
          {version.hash === skill.hash && <Tag tone="neutral">{t('versions.current')}</Tag>}
          <span />
          {version.hash !== skill.hash && <>
            <Button variant="ghost" size="sm" onClick={() => void context.client.version(skill.key, version.id).then(setComparing).catch(context.fail)}>{t('versions.compare')}</Button>
            <Button variant="ghost" size="sm" disabled={!context.writable || busy || skill.readOnly === true} onClick={() => void write(() => context.client.restoreVersion(skill.key, version.id, skill.hash))}>{t('versions.restore')}</Button>
          </>}
        </li>)}</ul>}
      </Fold>
      {(skill.resources?.length ?? 0) > 0 && <Fold title={t('skills.files')} meta={String(skill.resources!.length)}>
        <div className={css.skResources}>{skill.resources!.map(file => <code key={file}>{file}</code>)}</div>
      </Fold>}
    </div>
    {editing !== null && <SidebarModal wide title={t('editor.title', { name: skill.name })} busy={busy} onClose={() => setEditing(null)} footer={<>
      <Button variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={busy || editing === skill.content} onClick={() => void write(async () => { await context.client.saveSkill(skill.key, editing, skill.hash); setEditing(null) })}>{busy ? t('common.saving') : t('common.save')}</Button>
    </>}>
      <textarea className={css.skEditor} spellCheck={false} value={editing} onChange={event => setEditing(event.target.value)} aria-label="SKILL.md" />
    </SidebarModal>}
    {improving && <ImproveDialog context={context} name={skill.name} onClose={() => setImproving(false)} />}
    {comparing !== null && <SidebarModal wide title={t('versions.compareTitle', { time: stamp(comparing.version.createdAt) })} onClose={() => setComparing(null)}>
      <DiffBlock maxLines={400} labels={diffLabels(t)} diffs={[{ path: `${skill.name}/SKILL.md`, oldText: comparing.content, newText: skill.content }]} />
    </SidebarModal>}
    {deleting && <Confirm danger title={t('skills.removeTitle', { name: skill.name })} body={t('skills.removeBody')} confirmLabel={t('skills.remove')} busy={busy} onClose={() => setDeleting(false)} onConfirm={() => void (async () => {
      setBusy(true)
      try {
        await context.client.deleteSkill(skill.key, skill.hash)
        context.notice(t('skills.removed', { name: skill.name }))
        setDeleting(false)
        props.onDeleted()
        context.refresh()
      } catch (error) { context.fail(error) } finally { setBusy(false) }
    })()} />}
  </article>
}

/** Ask for an improvement draft of a skill, with an optional note on what to change. */
function ImproveDialog(props: { context: SkillsPageContext; name: string; onClose: () => void }): JSX.Element {
  const t = useT()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await props.context.client.generateDraft({ skill: props.name, ...(note.trim() === '' ? {} : { guidance: note.trim() }) })
      props.context.notice(t('skills.improveStarted'))
      props.onClose()
      props.context.refresh()
    } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  return <SidebarModal title={t('skills.improveTitle', { name: props.name })} busy={busy} onClose={props.onClose} footer={<>
    {error !== null && <span className={css.skFormError}>{error}</span>}
    <Button variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" disabled={busy} onClick={() => void start()}>{t('skills.improveStart')}</Button>
  </>}>
    <div className={css.skForm}>
      <Field label={t('skills.improveNote')}>{control => <textarea {...control} rows={3} value={note} placeholder={t('skills.improvePlaceholder')} onChange={event => setNote(event.target.value)} />}</Field>
    </div>
  </SidebarModal>
}

function CreateDialog(props: { context: SkillsPageContext; roots: readonly SkillRootKind[]; onClose: () => void; onCreated: (skill: SkillSummary) => void }): JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [root, setRoot] = useState<SkillRootKind>(props.roots.includes('user-dsh') ? 'user-dsh' : props.roots[0] ?? 'user-dsh')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name.length <= 64 && description.trim() !== ''
  const submit = async () => {
    setBusy(true)
    setError(null)
    try { props.onCreated(await props.context.client.createSkill({ name, description: description.trim(), root })) } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  return <SidebarModal title={t('create.title')} busy={busy} onClose={props.onClose} footer={<>
    {error !== null && <span className={css.skFormError}>{error}</span>}
    <Button variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>{t('create.submit')}</Button>
  </>}>
    <div className={css.skForm}>
      <Field label={t('create.name')} hint={t('create.nameHint')}>{control => <input {...control} value={name} placeholder="release-notes" onChange={event => setName(event.target.value.trim().toLowerCase())} />}</Field>
      <Field label={t('create.description')} hint={t('create.descriptionHint')}>{control => <textarea {...control} rows={3} value={description} onChange={event => setDescription(event.target.value)} />}</Field>
      <div className={css.skFormRow}><SelectField label={t('create.root')} value={root} options={SKILL_ROOT_KINDS.filter(kind => props.roots.includes(kind)).map(kind => ({ value: kind, label: t(`root.${kind}`) }))} onChange={setRoot} /></div>
    </div>
  </SidebarModal>
}
