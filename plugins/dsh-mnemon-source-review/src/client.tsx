import { Proposals } from './proposals.tsx'
import { installMemorySourceUI, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import { createCollectionPage, RecordActionPanel, type RecordActionPanelOptions } from 'dsh-mnemon/client'
export const inject = ['slots']
const Settings = createCollectionPage({ title: { en: 'Review settings and constraints', 'zh-CN': '审核设置与约束' }, description: { en: 'Only visible conversation is sent to a separate reviewer. Automatic reviews are opt-in.', 'zh-CN': '独立审核仅接收用户可见的对话。自动审核需要显式开启。' }, kinds: [{ value: 'constraint', label: { en: 'Constraint', 'zh-CN': '审核约束' } }, { value: 'cycle', label: { en: 'Session review cycle', 'zh-CN': '会话审核周期' } }], scopes: ['session', 'project', 'global'], defaultScope: 'session', fields: [
  { key: 'enabled', label: { en: 'Enabled', 'zh-CN': '已启用' }, type: 'boolean', defaultValue: true },
  { key: 'interval', label: { en: 'User rounds between reviews', 'zh-CN': '审核间隔用户轮数' }, type: 'number', defaultValue: 5 },
  { key: 'automatic', label: { en: 'Automatically review when due', 'zh-CN': '到期时自动审核' }, type: 'boolean', defaultValue: false },
  { key: 'notify', label: { en: 'Deliver findings to the current session', 'zh-CN': '将审核结果投递到当前会话' }, type: 'boolean', defaultValue: true },
] })
const controls: RecordActionPanelOptions = { title: { en: 'Session review', 'zh-CN': '会话审核' }, filter: record => record.kind === 'cycle', fields: [{ key: 'question', label: { en: 'Ask the reviewer (optional)', 'zh-CN': '向审核者提问（可选）' }, type: 'textarea' }], details: (record, zh) => <p>{zh ? '累计用户轮数' : 'User rounds'}: {String(record.data.rounds)} · {record.data.due ? (zh ? '需要审核，等待显式完成' : 'Review due, awaiting explicit completion') : (zh ? '未到期' : 'Not due')}<br />{zh ? '执行状态' : 'Run status'}: {String(record.data.status)}{typeof record.data.error === 'string' && <><br />{record.data.error}</>}</p>, buttons: [
  { operation: 'run-review', label: { en: 'Run review / Ask', 'zh-CN': '执行审核 / 提问' } },
  { operation: 'complete-cycle', label: { en: 'Mark cycle complete', 'zh-CN': '标记本轮审核完成' } },
  { operation: 'reset-review', label: { en: 'Reset reviewer context', 'zh-CN': '重置审核上下文' } },
], result: (_value, zh) => <p>{zh ? '请求已处理。刷新审核历史查看结果。' : 'Request handled. Refresh review history for the result.'}</p> }
const History = createCollectionPage({ title: { en: 'Review history', 'zh-CN': '审核历史' }, description: { en: 'Findings and proposals remain separate from approved context.', 'zh-CN': '保留审核发现与建议；建议需审核后才能写入正式上下文。' }, kinds: [{ value: 'review', label: { en: 'Review', 'zh-CN': '审核结果' } }], scopes: ['session'], defaultScope: 'session', editable: () => false, fields: [{ key: 'severity', label: { en: 'Severity', 'zh-CN': '级别' }, type: 'select', options: [{value:'info',label:{en:'Information','zh-CN':'提示'}},{value:'nit',label:{en:'Minor issue','zh-CN':'小问题'}},{value:'concern',label:{en:'Concern','zh-CN':'需关注'}},{value:'blocker',label:{en:'Blocker','zh-CN':'阻塞'}}] }] })
export function Page(props: MemorySourcePageProps) { return <><RecordActionPanel {...props} options={controls} /><History {...props} writable={false} /><Proposals {...props} /><Settings {...props} /></> }
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'review', pages: [{ id: 'review', label: 'Review', localizedLabel: { en: 'Review', 'zh-CN': '会话审核' }, order: 48, component: Page, coordinateSources: true, navigation: { group: 'sources', primary: true } }] }) }
