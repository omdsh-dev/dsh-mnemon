import { useState, type ReactNode } from 'react'
import type { MemorySourcePageProps } from 'dsh-mnemon/client'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { filterLibrary } from './library.ts'

export function LibraryViews({ props, records, renderRecord }: { props: MemorySourcePageProps; records: RecordValue[]; renderRecord(record: RecordValue): ReactNode }) {
  const zh = props.locale.startsWith('zh'), [filters, setFilters] = useState({ name: '', category: '', tag: '', summary: '' }), [limit, setLimit] = useState(25)
  const labels = { name: zh ? '方法名称' : 'Playbook name', category: zh ? '方法分类' : 'Playbook category', tag: zh ? '标签筛选' : 'Filter tags', summary: zh ? '简介筛选' : 'Filter descriptions' }
  const categories = [...new Set(records.flatMap(record => typeof record.data.category === 'string' && record.data.category ? [record.data.category] : []))].sort()
  const filtered = filterLibrary(records, filters)
  return <div><div aria-label={zh ? '方法筛选' : 'Playbook filters'} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, margin: '16px 0' }}>{(Object.keys(labels) as Array<keyof typeof labels>).map(key => <label key={key}>{labels[key]}{key === 'category' ? <select value={filters.category} onChange={event => { setFilters(old => ({ ...old, category: event.target.value })); setLimit(25) }}><option value="">{zh ? '全部分类' : 'All categories'}</option>{categories.map(category => <option key={category}>{category}</option>)}</select> : <input value={filters[key]} onChange={event => { setFilters(old => ({ ...old, [key]: event.target.value })); setLimit(25) }} />}</label>)}</div>
    <button onClick={() => { setFilters({ name: '', category: '', tag: '', summary: '' }); setLimit(25) }}>{zh ? '清除方法筛选' : 'Clear playbook filters'}</button><p aria-live="polite">{filtered.length} {zh ? '项匹配方法' : 'matching playbooks'}</p>
    <div className="mc-list">{filtered.slice(0, limit).map(renderRecord)}</div>{filtered.length > limit && <button onClick={() => setLimit(old => old + 25)}>{zh ? '加载更多方法' : 'Load more playbooks'}</button>}
  </div>
}
