import { SkillFiles } from './file-client.tsx'
import { SkillsPage } from './skill-client.tsx'
import { LibraryViews } from './library-client.tsx'
import { installMemorySourceUI, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import { createCollectionPage, RecordActionPanel, type RecordActionPanelOptions } from 'dsh-mnemon/client'
export const inject = ['slots']
const LibraryPage = createCollectionPage({
  reviewedRevisions: true,
  renderRecords: context => <LibraryViews {...context} />,
  "title": {
    "en": "Playbooks",
    "zh-CN": "工作方法"
  },
  "description": {
    "en": "Turn useful procedures into reviewed skills and reusable prompts. Read details only when needed.",
    "zh-CN": "将有效方法整理为经过审核的技能和可复用提示词，按需读取详情。"
  },
  "kinds": [
    {
      "value": "skill",
      "label": {
        "en": "Skill",
        "zh-CN": "技能"
      }
    },
    {
      "value": "prompt",
      "label": {
        "en": "Prompt",
        "zh-CN": "提示词"
      }
    }
  ],
  "scopes": [
    "project",
    "global"
  ],
  "defaultScope": "project",
  "fields": [
    { key: "summary", label: { en: "Short description", "zh-CN": "简要说明" }, type: "text" },
    { key: "tags", label: { en: "Tags", "zh-CN": "标签" }, type: "text" },
    {
      "key": "slug",
      "label": {
        "en": "Reusable name",
        "zh-CN": "通用名称"
      },
      "type": "text"
    },
    {
      "key": "category",
      "label": {
        "en": "Category",
        "zh-CN": "分类"
      },
      "type": "text"
    },
    {
      "key": "enabled",
      "label": {
        "en": "Enabled",
        "zh-CN": "已启用"
      },
      "type": "boolean",
      "defaultValue": true
    }
  ],
  "recordActions": [
    {
      "label": {
        "en": "Toggle enabled",
        "zh-CN": "切换启用状态"
      },
      "operation": "toggle"
    }
  ]
})
const invokeOptions: RecordActionPanelOptions = {
  title: { en: 'Use in this session', 'zh-CN': '在当前会话中使用' }, filter: record => record.kind !== 'schedule' && record.state === 'active' && record.data.enabled === true,
  fields: [
    { key: 'variables', label: { en: 'Variables (JSON)', 'zh-CN': '变量（JSON）' }, type: 'textarea', defaultValue: '{}' },
    { key: 'count', label: { en: 'Uses (0 = continuous)', 'zh-CN': '次数（0 为持续使用）' }, type: 'number', defaultValue: 1 },
    { key: 'interval', label: { en: 'Every N user rounds', 'zh-CN': '间隔用户轮数' }, type: 'number', defaultValue: 1 },
    { key: 'startAfter', label: { en: 'Start after N user rounds', 'zh-CN': '从第几轮开始' }, type: 'number', defaultValue: 1 },
    { key: 'wake', label: { en: 'Wake the current session for immediate use', 'zh-CN': '立即使用时唤醒当前会话' }, type: 'boolean', defaultValue: false },
  ], buttons: [
    { operation: 'prompt-preview', label: { en: 'Preview resolved prompt', 'zh-CN': '预览展开后的提示词' }, read: true },
    { operation: 'use-now', label: { en: 'Use now', 'zh-CN': '立即使用' } },
    { operation: 'schedule', label: { en: 'Schedule for this session', 'zh-CN': '安排会话调度' } },
  ], details: (record, zh) => <p>{zh ? '累计使用：' : 'Uses: '}{String(record.data.uses ?? 0)}<br />{record.content}</p>,
  result: (value, zh) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.text === 'string' ? <pre style={{whiteSpace:'pre-wrap'}}>{value.text}</pre> : <p>{zh ? '已保存。刷新调度面板查看状态。' : 'Saved. Refresh schedules to see their status.'}</p>,
}
const scheduleOptions: RecordActionPanelOptions = { title: { en: 'Session schedules', 'zh-CN': '会话调度' }, filter: record => record.kind === 'schedule', buttons: [{ operation: 'stop-schedule', label: { en: 'Stop schedule', 'zh-CN': '停止调度' }, visible: record => record.data.status === 'scheduled' }], details: (record, zh) => <p>{zh ? '状态' : 'Status'}: {String(record.data.status)} · {zh ? '使用次数' : 'Uses'}: {String(record.data.uses)} · {zh ? '剩余次数' : 'Remaining'}: {record.data.status === 'completed' ? '0' : record.data.continuous ? (zh ? '持续' : 'Continuous') : String(record.data.remaining)}<br />{typeof record.data.error === 'string' ? record.data.error : ''}</p> }
const categoryOptions: RecordActionPanelOptions = {
  title: { en: 'Organize categories', 'zh-CN': '整理分类' }, filter: record => ['prompt', 'skill'].includes(record.kind) && !!record.data.category && record.state !== 'deleted',
  fields: [{ key: 'category', label: { en: 'New category name', 'zh-CN': '新分类名称' }, type: 'text' }],
  buttons: [{ operation: 'rename-category', label: { en: 'Rename this category', 'zh-CN': '重命名此分类' } }, { operation: 'clear-category', label: { en: 'Remove this category', 'zh-CN': '移除此分类' } }],
  details: (record, zh) => <p>{zh ? '本次将修改所选条目同一作用域内的整个分类，保留方法正文与历史。当前分类：' : 'Changes this entire category within the selected record’s scope, preserving contents and history. Current category: '}{String(record.data.category)} · {record.scope}</p>,
}
export function Page(props: MemorySourcePageProps) { return <><LibraryPage {...props} /><hr /><RecordActionPanel {...props} options={categoryOptions} /><RecordActionPanel {...props} options={invokeOptions} /><RecordActionPanel {...props} options={scheduleOptions} /><SkillFiles {...props} /></> }
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'playbooks', pages: [{ id: 'records', label: 'Playbooks', localizedLabel: { en: 'Playbooks', 'zh-CN': '工作方法' }, order: 44, component: Page, navigation: { group: 'sources', primary: true } }, { id: 'skills', label: 'Skills', localizedLabel: { en: 'Skills', 'zh-CN': '技能' }, order: 45, component: SkillsPage, navigation: { group: 'sources', primary: true } }] }) }
