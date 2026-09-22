import { installMemorySourceUI, type MemorySourceUIContext } from 'dsh-mnemon/client'
import { createCollectionPage } from 'dsh-mnemon/client'
import { TaskViews } from './views.tsx'
export const inject = ['slots']
export const Page = createCollectionPage({
  renderRecords: context => <TaskViews {...context} />,
  scopeForKind: { personal: 'global', work: 'global', project: 'project', daily: 'daily' },
  "title": {
    "en": "Tasks",
    "zh-CN": "任务清单"
  },
  "description": {
    "en": "Organize personal, work, project and daily tasks. Adopt suggestions and track their completion.",
    "zh-CN": "管理个人、工作、项目和每日任务，审核建议并跟踪完成情况。"
  },
  "kinds": [
    {
      "value": "project",
      "label": {
        "en": "Project",
        "zh-CN": "项目"
      }
    },
    {
      "value": "personal",
      "label": {
        "en": "Personal",
        "zh-CN": "个人"
      }
    },
    {
      "value": "work",
      "label": {
        "en": "Work",
        "zh-CN": "工作"
      }
    },
    {
      "value": "daily",
      "label": {
        "en": "Daily",
        "zh-CN": "每日"
      }
    }
  ],
  "scopes": [
    "project",
    "global",
    "daily"
  ],
  "defaultScope": "project",
  "fields": [
    {
      "key": "status",
      "label": {
        "en": "Status",
        "zh-CN": "状态"
      },
      "type": "select",
      "defaultValue": "pending",
      "options": [
        {
          "value": "pending",
          "label": {
            "en": "Pending",
            "zh-CN": "未开始"
          }
        },
        {
          "value": "in-progress",
          "label": {
            "en": "In progress",
            "zh-CN": "进行中"
          }
        },
        {
          "value": "done",
          "label": {
            "en": "Done",
            "zh-CN": "已完成"
          }
        },
        {
          "value": "blocked",
          "label": {
            "en": "Blocked",
            "zh-CN": "受阻"
          }
        },
        {
          "value": "cancelled",
          "label": {
            "en": "Cancelled",
            "zh-CN": "已取消"
          }
        }
      ]
    },
    {
      "key": "due",
      "label": {
        "en": "Due date",
        "zh-CN": "截止日期"
      },
      "type": "date"
    },
    {
      "key": "important",
      "label": {
        "en": "Important",
        "zh-CN": "重要"
      },
      "type": "boolean",
      "defaultValue": false
    },
    {
      "key": "urgent",
      "label": {
        "en": "Urgent",
        "zh-CN": "紧急"
      },
      "type": "boolean",
      "defaultValue": false
    },
    {
      "key": "category",
      "label": {
        "en": "Category",
        "zh-CN": "分类"
      },
      "type": "text"
    }
  ],
  "recordActions": [
    {
      "label": {
        "en": "Mark complete",
        "zh-CN": "标记完成"
      },
      "operation": "complete"
      ,available: record => record.state === 'active' && record.data.status !== 'done'
    }
  ]
})
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'tasks', pages: [{ id: 'records', label: 'Tasks', localizedLabel: { en: 'Tasks', 'zh-CN': '任务清单' }, order: 43, component: Page, navigation: { group: 'sources', primary: true } }] }) }
