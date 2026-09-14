import { useId, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { memoryPluginTokens } from './plugin-ui.tsx'

const en = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }
const zh = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
const styles = `
.mnemon-markdown-editor{${memoryPluginTokens}display:grid;gap:10px;min-width:0;color:var(--mc-text)}.mnemon-markdown-editor label{margin:0;display:grid;gap:6px}.mnemon-markdown-editor textarea{width:100%;min-height:160px;resize:vertical;font:13px/1.65 ui-monospace,monospace;color:var(--mc-text);background:var(--mc-input);border:1px solid var(--mc-border);border-radius:9px;padding:12px}.mnemon-markdown-editor .mnemon-editor-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.mnemon-editor-actions small{flex:1;color:var(--mc-muted)}.mnemon-markdown-editor button{font:inherit;cursor:pointer;color:var(--mc-text);background:var(--mc-input);border:1px solid var(--mc-border);border-radius:8px;padding:7px 10px}.mnemon-markdown-editor button:disabled{cursor:default;opacity:.5}.mnemon-markdown-editor button[data-primary=true]{background:var(--mc-text);border-color:var(--mc-text);color:var(--mc-base)}.mnemon-markdown-editor :is(button,textarea):focus-visible{outline:2px solid var(--mc-focus);outline-offset:2px}.mnemon-markdown{min-width:0;overflow-wrap:anywhere;line-height:1.65}.mnemon-markdown pre{max-width:100%;overflow:auto}.mnemon-markdown table{display:block;max-width:100%;overflow:auto}.mnemon-markdown img{max-width:100%;height:auto}.mnemon-markdown-editor .mnemon-markdown{padding:12px;border:1px solid var(--mc-border);border-radius:9px;min-height:160px}
`

/** Reuse DSH's public renderer and its untrusted-content policy. */
export function MemoryMarkdown(props: { content: string; locale: string }) {
  return <div className="mnemon-markdown"><style>{styles}</style><MarkdownText text={props.content} labels={props.locale.startsWith('zh') ? zh : en} /></div>
}

export interface MemoryMarkdownEditorProps {
  label: string
  locale: string
  value: string
  savedValue: string
  /** Include other fields in the same save, such as an edited title. */
  dirty?: boolean
  disabled?: boolean
  saving?: boolean
  maxLength?: number
  rows?: number
  onChange(value: string): void
  /** The owner retains responsibility for versions, scope and error reporting. */
  onSave(): void
  onDiscard?(): void
}

export function MemoryMarkdownEditor(props: MemoryMarkdownEditorProps) {
  const chinese = props.locale.startsWith('zh'), [preview, setPreview] = useState(false), id = useId()
  const dirty = props.dirty ?? props.value !== props.savedValue
  const unavailable = props.disabled || props.saving
  return <div className="mnemon-markdown-editor" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation()
      if (dirty && !unavailable) props.onSave()
    }
  }}>
    <style>{styles}</style>
    <div className="mnemon-editor-actions"><span>{props.label}</span><button type="button" aria-pressed={preview} onClick={() => setPreview(value => !value)}>{preview ? chinese ? '继续编辑' : 'Continue editing' : chinese ? '预览 Markdown' : 'Preview Markdown'}</button></div>
    {preview ? <MemoryMarkdown content={props.value} locale={props.locale} /> : <label htmlFor={id}><textarea id={id} aria-label={props.label} value={props.value} disabled={unavailable} rows={props.rows ?? 8} maxLength={props.maxLength} onChange={event => props.onChange(event.target.value)} /></label>}
    <div className="mnemon-editor-actions"><small aria-live="polite">{props.saving ? chinese ? '正在保存…' : 'Saving…' : dirty ? chinese ? '有未保存的修改 · ⌘ / Ctrl + S 保存' : 'Unsaved changes · ⌘ / Ctrl + S to save' : chinese ? '内容已同步' : 'Content up to date'}</small><button type="button" data-primary="true" disabled={!dirty || unavailable} onClick={props.onSave}>{chinese ? '保存内容' : 'Save content'}</button>{props.onDiscard && <button type="button" disabled={!dirty || unavailable} onClick={props.onDiscard}>{chinese ? '放弃修改' : 'Discard changes'}</button>}</div>
  </div>
}
