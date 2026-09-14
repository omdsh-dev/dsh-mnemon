import { installMemorySourceUI, type MemorySourceUIContext } from 'dsh-mnemon/client'
import { createCollectionPage } from 'dsh-mnemon/client'
export const inject = ['slots']
export const Page = createCollectionPage({
  reviewedRevisions: true,
  "title": {
    "en": "Project notes",
    "zh-CN": "项目笔记"
  },
  "description": {
    "en": "Keep project facts and decisions aligned with the branches where they apply.",
    "zh-CN": "记录项目事实和决策，并限定其适用分支。"
  },
  "kinds": [
    {
      "value": "fact",
      "label": {
        "en": "Fact",
        "zh-CN": "事实"
      }
    },
    {
      "value": "decision",
      "label": {
        "en": "Decision",
        "zh-CN": "决策"
      }
    },
    {
      "value": "note",
      "label": {
        "en": "Working note",
        "zh-CN": "工作笔记"
      }
    }
  ],
  "scopes": [
    "project",
    "session"
  ],
  "defaultScope": "project",
  "fields": [
    {
      "key": "branches",
      "label": {
        "en": "Branches (comma separated)",
        "zh-CN": "适用分支（逗号分隔）"
      },
      "type": "list"
    }
  ]
})
export function apply(ctx: MemorySourceUIContext): void { installMemorySourceUI(ctx, { sourceTypeId: 'project-context', pages: [{ id: 'records', label: 'Project notes', localizedLabel: { en: 'Project notes', 'zh-CN': '项目笔记' }, order: 41, component: Page, navigation: { group: 'sources', primary: true } }] }) }
