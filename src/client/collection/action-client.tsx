import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryJsonValue } from '../../core/contracts/index.ts'
import type { MemorySourcePageProps } from '../source-pages.tsx'
import type { RecordSnapshot, RecordValue } from '../../sdk/source/records.ts'
import type { CollectionField, Localized } from './client.tsx'
import { collectionStyles } from './collection-styles.ts'
export function managementError(reason: unknown, zh: boolean): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return /revision (?:changed|conflict)|version changed/.test(message)
    ? zh
      ? '内容已发生变化。请刷新，检查后重新保存；填写内容已保留。'
      : 'The content changed. Refresh, review it and save again. Your input has been retained.'
    : message
}
export interface RecordActionPanelOptions {
  title: Localized
  filter(record: RecordValue): boolean
  fields?: CollectionField[]
  buttons: Array<{
    label: Localized
    operation: string
    read?: boolean
    openSession?(record: RecordValue): string
    visible?(record: RecordValue): boolean
    input?(record: RecordValue, fields: Record<string, MemoryJsonValue>): MemoryJsonValue
  }>
  details?(record: RecordValue, zh: boolean): ReactNode
  result?(value: MemoryJsonValue, zh: boolean): ReactNode
}
export function RecordActionPanel({
  options,
  ...props
}: MemorySourcePageProps & { options: RecordActionPanelOptions }) {
  const zh = props.locale.startsWith('zh'),
    label = (v: Localized) => (zh ? v['zh-CN'] : v.en)
  const [snapshot, setSnapshot] = useState<RecordSnapshot>({ revision: '', records: [] }),
    [selected, setSelected] = useState(''),
    [fields, setFields] = useState<Record<string, MemoryJsonValue>>({}),
    [result, setResult] = useState<MemoryJsonValue>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const scopeKey = JSON.stringify([props.sourceInstanceKey, props.workspaceId, props.sessionId])
  const scope = useRef({ key: scopeKey }), latestLoad = useRef(0)
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey }
  useEffect(() => {
    if (scope.current.key !== scopeKey) scope.current = { key: scopeKey }
    const current = scope.current
    setSnapshot({ revision: '', records: [] }); setSelected(''); setFields({}); setResult(null); setError(''); setBusy(false)
    return () => { if (scope.current === current) scope.current = { key: '' } }
  }, [scopeKey])
  const load = useCallback(async () => {
    if (!props.management) return
    const current = scope.current, sequence = ++latestLoad.current
    const value = (await props.management.read('snapshot')).value as unknown as RecordSnapshot
    if (scope.current !== current || latestLoad.current !== sequence) return
    setSnapshot(value)
    setSelected((previous) =>
      value.records.some((record) => record.id === previous && options.filter(record))
        ? previous
        : (value.records.filter(options.filter)[0]?.id ?? ''),
    )
  }, [props.management, options])
  useEffect(() => {
    const current = scope.current
    void load().catch((reason) => { if (scope.current === current) setError(managementError(reason, zh)) })
  }, [load, zh])
  const choices = snapshot.records.filter(options.filter),
    titleCounts = new Map<string, number>()
  for (const value of choices) titleCounts.set(value.title, (titleCounts.get(value.title) ?? 0) + 1)
  const choiceLabel = (value: RecordValue) =>
    (titleCounts.get(value.title) ?? 0) > 1
      ? value.title + ' · ' + new Date(value.createdAt).toLocaleString(props.locale) + ' · ' + value.id.slice(0, 8)
      : value.title
  const record = choices.find((value) => value.id === selected)
  async function execute(button: RecordActionPanelOptions['buttons'][number]) {
    if (!props.management || !record) return
    const current = scope.current
    setBusy(true)
    setError('')
    setResult(null)
    try {
      if (button.openSession) {
        await props.sessionNavigation?.open(button.openSession(record))
        return
      }
      const input = button.input?.(record, fields) ?? {
        id: record.id,
        version: record.version,
        ...Object.fromEntries(
          (options.fields ?? []).map((field) => [
            field.key,
            fields[field.key] ?? field.defaultValue ?? (field.type === 'boolean' ? false : ''),
          ]),
        ),
      }
      const response = button.read
        ? await props.management.read(button.operation, input)
        : await props.management.mutate(button.operation, input, {
            confirmed: true,
            expectedRevision: snapshot.revision,
          })
      if (scope.current !== current) return
      setResult(response.value)
      await load()
      if (scope.current === current) props.onRefresh?.()
    } catch (reason) {
      if (scope.current === current) setError(managementError(reason, zh))
    } finally {
      if (scope.current === current) setBusy(false)
    }
  }
  return (
    <section data-mnemon-collection aria-label={label(options.title)}>
      <style>{collectionStyles}</style>
      <header>
        <h2>{label(options.title)}</h2>
        <button onClick={() => void load().catch((reason) => setError(managementError(reason, zh)))}>
          {zh ? '刷新操作面板' : 'Refresh controls'}
        </button>
      </header>
      <label>
        {zh ? '选择条目' : 'Select item'}{' '}
        <select
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value)
            setResult(null)
          }}
        >
          <option value="">{zh ? '请选择' : 'Choose an item'}</option>
          {choices.map((value) => (
            <option key={value.id} value={value.id}>
              {choiceLabel(value)}
            </option>
          ))}
        </select>
      </label>
      {record && (
        <article style={{ marginTop: 16 }}>
          <h3>{record.title}</h3>
          {options.details?.(record, zh)}
          <div className="mc-fields">
            {options.fields?.map((field) => (
              <label key={field.key}>
                {field.type !== 'boolean' && label(field.label)}
                {field.type === 'select' ? (
                  <select
                    value={String(fields[field.key] ?? field.defaultValue ?? '')}
                    onChange={(event) => setFields((value) => ({ ...value, [field.key]: event.target.value }))}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {label(option.label)}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'boolean' ? (
                  <>
                    <input
                      type="checkbox"
                      checked={(fields[field.key] ?? field.defaultValue) === true}
                      onChange={(event) => setFields((value) => ({ ...value, [field.key]: event.target.checked }))}
                    />
                    {label(field.label)}
                  </>
                ) : field.type === 'textarea' ? (
                  <textarea
                    maxLength={40_000}
                    value={String(fields[field.key] ?? field.defaultValue ?? '')}
                    onChange={(event) => setFields((value) => ({ ...value, [field.key]: event.target.value }))}
                  />
                ) : (
                  <input
                    type={field.type === 'number' ? 'number' : 'text'}
                    maxLength={4000}
                    value={String(fields[field.key] ?? field.defaultValue ?? '')}
                    onChange={(event) =>
                      setFields((value) => ({
                        ...value,
                        [field.key]: field.type === 'number' ? Number(event.target.value) : event.target.value,
                      }))
                    }
                  />
                )}
              </label>
            ))}
          </div>
          <footer>
            {options.buttons
              .filter((button) => button.visible?.(record) ?? true)
              .map((button) => (
                <button
                  key={button.operation}
                  disabled={
                    busy ||
                    (!button.read && !button.openSession && !props.writable) ||
                    (!!button.openSession && !props.sessionNavigation)
                  }
                  onClick={() => void execute(button)}
                >
                  {label(button.label)}
                </button>
              ))}
          </footer>
        </article>
      )}
      {error && <p role="alert">{error}</p>}
      {result !== null && (
        <div role="status">{options.result?.(result, zh) ?? (zh ? '操作已完成。' : 'Operation completed.')}</div>
      )}
    </section>
  )
}
