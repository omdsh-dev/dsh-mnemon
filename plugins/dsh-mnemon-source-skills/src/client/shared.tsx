import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  Button, Checkbox, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, MarkdownText, Menu, PathLabel, StateDot, Tag, TextShimmer,
  type MarkdownLabels, type StateDotState, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { EmptyState, Reveal, SidebarModal, useLocale } from 'dsh-mnemon/client'
import type { EvolutionSignal, RunStatus, SuggestionStatus, TrajectoryAnnotation, TrajectoryStep } from '../contracts.ts'
import { css, useT, type SkillsKey, type SkillsTranslate } from './presentation.ts'

const canRenderMarkdown = typeof MarkdownText === 'function' || (typeof MarkdownText === 'object' && MarkdownText !== null)
const canRenderPathLabel = typeof PathLabel === 'function' || (typeof PathLabel === 'object' && PathLabel !== null)

export function SkillPath(props: { path: string }): JSX.Element {
  return canRenderPathLabel ? <PathLabel path={props.path} /> : <>{props.path}</>
}

const SIGNAL_TONE: Record<EvolutionSignal, TagTone> = {
  correction: 'warning', directive: 'info', 'tool-failure': 'danger', 'approach-change': 'warning',
  procedure: 'info', 'skill-gap': 'warning', 'skill-misleading': 'warning', success: 'success',
}

export function SignalTag(props: { signal: EvolutionSignal }): JSX.Element {
  const t = useT()
  return <Tag tone={SIGNAL_TONE[props.signal]}>{t(`signal.${props.signal}` as SkillsKey)}</Tag>
}

const STATUS_TONE: Record<SuggestionStatus, TagTone> = {
  pending: 'info', drafting: 'info', review: 'warning', adopted: 'success', dismissed: 'quiet', expired: 'quiet', invalidated: 'quiet',
}

export function StatusTag(props: { status: SuggestionStatus }): JSX.Element {
  const t = useT()
  return <Tag tone={STATUS_TONE[props.status]}>{t(`status.${props.status}` as SkillsKey)}</Tag>
}

/** New skill or improvement, the first thing a suggestion says about itself. */
export function ActionTag(props: { action: 'create' | 'update' }): JSX.Element {
  const t = useT()
  return <Tag tone={props.action === 'create' ? 'success' : 'info'}>{t(`action.${props.action}`)}</Tag>
}

export function RunStatusDot(props: { status: RunStatus }): JSX.Element {
  const state: Record<RunStatus, StateDotState> = { running: 'ongoing', completed: 'done', failed: 'error', interrupted: 'warning' }
  return <StateDot state={state[props.status]} />
}

/**
 * Follows each link the page is given once, as soon as what it points into
 * has loaded. A link is known by its nonce, so reloading the page's data
 * leaves whatever the reader chose since alone.
 */
export function useLink(nonce: number | undefined, ready: boolean, follow: () => void): void {
  const followed = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (nonce === undefined || followed.current === nonce || !ready) return
    followed.current = nonce
    follow()
  })
}

export function Busy(props: { label: string }): JSX.Element {
  return <span className={css.skBusy} role="status"><StateDot state="ongoing" /><TextShimmer active>{props.label}</TextShimmer></span>
}

export function Empty(props: { glyph: string; title: string; children: string; action?: ReactNode }): JSX.Element {
  return <div className={css.skEmpty}>
    <EmptyState glyph={props.glyph} title={props.title}>{props.children}</EmptyState>
    {props.action !== undefined && <div className={css.skEmptyActions}>{props.action}</div>}
  </div>
}

export function Confirm(props: { title: string; body: string; confirmLabel: string; busy?: boolean; danger?: boolean; onConfirm: () => void; onClose: () => void }): JSX.Element {
  const t = useT()
  return <SidebarModal title={props.title} {...(props.busy === undefined ? {} : { busy: props.busy })} onClose={props.onClose} footer={<>
    <Button variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" className={props.danger === true ? css.skDangerButton : undefined} disabled={props.busy === true} onClick={props.onConfirm}>{props.confirmLabel}</Button>
  </>}><p className={css.skProse}>{props.body}</p></SidebarModal>
}

/**
 * A section that stays closed until asked for: its title and a short summary
 * on one row, the content below it once open.
 */
export function Fold(props: { title: string; meta?: ReactNode; defaultOpen?: boolean; actions?: ReactNode; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen === true)
  const id = useId()
  return <section className={css.skFold} data-open={open ? '' : undefined}>
    <header>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <IconChevronDownOutlineRegular size={12} />
        <span>{props.title}</span>
        {props.meta !== undefined && <small>{props.meta}</small>}
      </button>
      {open && props.actions !== undefined && <div>{props.actions}</div>}
    </header>
    <Reveal>{open ? <div id={id} className={css.skFoldBody}>{props.children}</div> : null}</Reveal>
  </section>
}

/** A row among the folds that leads elsewhere instead of opening in place. */
export function FoldLink(props: { title: string; meta?: ReactNode; onOpen: () => void }): JSX.Element {
  return <section className={css.skFold} data-link="">
    <header>
      <button type="button" onClick={props.onOpen}>
        <span>{props.title}</span>
        {props.meta !== undefined && <small>{props.meta}</small>}
        <b aria-hidden="true">›</b>
      </button>
    </header>
  </section>
}

/**
 * A paragraph that shows its first lines and opens to the rest, so a long
 * reason or note never pushes what follows out of view.
 */
export function Clamp(props: { text: string; lines?: number }): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const lines = props.lines ?? 3
  // A paragraph short enough to fit needs no toggle.
  const long = props.text.length > lines * 60 || props.text.split('\n').length > lines
  return <div className={css.skClamp}>
    <p className={css.skProse} data-clamped={long && !open ? '' : undefined} style={{ ['--sk-lines' as string]: lines }}>{props.text}</p>
    {long && <button type="button" className={css.skLink} onClick={() => setOpen(value => !value)}>{open ? t('common.less') : t('common.more')}</button>}
  </div>
}

/** A list that shows its first items and opens to the rest. */
export function MoreList(props: { items: readonly string[]; shown: number }): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const hidden = props.items.length - props.shown
  const items = open || hidden <= 0 ? props.items : props.items.slice(0, props.shown)
  return <div className={css.skClamp}>
    <ul className={css.skChanges}>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    {hidden > 0 && <button type="button" className={css.skLink} onClick={() => setOpen(value => !value)}>{open ? t('common.less') : t('common.moreCount', { count: hidden })}</button>}
  </div>
}

export interface MoreItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
}

/** The less frequent actions behind one quiet button. */
export function MoreMenu(props: { label: string; items: readonly MoreItem[]; disabled?: boolean; onSelect: (id: string) => void }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (props.items.length === 0) return null
  return <Menu open={open} autoFocus onClose={() => setOpen(false)} align="end" portal
    items={props.items.map(item => ({ id: item.id, label: item.label, ...(item.danger === true ? { danger: true } : {}), ...(item.disabled === true ? { disabled: true } : {}) }))}
    onSelect={id => { setOpen(false); props.onSelect(id) }}
    anchor={<button type="button" className={css.skIconButton} aria-label={props.label} title={props.label} aria-haspopup="menu" aria-expanded={open} disabled={props.disabled} onClick={() => setOpen(value => !value)}>
      <IconEllipsisOutlineRegular size={16} />
    </button>} />
}

const STEP_GLYPH: Record<TrajectoryStep['kind'], string> = { user: '›', assistant: '‹', tool: '⚙', skill: '✦' }

/**
 * A conversation's steps as a numbered timeline. Annotated steps carry their
 * signal and note; selectable steps get a checkbox, for making test cases.
 */
export function StepTimeline(props: {
  steps: readonly TrajectoryStep[]
  annotations?: readonly TrajectoryAnnotation[]
  highlight?: ReadonlySet<number>
  selected?: ReadonlySet<number>
  onToggle?: (index: number) => void
  compact?: boolean
}): JSX.Element {
  const t = useT()
  const notes = new Map<number, TrajectoryAnnotation[]>()
  for (const annotation of props.annotations ?? []) notes.set(annotation.step, [...(notes.get(annotation.step) ?? []), annotation])
  let lastTurn: number | undefined
  return <ol className={css.skTimeline} data-compact={props.compact === true ? '' : undefined}>
    {props.steps.map(step => {
      const annotated = notes.get(step.index) ?? []
      const turnLabel = step.turn !== lastTurn ? t('timeline.turn', { turn: step.turn }) : undefined
      lastTurn = step.turn
      const failed = step.kind === 'tool' && step.tool?.ok === false
      return <li key={step.index} data-kind={step.kind} data-failed={failed ? '' : undefined} data-annotated={annotated.length > 0 ? '' : undefined} data-highlight={props.highlight?.has(step.index) === true ? '' : undefined}>
        {turnLabel !== undefined && <div className={css.skTurn}>{turnLabel}</div>}
        <div className={css.skStep}>
          {props.onToggle !== undefined
            ? <Checkbox checked={props.selected?.has(step.index) === true} label={`#${step.index}`} onChange={() => props.onToggle!(step.index)} />
            : <span className={css.skStepIndex}>{step.index}</span>}
          <span className={css.skStepGlyph} aria-hidden="true">{STEP_GLYPH[step.kind]}</span>
          <div className={css.skStepBody}>
            <div className={css.skStepHead}>
              <strong>{step.kind === 'tool' ? step.tool?.name ?? t('timeline.tool') : t(`timeline.${step.kind}` as SkillsKey)}</strong>
              {step.kind === 'skill' && step.skill !== undefined && <code>{step.skill.by === 'user' ? `/${step.skill.name}` : step.skill.name}</code>}
              {step.kind === 'tool' && step.tool?.input !== undefined && <code title={step.tool.input}>{step.tool.input}</code>}
              {failed && <Tag tone="danger">{t('timeline.failed')}</Tag>}
            </div>
            {step.kind !== 'skill' && step.text !== '' && <p>{step.text}</p>}
            {annotated.map((annotation, index) => <div key={index} className={css.skAnnotation}><SignalTag signal={annotation.signal} /><span>{annotation.note}</span></div>)}
          </div>
        </div>
      </li>
    })}
  </ol>
}

/** A labelled form control with an optional hint, associated for assistive technology. */
export function Field(props: { label: string; hint?: string; children: (control: { id: string; 'aria-describedby'?: string }) => ReactNode }): JSX.Element {
  const id = useId()
  const hintId = useId()
  return <div className={css.skField}>
    <label htmlFor={id}>{props.label}</label>
    {props.children({ id, ...(props.hint === undefined ? {} : { 'aria-describedby': hintId }) })}
    {props.hint !== undefined && <small id={hintId}>{props.hint}</small>}
  </div>
}

export function diffLabels(t: SkillsTranslate) {
  return {
    codeLabel: t('diff.code'), wrapLabel: t('diff.wrap'), unwrapLabel: t('diff.unwrap'),
    copy: t('diff.copy'), copied: t('diff.copied'), collapseAria: t('diff.collapse'),
    expandAria: (hidden: number) => t('diff.expand', { count: hidden }), collapse: t('diff.collapse'),
    expand: (hidden: number) => t('diff.expand', { count: hidden }),
  }
}

/** The SKILL.md body as Markdown, without its frontmatter. */
export function SkillMarkdown(props: { body: string }): JSX.Element {
  const locale = useLocale()
  const labels = useMemo<MarkdownLabels>(() => {
    const zh = locale.startsWith('zh')
    return {
      code: { copyLabel: zh ? '复制' : 'Copy', copiedLabel: zh ? '已复制' : 'Copied' },
      footnotes: zh ? '脚注' : 'Footnotes',
    }
  }, [locale])
  return <div className={css.skDoc}>{canRenderMarkdown ? <MarkdownText text={props.body} labels={labels} /> : props.body}</div>
}

const CATEGORY_GLYPH: Record<string, string> = {
  'docs-writing': '✎', 'content-creation': '✦', 'design-ui': '◐', development: '⌘', devops: '⇪', 'research-analysis': '⌕', productivity: '✓', marketing: '◎',
}

/** A square with the category's glyph, or the skill's initial. */
export function SkillIcon(props: { name: string; category?: string | undefined }): JSX.Element {
  const glyph = props.category === undefined ? undefined : CATEGORY_GLYPH[props.category]
  return <span className={css.skIcon} aria-hidden="true">{glyph ?? props.name.slice(0, 1).toUpperCase()}</span>
}
