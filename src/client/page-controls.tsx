import { useId, useState, type InputHTMLAttributes, type JSX } from 'react'
import { Button, IconChevronDownOutlineRegular, IconSearchOutlineRegular, Input, Menu, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useT } from './page-kit.tsx'
import type { MnemonKey, MnemonTranslate } from './locales.ts'
import css from './PageControls.module.css'

export function SearchField({ label, className, ...input }: { label: string; className?: string | undefined } & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <Input {...input} aria-label={label} icon={<IconSearchOutlineRegular size={16} />} className={[css.search, className].filter(Boolean).join(' ')} />
}

export interface FieldOption<T extends string> {
  value: T
  label: string
  detail?: string | undefined
  disabled?: boolean | undefined
}

export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: readonly FieldOption<T>[]
  disabled?: boolean | undefined
  hideLabel?: boolean | undefined
  size?: 'md' | 'sm' | undefined
  inline?: boolean | undefined
  ariaLabel?: string | undefined
  className?: string | undefined
  triggerDetail?: boolean | undefined
  onChange: (value: T) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
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

export type WriteOutcome = 'written' | 'updated' | 'pending' | 'skipped' | 'partial' | 'unfinished'

const OUTCOMES: Readonly<Record<string, WriteOutcome>> = {
  stored: 'written', added: 'written', created: 'written', merged: 'written', linked: 'written',
  updated: 'updated', replaced: 'updated',
  accepted: 'pending', candidate: 'pending',
  skipped: 'skipped',
  partial: 'partial',
}

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

export function WriteReceipt(props: {
  action?: string | undefined
  summary?: string | undefined
  error?: string | undefined
  unembedded?: boolean | undefined
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

export function TaskAgentTag(props: { available: boolean; t?: MnemonTranslate | undefined }): JSX.Element {
  const shared = useT()
  const t = props.t ?? shared
  return <Tag tone={props.available ? 'success' : 'warning'}>{t(props.available ? 'taskAgent.ready' : 'taskAgent.unavailable')}</Tag>
}
