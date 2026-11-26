import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  Button, Checkbox, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, MarkdownText, Menu, PathLabel, StateDot, Tag, TextShimmer,
  type MarkdownLabels, type StateDotState, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { EmptyState, Reveal, SidebarModal } from 'dsh-mnemon/client'
import type { EvolutionSignal, RunStatus, SuggestionStatus, TrajectoryAnnotation, TrajectoryStep } from '../contracts.ts'
import { css, MnemonTooltip, useT, type SkillsKey, type SkillsTranslate } from './presentation.ts'

const canRenderMarkdown = typeof MarkdownText === 'function' || (typeof MarkdownText === 'object' && MarkdownText !== null)
const canRenderPathLabel = typeof PathLabel === 'function' || (typeof PathLabel === 'object' && PathLabel !== null)

export function SkillPath(props: { path: string }): JSX.Element {
  return canRenderPathLabel
    ? <PathLabel path={props.path} />
    : <MnemonTooltip label={props.path} side="top" maxWidth={420} onlyWhenClipped><span>{props.path}</span></MnemonTooltip>
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

export function ActionTag(props: { action: 'create' | 'update' }): JSX.Element {
  const t = useT()
  return <Tag tone={props.action === 'create' ? 'success' : 'info'}>{t(`action.${props.action}`)}</Tag>
}

export function RunStatusDot(props: { status: RunStatus }): JSX.Element {
  const state: Record<RunStatus, StateDotState> = { running: 'ongoing', completed: 'done', failed: 'error', interrupted: 'warning' }
  return <StateDot state={state[props.status]} />
}

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

export function Clamp(props: { text: string; lines?: number }): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const lines = props.lines ?? 3
  const long = props.text.length > lines * 60 || props.text.split('\n').length > lines
  return <div className={css.skClamp}>
    <p className={css.skProse} data-clamped={long && !open ? '' : undefined} style={{ ['--sk-lines' as string]: lines }}>{props.text}</p>
    {long && <button type="button" className={css.skLink} onClick={() => setOpen(value => !value)}>{open ? t('common.less') : t('common.more')}</button>}
  </div>
}

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

export function MoreMenu(props: { label: string; items: readonly MoreItem[]; disabled?: boolean; onSelect: (id: string) => void }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (props.items.length === 0) return null
  return <Menu open={open} autoFocus onClose={() => setOpen(false)} align="end" portal
    items={props.items.map(item => ({ id: item.id, label: item.label, ...(item.danger === true ? { danger: true } : {}), ...(item.disabled === true ? { disabled: true } : {}) }))}
    onSelect={id => { setOpen(false); props.onSelect(id) }}
    anchor={<MnemonTooltip label={props.label} side="bottom" disabled={open}><button type="button" className={css.skIconButton} aria-label={props.label} aria-haspopup="menu" aria-expanded={open} disabled={props.disabled} onClick={() => setOpen(value => !value)}>
      <IconEllipsisOutlineRegular size={16} />
    </button></MnemonTooltip>} />
}

const STEP_GLYPH: Record<TrajectoryStep['kind'], string> = { user: '›', assistant: '‹', tool: '⚙', skill: '✦' }

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
              {step.kind === 'tool' && step.tool?.input !== undefined && <MnemonTooltip label={step.tool.input} side="top" maxWidth={360} onlyWhenClipped><code>{step.tool.input}</code></MnemonTooltip>}
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

export function SkillMarkdown(props: { body: string }): JSX.Element {
  const t = useT()
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('diff.copy'), copiedLabel: t('diff.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  return <div className={css.skDoc}>{canRenderMarkdown ? <MarkdownText text={props.body} labels={labels} /> : props.body}</div>
}

const CATEGORY_GLYPH: Record<string, string> = {
  'docs-writing': '✎', 'content-creation': '✦', 'design-ui': '◐', development: '⌘', devops: '⇪', 'research-analysis': '⌕', productivity: '✓', marketing: '◎',
}

export function SkillIcon(props: { name: string; category?: string | undefined }): JSX.Element {
  const glyph = props.category === undefined ? undefined : CATEGORY_GLYPH[props.category]
  return <span className={css.skIcon} aria-hidden="true">{glyph ?? props.name.slice(0, 1).toUpperCase()}</span>
}
