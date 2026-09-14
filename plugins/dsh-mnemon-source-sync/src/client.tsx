import { useCallback, useEffect, useRef, useState } from 'react'
import { installMemorySourceUI, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import type { MemoryJsonValue, MemoryTransferCatalog, MemoryTransferSnapshot, MemoryTransferTrack } from 'dsh-mnemon/contracts'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { canonical, type Binding, type CapturedTrack, type SyncPlan } from './protocol.ts'
import { syncStyles } from './styles.ts'
export const inject = ['slots']
type CatalogTrack = { key: string; sourceKey: string; label: string; track: MemoryTransferTrack; slot: string }
type PushPlan = { targetId: string; remote: string; branch: string; head: string; enabled: boolean }
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as MemoryJsonValue
export function Page(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [targets, setTargets] = useState<RecordValue[]>([]), [selected, setSelected] = useState(''), [revision, setRevision] = useState(''), [tracks, setTracks] = useState<CatalogTrack[]>([]), [plan, setPlan] = useState<SyncPlan>(), [push, setPush] = useState<PushPlan>(), [acceptedPush, setAcceptedPush] = useState(false)
  const [form, setForm] = useState(false), [title, setTitle] = useState(''), [remote, setRemote] = useState(''), [identity, setIdentity] = useState(''), [targetScope, setTargetScope] = useState('project'), [enabled, setEnabled] = useState(true), [chosen, setChosen] = useState<Binding[]>([]), [editing, setEditing] = useState('')
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [suggestion, setSuggestion] = useState({ origin: '', projectKey: '' })
  const epoch = useRef(0), serial = useRef(0), pending = useRef(false), revisionRef = useRef('')
  const rememberRevision = (value: string) => { revisionRef.current = value; setRevision(value) }
  const refresh = useCallback(async () => {
    if (!props.management) return
    const generation = epoch.current, id = ++serial.current
    const result = await props.management.read('status')
    if (generation !== epoch.current || id !== serial.current) return
    const value = result.value as unknown as { targets: RecordValue[]; suggestion: typeof suggestion }
    rememberRevision(result.revision); setTargets(value.targets); setSuggestion(value.suggestion)
    setSelected(old => value.targets.some(target => target.id === old) ? old : value.targets[0]?.id ?? '')
  }, [props.management])
  useEffect(() => {
    const generation = ++epoch.current; pending.current = false; setBusy(false); setForm(false); setPlan(undefined); setPush(undefined); setTargets([]); setSelected(''); setTracks([]); setError(''); setStatus('')
    void refresh().catch(error => { if (generation === epoch.current) setError(String(error)) })
    const directory = props.managementDirectory
    if (directory) void Promise.all(directory.sources.filter(source => source.sourceTypeId !== 'sync' && source.availability !== 'unavailable' && source.capabilities.includes('export') && source.capabilities.includes('import')).map(async source => {
      try { const result = await directory.client(source.sourceInstanceKey)!.read('transfer-catalog'), value = result.value as unknown as MemoryTransferCatalog; if (value.format !== 'mnemon-source-transfer/v1' || !Array.isArray(value.tracks)) return []; return value.tracks.map(track => ({ key: source.sourceInstanceKey + '/' + track.id, sourceKey: source.sourceInstanceKey, label: source.management.label, track, slot: source.sourceTypeId + '-' + track.id })) } catch { return [] }
    })).then(values => { if (generation === epoch.current) setTracks(values.flat()) })
    return () => { epoch.current++; serial.current++ }
  }, [props.management?.sourceInstanceKey, props.workspaceId, props.sessionId])
  const action = async (work: (generation: number) => Promise<void>) => {
    if (pending.current || !props.management || !props.writable) return
    const generation = epoch.current; pending.current = true; setBusy(true); setError(''); setStatus('')
    try { await work(generation) } catch (error) { if (generation === epoch.current) { setError(error instanceof Error ? error.message : String(error)); await refresh().catch(() => {}) } }
    finally { if (generation === epoch.current) { pending.current = false; setBusy(false) } }
  }
  const mutate = async (operation: string, input: unknown, generation: number) => {
    if (generation !== epoch.current) throw new Error('The selected workspace changed')
    const result = await props.management!.mutate(operation, asJson(input), { expectedRevision: revisionRef.current, confirmed: true })
    if (generation !== epoch.current) throw new Error('The selected workspace changed')
    rememberRevision(result.revision); return result
  }
  const target = targets.find(target => target.id === selected)
  useEffect(() => { setPlan(undefined); setPush(undefined); setAcceptedPush(false); setForm(false) }, [selected])
  const readPlan = async () => { const id = ++serial.current, generation = epoch.current; try { const result = await props.management!.read('plan', { id: selected }); if (generation === epoch.current && id === serial.current) { rememberRevision(result.revision); setPlan(result.value as unknown as SyncPlan || undefined); setPush(undefined) } } catch (error) { if (generation === epoch.current && id === serial.current) setError(String(error)) } }
  const prepare = async (generation: number) => {
    if (!target) return
    const captures: CapturedTrack[] = []
    for (const binding of target.data.bindings as unknown as Binding[]) {
      if (generation !== epoch.current) return
      const client = props.managementDirectory?.client(binding.sourceKey)
      if (!client) throw new Error(t('A selected Source is unavailable. Update the target bindings.', '选定的 Source 不可用，请更新目标绑定。'))
      const result = await client.read('transfer-export', { track: binding.track })
      captures.push({ binding, revision: result.revision, snapshot: result.value as unknown as MemoryTransferSnapshot })
    }
    const result = await mutate('prepare', { id: target.id, captures }, generation); setPlan(result.value as unknown as SyncPlan); setPush(undefined)
  }
  const changePlan = async (operation: string, input: Record<string, unknown>, generation: number) => { const result = await mutate(operation, { id: selected, planId: plan?.id, ...input }, generation); const next = result.value as unknown as SyncPlan; setPlan(next); return next }
  const apply = async (generation: number) => {
    let current = await changePlan('begin-apply', {}, generation)
    for (const capture of current.local) {
      const { binding } = capture, client = props.managementDirectory?.client(binding.sourceKey)
      if (!client) throw new Error(t('A selected Source was unloaded. Its data was preserved.', '选定的 Source 已卸载，已有数据保留。'))
      if (generation !== epoch.current) return
      const before = await client.read('transfer-export', { track: binding.track }), expected = current.merged.tracks[binding.slot]!, receipt = current.receipts[binding.slot]
      if (receipt) { if (canonical(before.value) !== canonical(receipt.snapshot)) throw new Error(t('An imported track changed. Cancel this plan and prepare again.', '已导入的记录再次发生变化，请取消本次计划后重新准备。')); continue }
      let imported = before
      if (canonical(before.value) !== canonical(expected)) {
        if (canonical(before.value) !== canonical(capture.snapshot)) throw new Error(t('Local records changed after preview. Cancel this plan and prepare again.', '预览后的本机记录已变化，请取消本次计划后重新准备。'))
        if (generation !== epoch.current) return
        imported = await client.mutate('transfer-import', { snapshot: asJson(expected) }, { expectedRevision: before.revision, confirmed: true })
      }
      const result = await mutate('record-apply', { id: selected, planId: current.id, slot: binding.slot, sourceRevision: imported.revision, snapshot: imported.value }, generation)
      current = result.value as unknown as SyncPlan; setPlan(current)
    }
    const result = await mutate('commit-plan', { id: selected, planId: current.id }, generation); setPlan(result.value as unknown as SyncPlan); await refresh(); setStatus(t('Reviewed imports and the local snapshot are complete. Push is a separate action.', '已完成审阅后的导入和本地快照。推送需要单独操作。'))
  }
  const edit = (target?: RecordValue) => { setEditing(target?.id ?? ''); setTitle(target?.title ?? ''); setRemote(String(target?.data.remote ?? suggestion.origin)); setIdentity(String(target?.data.projectKey ?? suggestion.projectKey)); setTargetScope(target?.scope ?? (props.workspaceId ? 'project' : 'global')); setEnabled(target?.data.enabled !== false); setChosen(target?.data.bindings as unknown as Binding[] ?? []); setForm(true); setPlan(undefined); setPush(undefined) }
  const trackLabel = (binding: Binding) => { const found = tracks.find(track => track.sourceKey === binding.sourceKey && track.track.id === binding.track); return found ? found.label + ' · ' + found.track.label[zh ? 'zh-CN' : 'en'] : binding.slot }
  return <section className="sy-page" aria-label={t('Memory synchronization', '记忆同步')}><style>{syncStyles}</style><h2>{t('Memory synchronization', '记忆同步')}</h2><p>{t('Select the memory tracks to share. Compare changes, apply a reviewed snapshot, then explicitly push to its destination.', '选择需要共享的记忆范围，对比修改并应用审阅后的快照，再单独推送到指定地址。')}</p>
    <div className="sy-row"><button disabled={!props.writable || busy} onClick={() => edit()}>{t('New sync target', '新建同步目标')}</button><button disabled={busy} onClick={() => void refresh().catch(error => setError(String(error)))}>{t('Refresh targets', '刷新目标')}</button><select aria-label={t('Sync target', '同步目标')} disabled={busy} value={selected} onChange={event => { serial.current++; setSelected(event.target.value) }}><option value="">{t('Select a target', '选择目标')}</option>{targets.map(target => <option key={target.id} value={target.id}>{target.title} · {target.data.enabled ? t('Enabled', '已启用') : t('Disabled', '已停用')}</option>)}</select></div>
    {error && <p className="sy-error" role="alert">{error}</p>}{status && <p className="sy-success" role="status">{status}</p>}
    {form && <form onSubmit={event => { event.preventDefault(); void action(async generation => { const saved = await mutate('configure', { ...(editing ? { id: editing } : {}), title, remote, projectKey: identity, scope: targetScope, enabled, bindings: chosen }, generation); const updated = (saved.value as unknown as { targets: RecordValue[] }).targets; const created = updated.find(value => !targets.some(old => old.id === value.id)); setSelected(editing || created?.id || selected); setForm(false); await refresh(); setStatus(t('Sync target saved. No push has occurred.', '同步目标已保存，尚未推送。')) }) }}>
      <h3>{t('Configure a target', '配置同步目标')}</h3><label>{t('Name', '目标名称')}<input required value={title} maxLength={300} onChange={event => setTitle(event.target.value)} /></label>
      <label>{t('Scope', '同步范围')}<select value={targetScope} disabled={!!editing} onChange={event => { setTargetScope(event.target.value); setChosen([]); setIdentity(event.target.value === 'project' ? suggestion.projectKey : 'personal'); if (event.target.value === 'global') setRemote('') }}><option value="project" disabled={!props.workspaceId}>{t('Current project', '当前项目')}</option><option value="global">{t('Global memory', '全局记忆')}</option></select></label>
      <label>{t('Git remote', 'Git 远端地址')}<input required value={remote} placeholder="git@host:owner/private-memory.git" onChange={event => setRemote(event.target.value)} /></label><small>{t('Anyone who can read this remote may read the selected memory. Use a private memory repository when needed.', '能够读取该远端的人也能读取选中的记忆，请按需要使用私有记忆仓库。')}</small>
      <label>{t('Stable project or personal identity', '稳定的项目或个人标识')}<input required value={identity} maxLength={300} onChange={event => setIdentity(event.target.value)} /></label><small>{t('Use the same identity and portable names on each device. The branch is derived from this identity; local paths are not shared.', '各设备使用相同标识和同步名称。分支根据此标识生成，本机路径不用于远端项目归属。')}</small>
      <div className="sy-row"><label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t('Enable this target', '启用此目标')}</label></div>
      <div className="sy-tracks">{tracks.filter(item => item.track.scope === targetScope).map(item => { const binding = chosen.find(value => value.sourceKey === item.sourceKey && value.track === item.track.id); return <div className="sy-track" key={item.key}><label><input type="checkbox" checked={!!binding} onChange={event => setChosen(old => event.target.checked ? [...old, { sourceKey: item.sourceKey, track: item.track.id, slot: item.slot }] : old.filter(value => value !== binding))} />{item.label} · {item.track.label[zh ? 'zh-CN' : 'en']}</label>{binding && <input type="text" aria-label={t('Portable name: ', '同步名称：') + item.label + ' ' + item.track.id} value={binding.slot} pattern="[a-z][a-z0-9-]{0,99}" onChange={event => setChosen(old => old.map(value => value === binding ? { ...value, slot: event.target.value } : value))} />}</div> })}</div>
      {!tracks.some(item => item.track.scope === targetScope) && <p>{t('No available Source publishes a portable track for this scope.', '没有可用于此范围的 Source 同步轨道。')}</p>}<div className="sy-row"><button data-primary disabled={!props.writable || busy || !chosen.length}>{t('Save target', '保存目标')}</button><button type="button" disabled={busy} onClick={() => setForm(false)}>{t('Cancel', '取消')}</button></div>
    </form>}
    {target && !form && <div className="sy-panel"><h3>{target.title}</h3><div className="sy-destination"><code>{String(target.data.remote)}</code><code>{String(target.data.branch)}</code><small>{t('Identity', '标识')}: {String(target.data.projectKey)}</small></div><ul>{(target.data.bindings as unknown as Binding[]).map(binding => <li key={binding.slot}>{trackLabel(binding)} <small>{binding.slot}</small></li>)}</ul>{target.data.lastPushAt && <small>{t('Last push', '最近推送')}: {String(target.data.lastPushAt)}</small>}<div className="sy-row"><button disabled={busy || !props.writable} onClick={() => edit(target)}>{t('Edit / disable', '编辑 / 停用')}</button><button disabled={busy || !target.data.enabled || !props.writable} onClick={() => void action(prepare)}>{t('Fetch and compare', '拉取并对比')}</button><button disabled={busy} onClick={() => void readPlan()}>{t('Open retained plan', '查看保留的计划')}</button><button disabled={busy || (!target.data.lastCommit && !(plan?.targetId === target.id && plan.status === 'complete'))} onClick={() => void action(async generation => { const result = await props.management!.read('push-plan', { id: target.id }); if (generation !== epoch.current) return; rememberRevision(result.revision); setPush(result.value as unknown as PushPlan); setAcceptedPush(false) })}>{t('Review push destination', '查看推送计划')}</button></div></div>}
    {plan && !form && <div className="sy-panel"><h3>{t('Merge plan', '合并计划')}</h3><div>{({ conflicts: t('Awaiting decisions', '等待冲突决策'), ready: t('Ready to apply', '可以应用'), applying: t('Applying; acknowledged tracks are retained', '应用中；已完成的轨道回执保留'), complete: t('Local snapshot committed', '本地快照已提交'), cancelled: t('Cancelled; imported records remain local', '已取消；已导入的记录保留在本机') })[plan.status]}</div><small>{plan.createdAt} · {plan.id}</small>
      <table className="sy-table"><thead><tr><th>{t('Track', '轨道')}</th><th>{t('Local entries', '本机条目')}</th><th>{t('Merged entries', '合并条目')}</th><th>{t('Import receipt', '导入回执')}</th></tr></thead><tbody>{plan.local.map(value => <tr key={value.binding.slot}><td>{trackLabel(value.binding)}</td><td>{value.snapshot.entries.length}</td><td>{plan.merged.tracks[value.binding.slot]?.entries.length}</td><td>{plan.receipts[value.binding.slot] ? t('Acknowledged', '已完成') : t('Pending', '待处理')}</td></tr>)}</tbody></table>
      <details><summary>{t('Inspect complete merged payload', '查看完整合并内容')}</summary><pre>{JSON.stringify(plan.merged, null, 2)}</pre></details>
      {plan.conflicts.map(conflict => <div className="sy-panel" key={conflict.key}><strong>{conflict.slot} · {conflict.id}</strong><div className="sy-versions">{(['base', 'local', 'remote'] as const).map(side => <div key={side}><strong>{side === 'base' ? t('Common version', '共同版本') : side === 'local' ? t('This device', '本机') : t('Remote', '远端')}</strong><pre>{JSON.stringify(conflict[side], null, 2)}</pre></div>)}</div>{conflict.choice ? <p>{t('Chosen', '已选择')}: {conflict.choice}</p> : <div className="sy-row">{(['local', 'remote', 'both'] as const).map(choice => <button key={choice} disabled={busy || !props.writable} onClick={() => void action(generation => changePlan('resolve-conflict', { key: conflict.key, choice }, generation).then(() => {}))}>{choice === 'local' ? t('Keep local', '采用本机') : choice === 'remote' ? t('Keep remote', '采用远端') : t('Keep both', '两者保留')}</button>)}</div>}</div>)}
      <div className="sy-row">{['ready', 'applying'].includes(plan.status) && <button data-primary disabled={busy || !props.writable} onClick={() => void action(apply)}>{plan.status === 'applying' ? t('Resume reviewed imports', '继续已审阅的导入') : t('Apply and commit locally', '应用并保存本地快照')}</button>}{!['complete', 'cancelled'].includes(plan.status) && <button disabled={busy || !props.writable} onClick={() => void action(generation => changePlan('cancel-plan', {}, generation).then(() => {}))}>{t('Cancel this plan', '取消本次计划')}</button>}</div>{plan.commit && <code>{plan.commit}</code>}
    </div>}
    {push && <div className="sy-panel"><h3>{t('Push this snapshot', '推送这份快照')}</h3><div className="sy-destination"><code>{push.remote}</code><code>{push.branch}</code><code>{push.head}</code></div><div className="sy-row"><label><input type="checkbox" checked={acceptedPush} onChange={event => setAcceptedPush(event.target.checked)} />{t('I reviewed the selected memory and this destination', '已核对选中的记忆内容与推送地址')}</label></div><button data-primary disabled={busy || !props.writable || !acceptedPush || !push.head || !push.enabled} onClick={() => void action(async generation => { await mutate('push', { id: push.targetId, ...push }, generation); setPush(undefined); setAcceptedPush(false); await refresh(); setStatus(t('The reviewed snapshot was pushed successfully.', '已成功推送审阅后的快照。')) })}>{t('Push reviewed snapshot', '推送已审阅快照')}</button></div>}
    {busy && <p role="status">{t('Processing the selected operation…', '正在处理选定的操作…')}</p>}
  </section>
}
export function apply(ctx: MemorySourceUIContext) { installMemorySourceUI(ctx, { sourceTypeId: 'sync', pages: [{ id: 'sync', label: 'Memory synchronization', localizedLabel: { en: 'Memory synchronization', 'zh-CN': '记忆同步' }, order: 90, component: Page, coordinateSources: true, navigation: { group: 'sources', primary: true } }] }) }
