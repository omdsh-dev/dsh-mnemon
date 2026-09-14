import { useEffect, useRef, useState } from 'react'
import { MemoryFileEditor, useRequestVersion, type MemorySourcePageProps } from 'dsh-mnemon/client'
import { managementError } from 'dsh-mnemon/client'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'

type NativeEntry = { name: string; description: string; provider: string; source: string; enabled: boolean; protected: boolean }
type NativeDetail = NativeEntry & { content: string; directory: string | null; files: Array<{ path: string; content: string }>; digest: string; editable: boolean }
export function NativeSkills(props: MemorySourcePageProps & { onNotice(value: string): void; onError(value: string): void; onDirty(value: boolean): void; onGenerationStarted(id: string): void }) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [entries, setEntries] = useState<NativeEntry[]>([]), [roots, setRoots] = useState<string[]>([]), [configuredRoots, setConfiguredRoots] = useState<string[]>([]), [root, setRoot] = useState(''), [selected, setSelected] = useState<NativeDetail>(), [files, setFiles] = useState<NativeDetail['files']>([]), [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [instruction, setInstruction] = useState('')
  const requests = useRequestVersion(), busyRef = useRef(false), dirty = !!selected && JSON.stringify(files) !== JSON.stringify(selected.files)
  useEffect(() => { props.onDirty(dirty); return () => props.onDirty(false) }, [dirty])
  const disabled = busy || !props.writable
  async function load(name?: string) {
    if (!props.management || busyRef.current) return
    if (dirty) { props.onNotice(t('Save or discard resource edits before opening another skill.', '请先保存或放弃资源修改，再打开其他技能。')); return }
    const token = requests.begin(); busyRef.current = true; setBusy(true); props.onError('')
    try {
      const result = await props.management.read(name ? 'skills-native-read' : 'skills-catalog', name ? { name } : {})
      if (!requests.isCurrent(token)) return
      if (name) { const detail = result.value as unknown as NativeDetail; setSelected(detail); setFiles(detail.files) }
      else { const value = result.value as unknown as { skills: NativeEntry[]; roots: string[]; configuredRoots: string[] }; setEntries(value.skills); setRoots(value.roots); setConfiguredRoots(value.configuredRoots ?? []); if (selected && !value.skills.some(entry => entry.name === selected.name)) { setSelected(undefined); setFiles([]) } }
    } catch (error) { if (requests.isCurrent(token)) props.onError(managementError(error, zh)) }
    finally { if (requests.isCurrent(token)) { busyRef.current = false; setBusy(false) } }
  }
  useEffect(() => { void load() }, [])
  async function mutate(operation: string, input: Record<string, MemoryJsonValue>) {
    if (!props.management || busyRef.current || !props.writable) return
    busyRef.current = true; setBusy(true); props.onError('')
    const token = requests.begin()
    try {
      const current = await props.management.read('skills-catalog', {})
      const mutation = await props.management.mutate(operation, input, { confirmed: true, expectedRevision: current.revision })
      if (!requests.isCurrent(token)) return
      if (selected && ['skills-native-save', 'skills-native-toggle'].includes(operation)) {
        const result = await props.management.read('skills-native-read', { name: selected.name }), detail = result.value as unknown as NativeDetail
        if (!requests.isCurrent(token)) return
        setSelected(detail); setFiles(detail.files)
      }
      const result = await props.management.read('skills-catalog', {}), value = result.value as unknown as { skills: NativeEntry[]; roots: string[]; configuredRoots: string[] }
      if (!requests.isCurrent(token)) return
      setEntries(value.skills); setRoots(value.roots); setConfiguredRoots(value.configuredRoots ?? []); if (selected && !value.skills.some(entry => entry.name === selected.name)) { setSelected(undefined); setFiles([]) }; setRoot('')
      if (operation === 'skills-native-generate') {
        props.onNotice(t('Generating a revision with the current session model. The original skill remains available.', '正在使用当前会话模型生成修订，原技能继续可用。'))
        props.onGenerationStarted(String((mutation.value as { id?: string })?.id ?? ''))
      } else props.onNotice(t('Native skill settings saved.', '原生技能设置已保存。'))
    } catch (error) { if (requests.isCurrent(token)) props.onError(managementError(error, zh)) }
    finally { if (requests.isCurrent(token)) { busyRef.current = false; setBusy(false) } }
  }
  const changed = files.filter(file => selected?.files.find(original => original.path === file.path)?.content !== file.content)
  return <div style={{ marginTop: 18 }}>
    <p>{t('This catalog follows the current session’s DSH preset and workspace. Skills managed as published versions use the review workflow.', '此目录遵循当前会话的 DSH 预设与工作区。已发布的托管技能通过版本审核流程修改。')}</p>
    <div className="mc-toolbar"><input aria-label={t('Filter native skills', '筛选原生技能')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search name or description', '搜索名称或说明')} /><button disabled={busy || dirty} onClick={() => void load()}>{t('Reload catalog', '刷新目录')}</button></div>
    <details><summary>{t('Additional skill directories', '附加技能目录')} ({roots.length})</summary><p>{t('Directories are discovered by the native provider. Removing a directory only disconnects it; its files stay in place.', '目录由原生 Provider 发现。移除目录只解除接入，文件保留原位。')}</p>{roots.map(path => <div key={path} className="mc-meta"><code style={{ overflowWrap: 'anywhere' }}>{path}</code>{configuredRoots.includes(path) ? <span>{t('Plugin configuration', '由插件配置管理')}</span> : <button disabled={disabled || dirty} onClick={() => void mutate('skills-remove-root', { path })}>{t('Disconnect', '解除接入')}</button>}</div>)}<label>{t('Directory path', '目录路径')}<input value={root} onChange={event => setRoot(event.target.value)} placeholder="/path/to/skills" /></label><button disabled={disabled || dirty || !root.trim()} onClick={() => void mutate('skills-add-root', { path: root })}>{t('Connect directory', '接入目录')}</button></details>
    <div className="mnemon-skills-layout" style={{ marginTop: 16 }}><nav className="sk-list" aria-label={t('Native skills', '原生技能目录')}>{entries.filter(entry => (entry.name + ' ' + entry.description).toLowerCase().includes(query.toLowerCase())).map(entry => <button key={entry.name} aria-pressed={selected?.name === entry.name} disabled={busy} onClick={() => void load(entry.name)}><strong>{entry.name}</strong><small>{entry.source} · {entry.enabled ? t('Enabled', '已启用') : t('Disabled', '已停用')}</small></button>)}</nav><div className="sk-detail">{selected ? <article><h3>{selected.name}</h3><p>{selected.description}</p><div className="mc-meta"><span>{selected.provider}</span><span>{selected.source}</span><span>{selected.enabled ? t('Enabled', '已启用') : t('Disabled', '已停用')}</span></div>{selected.directory && <details><summary>{t('Resource directory', '资源目录')}</summary><code style={{ overflowWrap: 'anywhere' }}>{selected.directory}</code></details>}
      {selected.files.length ? <MemoryFileEditor allowResourceChanges={false} files={files} locale={props.locale} readOnly={!selected.editable} disabled={disabled} onChange={next => {
        // Existing native resources are edited one file at a time with a digest fence.
        if (next.length !== selected.files.length || next.some(file => !selected.files.some(original => original.path === file.path))) { props.onNotice(t('Add or remove resources through a reviewed skill candidate.', '请通过技能候选添加或移除资源。')); return }
        if (next.filter(file => selected.files.find(original => original.path === file.path)?.content !== file.content).length > 1) { props.onNotice(t('Save the current resource before editing another file.', '请先保存当前资源，再修改其他文件。')); return }
        setFiles(next)
      }} /> : <p className="mc-content">{selected.content}</p>}
      {selected.editable && <footer><button data-primary="true" disabled={disabled || changed.length !== 1} onClick={() => void mutate('skills-native-save', { name: selected.name, digest: selected.digest, path: changed[0]!.path, content: changed[0]!.content })}>{t('Save resource', '保存资源')}</button><button disabled={busy || !dirty} onClick={() => setFiles(selected.files)}>{t('Discard edits', '放弃修改')}</button><button disabled={disabled || dirty} onClick={() => void mutate('skills-native-toggle', { name: selected.name, digest: selected.digest })}>{selected.enabled ? t('Disable skill', '停用技能') : t('Enable skill', '启用技能')}</button></footer>}
      {selected.editable && <details><summary>{t('Generate a reviewed revision', '生成待审核修订')}</summary><label>{t('What should improve', '需要改进的方面')}<textarea value={instruction} maxLength={4000} onChange={event => setInstruction(event.target.value)} /></label><p>{t('The original stays available during review. Publication makes the managed version available through the native registry and preserves the original files.', '审核期间原技能继续可用。发布后通过原生注册表提供托管版本，并保留原始文件。')}</p><button disabled={disabled || dirty || !selected.enabled || !instruction.trim() || !props.sessionId} onClick={() => void mutate('skills-native-generate', { name: selected.name, digest: selected.digest, instruction })}>{t('Generate revision candidate', '生成修订候选')}</button></details>}
    </article> : <div className="sk-empty">{t('Select a native skill to inspect its resources.', '选择一个原生技能，查看它的资源。')}</div>}</div></div>
  </div>
}
