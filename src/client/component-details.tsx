import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular, Modal, StateDot, Tag, TextShimmer, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryJsonValue } from '../core/contracts/index.ts'
import type { MemoryPluginEntryView, MemoryViewDashboard } from '../host/view-protocol.ts'
import { isExperimental, isShipped, nameList } from './component-copy.ts'
import { relationsOf, switchPlan } from './component-model.ts'
import { ComponentOptions } from './component-options.tsx'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'

export interface ComponentState {
  tone?: StateDotState | undefined
  text: string
  pending?: boolean | undefined
}

export interface ComponentDetailsProps {
  entry: MemoryPluginEntryView
  dashboard: MemoryViewDashboard
  name: (entry: MemoryPluginEntryView) => string
  hint: string
  state: ComponentState | undefined
  control: ReactNode
  writable: boolean
  applying: boolean
  language: string
  t: MnemonTranslate
  settings?: ReactNode | undefined
  section?: string | undefined
  back?: { name: string; go: () => void } | undefined
  headed?: boolean | undefined
  onOpen: (entry: MemoryPluginEntryView) => void
  onApply: (config: Record<string, MemoryJsonValue>) => Promise<boolean>
  onClose: () => void
}

export function ComponentDetails(props: ComponentDetailsProps): JSX.Element {
  return <Modal open onClose={props.onClose} title={props.name(props.entry)} description={props.hint} closeLabel={props.t('common.close')} className={css.detailsDialog ?? ''} contentClassName={css.detailsScroll ?? ''}>
    <ComponentPage {...props} />
  </Modal>
}

export function ComponentPage(props: Omit<ComponentDetailsProps, 'onClose'>): JSX.Element {
  const { entry, dashboard, name, t } = props
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const target = props.section?.trim()
    const body = bodyRef.current
    if (target === undefined || target === '' || body === null) return
    const escapeAttr = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(target) : target.replace(/["\\]/gu, '\\$&')
    const reveal = (): boolean => {
      const element = body.querySelector<HTMLElement>(`[data-settings-section="${escapeAttr}"]`)
      if (element === null) return false
      let current: HTMLElement | null = element
      while (current !== null && current !== body) {
        if (current instanceof HTMLDetailsElement && !current.open) current.open = true
        if (current.hasAttribute('data-disclosure-open')) {
          current.click()
        } else {
          const trigger = [...current.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute('data-disclosure-open'))
          trigger?.click()
        }
        current = current.parentElement
      }
      const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
      element.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
      return true
    }
    if (reveal()) return
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      if (reveal()) {
        clearTimeout(timeout)
        observer.disconnect()
      }
    })
    const timeout = setTimeout(() => observer.disconnect(), 4000)
    observer.observe(body, { childList: true, subtree: true })
    return () => {
      clearTimeout(timeout)
      observer.disconnect()
    }
  }, [props.section, entry.entryId])
  const relations = relationsOf(dashboard, entry)
  const names = (entries: readonly MemoryPluginEntryView[]): string => nameList(entries.map(name), t)
  const plan = entry.roles.includes('strategy') ? undefined : switchPlan(dashboard, entry, !entry.enabled)
  const others = plan?.changes?.filter(change => change.entry !== entry) ?? []
  const on = names(others.filter(change => change.enabled).map(change => change.entry))
  const off = names(others.filter(change => !change.enabled).map(change => change.entry))
  const effect = plan?.blocked === 'last-source' ? t('details.effectLast')
    : entry.enabled ? off === '' ? undefined : t('details.effectOff', { names: off })
      : on === '' && off === '' ? undefined : off === '' ? t('details.effectOn', { names: on }) : on === '' ? t('details.effectOnReplace', { names: off }) : t('details.effectOnMixed', { on, off })
  const needs = relations.needs.filter(need => need.providers.length > 0 || !need.met)
  const hasRelations = needs.length > 0 || relations.neededBy.length > 0 || relations.conflictsWith.length > 0 || effect !== undefined
  const link = (other: MemoryPluginEntryView, on: boolean): JSX.Element => <button key={other.entryId} type="button" className={css.detailsName} onClick={() => props.onOpen(other)}>
    <StateDot state={on ? 'done' : 'idle'} /><span>{name(other)}</span>
  </button>

  return <div ref={bodyRef} className={`${css.surface} ${css.detailsBody}`}>
    {props.back !== undefined && <button type="button" className={css.detailsBack} onClick={props.back.go}>
      <IconChevronLeftOutlineRegular size={12} aria-hidden="true" />{t('details.back', { component: props.back.name })}
    </button>}
    <div className={css.detailsHead}>
      <div className={css.detailsHeadLine}>
        {props.state !== undefined && <span className={css.boardState} data-tone={props.state.pending === true ? 'ongoing' : props.state.tone}>
          {props.state.pending === true
            ? <><StateDot state="ongoing" /><TextShimmer active>{props.state.text}</TextShimmer></>
            : <>{props.state.tone !== undefined && <StateDot state={props.state.tone} />}<span>{props.state.text}</span></>}
        </span>}
        <Tag tone={isShipped(entry) ? 'neutral' : 'info'}>{t(isShipped(entry) ? 'details.shipped' : 'details.installed')}</Tag>
        {isExperimental(entry) && <Tag tone="info">{t('board.experimental')}</Tag>}
        {props.headed !== true && <code className={css.detailsPackage}>{entry.packageName}</code>}
        <span className={css.detailsControl}>{props.control}</span>
      </div>
    </div>
    {hasRelations && <section className={css.detailsSection} aria-label={t('details.relations')}>
      <h3>{t('details.relations')}</h3>
      <dl className={css.detailsRelations}>
        {needs.map(need => <div key={need.requirement}>
          <dt>{t(need.providers.length > 1 ? 'details.needsAny' : 'details.needs')}</dt>
          <dd>{need.providers.length === 0
            ? <span className={css.detailsMissing}>{t('details.needsMissing', { capability: need.requirement })}</span>
            : need.providers.map(provider => link(provider, provider.enabled))}</dd>
        </div>)}
        {relations.neededBy.length > 0 && <div>
          <dt>{t('details.neededBy')}</dt>
          <dd>{relations.neededBy.map(dependent => link(dependent, true))}</dd>
        </div>}
        {relations.conflictsWith.length > 0 && <div>
          <dt>{t('details.conflicts')}</dt>
          <dd>{relations.conflictsWith.map(other => link(other, other.enabled))}</dd>
        </div>}
      </dl>
      {effect !== undefined && <p className={css.detailsEffect}>{effect}</p>}
    </section>}
    {entry.fields.length > 0 && <section className={css.detailsSection} aria-label={t('details.options')}>
      <h3>{t('details.options')}</h3>
      <ComponentOptions key={entry.entryId + JSON.stringify(entry.config)} entry={entry} name={name(entry)} dashboard={dashboard} language={props.language} t={t}
        disabled={!props.writable || !entry.writable} pending={props.applying} onApply={props.onApply} />
    </section>}
    {props.settings !== undefined && props.settings !== null && <div className={css.detailsContributed}>{props.settings}</div>}
  </div>
}

export function MainChoice(props: { selected: boolean; disabled: boolean; t: MnemonTranslate; onChoose: () => void }): JSX.Element {
  return props.selected
    ? <Tag tone="solid">{props.t('details.currentMain')}</Tag>
    : <Button variant="outline" size="sm" disabled={props.disabled} onClick={props.onChoose}>{props.t('details.useMain')}</Button>
}
