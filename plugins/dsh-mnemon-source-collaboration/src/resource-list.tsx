import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemorySourcePageProps } from 'dsh-mnemon/client'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
interface ResourcePage { items: RecordValue[]; total: number; presence: Array<{ owner: string; status: string; at: string }>; writeConflictPolicy: string; captureWrites: boolean; error: string }
export function ResourceList(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [query, setQuery] = useState(''), [type, setType] = useState(''), [offset, setOffset] = useState(0)
  const [page, setPage] = useState<ResourcePage>(), [revision, setRevision] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const epoch = useRef(0), serial = useRef(0)
  const refresh = useCallback(async () => {
    if (!props.management) return
    const current = epoch.current, request = ++serial.current
    try {
      const response = await props.management.read('resources', { query, resourceType: type, offset })
      if (current !== epoch.current || request !== serial.current) return
      setPage(response.value as unknown as ResourcePage); setRevision(response.revision); setError('')
    } catch (error) { if (current === epoch.current && request === serial.current) setError(String(error)) }
  }, [props.management, query, type, offset])
  useEffect(() => { epoch.current++; setPage(undefined); setBusy(false); return () => { epoch.current++ } }, [props.management, props.sessionId, props.workspaceId])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setOffset(0) }, [query, type])
  const remove = async (record: RecordValue) => {
    if (!props.management || !props.writable || busy) return
    const current = epoch.current; setBusy(true); setError('')
    try { await props.management.mutate('remove-resource', { id: record.id }, { confirmed: true, expectedRevision: revision }); if (current === epoch.current) { await refresh(); props.onRefresh?.() } }
    catch (error) { if (current === epoch.current) setError(String(error)) }
    finally { if (current === epoch.current) setBusy(false) }
  }
  const kinds: Record<string, string> = { file: t('File', '文件'), service: t('Service', '服务'), note: t('Note', '备注') }
  return <section data-mnemon-collection aria-label={t('Shared resources', '共享资源')}>
    <header><h2>{t('Shared resources', '共享资源')}</h2><button onClick={() => void refresh()}>{t('Refresh resources', '刷新资源')}</button></header>
    {page && <p>{t('Write conflicts', '写入冲突')}: {{ off: t('Disabled', '不检查'), warn: t('Warn', '提醒'), deny: t('Block', '阻止') }[page.writeConflictPolicy]} · {t('Automatic file registration', '文件自动登记')}: {page.captureWrites ? t('Enabled', '已开启') : t('Disabled', '已关闭')}</p>}
    {error && <p role="alert">{error}</p>}{page?.error && <p role="alert">{page.error}</p>}
    <div className="mc-fields"><label>{t('Search resources', '搜索资源')}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>{t('Filter resource type', '筛选资源类型')}<select value={type} onChange={event => setType(event.target.value)}><option value="">{t('All resource types', '全部资源类型')}</option>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <p role="status">{t('Matching resources', '匹配资源')}: {page?.total ?? 0}</p>
    {page?.items.map(record => <article key={record.id} style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
      <h3>{record.title}</h3><small>{kinds[String(record.data.resourceType)]} · {new Date(record.updatedAt).toLocaleString(props.locale)}</small>
      <p>{String(record.data.resource)}</p><p>{record.content}</p><p>{t('Owner', '持有会话')}: {String(record.data.owner)}</p>
      {record.data.automatic === true && <p>{t('Registered after a successful file write', '由成功的文件写入自动登记')}</p>}
      {record.data.owner === props.sessionId && <button disabled={!props.writable || busy} onClick={() => void remove(record)}>{t('Remove my declaration', '移除我的声明')}</button>}
    </article>)}
    <footer><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 25))}>{t('Previous resources', '上一页资源')}</button><button disabled={offset + 25 >= (page?.total ?? 0)} onClick={() => setOffset(value => value + 25)}>{t('Next resources', '下一页资源')}</button></footer>
    <details><summary>{t('Member activity', '成员动态')}</summary>{page?.presence.map(member => <p key={member.owner} style={{ overflowWrap: 'anywhere' }}>{member.owner} · {{ idle: t('Idle', '空闲'), running: t('Running', '运行中'), closed: t('Closed', '已退出') }[member.status] ?? member.status} · {new Date(member.at).toLocaleString(props.locale)}</p>)}</details>
  </section>
}
