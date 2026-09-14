import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemorySourcePageProps } from 'dsh-mnemon/client'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { AssetInput, AssetReference, RecordSnapshot, RecordValue } from 'dsh-mnemon/source-sdk'

function Attachment({ record, reference, ...props }: MemorySourcePageProps & { record: RecordValue; reference: AssetReference }) {
  const zh = props.locale.startsWith('zh'), [url, setUrl] = useState(''), [text, setText] = useState(''), [error, setError] = useState('')
  const epoch = useRef(0)
  useEffect(() => { epoch.current++; setUrl(''); setError(''); return () => { epoch.current++ } }, [props.management, record.id, reference.id])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  const read = async () => {
    const current = epoch.current
    try {
      const response = await props.management!.read('asset', { id: record.id, assetId: reference.id })
      if (current !== epoch.current) return
      const bytes = Uint8Array.from(atob((response.value as { base64: string }).base64), value => value.charCodeAt(0))
      setUrl(URL.createObjectURL(new Blob([bytes], { type: reference.mediaType })))
      if (reference.mediaType === 'text/plain') setText(new TextDecoder().decode(bytes.slice(0, 20000)))
    } catch (error) { if (current === epoch.current) setError(String(error)) }
  }
  return <div style={{ marginTop: 10 }}>
    <strong>{reference.name}</strong> · {Math.ceil(reference.bytes / 1024)} KB
    {!url && <button onClick={() => void read()}>{zh ? '预览附件' : 'Preview attachment'}</button>}
    {error && <p role="alert">{error}</p>}
    {url && <div>{reference.mediaType.startsWith('image/') && <img src={url} alt={reference.name} style={{ maxWidth: '100%', maxHeight: 280, objectFit: 'contain' }} />}
      {reference.mediaType.startsWith('audio/') && <audio controls src={url} />}{reference.mediaType.startsWith('video/') && <video controls src={url} style={{ maxWidth: '100%' }} />}
      {text && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</pre>}<a href={url} download={reference.name}>{zh ? '下载附件' : 'Download attachment'}</a></div>}
  </div>
}
interface History { total: number; items: Array<{ id: string; record: RecordValue; unread: boolean }> }
export function MessageHistory(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [rooms, setRooms] = useState<RecordValue[]>([]), [room, setRoom] = useState(''), [history, setHistory] = useState<History>({ total: 0, items: [] })
  const [query, setQuery] = useState(''), [unread, setUnread] = useState(false), [archived, setArchived] = useState(false), [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const [recipients, setRecipients] = useState(''), [message, setMessage] = useState(''), [wake, setWake] = useState(false)
  const [attachments, setAttachments] = useState<AssetInput[]>([]), [attachmentKind, setAttachmentKind] = useState('path'), [attachmentValue, setAttachmentValue] = useState('')
  const epoch = useRef(0), serial = useRef(0)
  const refresh = useCallback(async () => {
    if (!props.management) return
    const current = epoch.current, request = ++serial.current
    try {
      const snapshot = (await props.management.read('snapshot')).value as unknown as RecordSnapshot
      const nextRooms = snapshot.records.filter(record => record.kind === 'room' && ['active', 'archived'].includes(record.state) && (record.data.members as string[]).includes(props.sessionId ?? ''))
      const selected = nextRooms.some(value => value.id === room) ? room : nextRooms[0]?.id ?? ''
      const response = selected ? await props.management.read('room-history', { id: selected, query, unread, archived, offset }) : undefined
      if (current !== epoch.current || request !== serial.current) return
      setRooms(nextRooms); setRoom(selected); setRevision(response?.revision ?? snapshot.revision)
      setHistory(response ? response.value as unknown as History : { total: 0, items: [] }); setError('')
    } catch (error) { if (current === epoch.current && request === serial.current) setError(String(error)) }
  }, [props.management, props.sessionId, room, query, unread, archived, offset])
  useEffect(() => {
    epoch.current++; setRooms([]); setRoom(''); setMessage(''); setAttachments([]); setHistory({ total: 0, items: [] }); setStatus(''); setBusy(false)
    return () => { epoch.current++ }
  }, [props.management, props.sessionId, props.workspaceId])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setOffset(0) }, [room, query, unread, archived])
  const write = async (operation: string, input: Record<string, MemoryJsonValue>) => {
    if (!props.management || !props.writable || busy) return
    const current = epoch.current
    setBusy(true); setError(''); setStatus('')
    try {
      await props.management.mutate(operation, input, { confirmed: true, expectedRevision: revision })
      if (current !== epoch.current) return
      if (operation === 'send-message') { setMessage(''); setAttachments([]); setStatus(t('Message sent. Check each delivery receipt below.', '消息已提交，请查看下方各会话的投递回执。')) }
      await refresh(); props.onRefresh?.()
    } catch (error) { if (current === epoch.current) setError(String(error)) }
    finally { if (current === epoch.current) setBusy(false) }
  }
  const add = () => {
    if (attachments.length >= 8 || attachmentKind !== 'latest' && !attachmentValue.trim()) return
    setAttachments(value => [...value, attachmentKind === 'latest' ? { latestSessionImage: true } : { [attachmentKind]: attachmentValue.trim() }])
    setAttachmentValue('')
  }
  const upload = async (file: File | undefined) => {
    if (!file) return
    if (attachments.length >= 8 || file.size > 5 * 1024 * 1024) { setError(t('At most eight files, each up to 5 MiB.', '最多 8 个附件，每个不超过 5 MiB。')); return }
    const current = epoch.current, bytes = new Uint8Array(await file.arrayBuffer())
    if (current !== epoch.current) return
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.slice(offset, offset + 8192))
    setAttachments(value => [...value, { base64: btoa(binary), name: file.name }])
  }
  const selected = rooms.find(value => value.id === room)
  return <section data-mnemon-collection aria-label={t('Directed messages', '定向消息')}>
    <header><h2>{t('Directed messages', '定向消息')}</h2><button onClick={() => void refresh()}>{t('Refresh messages', '刷新消息')}</button></header>
    <label>{t('Message room', '消息空间')}<select value={room} onChange={event => setRoom(event.target.value)}><option value="">{t('Select a joined room', '选择已加入的空间')}</option>{rooms.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {selected?.state === 'active' && <details><summary>{t('Compose a message', '撰写消息')}</summary>
      <p style={{ overflowWrap: 'anywhere' }}>{t('Members', '成员')}: {(selected.data.members as string[]).join(', ')}</p>
      <label>{t('Recipients (comma separated; blank for all other members)', '收件会话（逗号分隔；留空为其他成员）')}<input value={recipients} onChange={event => setRecipients(event.target.value)} /></label>
      <label>{t('Message text', '消息正文')}<textarea maxLength={10000} value={message} onChange={event => setMessage(event.target.value)} /></label>
      <label><input type="checkbox" checked={wake} onChange={event => setWake(event.target.checked)} />{t('Wake recipients to respond', '唤醒收件会话进行回复')}</label>
      <div className="mc-fields"><label>{t('Attachment source', '附件来源')}<select value={attachmentKind} onChange={event => setAttachmentKind(event.target.value)}>
        <option value="path">{t('Project file', '项目文件')}</option><option value="url">{t('Configured URL', '已配置的 URL')}</option><option value="latest">{t('Latest session image', '当前会话最新图片')}</option>
      </select></label>{attachmentKind !== 'latest' && <label>{t('Attachment path or URL', '附件路径或 URL')}<input value={attachmentValue} onChange={event => setAttachmentValue(event.target.value)} /></label>}
        <button disabled={attachments.length >= 8} onClick={add}>{t('Add attachment', '添加附件')}</button>
        <label>{t('Upload an attachment', '上传附件')}<input type="file" onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} /></label></div>
      <ul>{attachments.map((value, index) => <li key={index} style={{ overflowWrap: 'anywhere' }}>{value.name || value.path || value.url || t('Latest session image', '当前会话最新图片')} <button onClick={() => setAttachments(values => values.filter((_, i) => i !== index))}>{t('Remove attachment', '移除附件')}</button></li>)}</ul>
      <button disabled={!props.writable || busy || !message.trim()} onClick={() => void write('send-message', { id: room, recipients, message, wake, attachments: attachments as unknown as MemoryJsonValue })}>{t('Send to selected members', '发送给选定成员')}</button>
    </details>}
    <div className="mc-fields"><label>{t('Search messages', '搜索消息')}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label><input type="checkbox" checked={unread} onChange={event => setUnread(event.target.checked)} />{t('Unread only', '仅未读消息')}</label>
      <label><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />{t('Archived messages', '已归档消息')}</label></div>
    <p role="status">{t('Matching messages', '匹配消息')}: {history.total}</p>
    {history.items.map(({ record, unread }) => <article key={record.id} style={{ marginTop: 14 }}>
      <strong>{unread ? t('Unread', '未读') : t('Read', '已读')}</strong> · {new Date(record.createdAt).toLocaleString(props.locale)}
      <p style={{ overflowWrap: 'anywhere' }}>{String(record.data.sender)} → {(record.data.recipients as string[]).join(', ')}</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{record.content}</pre>
      <p style={{ overflowWrap: 'anywhere' }}>{Object.entries(record.data.deliveries as object).map(([id, state]) => id + ': ' + String(state)).join('; ')}</p>
      {(record.data.assets as unknown as AssetReference[] | undefined ?? []).map(reference => <Attachment key={reference.id} {...props} record={record} reference={reference} />)}
      <footer>{(record.data.recipients as string[]).includes(props.sessionId ?? '') && unread && <button disabled={busy || !props.writable} onClick={() => void write('mark-read', { id: record.id })}>{t('Mark read', '标记已读')}</button>}
        {record.data.sender === props.sessionId && <><button disabled={busy || !props.writable} onClick={() => void write(archived ? 'restore-message' : 'archive-message', { id: record.id })}>{archived ? t('Restore message', '恢复消息') : t('Archive message', '归档消息')}</button>
          {archived && <button disabled={busy || !props.writable} onClick={() => void write('delete-message', { id: record.id })}>{t('Delete archived message', '删除归档消息')}</button>}</>}</footer>
    </article>)}
    <footer><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 25))}>{t('Previous page', '上一页')}</button>
      <button disabled={offset + 25 >= history.total} onClick={() => setOffset(value => value + 25)}>{t('Next page', '下一页')}</button>
      <button disabled={busy || !props.writable} onClick={() => void write('prune-assets', {})}>{t('Prune unreferenced attachments older than 30 days', '清理超过 30 天的无引用附件')}</button></footer>
  </section>
}
