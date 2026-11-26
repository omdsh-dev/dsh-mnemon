import { css, MnemonTooltip, useT } from './presentation.ts'
import { useState, type JSX } from 'react'
import { memorySettingsStyles, SelectField } from 'dsh-mnemon/client'
import type { MemoryProviderConfigField } from '../contracts.ts'
import { providerFieldLabel, providerOptionLabel } from './provider-presentation.ts'

const SAVED_SECRET_MASK = '••••••••••••'

export interface ProviderFieldProps {
  field: MemoryProviderConfigField
  value: string | number | boolean | undefined
  saved: boolean
  clearing?: boolean
  disabled?: boolean
  layout: 'settings' | 'dialog'
  onChange: (value: string | number | boolean) => void
  onClearChange?: (clearing: boolean) => void
}

function inputType(field: MemoryProviderConfigField, secretVisible: boolean): string {
  return field.input === 'secret' ? secretVisible ? 'text' : 'password' : field.input === 'number' ? 'number' : field.input === 'url' ? 'url' : 'text'
}

function SecretVisibilityIcon({ visible }: { visible: boolean }): JSX.Element {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M2.3 10s2.8-4.5 7.7-4.5 7.7 4.5 7.7 4.5-2.8 4.5-7.7 4.5S2.3 10 2.3 10Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="10" cy="10" r="2.1" stroke="currentColor" strokeWidth="1.4" />
    {visible && <path d="m3.5 3.5 13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
  </svg>
}

export function ProviderField(props: ProviderFieldProps): JSX.Element {
  return props.layout === 'settings' ? <SettingsField {...props} /> : <DialogField {...props} />
}

function SettingsField(props: ProviderFieldProps): JSX.Element {
  const t = useT()
  const settings = memorySettingsStyles
  const [secretVisible, setSecretVisible] = useState(false)
  const { field } = props
  const label = providerFieldLabel(t, field)
  const disabled = props.disabled === true
  const required = field.required && !props.saved
  const secret = field.input === 'secret'
  const fieldValue = String(props.value ?? '')
  const showingSavedMask = secret && props.saved && fieldValue === ''
  const displayValue = showingSavedMask
    ? secretVisible ? t('config.providerSecretStoredValue') : SAVED_SECRET_MASK
    : fieldValue
  const secretToggleLabel = t(secretVisible ? 'config.providerSecretHide' : 'config.providerSecretShow')
  const input = field.input === 'boolean'
    ? <label className={settings.providerBoolean}><input aria-label={label} type="checkbox" checked={Boolean(props.value)} disabled={disabled} onChange={event => props.onChange(event.target.checked)} /><span>{label}</span></label>
    : field.input === 'select'
      ? <SelectField label={label} value={String(props.value ?? '')} disabled={disabled} options={(field.options ?? []).map(option => ({ value: option.value, label: providerOptionLabel(t, option) }))} onChange={next => props.onChange(next)} />
      : <label>{label}<div className={secret ? settings.providerSecretInput : undefined}><input aria-label={label} type={inputType(field, secretVisible)} value={displayValue} required={required} disabled={disabled} autoComplete={secret ? 'new-password' : undefined} placeholder={field.placeholder ?? (secret ? t('overview.providerApiKeyOptional') : undefined)} maxLength={field.maxLength ?? (secret ? 8000 : 2000)} min={field.min} max={field.max} pattern={field.pattern} step={field.input === 'number' ? 'any' : undefined} onFocus={event => {
        if (showingSavedMask) event.currentTarget.select()
      }} onClick={event => {
        if (showingSavedMask) event.currentTarget.select()
      }} onChange={event => {
        const value = showingSavedMask ? event.target.value.replace(SAVED_SECRET_MASK, '').replace(t('config.providerSecretStoredValue'), '') : event.target.value
        props.onChange(value)
      }} />{secret && <MnemonTooltip label={secretToggleLabel} side="top"><button type="button" className={settings.providerSecretVisibility} aria-label={secretToggleLabel} aria-pressed={secretVisible} disabled={disabled} onClick={() => setSecretVisible(value => !value)}><SecretVisibilityIcon visible={secretVisible} /></button></MnemonTooltip>}</div></label>
  return <div className={settings.providerFieldControl} data-input={field.input}>
    {input}
  </div>
}

function DialogField(props: ProviderFieldProps): JSX.Element {
  const t = useT()
  const { field } = props
  const label = providerFieldLabel(t, field)
  const value = props.value ?? ''
  const clearing = props.clearing === true
  const required = field.required && (!props.saved || clearing)
  const input = field.input === 'boolean'
    ? <input aria-label={label} type="checkbox" checked={Boolean(value)} onChange={event => props.onChange(event.target.checked)} />
    : field.input === 'select'
      ? <SelectField hideLabel label={label} value={String(value)} options={(field.options ?? []).map(option => ({ value: option.value, label: providerOptionLabel(t, option) }))} onChange={next => props.onChange(next)} />
      : <input aria-label={label} type={inputType(field, false)} value={String(value)} required={required} autoComplete={field.input === 'secret' ? 'new-password' : undefined} placeholder={props.saved ? t('overview.providerApiKeyKeep') : field.placeholder ?? (field.input === 'secret' ? t('overview.providerApiKeyOptional') : undefined)} maxLength={field.maxLength ?? (field.input === 'secret' ? 8000 : 2000)} min={field.min} max={field.max} pattern={field.pattern} step={field.input === 'number' ? 'any' : undefined} onChange={event => props.onChange(event.target.value)} />
  return <div className={css.providerFieldControl}><label>{label}{input}</label>{field.input === 'secret' && props.saved && props.onClearChange !== undefined && <label className={css.providerSecretClear}><input type="checkbox" checked={clearing} onChange={event => props.onClearChange!(event.target.checked)} />{t('overview.providerSecretClear')}</label>}</div>
}
