import { useEffect, useState, type ReactNode } from 'react'
import type { MemorySourcePageProps } from 'dsh-mnemon/client'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
export function activityDay(record: RecordValue) {
  if (record.date) return record.date
  const date = new Date(typeof record.data.eventAt === 'string' ? record.data.eventAt : record.createdAt)
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
export function JournalViews({ props, records, renderRecord }: { props: MemorySourcePageProps; records: RecordValue[]; renderRecord(record: RecordValue): ReactNode }) {
  const zh=props.locale.startsWith('zh'),t=(en:string,cn:string)=>zh?cn:en
  const [kind,setKind]=useState(''),[from,setFrom]=useState(''),[through,setThrough]=useState(''),[branch,setBranch]=useState(''),[category,setCategory]=useState(''),[limit,setLimit]=useState(25)
  useEffect(()=>setLimit(25),[kind,from,through,branch,category])
  const branches=[...new Set(records.flatMap(record=>typeof record.data.branch==='string'?[record.data.branch]:[]))].sort()
  const categories=[...new Set(records.flatMap(record=>typeof record.data.category==='string'?[record.data.category]:[]))].sort()
  const selected=records.filter(record=>(!kind||record.kind===kind)&&(!from||activityDay(record)>=from)&&(!through||activityDay(record)<=through)&&(!branch||record.data.branch===branch)&&(!category||record.data.category===category))
  return <div><style>{`.journal-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}.journal-filters label{margin:0!important}.journal-count{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}`}</style><div className="journal-filters" aria-label={t('Journal filters','日志筛选')}>
    <label>{t('Activity type','日志类型')}<select value={kind} onChange={event=>setKind(event.target.value)}><option value="">{t('All types','全部类型')}</option><option value="progress">{t('Progress','进展')}</option><option value="feedback">{t('Feedback','反馈')}</option><option value="result">{t('Result','成果')}</option></select></label>
    <label>{t('From date','开始日期')}<input type="date" value={from} onChange={event=>setFrom(event.target.value)}/></label><label>{t('Through date','结束日期')}<input type="date" value={through} min={from} onChange={event=>setThrough(event.target.value)}/></label>
    <label>{t('Recorded branch','记录分支')}<select value={branch} onChange={event=>setBranch(event.target.value)}><option value="">{t('All branches','全部分支')}</option>{branches.map(value=><option key={value}>{value}</option>)}</select></label>
    <label>{t('Activity category','日志分类')}<select value={category} onChange={event=>setCategory(event.target.value)}><option value="">{t('All categories','全部分类')}</option>{categories.map(value=><option key={value}>{value}</option>)}</select></label>
  </div><div className="journal-count"><button onClick={()=>{setKind('');setFrom('');setThrough('');setBranch('');setCategory('')}}>{t('Clear journal filters','清除日志筛选')}</button><small aria-live="polite">{selected.length} {t('matching entries','项匹配日志')}</small></div><div className="mc-list">{selected.slice(0,limit).map(renderRecord)}</div>{!selected.length&&<p className="mc-empty">{t('No entries match these filters.','没有匹配筛选条件的日志。')}</p>}{selected.length>limit&&<button onClick={()=>setLimit(old=>old+25)}>{t('Load more entries','加载更多日志')}</button>}</div>
}
