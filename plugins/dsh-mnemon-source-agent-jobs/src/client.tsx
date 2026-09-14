import { MemoryExecutionStatus } from 'dsh-mnemon/client'
import type { MemoryExecutionState } from 'dsh-mnemon/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { installMemorySourceUI, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import { collectionStyles, createCollectionPage } from 'dsh-mnemon/client'
import type { RecordSnapshot } from 'dsh-mnemon/source-sdk'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { ExecutionPlan } from './engine.ts'
import { JobInputPanel } from './inputs-client.tsx'
import { JobStatistics } from './statistics-client.tsx'
export const inject = ['slots']
interface AdapterSummary { id: string; label: string; models: string[]; supportsImages: boolean; resumable: boolean }
function JobControls(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), [snapshot, setSnapshot] = useState<RecordSnapshot>({ revision: '', records: [] }), [selected, setSelected] = useState(''), [plan, setPlan] = useState<{ value: ExecutionPlan; revision: string } | null>(null), [log, setLog] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const epoch = useRef(0), selectedRef = useRef(selected)
  selectedRef.current = selected
  useEffect(() => { epoch.current++; setSnapshot({ revision: '', records: [] }); setSelected(''); setPlan(null); setLog(''); setError(''); setBusy(false); return () => { epoch.current++ } }, [props.management])
  const load = useCallback(async () => {
    if (!props.management) return
    const current = epoch.current
    const response = await props.management.read('snapshot'), value = response.value as unknown as RecordSnapshot
    if (current !== epoch.current) return
    setSnapshot(value)
    setSelected(current => value.records.some(record => record.id === current) ? current : value.records.filter(record => record.state === 'active').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id ?? '')
  }, [props.management])
  useEffect(() => { void load().catch(reason => setError(String(reason))); const timer = setInterval(() => { void load().catch(reason => setError(String(reason))) }, 2000); return () => clearInterval(timer) }, [load])
  const record = snapshot.records.find(record => record.id === selected)
  useEffect(() => { setPlan(current => current?.value.jobId === selected && current.value.version === record?.version ? current : null); setLog('') }, [selected, record?.version])
  const readLog = useCallback(async () => {
    if (!props.management || !selected) return
    const current = epoch.current
    const value = (await props.management.read('lookup-job-log', { id: selected })).value as { items: Array<{ text: string }> }
    if (current !== epoch.current || selectedRef.current !== selected) return
    setLog(value.items.map(item => item.text).join('\n'))
  }, [props.management, selected])
  useEffect(() => { if (!record || !['running', 'queued'].includes(String(record.data.status))) return; const timer = setInterval(() => { void readLog().catch(reason => setError(String(reason))) }, 1500); return () => clearInterval(timer) }, [readLog, record?.data.status])
  async function preview() {
    if (!props.management) return
    setBusy(true); setError('')
    const current = epoch.current
    try { const response = await props.management.read('execution-plan', { id: selected }); if (current === epoch.current && selectedRef.current === selected) setPlan({ value: response.value as unknown as ExecutionPlan, revision: response.revision }) }
    catch (reason) { if (current === epoch.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (current === epoch.current) setBusy(false) }
  }
  async function operate(operation: string, input: MemoryJsonValue, revision = snapshot.revision) {
    if (!props.management) return
    setBusy(true); setError('')
    const current = epoch.current
    try {
      const response = await props.management.mutate(operation, input, { confirmed: true, expectedRevision: revision }); if (current !== epoch.current) return; setSnapshot(response.value as unknown as RecordSnapshot); setPlan(null)
      if (operation === 'retry-job') setSelected((response.value as unknown as RecordSnapshot).records.filter(value => value.data.previousJobId === selected).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id ?? selected)
      await load(); props.onRefresh?.()
    } catch (reason) { if (current === epoch.current) { setError(reason instanceof Error ? reason.message : String(reason)); await load() } }
    finally { if (current === epoch.current) setBusy(false) }
  }
  const status: Record<string, string> = zh ? { draft: '待执行', queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', 'timed-out': '超时' } : { draft: 'Draft', queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', 'timed-out': 'Timed out' }
  return <section data-mnemon-collection aria-label={zh ? '执行控制' : 'Execution controls'}><style>{collectionStyles}</style><h2>{zh ? '执行控制' : 'Execution controls'}</h2>
    <label>{zh ? '选择任务' : 'Select job'} <select value={selected} onChange={event => setSelected(event.target.value)}><option value="">{zh ? '请选择' : 'Choose a job'}</option>{snapshot.records.filter(record => record.state === 'active').map(record => <option key={record.id} value={record.id}>{record.title} · {status[String(record.data.status)] ?? String(record.data.status)}</option>)}</select></label>
    {record && <article style={{ marginTop: 16 }}><h3>{record.title}</h3>{record.data.status === 'draft' ? <p>{status.draft}</p> : <MemoryExecutionStatus locale={props.locale} execution={{ id: record.id, state: record.data.status as MemoryExecutionState, ...(typeof record.data.exitCode === 'number' ? { exitCode: record.data.exitCode } : {}) }} />}
      {record.data.status === 'cancelled' ? <p>{zh ? '取消已生效，可读取日志或复制为新任务。' : 'Cancellation took effect. Read the log or copy this request for another run.'}</p> : typeof record.data.error === 'string' && <p role="alert">{record.data.error}</p>}{typeof record.data.deliveryError === 'string' && <p>{zh ? '结果投递失败：' : 'Result delivery failed: '}{String(record.data.deliveryError)}</p>}
      <footer>{record.data.status === 'draft' && <button disabled={busy || !props.writable} onClick={() => void preview()}>{zh ? '预览执行计划' : 'Preview execution plan'}</button>}
      {['queued', 'running'].includes(String(record.data.status)) && <button disabled={busy || !props.writable} onClick={() => void operate('stop-job', { id: selected })}>{zh ? '取消任务' : 'Cancel job'}</button>}
      {['succeeded', 'failed', 'cancelled', 'interrupted', 'timed-out'].includes(String(record.data.status)) && <><button disabled={busy || !props.writable} onClick={() => void operate('retry-job', { id: selected })}>{zh ? '复制为新任务' : 'Copy for retry'}</button>{typeof record.data.externalSessionId === 'string' && <button disabled={busy || !props.writable} onClick={() => void operate('retry-job', { id: selected, resume: true })}>{zh ? '继续外部会话' : 'Resume external session'}</button>}</>}
      <button disabled={busy} onClick={() => void readLog().catch(reason => setError(String(reason)))}>{zh ? '读取日志' : 'Read log'}</button></footer>
    </article>}
    {record && <JobInputPanel {...props} record={record} revision={snapshot.revision} onSaved={load} />}
    {plan && <article aria-label={zh ? '待确认的执行计划' : 'Execution plan to confirm'} style={{ marginTop: 16 }}><h3>{zh ? '执行计划' : 'Execution plan'}</h3>
      <p>{zh ? '程序' : 'Program'}: <code>{plan.value.command}</code><br />{zh ? '工作目录' : 'Working directory'}: {plan.value.cwd}<br />{zh ? '时限' : 'Timeout'}: {plan.value.timeoutSeconds}s</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(plan.value.args, null, 2)}</pre>
      {plan.value.stdin && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{plan.value.prompt}</pre>}
      <footer><button data-primary="true" disabled={busy || !props.writable} onClick={() => void operate('start-job', { id: selected, plan: plan.value } as unknown as MemoryJsonValue, plan.revision)}>{zh ? '确认并执行' : 'Confirm and run'}</button><button onClick={() => setPlan(null)}>{zh ? '关闭计划' : 'Close plan'}</button></footer>
    </article>}
    {error && <p role="alert">{error}</p>}{log && <article style={{ marginTop: 16 }}><h3>{zh ? '最近日志' : 'Recent log'}</h3><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{log}</pre></article>}
  </section>
}
export function Page(props: MemorySourcePageProps) {
  const [adapters, setAdapters] = useState<AdapterSummary[]>([]), [error, setError] = useState(''), zh = props.locale.startsWith('zh')
  useEffect(() => { let active = true; void props.management?.read('adapters').then(response => { if (active) setAdapters(response.value as unknown as AdapterSummary[]) }).catch(reason => { if (active) setError(String(reason)) }); return () => { active = false } }, [props.management])
  const Collection = useMemo(() => createCollectionPage({ title: { en: 'Job requests', 'zh-CN': '任务请求' }, description: { en: 'Write a prompt, approve the request and inspect its execution plan.', 'zh-CN': '填写提示词、采纳任务请求，再检查具体执行计划。' }, kinds: [{ value: 'job', label: { en: 'CLI job', 'zh-CN': 'CLI 任务' } }], scopes: ['project'], defaultScope: 'project', editable: record => record.data.status === 'draft', fields: [
    { key: 'adapter', label: { en: 'Adapter', 'zh-CN': '执行适配器' }, type: 'select', options: adapters.map(adapter => ({ value: adapter.id, label: { en: adapter.label, 'zh-CN': adapter.label } })), defaultValue: adapters[0]?.id ?? '' },
    { key: 'model', label: { en: 'Model (optional)', 'zh-CN': '模型（可选）' }, type: 'text' },
    { key: 'attachments', label: { en: 'Image paths to copy after saving (comma separated)', 'zh-CN': '保存后待复制的图片路径（逗号分隔）' }, type: 'list' },
    { key: 'context', label: { en: 'Reference context', 'zh-CN': '参考上下文' }, type: 'textarea' },
    { key: 'notify', label: { en: 'Deliver result to the originating session', 'zh-CN': '将结果投递到来源会话' }, type: 'boolean', defaultValue: true },
  ] }), [adapters])
  return <><JobStatistics {...props} /><JobControls {...props} /><hr />{error && <p role="alert">{error}</p>}{adapters.length ? <Collection {...props} /> : <p>{zh ? '请在本插件配置中添加 CLI 适配器，然后刷新页面。' : 'Configure a CLI adapter in this plugin, then refresh the page.'}</p>}</>
}
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'agent-jobs', pages: [{ id: 'jobs', label: 'Jobs', localizedLabel: { en: 'Jobs', 'zh-CN': '后台任务' }, order: 47, component: Page, coordinateSources: true, navigation: { group: 'sources', primary: true } }] }) }
