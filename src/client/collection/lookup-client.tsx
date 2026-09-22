import { MemoryExecutionStatus, MemoryResourceIdentity } from '../context-access.tsx'
import { useEffect, useRef, useState } from 'react'
import type { MemorySourcePageProps } from '../source-pages.tsx'
import type { MemoryEvidenceItem, MemoryJsonValue } from '../../core/contracts/index.ts'
import type { CollectionField, Localized } from './client.tsx'
import type { LookupResult } from '../../sdk/source/lookup.ts'
import { collectionStyles } from './collection-styles.ts'

export interface LookupPanelOptions {
  title: Localized; operation: string; fields: CollectionField[]
  defaults?: { [key: string]: MemoryJsonValue }
  itemActions?: Array<{ label: Localized; operation: string; input(item: MemoryEvidenceItem): MemoryJsonValue; mutate?: boolean; navigate?: boolean; visible?(item: MemoryEvidenceItem): boolean }>
}
export function LookupPanel({ options, ...props }: MemorySourcePageProps & { options: LookupPanelOptions }) {
  const zh = props.locale.startsWith('zh')
  const label = (value: Localized) => zh ? value['zh-CN'] : value.en
  const [input, setInput] = useState<{ [key: string]: MemoryJsonValue }>(options.defaults ?? {})
  const [result, setResult] = useState<LookupResult | null>(null)
  const [detail, setDetail] = useState<LookupResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; setResult(null); setDetail(null); setError(''); return () => { mounted.current = false; const id = current.current; current.current = null; if (id) void props.management?.read('lookup-cancel', { requestId: id }).catch(() => {}) } }, [props.sourceInstanceKey, props.sessionId, props.workspaceId])
  async function run(operation: string, value: MemoryJsonValue, isDetail = false, mutate = false, navigate = false) {
    if (!props.management) return
    const id = crypto.randomUUID()
    current.current = id; setBusy(true); setError('')
    try {
      if (navigate) { await props.sessionNavigation?.open(String((value as { sessionId: string }).sessionId)); return }
      const response = mutate ? await props.management.mutate(operation, value, { confirmed: true, expectedRevision: props.management.revision })
        : await props.management.read('lookup-' + operation, { ...(value as object), requestId: id })
      if (mounted.current && current.current === id) {
        const output = response.value as unknown as LookupResult
        if (Array.isArray(output.items)) { if (isDetail) setDetail(output); else { setResult(output); setDetail(null) } }
        else setDetail({ items: [{ id: 'receipt', text: zh ? '操作已完成。' : 'Operation completed.', provenance: {} }] })
        props.onRefresh?.()
      }
    } catch (reason) { if (mounted.current && current.current === id) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (mounted.current && current.current === id) { setBusy(false); current.current = null } }
  }
  async function cancel() { const id = current.current; if (!id || !props.management) return; try { await props.management.read('lookup-cancel', { requestId: id }) } catch (reason) { setError(String(reason)) } }
  return <section data-mnemon-collection aria-label={label(options.title)}><style>{collectionStyles}</style>
    <h2>{label(options.title)}</h2>
    <form onSubmit={event => { event.preventDefault(); void run(options.operation, input) }}><div className="mc-fields">
      {options.fields.map(field => <label key={field.key}>{label(field.label)}{field.type === 'select' ? <select value={String(input[field.key] ?? field.defaultValue ?? '')} onChange={event => setInput(current => ({ ...current, [field.key]: event.target.value }))}>{field.options?.map(option => <option key={option.value} value={option.value}>{label(option.label)}</option>)}</select>
        : field.type === 'boolean' ? <input type="checkbox" checked={input[field.key] === true} onChange={event => setInput(current => ({ ...current, [field.key]: event.target.checked }))} />
        : <input type={field.type === 'number' ? 'number' : 'text'} maxLength={4000} value={String(input[field.key] ?? field.defaultValue ?? '')} onChange={event => setInput(current => ({ ...current, [field.key]: field.type === 'number' ? Number(event.target.value) : event.target.value }))} />}</label>)}
    </div><footer><button data-primary="true" disabled={busy || !props.management}>{busy ? (zh ? '检索中…' : 'Searching…') : (zh ? '检索' : 'Search')}</button>{busy && <button type="button" onClick={() => void cancel()}>{zh ? '取消检索' : 'Cancel search'}</button>}</footer></form>
    {error && <p role="alert">{error}</p>}
    {result && <><p role="status">{zh ? `找到 ${result.items.length} 条结果` : `${result.items.length} results`}{result.truncated && (zh ? '；结果有截断，请缩小范围。' : '; results were bounded. Narrow the search.')}</p>
      <div className="mc-list">{result.items.map(item => <article key={item.id}>{item.reference && <MemoryResourceIdentity reference={item.reference} locale={props.locale} />}{item.execution && <MemoryExecutionStatus execution={item.execution} locale={props.locale} />}<p className="mc-content">{item.text}</p>{item.provenance && typeof item.provenance === 'object' && !Array.isArray(item.provenance) && <small>{[item.provenance.path, item.provenance.sessionId, item.provenance.role, item.provenance.line ? ':' + String(item.provenance.line) : null, item.provenance.at].filter(Boolean).join(' · ')}</small>}
        <footer>{options.itemActions?.filter(action => action.visible?.(item) ?? true).map(action => <button key={action.operation} disabled={busy || action.mutate && !props.writable || action.navigate && !props.sessionNavigation} onClick={() => void run(action.operation, action.input(item), true, action.mutate, action.navigate)}>{label(action.label)}</button>)}</footer>
      </article>)}</div></>}
    {detail && <section aria-label={zh ? '结果详情' : 'Result details'}><header><h3>{zh ? '结果详情' : 'Result details'}</h3><button onClick={() => setDetail(null)}>{zh ? '关闭详情' : 'Close details'}</button></header>{detail.items.map(item => <pre key={item.id} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 }}>{item.text}</pre>)}{detail.truncated && <p>{zh ? '详情有截断，可缩小读取范围。' : 'The detail is bounded; narrow the read range.'}</p>}</section>}
  </section>
}
