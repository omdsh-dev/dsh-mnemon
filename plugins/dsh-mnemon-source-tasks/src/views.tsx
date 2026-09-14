import { useEffect, useState, type ReactNode } from 'react'
import type { MemorySourcePageProps } from 'dsh-mnemon/client'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
export interface TaskFilters { kind: string; status: string; due: string; date: string; category: string }
export const taskDay = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export const taskQuadrant = (record: RecordValue) => (record.data.important === true ? 0 : 2) + (record.data.urgent === true ? 0 : 1)
export function filterTasks(records: RecordValue[], filters: TaskFilters, day: string): RecordValue[] {
  return records.filter(record => {
    const due = typeof record.data.due === 'string' ? record.data.due : '', status = String(record.data.status ?? 'pending')
    return (!filters.kind || record.kind === filters.kind)
      && (!filters.status || (filters.status === 'open' ? !['done', 'cancelled'].includes(status) : status === filters.status))
      && (!filters.date || record.date === filters.date)
      && (!filters.category || record.data.category === filters.category)
      && (!filters.due || (filters.due === 'none' ? !due : filters.due === 'overdue' ? !!due && due < day && !['done', 'cancelled'].includes(status) : filters.due === 'today' ? due === day : !!due && due > day))
  }).sort((a, b) => Number(['done', 'cancelled'].includes(String(a.data.status))) - Number(['done', 'cancelled'].includes(String(b.data.status)))
    || String(a.data.due || '9999-12-31').localeCompare(String(b.data.due || '9999-12-31')) || taskQuadrant(a) - taskQuadrant(b) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}
const styles = `.task-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}.task-filters label{margin:0!important}.task-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.task-matrix{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.task-quadrant{min-width:0;padding:14px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px}.task-quadrant>h3{margin:0 0 12px!important;font-size:16px}.task-quadrant[data-priority="0"]{border-top:3px solid #c77965}.task-quadrant[data-priority="1"]{border-top:3px solid #579878}.task-quadrant[data-priority="2"]{border-top:3px solid #bb964c}.task-quadrant[data-priority="3"]{border-top:3px solid #718096}.task-controls button[aria-pressed=true]{border-color:#579878;background:color-mix(in srgb,#579878 16%,transparent)}@media(max-width:850px){.task-matrix{grid-template-columns:1fr}}`
export function TaskViews({ props, records, renderRecord }: { props: MemorySourcePageProps; records: RecordValue[]; renderRecord(record: RecordValue): ReactNode }) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [matrix, setMatrix] = useState(false), [filters, setFilters] = useState<TaskFilters>({ kind: '', status: '', due: '', date: '', category: '' }), [limit, setLimit] = useState(25)
  useEffect(() => setLimit(25), [filters, matrix])
  const field = (key: keyof TaskFilters, value: string) => setFilters(old => ({ ...old, [key]: value }))
  const filtered = filterTasks(records, filters, taskDay()), categories = [...new Set(records.flatMap(record => typeof record.data.category === 'string' && record.data.category ? [record.data.category] : []))].sort()
  const groups = [t('Urgent and important', '紧急且重要'), t('Important, not urgent', '重要不紧急'), t('Urgent, less important', '紧急不重要'), t('Routine tasks', '常规事项')]
  const more = matrix ? [0, 1, 2, 3].some(index => filtered.filter(record => taskQuadrant(record) === index).length > limit) : filtered.length > limit
  return <div><style>{styles}</style><div className="task-filters" aria-label={t('Task filters', '任务筛选')}>
    <label>{t('Task type', '任务类型')}<select value={filters.kind} onChange={event => field('kind', event.target.value)}><option value="">{t('All types', '全部类型')}</option>{[['project', 'Project', '项目'], ['personal', 'Personal', '个人'], ['work', 'Work', '工作'], ['daily', 'Daily', '每日']].map(([value, en, cn]) => <option key={value} value={value}>{t(en!, cn!)}</option>)}</select></label>
    <label>{t('Progress', '完成状态')}<select value={filters.status} onChange={event => field('status', event.target.value)}>{[['', 'All states', '全部状态'], ['open', 'Unfinished', '尚未完成'], ['pending', 'Pending', '未开始'], ['in-progress', 'In progress', '进行中'], ['blocked', 'Blocked', '受阻'], ['done', 'Done', '已完成'], ['cancelled', 'Cancelled', '已取消']].map(([value, en, cn]) => <option key={value} value={value}>{t(en!, cn!)}</option>)}</select></label>
    <label>{t('Deadline', '截止范围')}<select value={filters.due} onChange={event => field('due', event.target.value)}>{[['', 'Any deadline', '不限截止日期'], ['overdue', 'Overdue', '已逾期'], ['today', 'Due today', '今天到期'], ['upcoming', 'Upcoming', '未来到期'], ['none', 'No deadline', '未设日期']].map(([value, en, cn]) => <option key={value} value={value}>{t(en!, cn!)}</option>)}</select></label>
    <label>{t('Daily task date', '每日任务日期')}<input type="date" value={filters.date} onChange={event => field('date', event.target.value)} /></label>
    <label>{t('Task category', '任务分类')}<select value={filters.category} onChange={event => field('category', event.target.value)}><option value="">{t('All categories', '全部分类')}</option>{categories.map(category => <option key={category}>{category}</option>)}</select></label>
  </div><div className="task-controls"><button aria-pressed={!matrix} onClick={() => setMatrix(false)}>{t('List view', '列表视图')}</button><button aria-pressed={matrix} onClick={() => setMatrix(true)}>{t('Priority matrix', '重要与紧急矩阵')}</button><button onClick={() => setFilters({ kind: '', status: '', due: '', date: '', category: '' })}>{t('Clear task filters', '清除任务筛选')}</button><small aria-live="polite">{filtered.length} {t('matching tasks', '项匹配任务')}</small></div>
  {matrix ? <div className="task-matrix">{groups.map((title, index) => { const values = filtered.filter(record => taskQuadrant(record) === index); return <section className="task-quadrant" data-priority={index} key={index} aria-label={title}><h3>{title} · {values.length}</h3><div className="mc-list">{values.slice(0, limit).map(renderRecord)}</div>{!values.length && <p>{t('No tasks in this quadrant.', '此象限暂无任务。')}</p>}</section> })}</div> : <div className="mc-list">{filtered.slice(0, limit).map(renderRecord)}</div>}
  {!matrix && !filtered.length && <p className="mc-empty">{t('No tasks match these filters.', '没有匹配筛选条件的任务。')}</p>}{more && <button onClick={() => setLimit(old => old + 25)}>{t('Load more tasks', '加载更多任务')}</button>}</div>
}
