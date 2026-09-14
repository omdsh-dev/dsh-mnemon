import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { installMemorySourceUI, MemoryMarkdown, MemoryMarkdownEditor, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import type { Geometry, MaterialContent } from './engine.ts'
import { canvasStyles } from './styles.ts'
export const inject = ['slots']
type Board = { records: RecordValue[]; maxFileBytes: number; openLocalFiles: boolean }
type Camera = { x: number; y: number; zoom: number }
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const shape = (record: RecordValue): Geometry => ({ x: Number(record.data.x), y: Number(record.data.y), width: Number(record.data.width), height: Number(record.data.height) })
const localKey = (props: MemorySourcePageProps, view: string) => `mnemon:canvas:${props.sourceInstanceKey}:${props.workspaceId ?? ''}:${props.sessionId ?? ''}:${view}`
const loadCamera = (key: string): Camera => { try { const v = JSON.parse(localStorage.getItem(key) ?? '{}') as Camera; if ([v.x, v.y, v.zoom].every(Number.isFinite) && v.zoom >= .2 && v.zoom <= 3 && Math.abs(v.x) <= 1000000 && Math.abs(v.y) <= 1000000) return v } catch {} return { x: 30, y: 30, zoom: 1 } }
const copy = async (text: string) => { await navigator.clipboard.writeText(text) }
function Card(props: MemorySourcePageProps & { record: RecordValue; view: string; selected: boolean; openLocalFiles: boolean; busy: boolean; zoom: number; onSelect(): void; onEdit(): void; onMove(next: Geometry): void; onCommit(next: Geometry): void; onAction(operation: string): void; onError(error: unknown): void }) {
  const { record } = props, zh = props.locale.startsWith('zh'), geo = shape(record)
  const [url, setUrl] = useState(''), [text, setText] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false), [details, setDetails] = useState<MaterialContent>()
  const serial = useRef(0), objectUrl = useRef(''), card = useRef<HTMLElement>(null)
  const read = useCallback(async () => {
    const current = ++serial.current; setLoading(true); setError('')
    try {
      const result = await props.management!.read('read-node', { id: record.id, view: props.view })
      if (current !== serial.current) return
      const material = result.value as unknown as MaterialContent, bytes = Uint8Array.from(atob(material.base64), c => c.charCodeAt(0))
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = URL.createObjectURL(new Blob([bytes], { type: material.mediaType }))
      setUrl(objectUrl.current); setText(material.mediaType === 'text/plain' ? new TextDecoder().decode(bytes) : ''); setDetails(material)
    } catch (error) { if (current === serial.current) { const message = error instanceof Error ? error.message : String(error); setError(/ENOENT|no such file/i.test(message) ? zh ? '文件已移动或不存在。恢复原路径后可重新读取。' : 'The file was moved or is missing. Restore its path, then reload.' : message); setUrl(''); setText('') } }
    finally { if (current === serial.current) setLoading(false) }
  }, [props.management, props.view, record.id, zh])
  useEffect(() => {
    if (record.kind === 'note' || !card.current) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void read() } }, { root: card.current.closest('.cv-board') })
    observer.observe(card.current)
    return () => { observer.disconnect(); serial.current++; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = '' }
  }, [read, record.kind])
  const drag = useRef<{ pointer: number; x: number; y: number; shape: Geometry; next: Geometry; resize: boolean }>()
  const start = (event: PointerEvent<HTMLElement>, resize: boolean) => {
    props.onSelect()
    if (!props.writable || props.busy || record.state !== 'active' || event.button !== 0) return
    event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, shape: geo, next: geo, resize }
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.pointer !== event.pointerId) return
    const dx = (event.clientX - d.x) / props.zoom, dy = (event.clientY - d.y) / props.zoom
    d.next = d.resize ? { ...d.shape, width: clamp(d.shape.width + dx, 180, 2400), height: clamp(d.shape.height + dy, 180, 2400) } : { ...d.shape, x: clamp(d.shape.x + dx, -1000000, 1000000), y: clamp(d.shape.y + dy, -1000000, 1000000) }
    props.onMove(d.next)
  }
  const end = (event: PointerEvent<HTMLElement>) => { const d = drag.current; if (!d || d.pointer !== event.pointerId) return; drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); if (JSON.stringify(d.next) !== JSON.stringify(d.shape)) props.onCommit(d.next) }
  const cancel = () => { const d = drag.current; drag.current = undefined; if (d) props.onMove(d.shape) }
  const invalid = () => setError(zh ? '媒体格式无效，可下载文件检查。' : 'Invalid media format. Download to inspect the file.')
  return <article ref={card} className="cv-card" data-selected={props.selected} aria-label={record.title} style={{ left: geo.x, top: geo.y, width: geo.width, height: geo.height, zIndex: props.selected ? 1000 : 1 }} onClick={props.onSelect}>
    <header onPointerDown={event => start(event, false)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel}><strong>{record.title}</strong><span>{zh ? ({ global: '全局', project: '项目', session: '会话' } as Record<string, string>)[record.scope] : record.scope}{record.data.createdBy === 'model' ? zh ? ' · 模型便签' : ' · Model note' : ''}</span></header>
    <main>{record.kind === 'note' ? <MemoryMarkdown content={record.content} locale={props.locale} /> : <>{loading && <small>{zh ? '正在读取素材…' : 'Loading material…'}</small>}{error && <p role="alert">{error}</p>}{url && <>{details?.mediaType.startsWith('image/') && <img draggable={false} src={url} alt={record.title} onError={invalid} />}{details?.mediaType.startsWith('audio/') && <audio controls src={url} onError={invalid} />}{details?.mediaType.startsWith('video/') && <video controls src={url} onError={invalid} />}{text && <pre>{text}</pre>}{!text && !/^(image|audio|video)\//.test(details?.mediaType ?? '') && <p>{details?.mediaType} · {details?.bytes} bytes</p>}</>}</>}
    </main>
    <footer><button onClick={() => void copy(`[material:${record.id}] ${record.title}`).catch(props.onError)}>{zh ? '复制引用' : 'Copy reference'}</button><button onClick={props.onEdit}>{zh ? '详情' : 'Details'}</button>{record.kind !== 'note' && <button disabled={loading} onClick={() => void read()}>{zh ? '重读' : 'Reload'}</button>}{url && <a href={url} download={details?.name}>{zh ? '下载' : 'Download'}</a>}{props.openLocalFiles && record.kind === 'file' && <button disabled={!props.writable || props.busy} onClick={() => props.onAction('open-file')}>{zh ? '在服务主机打开' : 'Open on service host'}</button>}</footer>
    {props.writable && record.state === 'active' && <button className="cv-resize" aria-label={(zh ? '调整卡片大小：' : 'Resize card: ') + record.title} onPointerDown={event => start(event, true)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} />}
  </article>
}
export function Page(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [board, setBoard] = useState<Board>({ records: [], maxFileBytes: 5242880, openLocalFiles: false }), [revision, setRevision] = useState(''), [view, setView] = useState('session'), [query, setQuery] = useState(''), [archived, setArchived] = useState(false)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState(''), [form, setForm] = useState(''), [title, setTitle] = useState(''), [content, setContent] = useState(''), [filePath, setFilePath] = useState(''), [scope, setScope] = useState(props.workspaceId ? 'project' : props.sessionId ? 'session' : 'global')
  const [fileName, setFileName] = useState(''), [base64, setBase64] = useState(''), [search, setSearch] = useState(''), [fileSource, setFileSource] = useState(''), [results, setResults] = useState<Array<{ id: string; text: string; provenance: { path: string } }>>([])
  const key = localKey(props, view), [camera, setCamera] = useState<Camera>(() => loadCamera(key)), [details, setDetails] = useState(false), [placement, setPlacement] = useState<Geometry>({ x: 0, y: 0, width: 320, height: 260 })
  const epoch = useRef(0), serial = useRef(0), uploadSerial = useRef(0), viewport = useRef<HTMLDivElement>(null), cameraRef = useRef(camera), busyRef = useRef(false)
  const [editingVersion, setEditingVersion] = useState(0)
  cameraRef.current = camera
  const sourceKey = props.management?.sourceInstanceKey
  const refresh = useCallback(async () => {
    const current = ++serial.current, generation = epoch.current
    if (!props.management) return
    try { const result = await props.management.read('board', { view, query, archived }); if (current === serial.current && generation === epoch.current) { setBoard(result.value as unknown as Board); setRevision(result.revision) } }
    catch (error) { if (current === serial.current && generation === epoch.current) setError(String(error)) }
  }, [props.management, view, query, archived])
  useEffect(() => { epoch.current++; setBoard({ records: [], maxFileBytes: 5242880, openLocalFiles: false }); setForm(''); setSelected(''); setDetails(false); setError(''); setBusy(false); busyRef.current = false; setScope(props.workspaceId ? 'project' : props.sessionId ? 'session' : 'global'); return () => { epoch.current++ } }, [sourceKey, props.workspaceId, props.sessionId])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setCamera(loadCamera(key)) }, [key])
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(camera)) } catch {} }, [key, camera])
  const updateCamera = useCallback((zoom: number, x?: number, y?: number) => {
    const rect = viewport.current?.getBoundingClientRect(), point = { x: x ?? (rect?.width ?? 500) / 2, y: y ?? (rect?.height ?? 500) / 2 }
    setCamera(old => { const z = clamp(zoom, .2, 3); return { zoom: z, x: point.x - (point.x - old.x) * z / old.zoom, y: point.y - (point.y - old.y) * z / old.zoom } })
  }, [])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const wheel = (event: WheelEvent) => { event.preventDefault(); const rect = el.getBoundingClientRect(); updateCamera(cameraRef.current.zoom * Math.exp(-event.deltaY * .001), event.clientX - rect.left, event.clientY - rect.top) }
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel)
  }, [updateCamera])
  const write = async (operation: string, input: Record<string, MemoryJsonValue>) => {
    if (!props.management || !props.writable || busyRef.current) return
    const generation = epoch.current; busyRef.current = true; setBusy(true); setError('')
    try { const result = await props.management.mutate(operation, { ...input, view }, { confirmed: true, expectedRevision: revision }); if (generation !== epoch.current) return; setRevision(result.revision); if (['add-note', 'register-file', 'upload'].includes(operation)) { setForm(''); setTitle(''); setContent(''); setBase64(''); setFileName(''); const id = (result.value as { id?: string }).id; if (id) setSelected(id) } if (operation === 'edit') setDetails(false); if (['archive', 'delete'].includes(operation)) { setDetails(false); setSelected('') } await refresh() }
    catch (error) { if (generation === epoch.current) { setError(error instanceof Error ? error.message : String(error)); await refresh() } }
    finally { if (generation === epoch.current) { busyRef.current = false; setBusy(false) } }
  }
  const selectedRecord = board.records.find(record => record.id === selected)
  useEffect(() => { if (selectedRecord) setPlacement(shape(selectedRecord)) }, [selectedRecord?.id, selectedRecord?.version])
  const focus = (record: RecordValue) => { setSelected(record.id); setPlacement(shape(record)); const g = shape(record), rect = viewport.current?.getBoundingClientRect(); setCamera({ zoom: 1, x: (rect?.width ?? 600) / 2 - g.x - g.width / 2, y: (rect?.height ?? 500) / 2 - g.y - g.height / 2 }) }
  const pan = useRef<{ pointer: number; x: number; y: number; camera: Camera }>()
  const files = props.managementDirectory?.sources.filter(source => source.sourceTypeId === 'files' && source.availability !== 'unavailable') ?? []
  const findFiles = async () => {
    const generation = epoch.current, id = fileSource || (files.length === 1 ? files[0]!.sourceInstanceKey : '')
    const client = props.managementDirectory?.client(id)
    if (!client) { setError(t('Choose a file search Source.', '请选择文件检索 Source。')); return }
    setBusy(true); setError('')
    try { const result = await client.read('lookup-find', { query: search, mode: 'name', types: 'all', limit: 30 }); if (generation === epoch.current) setResults((result.value as unknown as { items: typeof results }).items) }
    catch (error) { if (generation === epoch.current) setError(String(error)) }
    finally { if (generation === epoch.current) setBusy(false) }
  }
  const center = () => { const rect = viewport.current?.getBoundingClientRect(); return { x: Math.round(((rect?.width ?? 640) / 2 - camera.x) / camera.zoom - 160), y: Math.round(((rect?.height ?? 500) / 2 - camera.y) / camera.zoom - 130) } }
  return <section className="cv-page" aria-label={t('Material board', '素材画布')}><style>{canvasStyles}</style><h2>{t('Material board', '素材画布')}</h2><p>{t('Arrange notes and live file references. Read material only when you need it.', '自由摆放便签和文件引用，需要时再读取素材。')}</p>
    <div className="cv-toolbar"><button data-primary disabled={!props.writable || busy} onClick={() => { setForm('note'); setTitle(''); setContent('') }}>{t('New note', '新建便签')}</button><button disabled={!props.writable || busy} onClick={() => { setForm('file'); setTitle(''); setFilePath('') }}>{t('Reference file', '引用文件')}</button><button disabled={!props.writable || busy} onClick={() => setForm('upload')}>{t('Upload material', '上传素材')}</button><button disabled={!files.length || busy} onClick={() => setForm('search')}>{t('Find files', '检索后添加')}</button>
      <select aria-label={t('Board view', '画布视角')} value={view} onChange={event => { setView(event.target.value); setSelected(''); setDetails(false); setForm('') }}><option value="session">{t('This session + project + global', '当前会话＋项目＋全局')}</option><option value="project">{t('Current project and its sessions', '当前项目及其会话')}</option><option value="all">{t('All materials', '全部素材')}</option></select>
      <input aria-label={t('Find a material', '搜索画布素材')} value={query} placeholder={t('Search title, note or path', '搜索标题、便签或路径')} onChange={event => setQuery(event.target.value)} /><label><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />{t('Archived', '已归档')}</label><button disabled={busy} onClick={() => void refresh()}>{t('Refresh board', '刷新画布')}</button></div>
    {error && <p role="alert">{error}</p>}
    {form && <form className="cv-form" onSubmit={event => { event.preventDefault(); if (form === 'search') void findFiles(); else void write(form === 'note' ? 'add-note' : form === 'file' ? 'register-file' : 'upload', { title, content, path: filePath, base64, name: fileName, scope, ...center() }) }}>
      <h3>{form === 'note' ? t('Write a note', '编写便签') : form === 'file' ? t('Register a live file reference', '登记实时文件引用') : form === 'upload' ? t('Upload a retained copy', '上传并保留副本') : t('Search with the Files Source', '通过 Files Source 检索')}</h3>
      {form !== 'search' && <><label>{t('Material title', '素材标题')}<input value={title} maxLength={300} onChange={event => setTitle(event.target.value)} /></label><label>{t('Material ownership', '素材归属')}<select value={scope} onChange={event => setScope(event.target.value)}><option value="session" disabled={!props.sessionId}>{t('Session', '会话')}</option><option value="project" disabled={!props.workspaceId}>{t('Project', '项目')}</option><option value="global">{t('Global', '全局')}</option></select></label></>}
      {form === 'note' && <MemoryMarkdownEditor label={t('Note content', '便签内容')} locale={props.locale} value={content} savedValue="" dirty={Boolean(title || content)} maxLength={100000} disabled={!props.writable} saving={busy} onChange={setContent} onSave={() => void write('add-note', { title, content, scope, ...center() })} />}
      {form === 'file' && <><label>{t('Workspace or registered file path', '工作区或已登记目录中的文件路径')}<input required value={filePath} onChange={event => setFilePath(event.target.value)} /></label><small>{t('The file stays in place. Changes appear when reloaded; missing files show an error.', '保留原文件位置。重读时显示最新内容；文件缺失时显示提示。')}</small></>}
      {form === 'upload' && <label>{t('Select a local file', '选择本地文件')}<input type="file" onChange={event => { const current = ++uploadSerial.current, file = event.target.files?.[0]; setBase64(''); setFileName(''); if (!file) return; if (file.size > board.maxFileBytes) { setError(t('File exceeds the size limit.', '文件超过大小限制。')); return } const generation = epoch.current, reader = new FileReader(); reader.onload = () => { if (generation === epoch.current && current === uploadSerial.current) { setBase64(String(reader.result).split(',')[1] ?? ''); setFileName(file.name); if (!title) setTitle(file.name) } }; reader.onerror = () => { if (generation === epoch.current && current === uploadSerial.current) setError(t('Unable to read this local file.', '无法读取本地文件。')) }; reader.readAsDataURL(file) }} /></label>}
      {form === 'search' && <>{files.length > 1 && <select aria-label={t('File search Source', '文件检索 Source')} value={fileSource} onChange={event => setFileSource(event.target.value)}><option value="">{t('Choose a Source', '选择 Source')}</option>{files.map(source => <option key={source.sourceInstanceKey} value={source.sourceInstanceKey}>{source.sourceInstanceKey}</option>)}</select>}<label>{t('File name', '文件名')}<input required value={search} onChange={event => setSearch(event.target.value)} /></label><ul>{results.map(result => <li key={result.id}><span>{result.provenance.path}</span><button type="button" disabled={!props.writable || busy} onClick={() => { setForm('file'); setFilePath(result.provenance.path); setTitle('') }}>{t('Add this file', '添加此文件')}</button></li>)}</ul></>}
      <div className="cv-row">{form !== 'note' && <button data-primary disabled={busy || form === 'upload' && !base64}>{form === 'search' ? t('Search files', '检索文件') : t('Place on board', '放到画布')}</button>}<button type="button" onClick={() => setForm('')}>{t('Cancel', '取消')}</button></div></form>}
    {details && selectedRecord && <div className="cv-form"><h3>{selectedRecord.title}</h3><label>{t('Edit title', '编辑标题')}<input value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>{selectedRecord.kind === 'note' && <MemoryMarkdownEditor label={t('Edit note', '编辑便签')} locale={props.locale} value={content} savedValue={selectedRecord.content} dirty={content !== selectedRecord.content || title !== selectedRecord.title} maxLength={100000} disabled={!props.writable} saving={busy} onChange={setContent} onSave={() => void write('edit', { id: selected, version: editingVersion, title, content })} onDiscard={() => { setTitle(selectedRecord.title); setContent(selectedRecord.content); setEditingVersion(selectedRecord.version) }} />}
      <small className="cv-info">{selectedRecord.id}<br />{String(selectedRecord.data.path ?? '')}</small><div className="cv-row">{selectedRecord.kind !== 'note' && <button disabled={!props.writable || busy} onClick={() => void write('edit', { id: selected, version: editingVersion, title, content })}>{t('Save changes', '保存修改')}</button>}<button onClick={() => void copy(selectedRecord.id).catch(error => setError(String(error)))}>{t('Copy ID', '复制 ID')}</button><button onClick={() => void copy(selectedRecord.title).catch(error => setError(String(error)))}>{t('Copy title', '复制标题')}</button>{selectedRecord.kind === 'file' && <button onClick={() => void copy(String(selectedRecord.data.path)).catch(error => setError(String(error)))}>{t('Copy path', '复制路径')}</button>}<button disabled={!props.writable || busy} onClick={() => void write(archived ? 'restore' : 'archive', { id: selected, version: selectedRecord.version })}>{archived ? t('Restore card', '恢复卡片') : t('Archive card', '归档卡片')}</button>{archived && <button disabled={!props.writable || busy} onClick={() => void write('delete', { id: selected, version: selectedRecord.version })}>{t('Delete archived card', '删除已归档卡片')}</button>}<button onClick={() => setDetails(false)}>{t('Close details', '关闭详情')}</button></div></div>}
    <div className="cv-toolbar"><button aria-label={t('Zoom out', '缩小画布')} onClick={() => updateCamera(camera.zoom / 1.2)}>−</button><output>{Math.round(camera.zoom * 100)}%</output><button aria-label={t('Zoom in', '放大画布')} onClick={() => updateCamera(camera.zoom * 1.2)}>＋</button><button onClick={() => setCamera({ x: 30, y: 30, zoom: 1 })}>{t('Reset view', '重置视角')}</button><button disabled={!board.records.length} onClick={() => { const minX = Math.min(...board.records.map(record => Number(record.data.x))), minY = Math.min(...board.records.map(record => Number(record.data.y))), maxX = Math.max(...board.records.map(record => Number(record.data.x) + Number(record.data.width))), maxY = Math.max(...board.records.map(record => Number(record.data.y) + Number(record.data.height))); const rect = viewport.current!.getBoundingClientRect(), zoom = clamp(Math.min((rect.width - 60) / (maxX - minX), (rect.height - 60) / (maxY - minY)), .2, 1.5); setCamera({ x: 30 - minX * zoom, y: 30 - minY * zoom, zoom }) }}>{t('Fit all cards', '显示全部卡片')}</button><small className="cv-info">{t('Drag empty space to pan; use the wheel to zoom. Select a card to adjust its position.', '拖动空白处平移，滚轮缩放。选择卡片可调整位置。')}</small></div>
    <div ref={viewport} className="cv-board" tabIndex={0} aria-label={t('Material canvas', '素材摆放区域')} onPointerDown={event => { if ((event.target as HTMLElement).closest('.cv-card') || event.button !== 0) return; pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, camera }; event.currentTarget.setPointerCapture(event.pointerId); setSelected(''); setDetails(false) }} onPointerMove={event => { const p = pan.current; if (p && p.pointer === event.pointerId) setCamera({ ...p.camera, x: p.camera.x + event.clientX - p.x, y: p.camera.y + event.clientY - p.y }) }} onPointerUp={event => { if (pan.current?.pointer === event.pointerId) { pan.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId) } }} onPointerCancel={() => { pan.current = undefined }} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Escape') { setSelected(''); setDetails(false) } if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setCamera(old => ({ ...old, x: old.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: old.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) })) } }}>
      {!board.records.length && <div className="cv-empty"><h3>{t('A place for your working material', '把工作素材放在这里')}</h3><p>{t('Add a note, register a file, or upload media.', '添加便签、登记文件引用，或上传媒体。')}</p></div>}
      <div className="cv-world" style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})` }}>{board.records.map(record => <Card key={record.id} {...props} record={record} view={view} zoom={camera.zoom} selected={selected === record.id} openLocalFiles={board.openLocalFiles} busy={busy} onSelect={() => { setSelected(record.id); setPlacement(shape(record)) }} onEdit={() => { setSelected(record.id); setTitle(record.title); setContent(record.content); setEditingVersion(record.version); setDetails(true) }} onMove={next => { setBoard(old => ({ ...old, records: old.records.map(item => item.id === record.id ? { ...item, data: { ...item.data, ...next } } : item) })); setPlacement(next) }} onCommit={next => void write('move', { id: record.id, version: record.version, ...next })} onAction={operation => void write(operation, { id: record.id, version: record.version })} onError={error => setError(String(error))} />)}</div></div>
    {selectedRecord && <form className="cv-inspector" onSubmit={event => { event.preventDefault(); void write('move', { id: selected, version: selectedRecord.version, ...placement }) }}><span>{selectedRecord.title}</span>{(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>{t(field, { x: '横向', y: '纵向', width: '宽度', height: '高度' }[field])}<input type="number" value={placement[field]} onChange={event => setPlacement(old => ({ ...old, [field]: Number(event.target.value) }))} /></label>)}<button disabled={!props.writable || busy}>{t('Apply position', '应用位置')}</button></form>}
    <div className="cv-bottom"><small>{board.records.length} {t('cards · view is saved on this browser', '张卡片 · 视角保存在本浏览器')} · {t('Files are read live', '文件按需读取最新内容')}</small><details><summary>{t('Card index', '卡片目录')}</summary><div className="cv-results">{board.records.map(record => <div className="cv-result" key={record.id}><span>{record.title}</span><button onClick={() => focus(record)}>{t('Locate', '定位')}</button></div>)}</div></details><button disabled={!props.writable || busy} onClick={() => void write('prune-assets', {})}>{t('Clean unused uploads', '清理未使用的上传素材')}</button></div>
  </section>
}
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'canvas', pages: [{ id: 'board', label: 'Material board', localizedLabel: { en: 'Material board', 'zh-CN': '素材画布' }, order: 58, component: Page, coordinateSources: true, navigation: { group: 'sources', primary: true } }] }) }
