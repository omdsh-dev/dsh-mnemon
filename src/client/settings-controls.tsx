import { useEffect, useId, useState, type JSX, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MnemonSettingsCard.module.css'
import { Reveal, TARGET } from './feedback.tsx'

/**
 * The configuration's class names that Memory Spaces' own settings use, so they
 * draw as the shipped settings do. They are API: an installed Memory Spaces,
 * older or newer than this Starter, looks its classes up by these names, so
 * renaming or removing one unstyles it.
 */
export const MEMORY_SETTINGS_CLASS_NAMES = [
  'configFeedback', 'editor', 'editorHeading', 'editorNote', 'embeddingFillOutcome', 'embeddingSpaceCount',
  'embeddingSpaceName', 'embeddingSpaceState', 'embeddingSpaces', 'embeddingTest', 'error', 'fieldGrid',
  'groupCallout', 'memoryConfigFooter', 'packSuccess', 'panelHeading', 'panelNote', 'panelSection',
  'providerBoolean', 'providerChevron', 'providerDisclosure', 'providerEnableControl', 'providerFieldControl',
  'providerIdentity', 'providerInlineBody', 'providerList', 'providerLoadError', 'providerLocationField',
  'providerMark', 'providerRow', 'providerRowHeader', 'providerScopeTag', 'providerSecretInput',
  'providerSecretVisibility', 'providerServiceFooter', 'providerServiceForm', 'providerServiceLocation',
  'providerServicePrompt', 'providerSettingsGrid', 'providerState', 'providerTarget', 'providerToggle',
  'providerToggleError', 'scopeChanging', 'visuallyHidden',
] as const
export type MemorySettingsClass = typeof MEMORY_SETTINGS_CLASS_NAMES[number]

/** The configuration's class map, by the names in MEMORY_SETTINGS_CLASS_NAMES. */
export const memorySettingsStyles = css as Readonly<Record<MemorySettingsClass, string>>

/** Marks a row as the place a component's state shows, so the page can point at it. */
const targetOf = (target: string | undefined) => target === undefined ? {} : { [TARGET]: target }

/** One option of a settings selector; the detail explains it in the menu and under the row title. */
export interface SettingOption<T extends string> {
  value: T
  label: string
  detail?: string
  disabled?: boolean
}

/**
 * A DSH preference row: title and hint on the left, one control on the right.
 * Shared by Mnemon Settings and the Plugins page composition.
 */
export function SettingRow(props: { title: string; titleId?: string | undefined; hint?: ReactNode; htmlFor?: string | undefined; children?: ReactNode; stacked?: boolean | undefined; target?: string | undefined }): JSX.Element {
  const title = props.htmlFor === undefined
    ? <strong id={props.titleId}>{props.title}</strong>
    : <label id={props.titleId} htmlFor={props.htmlFor}><strong>{props.title}</strong></label>
  return <div className={css.settingRow} data-stacked={props.stacked === true ? '' : undefined} {...targetOf(props.target)}>
    <div className={css.settingCopy}>{title}{props.hint !== undefined && props.hint !== '' && <small>{props.hint}</small>}</div>
    {props.children !== undefined && <div className={css.settingControl}>{props.children}</div>}
  </div>
}

/** The DSH settings selector: a gray button that opens a Menu of the options. */
export function SettingSelect<T extends string>(props: { labelledBy: string; value: T; options: readonly SettingOption<T>[]; disabled?: boolean | undefined; onChange: (value: T) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const valueId = useId()
  const current = props.options.find(option => option.value === props.value)
  return <Menu
    open={open}
    onClose={() => setOpen(false)}
    align="end"
    portal
    selectedId={props.value}
    listClassName={css.selectMenu}
    items={props.options.map(option => ({
      id: option.value,
      label: option.detail === undefined ? option.label : <span className={css.selectOption}><span>{option.label}</span><small>{option.detail}</small></span>,
      ...(option.disabled === true ? { disabled: true } : {}),
    }))}
    onSelect={id => { setOpen(false); if (id !== props.value) props.onChange(id as T) }}
    anchor={<button type="button" className={css.selector} aria-haspopup="menu" aria-expanded={open} aria-labelledby={`${props.labelledBy} ${valueId}`} disabled={props.disabled} onClick={() => setOpen(value => !value)}>
      <span id={valueId}>{current?.label ?? props.value}</span>
      <IconChevronDownOutlineRegular size={12} />
    </button>}
  />
}

/** A row whose control is a selector; the chosen option's detail doubles as the hint. */
export function SelectRow<T extends string>(props: { id: string; label: string; hint?: string | undefined; value: T; options: readonly SettingOption<T>[]; disabled?: boolean | undefined; target?: string | undefined; onChange: (value: T) => void }): JSX.Element {
  const titleId = `${props.id}-title`
  const detail = props.options.find(option => option.value === props.value)?.detail
  return <SettingRow title={props.label} titleId={titleId} hint={props.hint ?? detail} target={props.target}>
    <SettingSelect labelledBy={titleId} value={props.value} options={props.options} disabled={props.disabled === true} onChange={props.onChange} />
  </SettingRow>
}

/**
 * A row whose control is the DSH Switch. A note under the hint states what the
 * switch depends on and offers what resolves it; it slides in and out.
 */
export function ToggleRow(props: { id: string; label: string; titleId?: string | undefined; hint: string; checked: boolean; disabled: boolean; ariaLabel?: string | undefined; note?: ReactNode; target?: string | undefined; onChange: (value: boolean) => void }): JSX.Element {
  return <div className={css.toggleRow} id={props.id} {...targetOf(props.target)}>
    <div className={css.settingCopy}>
      <strong id={props.titleId}>{props.label}</strong>
      {props.hint !== '' && <small>{props.hint}</small>}
      <Reveal>{props.note === undefined ? null : <div className={css.rowNote}>{props.note}</div>}</Reveal>
    </div>
    <Switch className={css.switch} checked={props.checked} label={props.ariaLabel ?? props.label} disabled={props.disabled} onChange={props.onChange} />
  </div>
}

/**
 * Smoothly animated collapsible disclosure for advanced or secondary settings.
 * Unmounts its body while collapsed so hidden controls are never focusable or
 * editable via keyboard navigation, while parent `useStaged` state preserves
 * unsaved edits across collapse/expand and section deep-links auto-expand it.
 */
export function AdvancedSection(props: {
  title: ReactNode
  hint?: ReactNode
  badge?: ReactNode
  defaultOpen?: boolean | undefined
  section?: string | undefined
  activeSection?: string | undefined
  className?: string | undefined
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(() => props.defaultOpen === true || (props.section !== undefined && props.activeSection === props.section))
  const titleId = useId()
  const bodyId = useId()
  useEffect(() => {
    if (props.section !== undefined && props.activeSection === props.section) setOpen(true)
  }, [props.section, props.activeSection])
  return <div className={[css.advanced, props.className].filter(Boolean).join(' ')} data-open={open ? '' : undefined}
    {...(props.section === undefined ? {} : { 'data-settings-section': props.section })}>
    <button type="button" className={css.advancedToggle} aria-expanded={open} aria-labelledby={titleId}
      {...(open ? { 'aria-controls': bodyId } : {})}
      data-disclosure-open={open ? undefined : ''} onClick={() => setOpen(value => !value)}>
      <span className={css.advancedHeading}>
        <span id={titleId} className={css.advancedTitle}>{props.title}</span>
        {props.hint !== undefined && props.hint !== '' && <small className={css.advancedHint}>{props.hint}</small>}
      </span>
      <span className={css.advancedMeta}>
        {props.badge !== undefined && <span className={css.advancedBadge}>{props.badge}</span>}
        <IconChevronDownOutlineRegular size={14} aria-hidden="true" />
      </span>
    </button>
    {open && <div id={bodyId} className={css.advancedBody}>
      <div className={css.advancedContent}>{props.children}</div>
    </div>}
  </div>
}
