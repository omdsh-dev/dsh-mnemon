import { useId, useState } from 'react'
import { MemoryMarkdown } from './plugin-editor.tsx'
import { memoryPluginTokens } from './plugin-ui.tsx'

export interface MemoryTextFile { path: string; content: string }
export interface MemoryFileEditorProps {
  files: readonly MemoryTextFile[]
  originalFiles?: readonly MemoryTextFile[]
  locale: string
  allowResourceChanges?: boolean
  readOnly?: boolean
  disabled?: boolean
  onChange?(files: MemoryTextFile[]): void
}
const styles = `
.mnemon-file-editor{${memoryPluginTokens}min-width:0;border:1px solid var(--mc-border);border-radius:10px;overflow:hidden}.mnemon-file-editor .mf-layout{display:grid;grid-template-columns:minmax(140px,1fr) minmax(0,4fr);min-height:240px}.mnemon-file-editor .mf-list{border-right:1px solid var(--mc-border);padding:8px;display:flex;flex-direction:column;gap:3px;min-width:0;background:var(--mc-input)}.mnemon-file-editor .mf-list button{text-align:left;border-color:transparent;border-radius:6px;font:12px/1.5 ui-monospace,monospace;word-break:break-word}.mnemon-file-editor .mf-list button[aria-pressed=true]{background:var(--mc-hover);color:var(--mc-text)}.mnemon-file-editor .mf-body{min-width:0;padding:12px}.mnemon-file-editor .mf-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px}.mnemon-file-editor .mf-actions code{flex:1;overflow-wrap:anywhere}.mnemon-file-editor textarea{width:100%;min-height:300px;resize:vertical;font:12px/1.7 ui-monospace,monospace;tab-size:2}.mnemon-file-editor pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace;margin:0;max-height:500px;overflow:auto}.mnemon-file-editor .mf-add{border-top:1px solid var(--mc-border);padding:8px;display:flex;gap:8px;flex-wrap:wrap}.mnemon-file-editor .mf-add input{flex:1;min-width:160px}.mnemon-file-editor .mf-diff{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mnemon-file-editor .mf-diff>section{min-width:0;padding:10px;background:var(--mc-input);border:1px solid var(--mc-border);border-radius:8px}.mnemon-file-editor .mf-diff h4{font-size:12px;font-weight:500;color:var(--mc-muted);margin:0 0 8px}.mnemon-file-editor .mf-removed{padding:8px 12px;border-top:1px solid var(--mc-border);color:var(--mc-muted);font-size:12px}@container(max-width:600px){.mnemon-file-editor .mf-layout{grid-template-columns:1fr}.mnemon-file-editor .mf-list{border-right:0;border-bottom:1px solid var(--mc-border);flex-direction:row;flex-wrap:wrap}.mnemon-file-editor .mf-diff{grid-template-columns:1fr}.mnemon-file-editor textarea{min-height:220px}}
`

/** Shared file review uses DSH theme tokens and text labels for every change. */
export function MemoryFileEditor(props: MemoryFileEditorProps) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [path, setPath] = useState('SKILL.md'), [preview, setPreview] = useState(false), [compare, setCompare] = useState(false), [newPath, setNewPath] = useState(''), id = useId()
  const selected = props.files.find(file => file.path === path) ?? props.files[0]
  const frontmatter = selected ? /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(selected.content) : null
  const original = props.originalFiles?.find(file => file.path === selected?.path), changed = !!selected && !!props.originalFiles && original?.content !== selected.content
  const removed = props.originalFiles?.filter(file => !props.files.some(current => current.path === file.path)) ?? []
  const editable = !props.readOnly && !!props.onChange, unavailable = props.disabled || !editable
  function add() {
    const next = newPath.trim()
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(next) || next.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || props.files.some(file => file.path.toLowerCase() === next.toLowerCase())) return
    props.onChange?.([...props.files, { path: next, content: '' }]); setPath(next); setNewPath(''); setCompare(false); setPreview(false)
  }
  return <div className="mnemon-file-editor"><style>{styles}</style><div className="mf-layout">
    <nav className="mf-list" aria-label={t('Skill resources', '技能资源文件')}>{props.files.map(file => <button type="button" key={file.path} disabled={props.disabled} aria-pressed={selected?.path === file.path} onClick={() => { setPath(file.path); setPreview(false) }}>{file.path}{props.originalFiles && props.originalFiles.find(original => original.path === file.path)?.content !== file.content && <small> · {props.originalFiles.some(original => original.path === file.path) ? t('changed', '已修改') : t('new', '新增')}</small>}</button>)}</nav>
    <div className="mf-body">{selected && <><div className="mf-actions"><code>{selected.path}</code>{selected.path.endsWith('.md') && <button type="button" aria-pressed={preview} onClick={() => { setPreview(value => !value); setCompare(false) }}>{preview ? t('Show text', '查看文本') : t('Preview', '预览')}</button>}{props.originalFiles && <button type="button" aria-pressed={compare} onClick={() => { setCompare(value => !value); setPreview(false) }}>{compare ? t('Close comparison', '收起对比') : t('Compare versions', '对比版本')}</button>}{editable && props.allowResourceChanges !== false && selected.path !== 'SKILL.md' && <button type="button" disabled={props.disabled} onClick={() => props.onChange?.(props.files.filter(file => file.path !== selected.path))}>{t('Remove resource', '移除资源')}</button>}</div>
      {compare ? <div className="mf-diff"><section><h4>{t('Comparison version', '对照版本')}</h4><pre>{original?.content ?? t('New file', '新增文件')}</pre></section><section><h4>{changed ? props.readOnly ? t('Selected version', '所选版本') : t('Candidate changes', '候选修改') : t('Unchanged', '内容未修改')}</h4><pre>{selected.content}</pre></section></div> : preview ? <>{frontmatter && <details><summary>{t('Document metadata', '文档元数据')}</summary><pre>{frontmatter[1]}</pre></details>}<MemoryMarkdown content={selected.content.slice(frontmatter?.[0].length ?? 0)} locale={props.locale} /></> : editable ? <label htmlFor={id}><span className="sr-only">{t('Resource content', '资源内容')}</span><textarea id={id} aria-label={t('Resource content', '资源内容')} value={selected.content} disabled={unavailable} spellCheck={false} maxLength={65536} onChange={event => props.onChange?.(props.files.map(file => file.path === selected.path ? { ...file, content: event.target.value } : file))} /></label> : <pre>{selected.content}</pre>}
    </>}</div></div>{removed.length > 0 && <div className="mf-removed">{t('Removed resources: ', '已移除资源：')}{removed.map(file => file.path).join(', ')}</div>}
    {editable && props.allowResourceChanges !== false && <div className="mf-add"><input aria-label={t('New resource path', '新资源相对路径')} value={newPath} disabled={props.disabled} placeholder="scripts/check.mjs" onChange={event => setNewPath(event.target.value)} /><button type="button" disabled={props.disabled || !newPath.trim() || props.files.length >= 24} onClick={add}>{t('Add resource', '添加资源')}</button></div>}
  </div>
}
