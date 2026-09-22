import { useCallback, useEffect, useRef, useState } from 'react'
import { installMemorySourceUI, MemoryMarkdown, MemoryPluginMetrics, MemoryPluginNotice, MemoryPluginSurface, MemorySourcePageFrame, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { RecordSnapshot, RecordValue } from 'dsh-mnemon/source-sdk'
import { managementError } from 'dsh-mnemon/client'
export const inject = ['slots']
type Snapshot = RecordSnapshot & { policy?: { [key: string]: MemoryJsonValue } }
type Fields = { [key: string]: MemoryJsonValue }
const dictionary = {
  'zh-CN': { title: '经验整理', description: '从真实对话、任务结果与明确反馈中整理可复用经验。每条建议都保留证据，审核后才能进入记忆。', review: '开始整理', running: '整理中…', refresh: '刷新', pending: '待审核', active: '已采纳与转存', evidence: '证据回流', history: '整理记录', archived: '已归档与拒绝', restore: '重新提交审核', more: '加载更多', rounds: '未整理用户轮次', proposals: '待审核建议', adopted: '已采纳经验', concerns: '需要重新审核', none: '当前视图暂无记录。', approve: '采纳到经验库', reject: '拒绝', archive: '归档', edit: '编辑建议', save: '保存修改', cancel: '取消', titleField: '建议标题', content: '建议内容', signals: '条独立证据', showEvidence: '查看证据', preference: '稳定偏好', fact: '长期事实', procedure: '可复用方法', global: '全局', project: '项目', reads: '被读取', uses: '模型自报使用', helpful: '有帮助', incorrect: '不准确', outdated: '已过时', irrelevant: '不相关', quote: '反馈说明', feedback: '记录使用反馈', submit: '保存反馈', saved: '已保存', transfer: '转入目标插件待审核', destination: '目标插件', transferred: '已转入目标插件，原建议保留追踪记录', targetPending: '目标中待审核', targetActive: '目标中已生效', needsReview: '收到问题反馈，需要重新审核', resolution: '审核结论', resolve: '完成重新审核', chooseSession: '选择会话并发送消息后即可开始整理。', notUseful: '读取只表示提供过上下文；是否有帮助由人工评价确认。', waitSignals: '稳定偏好需要至少两次独立的用户证据。', automatic: '自动采纳', historyMore: '查看变更记录', noDest: '启用项目笔记或技能与提示词插件后，可转入相应的待审核队列。' },
  en: { title: 'Learning', description: 'Distill reusable learning from real conversations, task outcomes and explicit feedback. Proposals retain their evidence and enter memory only after review.', review: 'Review learning', running: 'Reviewing…', refresh: 'Refresh', pending: 'Needs review', active: 'Adopted and transferred', evidence: 'Evidence and feedback', history: 'Review history', archived: 'Archived and rejected', restore: 'Return to review', more: 'Load more', rounds: 'Unreviewed human turns', proposals: 'Pending proposals', adopted: 'Adopted learning', concerns: 'Needs another review', none: 'No records in this view.', approve: 'Adopt into learning', reject: 'Reject', archive: 'Archive', edit: 'Edit proposal', save: 'Save changes', cancel: 'Cancel', titleField: 'Proposal title', content: 'Proposal content', signals: 'independent signals', showEvidence: 'Inspect evidence', preference: 'Stable preference', fact: 'Durable fact', procedure: 'Reusable procedure', global: 'Global', project: 'Project', reads: 'Reads', uses: 'Model-reported uses', helpful: 'Helpful', incorrect: 'Incorrect', outdated: 'Outdated', irrelevant: 'Irrelevant', quote: 'Feedback explanation', feedback: 'Record usage feedback', submit: 'Save feedback', saved: 'Saved', transfer: 'Send to destination for review', destination: 'Destination plugin', transferred: 'Transferred; this record retains its feedback history', targetPending: 'Pending at destination', targetActive: 'Active at destination', needsReview: 'Concern reported; review this learning again', resolution: 'Review conclusion', resolve: 'Resolve feedback review', chooseSession: 'Choose a session and send a message to begin collecting learning.', notUseful: 'A read records context exposure. Helpfulness requires explicit human feedback.', waitSignals: 'Stable preferences need at least two independent human observations.', automatic: 'Automatic adoption', historyMore: 'Inspect change history', noDest: 'Enable Project notes or Playbooks to send proposals to their review queues.' },
}
export function Page(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), t = dictionary[zh ? 'zh-CN' : 'en']
  const [snapshot, setSnapshot] = useState<Snapshot>({ revision: '', records: [] }), [tab, setTab] = useState<'pending' | 'active' | 'evidence' | 'history' | 'archived'>('pending')
  const [limit, setLimit] = useState(30), [selected, setSelected] = useState<string[]>([])
  useEffect(() => { setLimit(30); setSelected([]) }, [tab, props.workspaceId, props.sessionId])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [editing, setEditing] = useState(''), [title, setTitle] = useState(''), [content, setContent] = useState('')
  const [feedback, setFeedback] = useState(''), [verdict, setVerdict] = useState('helpful'), [quote, setQuote] = useState(''), [destination, setDestination] = useState<Record<string, string>>({}), [resolution, setResolution] = useState('')
  const epoch = useRef(0), serial = useRef(0), pending = useRef(false), latest = useRef(snapshot)
  latest.current = snapshot
  const load = useCallback(async () => {
    if (!props.management || pending.current) return
    const generation = epoch.current, request = ++serial.current
    try { const response = await props.management.read('snapshot'); if (generation === epoch.current && request === serial.current) { setSnapshot(response.value as unknown as Snapshot); setError('') } }
    catch (e) { if (generation === epoch.current && request === serial.current) setError(managementError(e, zh)) }
  }, [props.management, zh])
  useEffect(() => { epoch.current++; serial.current++; pending.current = false; setSnapshot({ revision: '', records: [] }); setEditing(''); setFeedback(''); setError(''); setNotice(''); setBusy(false); setDestination({}); return () => { epoch.current++; serial.current++ } }, [props.management?.sourceInstanceKey, props.workspaceId, props.sessionId])
  useEffect(() => { void load() }, [load])
  const cycle = snapshot.records.find(r => r.kind === 'cycle'), running = cycle?.data.status === 'running'
  useEffect(() => { if (!running) return; const timer = setInterval(() => void load(), 2000); return () => clearInterval(timer) }, [running, load])
  const write = async (operation: string, input: Fields, message = t.saved) => {
    if (!props.management || !props.writable || pending.current) return false
    const generation = epoch.current; pending.current = true; serial.current++; setBusy(true); setError(''); setNotice('')
    try {
      const result = await props.management.mutate(operation, input, { confirmed: true, expectedRevision: latest.current.revision })
      if (generation !== epoch.current) return false
      setSnapshot(result.value as unknown as Snapshot); setSelected([]); setNotice(message); props.onRefresh?.(); return true
    } catch (e) { if (generation === epoch.current) setError(managementError(e, zh)); return false }
    finally { if (generation === epoch.current) { pending.current = false; setBusy(false) } }
  }
  const proposals = snapshot.records.filter(r => r.kind === 'proposal'), rounds = Number(cycle?.data.rounds ?? 0) - Number(cycle?.data.completedRound ?? 0)
  const newEvidence = rounds + Number(cycle?.data.feedback ?? 0) - Number(cycle?.data.completedFeedback ?? 0) + Number(cycle?.data.outcomes ?? 0) - Number(cycle?.data.completedOutcomes ?? 0)
  const transfer = async (record: RecordValue, key: string) => {
    if (!props.management || !props.managementDirectory || !props.writable || pending.current) return
    const target = props.managementDirectory.client(key)
    if (!target) return
    const generation = epoch.current; pending.current = true; serial.current++; setBusy(true); setError(''); setNotice('')
    try {
      const transferKey = `${props.management.sourceInstanceKey}:${record.id}`, before = await target.read('snapshot')
      if (generation !== epoch.current) return
      const matching = (before.value as unknown as RecordSnapshot).records.filter(item => item.state === 'active' && item.kind === 'skill' && record.data.category === 'procedure' && item.scope === record.scope && item.data.slug === record.data.slug)
      if (matching.length > 1) throw new Error('Multiple active skills share this name; propose the revision from Playbooks')
      const result = await target.mutate('receive-proposal', { transferKey, ...(matching[0] ? { supersedes: { id: matching[0].id, version: matching[0].version } } : {}), title: record.title, content: record.content, kind: record.data.category === 'procedure' ? 'skill' : 'fact', scope: record.scope, data: { origin: 'learning', evidenceCount: record.signals, ...(record.data.category === 'procedure' ? { slug: record.data.slug!, enabled: true } : {}) } }, { confirmed: true, expectedRevision: before.revision })
      if (generation !== epoch.current) return
      const copied = (result.value as unknown as RecordSnapshot).records.find(r => r.data.mnemonTransfer === transferKey)
      if (!copied) throw new Error('Destination did not return a durable transfer record')
      const current = await props.management.read('snapshot')
      if (generation !== epoch.current) return
      const candidate = (current.value as unknown as RecordSnapshot).records.find(r => r.id === record.id)
      if (!candidate || candidate.content !== record.content) throw new Error('Proposal changed during transfer; inspect both records before retrying')
      const linked = await props.management.mutate('link-destination', { id: record.id, version: candidate.version, sourceInstanceKey: key, learningSourceInstanceKey: props.management.sourceInstanceKey, recordId: copied.id, destinationState: copied.state }, { confirmed: true, expectedRevision: current.revision })
      if (generation !== epoch.current) return
      setSnapshot(linked.value as unknown as Snapshot); setNotice(t.transferred); props.onRefresh?.()
    } catch (e) { if (generation === epoch.current) setError(managementError(e, zh)) }
    finally { if (generation === epoch.current) { pending.current = false; setBusy(false) } }
  }
  const rows = tab === 'pending' ? proposals.filter(r => r.state === 'pending') : tab === 'active' ? proposals.filter(r => r.state === 'active' || r.data.destination) : tab === 'archived' ? proposals.filter(r => ['archived', 'rejected'].includes(r.state) && !r.data.destination) : snapshot.records.filter(r => (tab === 'history' ? ['run', 'failure'] : ['observation', 'assessment', 'effect']).includes(r.kind)).slice().reverse()
  const selectedRecords = rows.filter(record => selected.includes(record.id) && record.kind === 'proposal' && ['active', 'pending'].includes(record.state) && !record.data.destination)
  const batch = (operation: string) => write(operation, { recordIds: selectedRecords.map(record => record.id), versions: Object.fromEntries(selectedRecords.map(record => [record.id, record.version])), supersededVersions: Object.fromEntries(selectedRecords.flatMap(record => { const original = proposals.find(item => item.id === record.data.supersedes); return original ? [[record.id, original.version]] : [] })) })
  const needsReview = (record: RecordValue) => record.data.needsReview === true && !record.data.replacedBy
  const category = (record: RecordValue) => t[record.data.category as 'preference' | 'fact' | 'procedure'] ?? record.kind
  const evidenceLabel = (record: RecordValue) => {
    if (record.data.attribution === 'assistant-report') return zh ? '助手报告 · 未经人工确认' : 'Assistant report · not human verified'
    const labels: Record<string, string> = zh
      ? { 'human-turn': '用户对话', 'human-feedback': '明确反馈', 'task-outcome': '任务结果', 'job-outcome': '后台任务结果', 'review-output': '审核结果', assessment: '使用评价', effect: '使用记录', run: '整理记录', failure: '整理失败' }
      : { 'human-turn': 'Human conversation', 'human-feedback': 'Explicit feedback', 'task-outcome': 'Task result', 'job-outcome': 'Background job result', 'review-output': 'Review result', assessment: 'Usage feedback', effect: 'Usage record', run: 'Review history', failure: 'Review failed' }
    return labels[String(record.data.origin ?? record.kind)] ?? record.kind
  }
  const recordTitle = (record: RecordValue) => {
    if (record.kind === 'proposal') return record.title
    if (record.data.origin === 'human-turn') return (zh ? '用户对话 ' : 'Human turn ') + String(record.data.turn ?? record.data.round ?? '')
    if (record.data.attribution === 'assistant-report') return (zh ? '助手报告 ' : 'Assistant report ') + String(record.data.turn ?? '')
    if (record.kind === 'assessment') return t[record.data.verdict as 'helpful' | 'incorrect' | 'outdated' | 'irrelevant'] ?? record.title
    return ['run', 'failure'].includes(record.kind) || record.data.origin === 'human-feedback' ? evidenceLabel(record) : record.title
  }
  return <MemorySourcePageFrame locale={props.locale}><MemoryPluginSurface title={t.title} description={t.description} actions={<><button disabled={busy} onClick={() => void load()}>{t.refresh}</button>{' '}<button data-primary="true" disabled={!props.writable || busy || running || newEvidence < 1} onClick={() => void write('review-now', {}, t.running)}>{running ? t.running : t.review}</button></>}>
    <MemoryPluginMetrics items={[{ label: t.rounds, value: rounds }, { label: t.proposals, value: proposals.filter(r => r.state === 'pending').length }, { label: t.adopted, value: proposals.filter(r => r.state === 'active' || r.data.destinationState === 'active').length }, { label: t.concerns, value: proposals.filter(needsReview).length }]} />
    {!cycle && <p>{t.chooseSession}</p>}{error && <MemoryPluginNotice error>{error}</MemoryPluginNotice>}{notice && (notice !== t.running || cycle?.data.status !== 'failed') && <MemoryPluginNotice>{notice === t.running && !running ? zh ? '整理完成，建议已进入审核队列。' : 'Review complete. Proposals are ready for approval.' : notice}</MemoryPluginNotice>}{cycle?.data.status === 'failed' && <MemoryPluginNotice error>{String(cycle.data.error)}</MemoryPluginNotice>}
    <details><summary>{zh ? '数据回流与采纳设置' : 'Feedback and adoption settings'}</summary><div className="mc-fields">{[
      ['captureFeedback', zh ? '记录明确的用户反馈' : 'Capture explicit human feedback'],
      ['captureOutcomes', zh ? '记录任务、作业与审核结果' : 'Capture task, job and review outcomes'],
      ['autoAcceptFacts', zh ? '自动采纳重复证据支持的事实' : 'Automatically adopt facts supported by repeated evidence'],
      ['autoAcceptPreferences', zh ? '自动采纳至少两条独立人工证据支持的偏好' : 'Automatically adopt preferences with two independent human signals'],
    ].map(([key, label]) => <label key={key}>{label}<input type="checkbox" checked={snapshot.policy?.[key!] === true} disabled={busy || !props.writable} onChange={event => void write('configure', { settings: { [key!]: event.target.checked } })} /></label>)}</div><small>{zh ? '默认仅收集证据，建议由你审核；可复用方法和替换建议始终需要人工审核。' : 'Evidence collection is enabled by default; proposals require your review. Procedures and replacements always need human review.'}</small></details>
    <div className="mc-toolbar">{(['pending', 'active', 'evidence', 'history', 'archived'] as const).map(value => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{t[value]}</button>)}</div>
    {props.writable && ['pending', 'active'].includes(tab) && <div className="mc-selection" aria-label={zh ? '批量审核' : 'Batch review'}><button disabled={busy} onClick={() => setSelected(rows.slice(0, limit).filter(record => ['active', 'pending'].includes(record.state) && !record.data.destination).slice(0, 50).map(record => record.id))}>{zh ? '选择当前页' : 'Select this page'}</button>{selectedRecords.length > 0 && <><span>{zh ? '已选' : 'Selected'} {selectedRecords.length}</span><button disabled={busy} onClick={() => setSelected([])}>{zh ? '清除选择' : 'Clear selection'}</button><button data-primary disabled={busy || selectedRecords.some(record => record.state !== 'pending' || record.data.category === 'preference' && (!Array.isArray(record.data.humanKeys) || record.data.humanKeys.length < 2))} onClick={() => void batch('batch-approve')}>{zh ? '采纳所选' : 'Approve selected'}</button><button disabled={busy || selectedRecords.some(record => record.state !== 'pending')} onClick={() => void batch('batch-reject')}>{zh ? '拒绝所选' : 'Reject selected'}</button><button disabled={busy} onClick={() => void batch('batch-archive')}>{zh ? '归档所选' : 'Archive selected'}</button></>}</div>}
    <div className="mc-list">{rows.slice(0, limit).map(record => {
      const isProposal = record.kind === 'proposal', humanSignals = Array.isArray(record.data.humanKeys) ? record.data.humanKeys.length : 0
      const targets = props.managementDirectory?.sources.filter(source => source.availability !== 'unavailable' && (record.data.category === 'procedure' ? source.role === 'instruction-library' : record.scope === 'project' && source.role === 'project-context')) ?? []
      const targetKey = destination[record.id] ?? (targets.length === 1 ? targets[0]!.sourceInstanceKey : '')
      const original = proposals.find(r => r.id === record.data.supersedes)
      return <article key={record.id} data-record-id={record.id}>
        {isProposal && props.writable && ['active', 'pending'].includes(record.state) && !record.data.destination && <label className="mc-selection"><input type="checkbox" aria-label={(zh ? '选择 ' : 'Select ') + record.title} checked={selected.includes(record.id)} disabled={busy || !selected.includes(record.id) && selected.length >= 50} onChange={event => setSelected(values => event.target.checked ? [...values, record.id] : values.filter(id => id !== record.id))} />{zh ? '选择条目' : 'Select record'}</label>}
        <h3>{recordTitle(record)}</h3><div className="mc-meta"><span className="mc-badge">{isProposal ? category(record) : evidenceLabel(record)}</span><time dateTime={record.updatedAt}>{new Date(record.updatedAt).toLocaleString(props.locale)}</time>{isProposal && <><span>{t[record.scope as 'global' | 'project']}</span><span>{record.signals} {t.signals}</span></>}</div>
        {needsReview(record) && <MemoryPluginNotice>{t.needsReview}</MemoryPluginNotice>}
        {original && <details><summary>{zh ? '对照原版本' : 'Compare with the original'}</summary><div><h3>{original.title}</h3><MemoryMarkdown content={original.content} locale={props.locale} /><small>{zh ? '审核采纳修订后，原版才会归档。' : 'The original is archived only when this revision is approved.'}</small></div></details>}
        {editing === record.id ? <form onSubmit={event => { event.preventDefault(); void write('update', { id: record.id, version: record.version, title, content }).then(ok => { if (ok) setEditing('') }) }}><label>{t.titleField}<input required value={title} onChange={event => setTitle(event.target.value)} /></label><label>{t.content}<textarea required rows={7} value={content} onChange={event => setContent(event.target.value)} /></label><footer><button data-primary="true" disabled={busy}>{t.save}</button><button type="button" onClick={() => setEditing('')}>{t.cancel}</button></footer></form> : <MemoryMarkdown content={record.content} locale={props.locale} />}
        {isProposal && <>
          <details><summary>{t.showEvidence} ({Array.isArray(record.data.evidenceIds) ? record.data.evidenceIds.length : 0})</summary>{snapshot.records.filter(r => Array.isArray(record.data.evidenceIds) && record.data.evidenceIds.includes(r.id)).map(evidence => <div key={evidence.id}><small>{evidenceLabel(evidence)} · {new Date(evidence.createdAt).toLocaleString(props.locale)}</small><MemoryMarkdown content={evidence.content} locale={props.locale} /></div>)}</details>
          {record.state === 'pending' && record.data.category === 'preference' && humanSignals < 2 && <p><small>{t.waitSignals}</small></p>}
          {record.data.destination && <p><small>{record.data.destinationState === 'active' ? t.targetActive : record.data.destinationState === 'pending' ? t.targetPending : record.data.destinationState === 'archived' ? zh ? '目标条目已归档' : 'Archived at destination' : record.data.destinationState === 'rejected' ? zh ? '目标建议已拒绝' : 'Rejected at destination' : zh ? '目标条目已移除' : 'Removed at destination'}</small></p>}
          {(record.state === 'active' || record.data.destination) && <><div className="mc-meta">{(['reads', 'uses', 'helpful'] as const).map(key => <span key={key}>{t[key]}: {Number(record.data[key] ?? 0)}</span>)}</div><small>{t.notUseful}</small></>}
          {props.writable && <footer>{record.state === 'pending' && <><button data-primary="true" disabled={busy || record.data.category === 'preference' && humanSignals < 2} onClick={() => void write('approve', { id: record.id, version: record.version, ...(original ? { supersededVersion: original.version } : {}) })}>{t.approve}</button><button disabled={busy} onClick={() => { setEditing(record.id); setTitle(record.title); setContent(record.content) }}>{t.edit}</button><button disabled={busy} onClick={() => void write('reject', { id: record.id, version: record.version })}>{t.reject}</button></>}{['archived', 'rejected'].includes(record.state) && !record.data.destination && <button disabled={busy} onClick={() => void write('restore', { id: record.id, version: record.version })}>{t.restore}</button>}{record.state === 'active' && <button disabled={busy} onClick={() => void write('archive', { id: record.id, version: record.version })}>{t.archive}</button>}{(record.state === 'active' || record.data.destinationState === 'active') && <button disabled={busy} onClick={() => { setFeedback(record.id); setQuote(''); setVerdict('helpful') }}>{t.feedback}</button>}</footer>}
          {props.writable && !record.data.destination && ['active', 'pending'].includes(record.state) && targets.length > 0 && <details><summary>{t.transfer}</summary><label>{t.destination}<select value={targetKey} onChange={event => setDestination(current => ({ ...current, [record.id]: event.target.value }))}><option value="">—</option>{targets.map(target => <option key={target.sourceInstanceKey} value={target.sourceInstanceKey}>{target.management.label}</option>)}</select></label><button disabled={busy || !targetKey} onClick={() => void transfer(record, targetKey)}>{t.transfer}</button></details>}
          {feedback === record.id && <form onSubmit={event => { event.preventDefault(); void write('record-feedback', { id: record.id, version: record.version, verdict, quote, eventKey: crypto.randomUUID() }).then(ok => { if (ok) setFeedback('') }) }}><label>{t.feedback}<select value={verdict} onChange={event => setVerdict(event.target.value)}>{(['helpful', 'incorrect', 'outdated', 'irrelevant'] as const).map(value => <option key={value} value={value}>{t[value]}</option>)}</select></label><label>{t.quote}<textarea required rows={3} value={quote} onChange={event => setQuote(event.target.value)} /></label><footer><button data-primary="true" disabled={busy}>{t.submit}</button><button type="button" onClick={() => setFeedback('')}>{t.cancel}</button></footer></form>}
          {props.writable && needsReview(record) && <details><summary>{t.resolve}</summary><label>{t.resolution}<textarea value={resolution} onChange={event => setResolution(event.target.value)} /></label><button disabled={busy || !resolution.trim()} onClick={() => void write('resolve-feedback', { id: record.id, version: record.version, reason: resolution })}>{t.resolve}</button></details>}
        </>}
        {record.history.length > 0 && <details><summary>{t.historyMore}</summary>{record.history.slice().reverse().map((entry, index) => <div key={index}><small>{entry.operation} · {new Date(entry.at).toLocaleString(props.locale)}</small><p>{entry.title}</p></div>)}</details>}
      </article>
    })}</div>{rows.length > limit && <button onClick={() => setLimit(value => value + 30)}>{t.more}</button>}{rows.length === 0 && <p className="mc-empty">{t.none}</p>}
  </MemoryPluginSurface></MemorySourcePageFrame>
}
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'learning', pages: [{ id: 'learning', label: 'Learning', localizedLabel: { en: 'Learning', 'zh-CN': '经验整理' }, order: 51, component: Page, coordinateSources: true, navigation: { group: 'sources', primary: true } }] }) }
