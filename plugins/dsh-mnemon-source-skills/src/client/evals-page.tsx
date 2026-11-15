import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { IconSettingsOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { SearchField, SelectField } from 'dsh-mnemon/client'
import type { CatalogView, EvalCase } from '../contracts.ts'
import { modelOptionPick, modelOptionValue, useModelChoice } from './model-choice.tsx'
import { css, points, relative, supportsSettingsSection, useT } from './presentation.ts'
import { Busy, Empty, SkillIcon } from './shared.tsx'
import { SkillTests } from './skill-tests.tsx'
import type { SkillsLocation, SkillsPageContext } from './ui.tsx'

interface Row {
  name: string
  /** Cases a backtest runs; the switched-off ones are counted apart. */
  cases: number
  off: number
  description?: string
  lastScore?: number
  lastRunAt?: string
  /** Cases can wait for a skill not written yet: one a suggestion proposes. */
  exists: boolean
}

/** A score's tone: good from 80, poor under 50. */
export function scoreTone(score: number | undefined): 'good' | 'bad' | undefined {
  return score === undefined ? undefined : score >= 0.8 ? 'good' : score < 0.5 ? 'bad' : undefined
}

/**
 * Every skill's tests in one place: the skills with cases first, each with
 * its last score against the version DSH loads, and the ones a suggestion
 * proposes after them; on the right, the chosen skill's cases and backtests.
 */
export function EvalsPage(props: { context: SkillsPageContext; location: SkillsLocation }): JSX.Element {
  const t = useT()
  const { context, location } = props
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [cases, setCases] = useState<EvalCase[]>([])
  /** Skills a waiting suggestion proposes to create. */
  const [proposed, setProposed] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | undefined>(location.skillName)
  const choice = useModelChoice(context, 'tests.modelAuto')
  useEffect(() => { if (location.skillName !== undefined) setSelected(location.skillName) }, [location.skillName, location.nonce])
  useEffect(() => {
    let active = true
    void Promise.all([context.client.catalog(), context.client.cases(), context.client.suggestions(['pending', 'drafting', 'review'])]).then(([view, list, waiting]) => {
      if (!active) return
      setCatalog(view)
      setCases(list)
      setProposed(new Set(waiting.filter(entry => entry.action === 'create').map(entry => entry.skillName)))
    }).catch(context.fail)
    return () => { active = false }
  }, [context.client, context.revision])
  const rows = useMemo<Row[]>(() => {
    if (catalog === null) return []
    const loaded = new Map(catalog.skills.filter(skill => skill.shadowedBy === undefined).map(skill => [skill.name, skill.description]))
    return [...new Set([...loaded.keys(), ...cases.map(entry => entry.skillName)])].map(name => {
      const stats = catalog.stats[name]
      const own = cases.filter(entry => entry.skillName === name)
      const description = loaded.get(name)
      return {
        name, exists: loaded.has(name), cases: own.filter(entry => entry.enabled).length, off: own.filter(entry => !entry.enabled).length,
        ...(description === undefined ? {} : { description }),
        ...(stats?.lastScore === undefined ? {} : { lastScore: stats.lastScore }),
        ...(stats?.lastRunAt === undefined ? {} : { lastRunAt: stats.lastRunAt }),
      }
    }).sort((a, b) => Number(b.exists) - Number(a.exists) || a.name.localeCompare(b.name))
  }, [catalog, cases])
  const paneRef = useRef<HTMLDivElement | null>(null)
  const needle = query.trim().toLowerCase()
  const visible = rows.filter(row => needle === '' || row.name.includes(needle))
  const groups = [
    { key: 'tested', title: t('evals.tested'), rows: visible.filter(row => row.cases > 0) },
    { key: 'untested', title: t('evals.untested'), rows: visible.filter(row => row.cases === 0) },
  ].filter(group => group.rows.length > 0)
  const activeRow = rows.find(row => row.name === selected) ?? groups[0]?.rows[0] ?? rows[0]
  useLayoutEffect(() => {
    if (paneRef.current !== null) paneRef.current.scrollTop = 0
  }, [activeRow?.name])
  if (catalog === null) return <Busy label={t('common.loading')} />
  if (rows.length === 0) return <Empty glyph="✓" title={t('evals.empty')}>{t('evals.emptyBody')}</Empty>
  const current = activeRow!
  const currentCases = cases.filter(entry => entry.skillName === current.name)
  // The pick for this skill, else the global one: a backtest runs on the first
  // that is set, and on the task Agent's own route when neither is.
  const runOverride = Object.hasOwn(choice.preferences.skillRunModels, current.name) ? choice.preferences.skillRunModels[current.name]! : null
  const effectiveRunModel = runOverride ?? choice.preferences.runModel ?? null
  const saveSkillRun = (value: string) => choice.saveSkillRunModel(current.name, modelOptionPick(value))
  const modelSettingsAvailable = context.openSettings !== undefined && supportsSettingsSection('models')
  const modelBar = <div className={css.skPaneBar}>
    {!modelSettingsAvailable && <SelectField<string> label={t('tests.model')} triggerDetail inline size="sm" value={modelOptionValue(choice.preferences.runModel)} disabled={!context.writable || choice.models === null} onChange={value => choice.saveRunModel(modelOptionPick(value))} options={choice.options} />}
    <SelectField<string> label={t('tests.modelCard')} triggerDetail inline size="sm" value={modelOptionValue(runOverride)} disabled={!context.writable || choice.models === null} onChange={saveSkillRun} options={choice.cardOptions} />
    {modelSettingsAvailable && <button type="button" className={css.skIconButton} onClick={() => context.openSettings!('models')} aria-label={t('common.settings')} title={t('common.settings')}><IconSettingsOutlineRegular size={15} /></button>}
  </div>
  return <div className={`${css.skSplit} ${css.skSkillsSplit}`}>
    <aside className={css.skList}>
      <header className={css.skListBar}>
        <SearchField label={t('skills.search')} placeholder={t('skills.search')} value={query} onChange={event => setQuery(event.target.value)} />
      </header>
      {visible.length === 0 && <p className={css.skListNote}>{t('skills.noMatch')}</p>}
      {groups.map(group => <section key={group.key} className={css.skListGroup}>
        <h5 className={css.skGroupHeading}>{group.title}</h5>
        {group.rows.map(row => <div key={row.name} className={css.skRow} data-selected={row.name === current.name ? '' : undefined}>
          <button type="button" className={css.skRowMain} onClick={() => setSelected(row.name)}>
            <SkillIcon name={row.name} />
            <span className={css.skRowText}>
              <strong><span>{row.name}</span>{!row.exists && <Tag tone="quiet">{t('evals.notCreated')}</Tag>}</strong>
              <small>{row.cases > 0 ? [t('tests.count', { count: row.cases }), ...(row.lastRunAt === undefined ? [] : [relative(t, row.lastRunAt)])].join(' · ')
                : row.off > 0 ? t('evals.off', { count: row.off }) : row.description}</small>
            </span>
          </button>
          {row.lastScore !== undefined && <b className={css.skScore} data-tone={scoreTone(row.lastScore)} title={t('tests.lastScore', { score: points(row.lastScore) })}>{points(row.lastScore)}</b>}
        </div>)}
      </section>)}
    </aside>
    <div ref={paneRef} className={css.skPane}>
      {modelBar}
      <article key={current.name} className={css.skDetail}>
        <header className={css.skDetailHead}>
          <div>
            <h3>{current.exists ? <button type="button" className={css.skTitleLink} onClick={() => context.navigate({ tab: 'skills', skillName: current.name })}>{current.name}</button> : current.name}</h3>
            {!current.exists && <p>{t('evals.notCreatedBody')}{proposed.has(current.name) && <> <button type="button" className={css.skLink} onClick={() => context.navigate({ tab: 'evolution', skillName: current.name })}>{t('evals.openSuggestion')} ›</button></>}</p>}
          </div>
        </header>
        <SkillTests context={context} skillName={current.name} cases={currentCases} hasFile={current.exists} runModel={effectiveRunModel} />
      </article>
    </div>
  </div>
}
