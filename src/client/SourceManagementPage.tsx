import { useEffect, useState, type FormEvent } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonValue, MemorySourceManagementInstance } from '../host/protocol.ts'
import type { MnemonKey } from './locales.ts'
import { MNEMON_SOURCE_CONFIGURATION_MUTATE, MNEMON_SOURCE_CONFIGURATION_READ } from './source-pages.tsx'
import type { MnemonSourceManagementClient } from './dsh-context.ts'
import { SelectField } from './page-controls.tsx'
import { jsonRecord } from './is-record.ts'
import css from './MnemonView.module.css'
import { useT, message, short, PageHeader } from './page-kit.tsx'

const EMPTY_SOURCE_MANAGEMENT_FIELDS: NonNullable<MemorySourceManagementInstance['management']['fields']> = []

/** Fixed descriptor-driven baseline; custom Source pages can only add to it. */
export function SourceManagementPage(props: {
  instance: MemorySourceManagementInstance
  instances: readonly MemorySourceManagementInstance[]
  management?: MnemonSourceManagementClient
  onSelect(sourceInstanceKey: string): void
  onMutate(): void
}): JSX.Element {
  const t = useT()
  const fields = props.instance.management.fields ?? EMPTY_SOURCE_MANAGEMENT_FIELDS
  const [draft, setDraft] = useState<Record<string, JsonValue>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    setDraft({})
    setError(null)
    setSaved(false)
    if (fields.length === 0 || props.management === undefined) {
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    void props.management.read(MNEMON_SOURCE_CONFIGURATION_READ).then(result => {
      if (!active) return
      const root = jsonRecord(result.value)
      const values = jsonRecord(root?.values ?? result.value) ?? {}
      setDraft(Object.fromEntries(fields.flatMap(field => {
        if (field.secret === true || field.input === 'secret') return []
        const value = values[field.key]
        return value === undefined ? [] : [[field.key, value]]
      })))
    }).catch(reason => {
      if (active) setError(message(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [fields, props.instance.revision, props.instance.sourceInstanceKey, props.management])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (props.management === undefined) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const input = Object.fromEntries(fields.flatMap(field => {
        const value = draft[field.key]
        if ((field.secret === true || field.input === 'secret') && (value === undefined || value === '')) return []
        if (field.input === 'number' && value !== undefined && value !== '') return [[field.key, Number(value)]]
        if (field.input === 'boolean') return [[field.key, value === true]]
        return value === undefined || value === '' ? [] : [[field.key, value]]
      }))
      await props.management.mutate(MNEMON_SOURCE_CONFIGURATION_MUTATE, input, { confirmed: true })
      setSaved(true)
      props.onMutate()
    } catch (reason) {
      setError(message(reason))
    } finally {
      setSaving(false)
    }
  }

  const availability = t(`sourcePage.availability.${props.instance.availability}` as MnemonKey)
  return <div className={css.page} data-source-management={props.instance.sourceTypeId}>
    <PageHeader
      title={props.instance.management.label}
      description={props.instance.management.description}
      meta={props.instance.sourceTypeId}
      {...(loading ? { loadingLabel: t('sourcePage.configLoading') } : {})}
    />
    {props.instances.length > 1 && <SelectField inline size="sm" className={css.workspacePicker} label={t('sourcePage.instance')} ariaLabel={t('sourcePage.instanceAria')} value={props.instance.sourceInstanceKey} options={props.instances.map(instance => ({ value: instance.sourceInstanceKey, label: instance.management.label, detail: instance.sourceInstanceKey }))} onChange={props.onSelect} />}
    <section className={css.sourceManagementSummary} data-availability={props.instance.availability} aria-label={t('sourcePage.summaryAria')}>
      <div className={css.sourceManagementIdentity}><span aria-hidden="true" /><div><small>{t('sourcePage.package')}</small><strong>{props.instance.packageName}</strong><code>{props.instance.sourceInstanceKey}</code></div></div>
      <dl>
        <div><dt>{t('sourcePage.availability')}</dt><dd>{availability}</dd></div>
        <div><dt>{t('sourcePage.role')}</dt><dd>{props.instance.role}</dd></div>
        <div><dt>{t('sourcePage.revision')}</dt><dd><code>{short(props.instance.revision, 32)}</code></dd></div>
      </dl>
      <div className={css.sourceManagementCapabilities}><small>{t('sourcePage.permissions')}</small><div>{props.instance.capabilities.map(capability => <span key={capability}>{capability}</span>)}</div></div>
    </section>
    {props.instance.management.diagnostics !== undefined && props.instance.management.diagnostics.length > 0 && <section className={css.sourceManagementDiagnostics} aria-label={t('sourcePage.diagnostics')}><h3>{t('sourcePage.diagnostics')}</h3><ul>{props.instance.management.diagnostics.map((diagnostic, index) => <li key={`${index}:${diagnostic}`}>{diagnostic}</li>)}</ul></section>}
    {fields.length > 0 && <form className={css.sourceManagementForm} onSubmit={event => void submit(event)}>
      <div><h3>{t('sourcePage.configuration')}</h3><p>{t('sourcePage.configurationDescription')}</p></div>
      <div className={css.formGrid}>{fields.map(field => {
        const value = draft[field.key]
        const update = (next: JsonValue): void => setDraft(current => ({ ...current, [field.key]: next }))
        if (field.input === 'boolean') {
          return <div key={field.key} className={css.providerFieldControl}>
            <Checkbox checked={value === true} label={field.label} onChange={next => update(next)} />
            {field.description !== undefined && <small>{field.description}</small>}
          </div>
        }
        return <label key={field.key}>{field.label}
          {field.input === 'select'
            ? <SelectField hideLabel label={field.label} value={typeof value === 'string' ? value : ''} options={[{ value: '', label: '—' }, ...(field.options ?? []).map(option => ({ value: option.value, label: option.label }))]} onChange={update} />
            : <input type={field.input === 'secret' ? 'password' : field.input === 'number' ? 'number' : field.input === 'url' ? 'url' : 'text'} value={typeof value === 'string' || typeof value === 'number' ? value : ''} required={field.required && field.input !== 'secret'} autoComplete={field.input === 'secret' ? 'new-password' : undefined} placeholder={field.input === 'secret' ? t('sourcePage.secretPlaceholder') : undefined} onChange={event => update(event.target.value)} />}
          {field.description !== undefined && <small>{field.description}</small>}
        </label>
      })}</div>
      {error !== null && <div className={css.alert} role="alert">{error}</div>}
      {saved && <div className={css.runtimeNotice} role="status">{t('sourcePage.configSaved')}</div>}
      <div><button type="submit" className={css.primaryButton} disabled={saving || loading || props.management === undefined || props.instance.availability === 'unavailable'}>{saving ? t('sourcePage.configSaving') : t('sourcePage.configSave')}</button>{props.management === undefined && <span>{t('sourcePage.unavailable')}</span>}</div>
    </form>}
    {fields.length === 0 && props.instance.availability === 'unavailable' && <div className={css.emptyState}><span className={css.emptyGlyph}>!</span><div><h3>{t('sourcePage.unavailable')}</h3><p>{t('sourcePage.unavailableDescription')}</p></div></div>}
  </div>
}
