import { useCallback, useEffect, useRef, useState } from 'react'
import { installMemorySourceUI, installMemorySourceOverlayUI, MemorySourcePageFrame, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { AssetReference, RecordValue } from 'dsh-mnemon/source-sdk'
import type { DeliveryPlan } from './delivery.ts'
import { notificationStyles } from './styles.ts'
export const inject = ['slots']
interface Inbox { unread: number; total: number; items: RecordValue[]; activityError?: string }
const empty: Inbox = { unread: 0, total: 0, items: [] }
function useInbox(props: MemorySourcePageProps, query = '', unread = false, archived = false, offset = 0) {
  const [value, setValue] = useState(empty), [revision, setRevision] = useState(''), [error, setError] = useState('')
  const generation = useRef(0), serial = useRef(0)
  const refresh = useCallback(async () => {
    if (!props.management) return
    const mine = ++serial.current, epoch = generation.current
    try {
      const result = await props.management.read('inbox', { query, unread, archived, offset })
      if (mine !== serial.current || epoch !== generation.current) return
      setValue(result.value as unknown as Inbox); setRevision(result.revision); setError('')
    } catch (error) { if (epoch === generation.current) setError(error instanceof Error ? error.message : String(error)) }
  }, [props.management, query, unread, archived, offset])
  useEffect(() => {
    generation.current++; setValue(empty); setRevision(''); void refresh()
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 5000)
    return () => { generation.current++; clearInterval(timer) }
  }, [refresh])
  return { value, revision, error, refresh }
}
function Attachment({ asset, record, ...props }: MemorySourcePageProps & { asset: AssetReference; record: RecordValue }) {
  const zh = props.locale.startsWith('zh'), [url, setUrl] = useState(''), [error, setError] = useState(''), [text, setText] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  const read = async () => {
    if (!props.management) return
    setBusy(true); setError('')
    try {
      const result = await props.management.read('asset', { id: record.id, assetId: asset.id })
      const payload = result.value as unknown as { base64: string }
      const bytes = Uint8Array.from(atob(payload.base64), char => char.charCodeAt(0))
      setUrl(URL.createObjectURL(new Blob([bytes], { type: asset.mediaType })))
      if (asset.mediaType === 'text/plain') setText(new TextDecoder().decode(bytes.slice(0, 16000)))
    } catch { setError(zh ? '附件不可用、已损坏或不属于当前工作区。' : 'Attachment unavailable, damaged or outside this workspace.') }
    finally { setBusy(false) }
  }
  return <div className="nt-asset"><strong>{asset.name}</strong> <small>{asset.mediaType} · {Math.ceil(asset.bytes / 1024)} KB</small>
    <details><summary>{zh ? '内容校验值' : 'Content digest'}</summary><code>{asset.id}</code></details>
    {!url && <button disabled={busy} onClick={() => void read()}>{busy ? (zh ? '读取中…' : 'Loading…') : zh ? '预览附件' : 'Preview attachment'}</button>}
    {error && <p role="alert">{error}</p>}{url && <>{asset.mediaType.startsWith('image/') && <img src={url} alt={asset.name} onError={() => setError(zh ? '图片格式无效，仍可下载检查。' : 'Invalid image; download to inspect.')} />}
      {asset.mediaType.startsWith('audio/') && <audio controls src={url} />}{asset.mediaType.startsWith('video/') && <video controls src={url} />}{text && <pre>{text}</pre>}
      <a href={url} download={asset.name}>{zh ? '下载附件' : 'Download attachment'}</a></>}</div>
}

function InboxView(props: MemorySourcePageProps & { compact?: boolean }) {
  const zh = props.locale.startsWith('zh'), [query, setQuery] = useState(''), [unread, setUnread] = useState(false), [archived, setArchived] = useState(false), [offset, setOffset] = useState(0)
  const inbox = useInbox(props, query, unread, archived, offset)
  const [detail, setDetail] = useState<RecordValue>(), [detailRevision, setDetailRevision] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false)
  const [compose, setCompose] = useState(false), [title, setTitle] = useState(''), [content, setContent] = useState(''), [delivery, setDelivery] = useState(false), [mode, setMode] = useState('notification')
  const [channels, setChannels] = useState<DeliveryPlan['channels']>([]), [selected, setSelected] = useState<string[]>([])
  const [attachmentKind, setAttachmentKind] = useState('path'), [attachmentValue, setAttachmentValue] = useState(''), [attachments, setAttachments] = useState<Array<Record<string, string | boolean>>>([])
  const epoch = useRef(0)
  useEffect(() => { epoch.current++; setDetail(undefined); setError(''); setCompose(false); setBusy(false); return () => { epoch.current++ } }, [props.management])
  const show = async (id: string) => {
    const current = epoch.current
    try { const result = await props.management!.read('detail', { id }); if (current === epoch.current) { setDetail(result.value as unknown as RecordValue); setDetailRevision(result.revision); setConfirmed(false) } }
    catch (error) { if (current === epoch.current) setError(String(error)) }
  }
  const write = async (operation: string, input: Record<string, MemoryJsonValue>, revision = inbox.revision) => {
    if (!props.management || !props.writable || busy) return
    const current = epoch.current
    setBusy(true); setError('')
    try {
      const result = await props.management.mutate(operation, input, { confirmed: true, expectedRevision: revision })
      if (current !== epoch.current) return
      if (operation === 'stage') { setDetail(result.value as unknown as RecordValue); setDetailRevision(result.revision); setCompose(false); setTitle(''); setContent(''); setAttachments([]) }
      else if (operation === 'delete' || operation === 'archive') setDetail(undefined)
      else if (detail) await show(detail.id)
      await inbox.refresh()
    } catch (error) { if (current === epoch.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (current === epoch.current) setBusy(false) }
  }
  const startCompose = async () => {
    setCompose(true); setDetail(undefined); setConfirmed(false)
    try { const result = await props.management!.read('channels'); setChannels(result.value as unknown as DeliveryPlan['channels']) } catch (error) { setError(String(error)) }
  }
  useEffect(() => { setOffset(0) }, [query, unread, archived])
  const plan = detail?.kind === 'delivery' ? detail.data.plan as unknown as DeliveryPlan : undefined
  const status = (value: unknown) => zh ? ({ draft: '待发送', sending: '发送中', sent: '已被渠道接收', partial: '存在未确认投递', accepted: '已接收', uncertain: '待确认', failed: '未发送' } as Record<string, string>)[String(value)] ?? String(value) : String(value)
  return <section className={'nt-view' + (props.compact ? ' nt-compact' : '')} aria-label={zh ? '通知收件箱' : 'Notification inbox'}><style>{notificationStyles}</style>
    <header className="nt-header"><div><h2>{zh ? '通知中心' : 'Notifications'} <span className="nt-count">{inbox.value.unread}</span></h2>{!props.compact && <p>{zh ? '查看活动、打开关联会话，以及审核发送到指定渠道的消息。' : 'Read activity, open related sessions and review messages addressed to configured channels.'}</p>}</div>
      <button disabled={!props.writable || busy} onClick={() => void startCompose()}>{zh ? '新建通知' : 'New notification'}</button></header>
    {(error || inbox.error) && <p role="alert">{error || inbox.error}</p>}
    {compose && <form className="nt-compose" onSubmit={event => { event.preventDefault(); void write('stage', { title, content, delivery, mode, channels: selected, attachments }) }}>
      <h3>{zh ? '编写通知' : 'Compose'}</h3><label>{zh ? '通知标题' : 'Notification title'}<input required value={title} maxLength={300} onChange={event => setTitle(event.target.value)} /></label>
      <label>{zh ? '通知内容' : 'Notification content'}<textarea rows={4} maxLength={20000} value={content} onChange={event => setContent(event.target.value)} /></label>
      <label className="nt-check"><input type="checkbox" checked={delivery} onChange={event => setDelivery(event.target.checked)} />{zh ? '准备发送到外部渠道' : 'Prepare external channel delivery'}</label>
      {delivery && <fieldset><legend>{zh ? '发送目标' : 'Delivery targets'}</legend><label>{zh ? '发送方式' : 'Delivery mode'}<select value={mode} onChange={event => setMode(event.target.value)}><option value="notification">{zh ? '通知' : 'Notification'}</option><option value="message">{zh ? '直接消息' : 'Direct message'}</option></select></label>
        {!channels.length && <p>{zh ? '尚未配置发送渠道。' : 'No delivery channels configured.'}</p>}{channels.map(channel => <label className="nt-check" key={channel.id}><input type="checkbox" checked={selected.includes(channel.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, channel.id] : ids.filter(id => id !== channel.id))} />{channel.label} → {channel.target}</label>)}
        {channels.length > 1 && <button type="button" onClick={() => setSelected(channels.map(channel => channel.id))}>{zh ? '选择全部渠道' : 'Select all channels'}</button>}</fieldset>}
      <fieldset><legend>{zh ? '附件' : 'Attachments'}</legend><label>{zh ? '附件来源' : 'Attachment source'}<select value={attachmentKind} onChange={event => { setAttachmentKind(event.target.value); setAttachmentValue('') }}><option value="path">{zh ? '工作区文件路径' : 'Workspace path'}</option><option value="url">{zh ? '已配置来源的 URL' : 'Allowed origin URL'}</option><option value="latestSessionImage">{zh ? '本会话最新用户图片' : 'Latest user image'}</option><option value="sessionAttachmentId">{zh ? '本会话图片 ID' : 'Session image ID'}</option><option value="base64">Base64</option></select></label>
        {attachmentKind !== 'latestSessionImage' && <label>{zh ? '附件地址或内容' : 'Attachment location or content'}<input value={attachmentValue} onChange={event => setAttachmentValue(event.target.value)} /></label>}
        <button type="button" disabled={attachments.length >= 10 || !attachmentValue.trim() && attachmentKind !== 'latestSessionImage'} onClick={() => { setAttachments(items => [...items, { [attachmentKind]: attachmentKind === 'latestSessionImage' ? true : attachmentValue }]); setAttachmentValue('') }}>{zh ? '加入附件' : 'Add attachment'}</button>
        {attachments.map((value, index) => <div className="nt-attachment-row" key={index}><span>{Object.keys(value)[0]} · {String(Object.values(value)[0]).slice(0, 100)}</span><button type="button" onClick={() => setAttachments(items => items.filter((_item, i) => i !== index))}>{zh ? '移除附件' : 'Remove attachment'} {index + 1}</button></div>)}</fieldset>
      <footer><button data-primary disabled={busy || delivery && !selected.length}>{delivery ? (zh ? '生成发送计划' : 'Prepare delivery plan') : zh ? '保存到收件箱' : 'Save to inbox'}</button><button type="button" onClick={() => setCompose(false)}>{zh ? '取消' : 'Cancel'}</button></footer></form>}
    {detail && <article className="nt-detail" aria-label={zh ? '通知详情' : 'Notification details'}><div className="nt-row"><h3>{detail.title}</h3><button aria-label={zh ? '关闭详情' : 'Close details'} onClick={() => setDetail(undefined)}>×</button></div><small>{new Date(detail.createdAt).toLocaleString(props.locale)} · {detail.data.level === 'info' ? (zh ? '信息' : 'Info') : detail.data.level === 'warning' ? (zh ? '提醒' : 'Warning') : zh ? '错误' : 'Error'}</small>
      <p className="nt-content">{detail.content}</p>{typeof detail.data.session === 'string' && detail.data.session && props.sessionNavigation && <button onClick={() => { void props.sessionNavigation!.open(String(detail.data.session)).catch(error => setError(String(error))) }}>{zh ? '打开关联会话' : 'Open related session'}</button>}
      {plan && <div className="nt-plan"><h4>{zh ? '发送计划' : 'Delivery plan'} · {status(detail.data.status)}</h4><p>{plan.mode === 'message' ? (zh ? '直接消息' : 'Direct message') : zh ? '通知' : 'Notification'}</p><ul>{plan.channels.map(channel => <li key={channel.id}><strong>{channel.label}</strong> → {channel.target}<br /><small>{channel.endpoint}</small></li>)}</ul><small>{zh ? '渠道回执表示接收请求，不等于收件人已读。' : 'Channel acceptance does not confirm the recipient has read it.'}</small></div>}
      {(detail.data.assets as unknown as AssetReference[]).map((asset, index) => <Attachment key={asset.id + index} {...props} asset={asset} record={detail} />)}
      {detail.data.receipts && <ul className="nt-receipts">{Object.entries(detail.data.receipts as Record<string, { status: string; detail: string }>).map(([id, receipt]) => <li key={id}>{id} · {status(receipt.status)}<br /><small>{receipt.detail}</small></li>)}</ul>}
      {plan && detail.data.status === 'draft' && <><label className="nt-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{zh ? '已核对发送内容、附件和全部目标' : 'I reviewed the content, attachments and all targets'}</label><button data-primary disabled={!confirmed || !props.writable || busy} onClick={() => void write('send-delivery', { id: detail.id, plan: detail.data.plan! }, detailRevision)}>{zh ? '发送这份计划' : 'Send this plan'}</button></>}
      <footer><button disabled={!props.writable || busy} onClick={() => void write(detail.data.read ? 'mark-unread' : 'mark-read', { id: detail.id }, detailRevision)}>{detail.data.read ? (zh ? '标记未读' : 'Mark unread') : zh ? '标记已读' : 'Mark read'}</button><button disabled={!props.writable || busy} onClick={() => void write(detail.state === 'archived' ? 'restore' : 'archive', { id: detail.id }, detailRevision)}>{detail.state === 'archived' ? (zh ? '恢复' : 'Restore') : zh ? '归档通知' : 'Archive notice'}</button>{detail.state === 'archived' && <button disabled={!props.writable || busy} onClick={() => void write('delete', { id: detail.id }, detailRevision)}>{zh ? '删除已归档通知' : 'Delete archived notice'}</button>}</footer></article>}
    <div className="nt-toolbar"><input aria-label={zh ? '搜索通知' : 'Search notifications'} placeholder={zh ? '搜索标题与内容' : 'Search title and content'} value={query} onChange={event => setQuery(event.target.value)} /><label className="nt-check"><input type="checkbox" checked={unread} onChange={event => setUnread(event.target.checked)} />{zh ? '仅未读' : 'Unread only'}</label><label className="nt-check"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />{zh ? '已归档' : 'Archived'}</label></div>
    <div className="nt-row"><small>{inbox.value.total} {zh ? '条通知' : 'notices'}</small><button disabled={!props.writable || !inbox.value.unread || busy} onClick={() => void write('read-all', {})}>{zh ? '全部标为已读' : 'Mark all read'}</button><button onClick={() => void inbox.refresh()}>{zh ? '刷新通知' : 'Refresh'}</button></div>
    <div className="nt-list">{inbox.value.items.map(record => <button className="nt-item" key={record.id} onClick={() => void show(record.id)}><span className={'nt-dot ' + (record.data.read ? 'nt-read' : '')} /><span><strong>{record.title}</strong><small>{record.content.slice(0, 100)}</small><time>{new Date(record.createdAt).toLocaleString(props.locale)}{record.kind === 'delivery' ? ' · ' + status(record.data.status) : ''}</time></span></button>)}{!inbox.value.items.length && <p className="nt-empty">{zh ? '暂无匹配的通知。' : 'No matching notifications.'}</p>}</div>
    {(offset > 0 || inbox.value.total > offset + 30) && <footer><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 30))}>{zh ? '上一页' : 'Previous'}</button><button disabled={inbox.value.total <= offset + 30} onClick={() => setOffset(value => value + 30)}>{zh ? '下一页' : 'Next'}</button></footer>}
    {!props.compact && <details className="nt-maintenance"><summary>{zh ? '附件维护' : 'Attachment maintenance'}</summary><p>{zh ? '仅清理已删除通知中超过 30 天未再引用的附件。' : 'Only remove unreferenced attachments older than 30 days.'}</p><button disabled={!props.writable || busy} onClick={() => void write('prune-assets', {})}>{zh ? '清理未使用附件' : 'Clean unused attachments'}</button></details>}
  </section>
}
export function Page(props: MemorySourcePageProps) { return <MemorySourcePageFrame locale={props.locale}><InboxView {...props} /></MemorySourcePageFrame> }

type Position = { side: 'left' | 'right'; y: number }
export function Bell(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), inbox = useInbox(props), [open, setOpen] = useState(false), key = 'mnemon.notifications.position.' + props.sourceInstanceKey
  const [position, setPosition] = useState<Position>(() => { try { const value = JSON.parse(localStorage.getItem(key) ?? 'null'); if (value && ['left', 'right'].includes(value.side) && Number.isFinite(value.y)) return { side: value.side, y: Math.max(0, Math.min(1, value.y)) } } catch {} return { side: 'right', y: 0.64 } })
  const drag = useRef<{ x: number; y: number; moved: boolean }>(), skipClick = useRef(false)
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(position)) } catch {} }, [position, key])
  useEffect(() => { if (!open) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [open])
  const y = `calc(16px + (100dvh - 80px) * ${position.y})`
  return <div className="nt-floating"><style>{notificationStyles}</style><button className="nt-bell" style={{ [position.side]: 16, top: y }} aria-label={zh ? `通知中心，${inbox.value.unread} 条未读` : `Notifications, ${inbox.value.unread} unread`} aria-expanded={open} title={zh ? '点击查看通知；拖动可调整位置' : 'Click for notices; drag to reposition'}
    onPointerDown={event => { if (event.button !== 0) return; drag.current = { x: event.clientX, y: event.clientY, moved: false }; event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={event => { if (!drag.current) return; if (Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) > 6) drag.current.moved = true; if (drag.current.moved) setPosition({ side: event.clientX < window.innerWidth / 2 ? 'left' : 'right', y: Math.max(0, Math.min(1, (event.clientY - 40) / Math.max(1, window.innerHeight - 80))) }) }}
    onPointerUp={() => { skipClick.current = drag.current?.moved === true; drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}
    onClick={() => { if (skipClick.current) { skipClick.current = false; return } setOpen(value => !value); void inbox.refresh() }}>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{inbox.value.unread > 0 && <span>{inbox.value.unread > 99 ? '99+' : inbox.value.unread}</span>}</button>
    {open && <aside className="nt-popover" style={{ [position.side]: 16 }} aria-label={zh ? '通知面板' : 'Notification panel'}><div className="nt-popover-controls"><button onClick={() => setPosition(value => ({ ...value, side: value.side === 'left' ? 'right' : 'left' }))}>{position.side === 'right' ? (zh ? '移到左侧' : 'Move left') : zh ? '移到右侧' : 'Move right'}</button><button aria-label={zh ? '关闭通知面板' : 'Close notification panel'} onClick={() => setOpen(false)}>×</button></div><InboxView {...props} compact /></aside>}
  </div>
}
export function apply(ctx: MemorySourceUIContext) {
  installMemorySourceUI(ctx, { sourceTypeId: 'notifications', pages: [{ id: 'inbox', label: 'Notifications', localizedLabel: { en: 'Notifications', 'zh-CN': '通知中心' }, order: 65, component: Page, navigation: { group: 'sources', primary: true } }] })
  installMemorySourceOverlayUI(ctx, { sourceTypeId: 'notifications', overlays: [{ id: 'bell', label: 'Notifications', component: Bell }] })
}
