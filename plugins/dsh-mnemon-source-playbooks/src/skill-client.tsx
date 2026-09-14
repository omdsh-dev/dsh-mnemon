import { useEffect, useRef, useState } from 'react'
import { MemoryFileEditor, MemoryPluginMetrics, MemoryPluginNotice, MemoryPluginSurface, useRequestVersion, type MemorySourcePageProps } from 'dsh-mnemon/client'
import { managementError } from 'dsh-mnemon/client'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import type { SkillBundle } from './skill-bundle.ts'
import type { SkillBasis } from './skill-store.ts'
import { NativeSkills } from './skill-native-client.tsx'

type Snapshot = { revision: string; records: RecordValue[]; bases: Array<SkillBasis & { handled: boolean }> }
type Mutation = (operation: string, input: Record<string, MemoryJsonValue>) => Promise<boolean>
const json = (value: unknown): MemoryJsonValue => JSON.parse(JSON.stringify(value)) as MemoryJsonValue
const bundleOf = (record: RecordValue) => record.data.bundle as unknown as SkillBundle
const pending = (record: RecordValue) => record.state === 'pending'
const styles = `.mnemon-skills-layout{display:grid;grid-template-columns:minmax(170px,1fr) minmax(0,3fr);gap:14px}.mnemon-skills-layout .sk-list{display:flex;flex-direction:column;gap:6px;min-width:0}.mnemon-skills-layout .sk-list>button{text-align:left;padding:12px}.mnemon-skills-layout .sk-list>button[aria-pressed=true]{background:var(--mc-hover);border-color:var(--mc-muted)}.mnemon-skills-layout .sk-list strong,.mnemon-skills-layout .sk-list small{display:block}.mnemon-skills-layout .sk-detail{min-width:0}.sk-checks{display:grid;gap:8px}.sk-checks>div{display:flex;gap:6px;flex-wrap:wrap}.sk-checks input{flex:1;min-width:120px}.sk-checks input:last-of-type{flex:2;font-family:ui-monospace,monospace}.sk-timeline{display:grid;gap:8px;margin-top:12px}.sk-timeline article{padding:12px}.sk-timeline pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;font-size:12px}.sk-empty{padding:28px 16px;border:1px dashed var(--mc-border);border-radius:10px;color:var(--mc-muted)}@container(max-width:720px){.mnemon-skills-layout{grid-template-columns:1fr}.mnemon-skills-layout .sk-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}}`

export function SkillsPage(props: MemorySourcePageProps) { return <SkillsView key={JSON.stringify([props.sourceInstanceKey, props.workspaceId, props.sessionId])} {...props} /> }
function SkillsView(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [snapshot, setSnapshot] = useState<Snapshot>({ revision: '', records: [], bases: [] }), [tab, setTab] = useState('pending'), [selected, setSelected] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [query, setQuery] = useState(''), [watchedRun, setWatchedRun] = useState('')
  const [generate, setGenerate] = useState(false), [create, setCreate] = useState(false), [basisId, setBasisId] = useState(''), [baseId, setBaseId] = useState(''), [instruction, setInstruction] = useState('')
  const requests = useRequestVersion(), busyRef = useRef(false), dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const versions = snapshot.records.filter(record => record.kind === 'skill-version'), active = versions.filter(record => record.state === 'active')
  const opportunities = snapshot.bases.filter(basis => !basis.handled), runs = snapshot.records.filter(record => record.kind === 'skill-run').slice(-6).reverse()
  useEffect(() => {
    const run = snapshot.records.find(record => record.id === watchedRun)
    if (!run || run.data.status === 'running') return
    setWatchedRun('')
    setNotice(run.data.status === 'completed' ? run.data.kind === 'generate' ? t('Candidate generated. Review its resources before publishing.', '候选已生成，请审核资源后再发布。') : t('Checks completed. Inspect the actual results below.', '检查已完成，请查看下方实际结果。') : t('The run did not complete successfully. Inspect its results before retrying.', '本次运行未成功完成，请查看结果后再重试。'))
  }, [snapshot.records, watchedRun])
  const chosenBasis = opportunities.find(basis => basis.id === basisId) ?? opportunities[0]
  const filtered = versions.filter(record => (tab === 'history' ? ['archived', 'rejected'].includes(record.state) : record.state === tab) && (record.title + bundleOf(record).name).toLowerCase().includes(query.toLowerCase())).reverse()
  const record = filtered.find(record => record.id === selected) ?? filtered[0]
  async function refresh(poll = false) {
    if (!props.management || busyRef.current || poll && dirtyRef.current) return
    const token = requests.begin()
    if (!poll) setBusy(true)
    busyRef.current = true
    try {
      const result = await props.management.read('skills-snapshot', {})
      if (requests.isCurrent(token)) { setSnapshot(result.value as unknown as Snapshot); if (!poll) setError('') }
    } catch (error) { if (requests.isCurrent(token)) setError(managementError(error, zh)) }
    finally { if (requests.isCurrent(token)) { busyRef.current = false; setBusy(false) } }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(true), 2500); return () => clearInterval(timer) }, [])
  const mutate: Mutation = async (operation, input) => {
    if (!props.management || !props.writable || busyRef.current) return false
    busyRef.current = true; setBusy(true); setError(''); setNotice('')
    const token = requests.begin()
    try {
      // Every target retains its own version/digest fence; unrelated feedback may update the Source revision.
      const current = await props.management.read('skills-snapshot', {})
      const result = await props.management.mutate(operation, input, { expectedRevision: current.revision, confirmed: true })
      if (!requests.isCurrent(token)) return false
      setDirty(false); dirtyRef.current = false
      if (operation === 'skills-propose' || operation === 'skills-restore') { setSelected(String((result.value as { id?: string })?.id ?? '')); setTab('pending'); setCreate(false) }
      if (operation === 'skills-publish') setTab('active')
      if (['skills-generate', 'skills-validate'].includes(operation)) setWatchedRun(String((result.value as { id?: string })?.id ?? ''))
      if (operation === 'skills-generate') { setGenerate(false); setTab('pending'); setNotice(t('Generating a candidate with the selected session model. You can keep working and return to review it.', '正在使用当前会话模型生成候选。可以继续工作，完成后再回来审核。')) }
      else if (operation === 'skills-validate') setNotice(t('Checks are running through DSH. The results below belong to this exact candidate.', '正在通过 DSH 运行检查，下方结果将对应当前候选内容。'))
      else if (operation === 'skills-use') setNotice(t('The skill task was sent to the current conversation.', '技能任务已发送到当前会话。'))
      else setNotice(t('Saved.', '已保存。'))
      const value = await props.management.read('skills-snapshot', {})
      if (requests.isCurrent(token)) setSnapshot(value.value as unknown as Snapshot)
      return true
    } catch (error) { if (requests.isCurrent(token)) setError(managementError(error, zh)); return false }
    finally { if (requests.isCurrent(token)) { busyRef.current = false; setBusy(false) } }
  }
  function navigate(next: string, id?: string) {
    if (dirty) { setNotice(t('Save or discard the candidate edits before switching.', '请先保存或放弃候选修改，再切换视图。')); return }
    setTab(next); setSelected(id ?? ''); setCreate(false)
  }
  function openRunCandidate(id: string) {
    const state = versions.find(version => version.id === id)?.state
    navigate(state === 'active' ? 'active' : state === 'archived' || state === 'rejected' ? 'history' : 'pending', id)
  }
  const disabled = busy || !props.writable
  return <MemoryPluginSurface title={t('Skills', '技能')} description={t('Turn useful experience into native skills. Review resources, validate changes and publish a version you can trace.', '将有效经验整理为原生技能。审核资源、验证修改，再发布可追溯的版本。')} actions={<button disabled={busy || dirty} onClick={() => void refresh()}>{t('Refresh', '刷新')}</button>}>
    <style>{styles}</style><MemoryPluginMetrics items={[{ label: t('Awaiting review', '待审核'), value: versions.filter(pending).length }, { label: t('Published', '已发布'), value: active.length }, { label: t('Needs follow-up', '待跟进'), value: snapshot.bases.filter(basis => basis.kind === 'feedback' && !basis.handled).length }]} />
    {error && <MemoryPluginNotice error>{error}</MemoryPluginNotice>}{notice && <MemoryPluginNotice>{notice}</MemoryPluginNotice>}
    <div className="mc-toolbar">{[['pending', t('Candidates', '待审核')], ['active', t('Published', '已发布')], ['history', t('History', '历史')], ['native', t('Native catalog', '原生技能')]].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => navigate(id!)}>{label}</button>)}<input aria-label={t('Search skills', '搜索技能')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search skills', '搜索技能')} /></div>
    <footer><button disabled={disabled || dirty || !opportunities.length} onClick={() => { setGenerate(value => !value); setCreate(false) }}>{t('Generate from experience', '从经验生成')} {opportunities.length > 0 ? `(${opportunities.length})` : ''}</button><button disabled={disabled || dirty} onClick={() => { setCreate(value => !value); setGenerate(false) }}>{t('New candidate', '新建候选')}</button></footer>
    {generate && chosenBasis && <form onSubmit={event => { event.preventDefault(); void mutate('skills-generate', { basisId: chosenBasis.id, basisDigest: chosenBasis.digest, baseId: chosenBasis.kind === 'feedback' ? chosenBasis.recordId! : baseId, instruction }) }}>
      <h3>{t('Generate a reviewed skill candidate', '生成待审核技能')}</h3><p>{t('The model reads the selected evidence and any version being refined. It may produce scripts and tests; publication follows a separate review.', '模型会读取所选证据及待改进版本，按需生成脚本和测试，随后进入审核流程。')}</p>
      <label>{t('Evidence to use', '依据')}<select value={chosenBasis.id} disabled={busy} onChange={event => { setBasisId(event.target.value); setBaseId('') }}>{opportunities.map(basis => <option key={basis.id} value={basis.id}>{basis.kind === 'feedback' ? t('Feedback: ', '反馈：') : ''}{basis.title} · {basis.signals} {t('signals', '条证据')}</option>)}</select></label>
      <details><summary>{t('Inspect the evidence', '查看依据内容')}</summary><p className="mc-content">{chosenBasis.content}</p>{chosenBasis.evidence?.map(evidence => <blockquote key={evidence.id}><small>{evidence.origin} · {evidence.verifiedByHuman ? t('Human evidence', '人工证据') : t('Reported result', '结果报告')}</small><p>{evidence.content}</p></blockquote>)}</details>
      {chosenBasis.kind !== 'feedback' && <label>{t('Revision target', '改进目标')}<select value={baseId} onChange={event => setBaseId(event.target.value)}><option value="">{t('Create a new reusable skill', '创建新的通用技能')}</option>{active.filter(record => record.data.enabled !== false && record.scope === chosenBasis.scope).map(record => <option key={record.id} value={record.id}>{record.title} · v{String(record.data.release)}</option>)}</select></label>}
      <label>{t('Requirements for this candidate', '本次候选要求')}<textarea value={instruction} maxLength={4000} onChange={event => setInstruction(event.target.value)} placeholder={t('Expected inputs, outputs and checks', '补充预期输入、输出与验证要求')} /></label>
      <footer><button data-primary="true" disabled={disabled || !props.sessionId} type="submit">{t('Generate candidate', '生成候选')}</button><button type="button" disabled={busy} onClick={() => setGenerate(false)}>{t('Cancel', '取消')}</button></footer>
    </form>}
    {create && <CandidateEditor key="new" {...props} busy={busy} mutate={mutate} onDirty={setDirty} />}
    {runs.length > 0 && <details open={runs.some(run => run.data.status === 'running')}><summary>{t('Generation and validation runs', '生成与验证记录')}</summary><div className="sk-timeline">{runs.map(run => <article key={run.id}><strong>{run.data.kind === 'generate' ? t('Generate · ', '生成 · ') : t('Validate · ', '验证 · ')}{run.title.replace(/^(Draft|Validate) /, '')}</strong><div className="mc-meta"><span>{stateText(String(run.data.status), zh)}</span><time>{new Date(run.updatedAt).toLocaleString(props.locale)}</time></div>{Array.isArray(run.data.results) && run.data.results.map((value, index) => { const result = value as { label: string; status: string; command: string; exitCode: number | null; output: string }; return <details key={index}><summary>{result.label} · {stateText(result.status, zh)} · exit {String(result.exitCode ?? '—')}</summary><pre>{result.command}{'\n'}{result.output}</pre></details> })}{run.data.error && <p role="alert">{String(run.data.error)}</p>}{run.data.candidateId && <button onClick={() => openRunCandidate(String(run.data.candidateId))}>{versions.find(version => version.id === run.data.candidateId)?.state === 'pending' ? t('Review candidate', '审核候选') : t('View version', '查看版本')}</button>}{run.data.status === 'running' && <button disabled={disabled} onClick={() => void mutate('skills-cancel', { id: run.id })}>{t('Cancel run', '取消运行')}</button>}</article>)}</div></details>}
    {tab === 'native' ? <NativeSkills {...props} onNotice={setNotice} onError={setError} onDirty={setDirty} onGenerationStarted={id => { setWatchedRun(id); setTab('pending'); void refresh() }} /> : !create && <div className="mnemon-skills-layout" style={{ marginTop: 18 }}><nav className="sk-list" aria-label={t('Skill versions', '技能版本')}>{filtered.map(item => <button key={item.id} aria-pressed={record?.id === item.id} onClick={() => navigate(tab, item.id)}><strong>{item.title}</strong><small>{bundleOf(item).name} · v{String(item.data.release)}</small><small>{stateText(item.state, zh)}{item.state === 'active' && item.data.enabled === false ? t(' · Disabled', ' · 已停用') : ''}</small></button>)}</nav><div className="sk-detail">{record ? <CandidateEditor key={record.id + ':' + record.version} {...props} record={record} original={snapshot.records.find(version => version.id === (record.data.baseId ?? record.data.nativeOriginId))} events={snapshot.records.filter(event => event.kind === 'skill-event' && event.data.skillId === record.id)} busy={busy} mutate={mutate} onDirty={setDirty} onRefine={() => { const basis = opportunities.find(basis => basis.recordId === record.id && basis.kind === 'feedback'); if (basis) { setBasisId(basis.id); setGenerate(true) } }} /> : <div className="sk-empty">{tab === 'pending' ? t('No candidates yet. Start with reusable experience or create a skill candidate.', '暂无候选。从可复用经验生成，或新建一个技能候选。') : t('No skill versions in this view.', '此视图下暂无技能版本。')}</div>}</div></div>}
  </MemoryPluginSurface>
}

const defaultBundle = (): SkillBundle => ({ name: 'new-skill', description: 'Describe when to use this skill.', files: [{ path: 'SKILL.md', content: '---\nname: new-skill\ndescription: Describe when to use this skill.\n---\n\n# New skill\n\nDescribe the procedure, inputs and expected outcomes.\n' }], checks: [] })
function CandidateEditor(props: MemorySourcePageProps & { record?: RecordValue; original?: RecordValue | undefined; events?: RecordValue[]; busy: boolean; mutate: Mutation; onDirty(value: boolean): void; onRefine?(): void }) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en, record = props.record, editable = !record || pending(record)
  const [bundle, setBundle] = useState<SkillBundle>(() => record ? bundleOf(record) : defaultBundle()), [title, setTitle] = useState(record?.title ?? ''), [reason, setReason] = useState(''), [scope, setScope] = useState('project'), [quote, setQuote] = useState(''), [verdict, setVerdict] = useState('helpful'), [task, setTask] = useState('')
  const dirty = !record ? !!title || !!reason : JSON.stringify(bundle) !== JSON.stringify(bundleOf(record)) || title !== record.title
  useEffect(() => { props.onDirty(dirty) }, [dirty])
  const unavailable = props.busy || !props.writable, input = { id: record?.id ?? '', version: record?.version ?? 0 }
  const validation = record?.data.validation as { status?: string; digest?: string } | undefined, inspection = record?.data.inspection as { errors?: string[]; warnings?: string[] } | undefined
  const basis = record?.data.basis as unknown as SkillBasis | undefined
  function metadata(name: string, description: string) {
    setBundle(value => ({ ...value, name, description, files: value.files.map(file => file.path === 'SKILL.md' ? { ...file, content: file.content.replace(/^name:.*$/m, 'name: ' + JSON.stringify(name)).replace(/^description:.*$/m, 'description: ' + JSON.stringify(description)) } : file) }))
  }
  const save = () => void props.mutate(record ? 'skills-update' : 'skills-propose', { ...input, title, bundle: json(bundle), reason, scope })
  return <article onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && editable && dirty) { event.preventDefault(); if (!unavailable) save() } }}>
    <header><div><h3>{record?.title ?? t('New skill candidate', '新建技能候选')}</h3><div className="mc-meta"><span className="mc-badge">{record ? stateText(record.state, zh) : t('Draft', '草稿')}</span>{record && <span>v{String(record.data.release)}</span>}<span>{(record?.scope ?? scope) === 'global' ? t('Global', '全局') : t('Project', '当前项目')}</span></div></div></header>
    {editable && <><div className="mc-fields"><label>{t('Skill title', '技能标题')}<input value={title} disabled={unavailable} maxLength={300} onChange={event => setTitle(event.target.value)} /></label><label>{t('Reusable skill name', '通用技能名称')}<input value={bundle.name} disabled={unavailable || !!record?.data.baseId || !!record?.data.nativeOriginId} onChange={event => metadata(event.target.value, bundle.description)} /></label></div><label>{t('When to use', '适用场景')}<input value={bundle.description} disabled={unavailable} maxLength={1000} onChange={event => metadata(bundle.name, event.target.value)} /></label></>}
    {!record && <><label>{t('Scope', '作用域')}<select value={scope} onChange={event => setScope(event.target.value)}><option value="project">{t('Current project', '当前项目')}</option><option value="global">{t('Global', '全局')}</option></select></label><label>{t('Why this skill is reusable', '整理依据与复用价值')}<textarea value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} /></label></>}
    {basis && <details><summary>{t('Evidence and authoring rationale', '依据与整理说明')}</summary><p>{String(record?.data.reason ?? '')}</p><p className="mc-content">{basis.content}</p><small>{basis.kind} · {basis.signals} {t('independent signals', '条独立证据')}</small></details>}
    <MemoryFileEditor files={bundle.files} {...(props.original ? { originalFiles: bundleOf(props.original).files } : {})} locale={props.locale} readOnly={!editable} disabled={unavailable} onChange={files => setBundle(value => ({ ...value, files }))} />
    <details open={editable && bundle.checks.length > 0}><summary>{t('Validation checks', '验证检查')} ({bundle.checks.length})</summary><p>{t('Commands run from a separate copy of this bundle through DSH. Review each command before running it.', '命令通过 DSH 在此候选的独立副本中运行。请先检查每条命令。')}</p><div className="sk-checks">{bundle.checks.map((check, index) => <div key={index}><input aria-label={t('Check label ', '检查名称 ') + (index + 1)} value={check.label} disabled={unavailable || !editable} onChange={event => setBundle(value => ({ ...value, checks: value.checks.map((check, i) => i === index ? { ...check, label: event.target.value } : check) }))} /><input aria-label={t('Check command ', '检查命令 ') + (index + 1)} value={check.command} disabled={unavailable || !editable} onChange={event => setBundle(value => ({ ...value, checks: value.checks.map((check, i) => i === index ? { ...check, command: event.target.value } : check) }))} />{editable && <button disabled={unavailable} onClick={() => setBundle(value => ({ ...value, checks: value.checks.filter((_check, i) => i !== index) }))}>{t('Remove', '移除')}</button>}</div>)}</div>{editable && <button disabled={unavailable || bundle.checks.length >= 6} onClick={() => setBundle(value => ({ ...value, checks: [...value.checks, { label: '', command: '' }] }))}>{t('Add check', '添加检查')}</button>}</details>
    {editable && inspection?.errors?.map(error => <p role="alert" key={error}>{error}</p>)}{record && pending(record) && <p>{bundle.checks.length ? t('Check result: ', '检查结果：') + stateText(validation?.status ?? 'not-run', zh) : t('Instructions only. Structural validation is required before publication.', '仅包含说明文档，发布前需要通过结构校验。')}</p>}
    {editable && <footer><button data-primary="true" disabled={unavailable || !dirty || !title.trim() || !record && !reason.trim()} onClick={save}>{record ? t('Save candidate', '保存候选') : t('Create candidate', '创建候选')}</button>{record && <button disabled={unavailable || !dirty} onClick={() => { setBundle(bundleOf(record)); setTitle(record.title) }}>{t('Discard edits', '放弃修改')}</button>}</footer>}
    {record && pending(record) && <footer>{bundle.checks.length > 0 && <button disabled={unavailable || dirty || !!inspection?.errors?.length} onClick={() => void props.mutate('skills-validate', input)}>{t('Run declared checks', '运行上述检查')}</button>}<button data-primary="true" disabled={unavailable || dirty || !!inspection?.errors?.length || !!bundle.checks.length && validation?.status !== 'passed'} onClick={() => void props.mutate('skills-publish', input)}>{props.original ? t('Approve and replace version', '审核并替换版本') : t('Approve and publish', '审核并发布')}</button><button disabled={unavailable || dirty} onClick={() => void props.mutate('skills-reject', input)}>{t('Dismiss candidate', '不采纳')}</button></footer>}
    {record?.state === 'active' && <><footer><button disabled={unavailable} onClick={() => void props.mutate('skills-toggle', input)}>{record.data.enabled === false ? t('Enable skill', '启用技能') : t('Disable skill', '停用技能')}</button><button disabled={unavailable} onClick={() => void props.mutate('skills-archive', input)}>{t('Archive version', '归档版本')}</button>{props.events?.some(event => event.data.concern && !event.data.resolvedBy) && <button disabled={unavailable} onClick={props.onRefine}>{t('Refine from feedback', '根据反馈生成修订')}</button>}</footer><details><summary>{t('Use in this session', '在当前会话中使用')}</summary><label>{t('Task for this skill', '要执行的任务')}<textarea value={task} maxLength={4000} onChange={event => setTask(event.target.value)} /></label><button disabled={unavailable || !task.trim() || record.data.enabled === false || !props.sessionId} onClick={() => void props.mutate('skills-use', { ...input, task })}>{t('Load and use native skill', '加载并使用原生技能')}</button></details></>}
    {record?.state === 'archived' && <footer><button disabled={unavailable} onClick={() => void props.mutate('skills-restore', input)}>{t('Restore as a reviewed candidate', '恢复为待审核候选')}</button></footer>}
    {record && ['active', 'archived'].includes(record.state) && <details><summary>{t('Usage and feedback', '使用与反馈')}</summary><div className="mc-meta"><span>{t('Native loads: ', '原生加载：')}{props.events?.filter(event => event.data.kind === 'native-load').length ?? 0}</span><span>{t('Executions: ', '执行记录：')}{props.events?.filter(event => event.data.kind === 'execution').length ?? 0}</span><span>{t('Model reports: ', '模型报告：')}{props.events?.filter(event => event.data.kind === 'reported-use').length ?? 0}</span></div><label>{t('Feedback category', '反馈类型')}<select value={verdict} onChange={event => setVerdict(event.target.value)}>{[['helpful', t('Helpful', '有效')], ['incorrect', t('Incorrect', '存在错误')], ['outdated', t('Outdated', '需要更新')], ['failed', t('Execution failed', '执行失败')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>{t('Observed result', '实际观察到的结果')}<textarea value={quote} maxLength={2000} onChange={event => setQuote(event.target.value)} /></label><button disabled={unavailable || !quote.trim()} onClick={async () => { if (await props.mutate('skills-feedback', { ...input, verdict, quote })) setQuote('') }}>{t('Record feedback', '记录反馈')}</button><div className="sk-timeline">{props.events?.slice(-12).reverse().map(event => <article key={event.id}><small>{event.data.verifiedByHuman ? t('Human feedback', '人工反馈') : event.data.kind === 'native-load' ? t('Native load', '原生加载') : event.data.kind === 'execution' ? t('Native execution', '原生执行') : t('Model report', '模型报告')} · v{String(event.data.release)}{event.data.resolvedBy ? t(' · Addressed by a revision', ' · 已由修订处理') : ''}</small><p className="mc-content">{event.content}</p></article>)}</div></details>}
  </article>
}
function stateText(value: string, zh: boolean): string { const labels: Record<string, [string, string]> = { pending: ['Awaiting review', '待审核'], active: ['Published', '已发布'], archived: ['Archived', '已归档'], rejected: ['Dismissed', '未采纳'], running: ['Running', '运行中'], completed: ['Completed', '已完成'], passed: ['Passed', '已通过'], failed: ['Failed', '未通过'], blocked: ['Blocked', '未获准执行'], cancelled: ['Cancelled', '已取消'], 'not-run': ['Not run', '尚未运行'] }; return labels[value]?.[zh ? 1 : 0] ?? value }
