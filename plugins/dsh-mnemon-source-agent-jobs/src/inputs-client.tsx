import { useEffect, useRef, useState } from 'react'
import type { MemorySourcePageProps } from 'dsh-mnemon/client'
import type { MemoryJsonValue, MemoryTransferCatalog, MemoryTransferSnapshot } from 'dsh-mnemon/contracts'
import type { AssetInput, AssetReference, RecordValue } from 'dsh-mnemon/source-sdk'
import type { ContextCapture } from './inputs.ts'
interface Track { key: string; sourceKey: string; label: string; track: string }
export function JobInputPanel(props: MemorySourcePageProps & { record: RecordValue; revision: string; onSaved(): Promise<void> }) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [tracks, setTracks] = useState<Track[]>([]), [chosen, setChosen] = useState<string[]>([]), [captures, setCaptures] = useState<ContextCapture[]>([])
  const [images, setImages] = useState<AssetInput[]>([]), [keep, setKeep] = useState<string[]>([]), [kind, setKind] = useState('path'), [reference, setReference] = useState(''), [preview, setPreview] = useState<{ id: string; url: string }>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState(''), epoch = useRef(0)
  const assets = (props.record.data.assets ?? []) as unknown as AssetReference[], editable = props.record.data.status === 'draft' && props.writable
  useEffect(() => {
    const current = ++epoch.current; setBusy(false); setError(''); setStatus(''); setChosen([]); setTracks([]); setPreview(undefined)
    setCaptures(props.record.data.contextSnapshots as unknown as ContextCapture[] ?? []); setKeep(assets.map(asset => asset.id)); setImages((props.record.data.attachments as string[] ?? []).map(path => ({ path })))
    const directory = props.managementDirectory
    if (directory && editable) void Promise.all(directory.sources.filter(source => source.sourceInstanceKey !== props.sourceInstanceKey && source.availability !== 'unavailable' && source.capabilities.includes('export')).map(async source => {
      try { const result = await directory.client(source.sourceInstanceKey)!.read('transfer-catalog'), value = result.value as unknown as MemoryTransferCatalog
        return value.format === 'mnemon-source-transfer/v1' ? value.tracks.map(track => ({ key: source.sourceInstanceKey + '/' + track.id, sourceKey: source.sourceInstanceKey, label: source.management.label + ' · ' + track.label[zh ? 'zh-CN' : 'en'], track: track.id })) : []
      } catch { return [] }
    })).then(values => { if (epoch.current === current) setTracks(values.flat()) })
    return () => { epoch.current++ }
  }, [props.management, props.record.id, props.record.version])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])
  async function save() {
    if (!props.management || busy || !editable) return
    const current = epoch.current; setBusy(true); setError(''); setStatus('')
    try {
      const next = [...captures]
      for (const track of tracks.filter(track => chosen.includes(track.key))) {
        if (current !== epoch.current) return
        const source = props.managementDirectory?.client(track.sourceKey)
        if (!source) throw new Error(t('A selected Source is unavailable', '选定的 Source 不可用'))
        const result = await source.read('transfer-export', { track: track.track }), snapshot = result.value as unknown as MemoryTransferSnapshot
        if (snapshot.format !== 'mnemon-source-transfer/v1' || !Array.isArray(snapshot.entries)) throw new Error('Invalid Source export')
        // The Source owns payload semantics. Preserve its export verbatim as
        // user-selected reference data; do not guess which fields are active.
        const capture = { sourceKey: track.sourceKey, label: track.label, track: track.track, revision: result.revision, capturedAt: new Date().toISOString(), text: JSON.stringify(snapshot) }
        const index = next.findIndex(value => value.sourceKey === capture.sourceKey && value.track === capture.track)
        if (index >= 0) next[index] = capture; else next.push(capture)
      }
      if (current !== epoch.current) return
      await props.management.mutate('set-job-inputs', { id: props.record.id, images, keepAssetIds: keep, contextSnapshots: next } as unknown as MemoryJsonValue, { confirmed: true, expectedRevision: props.revision })
      if (current === epoch.current) { await props.onSaved(); props.onRefresh?.(); setStatus(t('Input copies saved. Review them in the execution plan.', '输入副本已保存，可在执行计划中审阅。')) }
    } catch (error) { if (current === epoch.current) setError(String(error)) }
    finally { if (current === epoch.current) setBusy(false) }
  }
  const view = async (asset: AssetReference) => {
    const current = epoch.current
    try { const result = await props.management!.read('job-asset', { id: props.record.id, assetId: asset.id }); if (current !== epoch.current) return
      const data = result.value as { base64: string }; setPreview({ id: asset.id, url: URL.createObjectURL(new Blob([Uint8Array.from(atob(data.base64), value => value.charCodeAt(0))], { type: asset.mediaType })) })
    } catch (error) { if (current === epoch.current) setError(String(error)) }
  }
  return <section aria-label={t('Saved job inputs', '任务输入副本')} style={{ marginTop: 20 }}><h3>{t('Saved job inputs', '任务输入副本')}</h3>
    <p>{t('Copy selected images and Source exports into this job. The execution plan includes the saved context; future Source changes do not alter it.', '将选中的图片和 Source 导出内容保存到任务。执行计划使用这份上下文副本，来源后续变化不会改动它。')}</p>
    {captures.map((capture, index) => <details key={capture.sourceKey + '/' + capture.track}><summary>{capture.label} · {capture.text.length} {t('characters', '字符')}</summary><p>{capture.revision} · {new Date(capture.capturedAt).toLocaleString(props.locale)}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' }}>{capture.text}</pre>{editable && <button onClick={() => setCaptures(values => values.filter((_, i) => i !== index))}>{t('Remove snapshot from selection', '从选择中移除快照')}</button>}</details>)}
    {assets.map(asset => <div key={asset.id} style={{ marginTop: 8 }}>{editable && <input type="checkbox" aria-label={t('Keep image: ', '保留图片：') + asset.name} checked={keep.includes(asset.id)} onChange={event => setKeep(values => event.target.checked ? [...values, asset.id] : values.filter(id => id !== asset.id))} />}<strong>{asset.name}</strong> · {Math.ceil(asset.bytes / 1024)} KB <button onClick={() => void view(asset)}>{t('Preview saved image', '预览已存图片')}</button>{preview?.id === asset.id && <img src={preview.url} alt={asset.name} style={{ display: 'block', maxWidth: '100%', maxHeight: 260, objectFit: 'contain', marginTop: 8 }} />}</div>)}
    {editable && <details><summary>{t('Select input copies', '选择输入副本')}</summary><div className="mc-fields">{tracks.map(track => <label key={track.key}><input type="checkbox" checked={chosen.includes(track.key)} onChange={event => setChosen(values => event.target.checked ? [...values, track.key] : values.filter(key => key !== track.key))} />{track.label}</label>)}</div>
      <div className="mc-fields"><label>{t('Image source', '图片来源')}<select value={kind} onChange={event => setKind(event.target.value)}><option value="path">{t('Project file', '项目文件')}</option><option value="url">{t('Configured URL', '已配置 URL')}</option><option value="session">{t('Latest session image', '当前会话最新图片')}</option></select></label>{kind !== 'session' && <label>{t('Image path or URL', '图片路径或 URL')}<input value={reference} onChange={event => setReference(event.target.value)} /></label>}</div>
      <button disabled={images.length + keep.length >= 8 || kind !== 'session' && !reference.trim()} onClick={() => { setImages(values => [...values, kind === 'session' ? { latestSessionImage: true } : kind === 'url' ? { url: reference } : { path: reference }]); setReference('') }}>{t('Add image to selection', '将图片加入选择')}</button>
      <label>{t('Upload image files', '上传图片文件')}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={busy} onChange={event => { const files = Array.from(event.target.files ?? []), current = epoch.current; event.target.value = ''; setError(''); void (async () => {
        const next: AssetInput[] = []
        if (files.length + images.length + keep.length > 8) throw new Error(t('At most eight images', '最多八张图片'))
        for (const file of files) { if (file.size > 5 * 1024 * 1024) throw new Error(t('Each image must be at most 5 MiB', '单张图片最大 5 MiB')); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384)); next.push({ name: file.name, base64: btoa(binary) }) }
        if (current === epoch.current) setImages(values => [...values, ...next])
      })().catch(error => { if (current === epoch.current) setError(String(error)) }) }} /></label>
      {images.map((value, index) => <p key={index} style={{ overflowWrap: 'anywhere' }}>{value.name || value.path || value.url || t('Latest session image', '当前会话最新图片')} <button onClick={() => setImages(values => values.filter((_, i) => i !== index))}>{t('Remove selected image', '移除所选图片')}</button></p>)}
      <button disabled={busy || !props.writable} onClick={() => void save()}>{t('Save input copies', '保存输入副本')}</button>
    </details>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
  </section>
}
