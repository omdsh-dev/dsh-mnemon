import { useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionHandle } from '../host/protocol.ts'
import type { MemoryPluginChangePlan, MemoryPluginEntryView, MemoryPluginInspection, MemoryViewDashboard } from '../host/view-protocol.ts'
import { MnemonClient } from './api.ts'
import { MemoryPluginMetrics, MemoryPluginNotice, MemoryPluginSurface } from './plugin-ui.tsx'
import css from './MemoryCompositionEditor.module.css'
import { MemoryAccessSummary, memoryAccessLabels } from './context-access.tsx'

interface Props { connection?: ClientConnectionHandle; sessionId?: string; workspaceId?: string; locale: string; refreshKey?: number; onChange?(): void }
export function MemoryPluginManager(props: Props) {
  const [open, setOpen] = useState(false), zh = props.locale.startsWith('zh')
  if (!props.connection) return null
  return <details className={css.root} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={css.summary}><span><strong>{zh ? '记忆插件' : 'Memory plugins'}</strong><small>{zh ? '发现可选能力，检查依赖并管理启用状态。' : 'Discover optional capabilities, check dependencies and manage activation.'}</small></span><IconChevronDownOutline14 className={css.chevron} /></summary>
    {open && <div className={css.body}><Manager {...props} connection={props.connection} /></div>}
  </details>
}

function Manager(props: Props & { connection: ClientConnectionHandle }) {
  const client = useMemo(() => new MnemonClient(props.connection, props.sessionId, props.workspaceId), [props.connection, props.sessionId, props.workspaceId])
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en, label = (entry: Pick<MemoryPluginEntryView, 'label'>) => entry.label[zh ? 'zh-CN' : 'en']
  const [dashboard, setDashboard] = useState<MemoryViewDashboard>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [page, setPage] = useState(0)
  const [plan, setPlan] = useState<MemoryPluginChangePlan>(), [packageName, setPackageName] = useState(''), [inspection, setInspection] = useState<MemoryPluginInspection>()
  const [restart, setRestart] = useState<string[]>([])
  const epoch = useRef(0), serial = useRef(0), pending = useRef(false), planRegion = useRef<HTMLDivElement>(null)
  async function load() {
    const generation = epoch.current, request = ++serial.current
    try { const next = await client.viewDashboard(); if (generation === epoch.current && request === serial.current) { setDashboard(next); setError(''); setPlan(undefined) } }
    catch (error) { if (generation === epoch.current && request === serial.current) setError(String(error)) }
  }
  useEffect(() => { epoch.current++; pending.current = false; setBusy(false); setDashboard(undefined); setPlan(undefined); setInspection(undefined); setNotice(''); setRestart([]); void load(); return () => { epoch.current++; serial.current++ } }, [client])
  useEffect(() => { if (props.refreshKey) void load() }, [props.refreshKey])
  useEffect(() => { setPage(0) }, [filter, query])
  useEffect(() => { if (plan) planRegion.current?.focus() }, [plan])
  async function run(operation: (current: () => boolean) => Promise<void>) {
    if (pending.current) return
    const generation = epoch.current
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation(() => generation === epoch.current) }
    catch (error) { if (generation === epoch.current) { setError(error instanceof Error ? error.message : String(error)); setPlan(undefined) } }
    finally { if (generation === epoch.current) { pending.current = false; setBusy(false) } }
  }
  const entries = dashboard?.entries ?? []
  const filtered = entries.filter(entry => (filter === 'all' || filter === 'enabled' && entry.enabled || filter === 'available' && !entry.enabled || entry.roles.includes(filter as never)) && `${label(entry)} ${entry.description[zh ? 'zh-CN' : 'en']} ${entry.packageName} ${dashboard?.sources.filter(source => source.packageName === entry.packageName).flatMap(source => [...memoryAccessLabels(source.operations, props.locale), ...memoryAccessLabels(source.managementOperations, props.locale)]).join(' ') ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const pages = Math.max(1, Math.ceil(filtered.length / 8)), currentPage = Math.min(page, pages - 1)
  const disabled = busy || !dashboard?.writable
  const reason = (value: MemoryPluginChangePlan['changes'][number]['reason']) => ({ requested: t('Your selection', '本次选择'), requirement: t('Required capability', '配套能力'), 'strategy-change': t('Composition change', '策略切换'), dependent: t('Depends on a disabled capability', '依赖的能力将停用') })[value]
  return <MemoryPluginSurface title={t('Available capabilities', '可用能力')} description={t('The default three-tier composition is ready to use. Additional Sources and strategies are optional. Disabling a plugin preserves its data.', '默认三层组合开箱即用，其余来源与策略均为可选。停用插件会保留已有数据。')} actions={<button disabled={busy} onClick={() => void load()}>{t('Refresh', '刷新')}</button>}>
    {error && <MemoryPluginNotice error>{error}</MemoryPluginNotice>}{notice && <MemoryPluginNotice>{notice}</MemoryPluginNotice>}
    {!dashboard ? <p>{t('Loading plugins…', '正在读取插件…')}</p> : <>
      <MemoryPluginMetrics items={[{ label: t('Installed', '已安装'), value: entries.length }, { label: t('Enabled', '已启用'), value: entries.filter(entry => entry.enabled && entry.active).length }, { label: t('Optional', '可选待启用'), value: entries.filter(entry => !entry.enabled).length }]} />
      {!dashboard.writable && <MemoryPluginNotice>{t('Plugin settings are read-only.', '当前插件设置为只读。')}</MemoryPluginNotice>}
      {plan && <div ref={planRegion} tabIndex={-1} aria-label={t('Plugin change preview', '插件变更预览')}>
        <article><h3>{t('Review these changes', '确认以下变更')}</h3><p>{t('Dependencies are applied together. Current conversations keep their existing context until the next turn.', '所需依赖将一并应用，新的对话轮次会使用更新后的组合。')}</p>
          <ul>{plan.changes.map(change => <li key={change.entryId}>{change.enabled ? t('Enable', '启用') : t('Disable', '停用')} · {label(change)} <small>— {reason(change.reason)}</small></li>)}</ul>
          {!plan.changes.length && <p>{t('The requested state is already applied.', '当前已经是所选状态。')}</p>}
          <footer><button data-primary disabled={disabled || !plan.changes.length} onClick={() => void run(async current => {
            await client.applyView(plan.configuration)
            if (!current()) return
            setPlan(undefined)
            try { const next = await client.viewDashboard(); if (!current()) return; setDashboard(next); setNotice(t('Plugin changes applied. New turns use the updated composition.', '插件变更已生效，新轮次将使用更新后的组合。')); props.onChange?.() }
            catch { if (current()) { setDashboard(old => old ? { ...old, writable: false } : old); setError(t('Changes were saved, but refresh failed. Refresh before editing again.', '变更已保存，但状态刷新失败。请刷新后再继续编辑。')) } }
          })}>{t('Apply these changes', '应用这些变更')}</button><button disabled={busy} onClick={() => setPlan(undefined)}>{t('Cancel', '取消')}</button></footer>
        </article>
      </div>}
      <nav className="mc-toolbar" aria-label={t('Filter plugins', '筛选插件')}>{[['all', t('All', '全部')], ['enabled', t('Enabled', '已启用')], ['available', t('Discover', '发现能力')], ['source', t('Sources', '数据来源')], ['strategy', t('Strategies', '主策略')], ['strategy-extension', t('Enhancements', '策略增强')]].map(([value, text]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value!)}>{text}</button>)}<input aria-label={t('Search plugins', '搜索插件')} placeholder={t('Search by capability or name', '搜索能力或名称')} value={query} onChange={event => setQuery(event.target.value)} /></nav>
      <div className="mc-list">{filtered.slice(currentPage * 8, (currentPage + 1) * 8).map(entry => {
        const main = entry.roles.includes('strategy'), selected = main && entry.typeId === dashboard.strategyTypeId
        const requires = entry.requires.flatMap(capability => entries.filter(provider => provider.provides.some(value => value.id === capability)).map(label))
        const dependents = entries.filter(value => entry.requiredBy.includes(value.entryId) && value.enabled).map(label)
        return <article key={entry.entryId} aria-label={label(entry)}><header><div><h3>{label(entry)}</h3><div className="mc-meta"><span className="mc-badge">{selected ? t('Current Strategy', '当前策略') : entry.enabled ? entry.active ? t('Enabled', '已启用') : t('Waiting to run', '等待运行') : t('Installed · inactive', '已安装 · 未启用')}</span><span>{main ? t('Strategy', '主策略') : entry.roles.includes('source') ? t('Source', '数据来源') : t('Enhancement', '策略增强')}</span></div></div><button disabled={disabled || !entry.writable || selected} aria-label={`${main ? t('Use ', '使用 ') : entry.enabled ? t('Disable ', '停用 ') : t('Enable ', '启用 ')}${label(entry)}`} onClick={() => void run(async current => { const value = await client.planPlugin(entry.entryId, main || !entry.enabled, dashboard.revision); if (current()) { setPlan(value); setInspection(undefined) } })}>{selected ? t('In use', '使用中') : main ? t('Use Strategy', '使用此策略') : entry.enabled ? t('Disable', '停用') : t('Enable', '启用')}</button></header>
          <p>{entry.description[zh ? 'zh-CN' : 'en']}</p>
          {dashboard.sources.filter(source => source.packageName === entry.packageName).slice(0, 1).map(source => <MemoryAccessSummary key={source.sourceInstanceKey} inventory={source.operations} management={source.managementOperations} context={source.context} locale={props.locale} compact />)}
          <details><summary>{t('Dependencies and package details', '依赖与软件包详情')}</summary><div><small>{entry.packageName}</small>{requires.length > 0 && <p>{t('Requires', '配套能力')} · {[...new Set(requires)].join('、')}</p>}{dependents.length > 0 && <p>{t('Used by', '已被以下能力使用')} · {dependents.join('、')}</p>}{entry.fields.length > 0 && <p>{t('Tune its fields in Composition settings below.', '可在下方“组合策略配置”中调整参数。')}</p>}{entry.diagnostic && <p>{entry.diagnostic}</p>}</div></details>
        </article>
      })}{!filtered.length && <p className="mc-empty">{t('No matching capabilities. You can inspect an external package below.', '没有匹配的能力，可在下方检查外部软件包。')}</p>}</div>
      {pages > 1 && <footer><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('Previous', '上一页')}</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>{t('Next', '下一页')}</button></footer>}
      <details><summary>{t('Install another plugin', '安装其他插件')}</summary><div><p>{t('Enter the exact npm package name. Review its version and compatibility before installing it into this DSH Profile.', '输入准确的 npm 软件包名称，检查版本与兼容性后再安装到当前 DSH 配置。')}</p>
        <form onSubmit={event => { event.preventDefault(); void run(async current => { const value = await client.inspectPlugin(packageName.trim()); if (current()) { setInspection(value); setPlan(undefined) } }) }}><label>{t('Package name', '软件包名称')}<input disabled={busy} value={packageName} required maxLength={214} placeholder="dsh-mnemon-source-…" onChange={event => { setPackageName(event.target.value); setInspection(undefined) }} /></label><button disabled={busy || !packageName.trim()}>{t('Check package', '检查软件包')}</button></form>
        {!dashboard.pluginInstallation.supported && <p>{t('Installation is unavailable here. Use the DSH CLI for this Profile.', '当前环境无法在网页内安装，可通过 DSH 命令行管理此配置。')}</p>}
        {inspection && <article aria-label={t('Package inspection', '软件包检查')}><h3>{inspection.packageName}</h3><p>{inspection.description}</p><div className="mc-meta"><span>{t('Release', '可安装版本')} {inspection.version}</span><span>{inspection.installed ? t('Installed version', '当前已安装') + ' ' + inspection.installedVersion : t('Not installed', '尚未安装')}</span></div>
          <p>{inspection.compatible ? t('Compatible with this runtime.', '与当前运行环境兼容。') : t('Compatibility requirements are not met.', '当前运行环境不满足兼容要求。')}</p><ul>{inspection.peerChecks.map(peer => <li key={peer.packageName}>{peer.packageName} · {peer.range} <small>({peer.installedVersion ?? t('not installed', '未安装')}) · {peer.compatible ? t('compatible', '兼容') : t('unavailable', '不兼容')}</small></li>)}</ul>
          <button data-primary disabled={disabled || !dashboard.pluginInstallation.supported || !inspection.compatible || restart.includes(inspection.packageName) || inspection.installedVersion === inspection.version} onClick={() => void run(async current => { const result = await client.installPlugin(inspection.packageName, inspection.version); if (current()) { setRestart(old => [...old, result.packageName]); setNotice(t('Installed. Restart this DSH Profile, then refresh to activate the plugin.', '安装完成。请重启当前 DSH 配置，再刷新此页并启用插件。')) } })}>{inspection.installedVersion === inspection.version ? t('Already installed', '已安装此版本') : inspection.installed ? t('Install this update', '安装此更新') : t('Install this version', '安装此版本')}</button>
        </article>}
      </div></details>
      {dashboard.diagnostics.length > 0 && <details><summary>{t('Runtime diagnostics', '运行诊断')}</summary><div>{dashboard.diagnostics.map(value => <p key={value}>{value}</p>)}</div></details>}
    </>}
  </MemoryPluginSurface>
}
