import { installMemorySourceUI, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import { createCollectionPage, LookupPanel, type LookupPanelOptions } from 'dsh-mnemon/client'
export const inject = ['slots']
const options: LookupPanelOptions = {
  title: { en: 'Search workspace files', 'zh-CN': '检索工作区文件' }, operation: 'find', defaults: { query: '', mode: 'content', types: 'documents' },
  fields: [
    { key: 'query', label: { en: 'Search text', 'zh-CN': '检索文本' }, type: 'text' },
    { key: 'mode', label: { en: 'Search in', 'zh-CN': '检索位置' }, type: 'select', options: [{ value: 'content', label: { en: 'Contents', 'zh-CN': '文件内容' } }, { value: 'name', label: { en: 'File names', 'zh-CN': '文件名' } }] },
    { key: 'types', label: { en: 'File types', 'zh-CN': '文件类型' }, type: 'select', options: [{ value: 'documents', label: { en: 'Documents', 'zh-CN': '文档' } }, { value: 'all', label: { en: 'All types', 'zh-CN': '所有类型' } }] },
    { key: 'root', label: { en: 'Registered directory (blank for all)', 'zh-CN': '已登记目录（留空选择全部）' }, type: 'text' },
  ],
  itemActions: [{ label: { en: 'Read excerpt', 'zh-CN': '读取片段' }, operation: 'read-file', input(item) { const p = item.provenance as { path: string; line?: number }; return { path: p.path, startLine: Math.max(1, (p.line ?? 1) - 3), lines: 80 } } }],
}
const Saved = createCollectionPage({ title: { en: 'Saved searches', 'zh-CN': '已保存的检索' }, description: { en: 'Save a query for your project or for all workspaces.', 'zh-CN': '保存项目内或跨工作区复用的检索条件。' }, kinds: [{ value: 'saved-search', label: { en: 'Search', 'zh-CN': '检索条件' } }], scopes: ['project', 'global'], defaultScope: 'project', fields: [{ key: 'query', label: { en: 'Query', 'zh-CN': '检索文本' }, type: 'text' }] })
export function Page(props: MemorySourcePageProps) { return <><LookupPanel {...props} options={options} /><details><summary>{props.locale.startsWith('zh') ? '保存检索条件' : 'Saved searches'}</summary><Saved {...props} /></details></> }
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'files', pages: [{ id: 'files', label: 'Files', localizedLabel: { en: 'Files', 'zh-CN': '文件检索' }, order: 45, component: Page, navigation: { group: 'sources', primary: true } }] }) }
