import { useId, useState, type InputHTMLAttributes, type JSX } from 'react'
import { Button, IconChevronDownOutlineRegular, IconSearchOutlineRegular, Input, Menu, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useT } from './page-kit.tsx'
import type { MnemonKey, MnemonTranslate } from './locales.ts'
import css from './PageControls.module.css'

/**
 * Controls every memory page shares, so a search, a choice or a write receipt
 * looks and behaves the same on each page: the DSH input and its search icon,
 * the DSH selector and its menu, and one receipt for a task Agent's write.
 */

/** A search box: the DSH input with its search icon. */
export function SearchField({ label, className, ...input }: { label: string; className?: string | undefined } & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <Input {...input} aria-label={label} icon={<IconSearchOutlineRegular size={16} />} className={[css.search, className].filter(Boolean).join(' ')} />
}

/** One choice of a {@link SelectField}; the detail explains it in the menu. */
export interface FieldOption<T extends string> {
  value: T
  label: string
  detail?: string | undefined
  disabled?: boolean | undefined
}

/** A labelled choice: the DSH selector, opening a menu of the options. */
export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: readonly FieldOption<T>[]
  disabled?: boolean | undefined
  /** Keep the label for assistive technology only, when the row already says it. */
  hideLabel?: boolean | undefined
  /** `sm` for compact toolbars and headers, as the DSH small button. */
  size?: 'md' | 'sm' | undefined
  /** Label beside the selector instead of above it. */
  inline?: boolean | undefined
  /** A fuller name for assistive technology than the visible label. */
  ariaLabel?: string | undefined
  className?: string | undefined
  /**
   * Repeat the chosen option's detail under its name in the selector itself, as
   * the menu shows it. Off by default: most fields have no room for a second line.
   */
  triggerDetail?: boolean | undefined
  onChange: (value: T) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  /**
   * Which way the menu opens. A menu taller than the room below its anchor is
   * pushed up by the portal until it covers the button, so the selector decides
   * the side itself once it knows how much room is left and how much is above.
   */
  const [side, setSide] = useState<'bottom' | 'top'>('bottom')
  const labelId = useId()
  const nameId = useId()
  const valueId = useId()
  const current = props.options.find(option => option.value === props.value)
  const detail = props.triggerDetail === true && current?.detail !== undefined
  return <span className={[css.field, props.className].filter(Boolean).join(' ')} data-inline={props.inline === true ? '' : undefined} data-size={props.size === 'sm' ? 'sm' : undefined}>
    <span id={labelId} data-part="label" className={props.hideLabel === true ? css.hiddenLabel : css.fieldLabel} aria-hidden={props.ariaLabel === undefined ? undefined : true}>{props.label}</span>
    {props.ariaLabel !== undefined && <span id={nameId} className={css.hiddenLabel}>{props.ariaLabel}</span>}
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      align="start"
      side={side}
      portal
      selectedId={props.value}
      className={css.menuRoot}
      listClassName={css.menu}
      items={props.options.map(option => ({
        id: option.value,
        label: option.detail === undefined ? option.label : <span className={css.option}><span>{option.label}</span><small>{option.detail}</small></span>,
        ...(option.disabled === true ? { disabled: true } : {}),
      }))}
      onSelect={id => { setOpen(false); if (id !== props.value) props.onChange(id as T) }}
      anchor={<button
        type="button"
        className={css.selector}
        data-trigger-detail={detail ? '' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={`${props.ariaLabel === undefined ? labelId : nameId} ${valueId}`}
        disabled={props.disabled === true}
        onClick={event => {
          if (open) {
            setOpen(false)
            return
          }
          // 4px for the menu's gap and 12px for the portal's viewport margin.
          const rect = event.currentTarget.getBoundingClientRect()
          const below = Math.floor(window.innerHeight - rect.bottom - 4 - 12)
          const above = Math.floor(rect.top - 4 - 12)
          const flip = below < 220 && above > below
          const nextValue = `${Math.max(160, flip ? above : below)}px`
          const root = document.documentElement
          if (root.style.getPropertyValue('--dsh-select-menu-max').trim() !== nextValue) {
            root.style.setProperty('--dsh-select-menu-max', nextValue)
          }
          setSide(flip ? 'top' : 'bottom')
          setOpen(true)
        }}
      >
        {detail
          ? <span id={valueId} className={css.option}><span>{current!.label}</span><small>{current!.detail}</small></span>
          : <span id={valueId}>{current?.label ?? props.value}</span>}
        <IconChevronDownOutlineRegular size={12} />
      </button>}
    />
  </span>
}

/** How a task Agent's write ended, as the receipt names it. */
export type WriteOutcome = 'written' | 'updated' | 'pending' | 'skipped' | 'partial' | 'unfinished'

const OUTCOMES: Readonly<Record<string, WriteOutcome>> = {
  stored: 'written', added: 'written', created: 'written', merged: 'written', linked: 'written',
  updated: 'updated', replaced: 'updated',
  accepted: 'pending', candidate: 'pending',
  skipped: 'skipped',
  partial: 'partial',
}

/** Map a write action from a receipt to what the user reads. */
export function writeOutcome(action: string): WriteOutcome {
  return OUTCOMES[action] ?? 'unfinished'
}

const TONES: Readonly<Record<WriteOutcome, TagTone>> = {
  written: 'success', updated: 'success', pending: 'info', skipped: 'neutral', partial: 'warning', unfinished: 'warning',
}
const LABELS: Readonly<Record<WriteOutcome, MnemonKey>> = {
  written: 'receipt.written', updated: 'receipt.updated', pending: 'receipt.pending',
  skipped: 'receipt.skipped', partial: 'receipt.partial', unfinished: 'receipt.unfinished',
}

/**
 * What a task Agent did with a candidate: the outcome, the Agent's own
 * summary, and, when something was written, a way to see it. A memory saved
 * without a vector says so on a line of its own (#388).
 */
export function WriteReceipt(props: {
  action?: string | undefined
  summary?: string | undefined
  error?: string | undefined
  unembedded?: boolean | undefined
  /**
   * Whether DSH manages the Mnemon Native embedding settings. Left at their
   * default (`false`), they set up no embedding service, so a memory without a
   * vector gets a neutral note; managed, or when this is omitted, it gets the
   * caution that embedding did not succeed.
   */
  embeddingManaged?: boolean | undefined
  t?: MnemonTranslate | undefined
  onView?: (() => void) | undefined
  viewLabel?: string | undefined
}): JSX.Element {
  const shared = useT()
  const t = props.t ?? shared
  if (props.error !== undefined) {
    return <div className={css.receipt} role="alert" data-outcome="failed">
      <Tag tone="danger">{t('receipt.failed')}</Tag>
      <p>{props.error}</p>
    </div>
  }
  const outcome = writeOutcome(props.action ?? '')
  const viewable = outcome !== 'skipped' && outcome !== 'unfinished'
  const vectorless = props.unembedded === true && (outcome === 'written' || outcome === 'updated' || outcome === 'partial')
  const expected = props.embeddingManaged === false
  return <div className={css.receipt} role="status" data-outcome={outcome}>
    <Tag tone={TONES[outcome]}>{t(LABELS[outcome])}</Tag>
    {props.summary !== undefined && props.summary !== '' && <p>{props.summary}</p>}
    {props.onView !== undefined && viewable && <Button variant="ghost" size="sm" className={css.receiptAction} onClick={props.onView}>{props.viewLabel ?? t('receipt.view')}</Button>}
    {vectorless && <p className={css.receiptNote} data-tone={expected ? 'neutral' : 'caution'}>{t(expected ? 'receipt.unembeddedNoService' : 'receipt.unembedded')}</p>}
  </div>
}

/** Whether a task Agent can take a write now. */
export function TaskAgentTag(props: { available: boolean; t?: MnemonTranslate | undefined }): JSX.Element {
  const shared = useT()
  const t = props.t ?? shared
  return <Tag tone={props.available ? 'success' : 'warning'}>{t(props.available ? 'taskAgent.ready' : 'taskAgent.unavailable')}</Tag>
}
