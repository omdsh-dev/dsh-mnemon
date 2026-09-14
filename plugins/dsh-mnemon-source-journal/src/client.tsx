import { useEffect, useRef, useState } from 'react'
import { installMemorySourceUI, type MemorySourcePageProps, type MemorySourceUIContext } from 'dsh-mnemon/client'
import { createCollectionPage } from 'dsh-mnemon/client'
import { JournalViews } from './views.tsx'
export const inject = ['slots']
const Records = createCollectionPage({
  renderRecords: context => <JournalViews {...context} />,
  "title": {
    "en": "Activity journal",
    "zh-CN": "活动日志"
  },
  "description": {
    "en": "Recover project progress, daily outcomes and feedback across sessions.",
    "zh-CN": "跨会话回顾项目进展、每日成果和反馈。"
  },
  "kinds": [
    {
      "value": "progress",
      "label": {
        "en": "Progress",
        "zh-CN": "进展"
      }
    },
    {
      "value": "feedback",
      "label": {
        "en": "Feedback",
        "zh-CN": "反馈"
      }
    },
    {
      "value": "result",
      "label": {
        "en": "Outcome",
        "zh-CN": "成果"
      }
    }
  ],
  "scopes": [
    "project",
    "daily"
  ],
  "defaultScope": "project",
  "fields": [
    { key: "branch", type: "text", label: { en: "Git branch", "zh-CN": "Git 分支" }, readOnly: true },
    {
      "key": "category",
      "label": {
        "en": "Category",
        "zh-CN": "分类"
      },
      "type": "text"
    },
    {
      "key": "sentiment",
      "label": {
        "en": "Feedback",
        "zh-CN": "反馈倾向"
      },
      "type": "select",
      "defaultValue": "neutral",
      "options": [
        {
          "value": "neutral",
          "label": {
            "en": "Neutral",
            "zh-CN": "中性"
          }
        },
        {
          "value": "positive",
          "label": {
            "en": "Positive",
            "zh-CN": "积极"
          }
        },
        {
          "value": "negative",
          "label": {
            "en": "Negative",
            "zh-CN": "消极"
          }
        }
      ]
    }
  ]
})
function ProgressStatus(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), [status, setStatus] = useState<{ enabled: boolean; gap: number; due: boolean; threshold: number }>(), [error, setError] = useState(''), request = useRef(0)
  useEffect(() => { request.current++; setStatus(undefined); setError(''); return () => { request.current++ } }, [props.sessionId, props.workspaceId, props.sourceInstanceKey])
  async function read() {
    const id = ++request.current
    try { const result = await props.management?.read('progress-status'); if (id === request.current && result) { setStatus(result.value as typeof status); setError('') } } catch (error) { if (id === request.current) setError(String(error)) }
  }
  return <section data-mnemon-collection aria-label={zh ? '日志记录提醒' : 'Journal progress reminder'}><h2>{zh ? '日志记录提醒' : 'Journal progress reminder'}</h2><button onClick={() => void read()}>{zh ? '读取记录状态' : 'Read progress status'}</button>{status && <p role="status">{status.enabled ? (zh ? `连续未记录轮次：${status.gap}；提醒阈值：${status.threshold}。${status.due ? '请记录实际进展。' : '尚未到期。'}` : `${status.gap} turns without an entry; threshold ${status.threshold}. ${status.due ? 'Record the actual progress.' : 'Not due.'}`) : (zh ? '提醒未启用。可在插件配置中设置轮次阈值。' : 'Reminder disabled. Set its turn threshold in the plugin configuration.')}</p>}{error && <p role="alert">{error}</p>}</section>
}
export function Page(props: MemorySourcePageProps) { return <><Records {...props} /><ProgressStatus {...props} /></> }
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'journal', pages: [{ id: 'records', label: 'Activity journal', localizedLabel: { en: 'Activity journal', 'zh-CN': '活动日志' }, order: 42, component: Page, navigation: { group: 'sources', primary: true } }] }) }
