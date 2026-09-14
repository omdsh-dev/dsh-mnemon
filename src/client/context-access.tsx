import { useState } from 'react'
import type { MemoryAccessKind, MemoryContextDecisionTrace, MemoryContextProfile, MemoryExecutionResult, MemoryOperationEffect, MemoryResourceReference, MemorySourceOperationInventory } from '../core/contracts/index.ts'
import css from './context-access.module.css'

const accessNames: Record<MemoryAccessKind, [string, string]> = {
  read: ['Read details', '读取详情'], browse: ['Browse resources', '浏览资源'], search: ['Search', '检索'],
  related: ['Follow relationships', '沿关联探索'], observe: ['Observe activity', '观察活动'],
}
const effectNames: Record<MemoryOperationEffect, [string, string]> = {
  append: ['Capture', '记录'], update: ['Update', '修改'], propose: ['Propose for review', '提交审核'],
  publish: ['Publish', '发布'], remove: ['Remove', '移除'], execute: ['Execute', '执行'],
  deliver: ['Deliver', '发送'], coordinate: ['Coordinate', '协调'], transfer: ['Transfer', '传输'], feedback: ['Record feedback', '回流反馈'],
}
const shapeNames = { text: ['Text', '文本'], records: ['Records', '条目'], resources: ['Resources', '资源'], events: ['Events', '事件'], execution: ['Execution status', '执行状态'] }
const accessHelp: Record<MemoryAccessKind, [string, string]> = {
  read: ['Open a selected item and inspect its contents.', '打开已选内容，读取其详情。'],
  browse: ['List available resources before choosing what to open.', '先浏览可用资源，再选择要打开的内容。'],
  search: ['Find relevant evidence with a query.', '通过查询筛选相关证据。'],
  related: ['Expand from known evidence through its relationships.', '从已知证据出发，沿关联继续探索。'],
  observe: ['Inspect activity, progress or changes over time.', '查看活动、进度或随时间发生的变化。'],
}
const effectHelp: Record<MemoryOperationEffect, [string, string]> = {
  append: ['Add a new record.', '追加一条新记录。'], update: ['Change existing content or state.', '修改已有内容或状态。'],
  propose: ['Create a candidate for review before it takes effect.', '生成待审核候选，采纳后才生效。'],
  publish: ['Make a reviewed version available for use.', '将审核后的版本投入使用。'],
  remove: ['Remove content from active use.', '将内容移出当前可用范围。'],
  execute: ['Run a task or executable resource and observe its outcome.', '运行任务或可执行资源，并观察结果。'],
  deliver: ['Send content to a selected destination.', '向选定目标发送内容。'],
  coordinate: ['Change shared task or collaboration state.', '变更协作状态或任务安排。'],
  transfer: ['Move a reviewed snapshot between storage scopes.', '在存储范围之间传输经过核对的快照。'],
  feedback: ['Record an observed outcome for later review and improvement.', '记录实际使用结果，供后续审核和改进。'],
}
type Inventory = MemorySourceOperationInventory

function operationGroups<T>(values: T[], key: (value: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const value of values) { const group = key(value); groups.set(group, [...groups.get(group) ?? [], value]) }
  return [...groups.values()]
}

/** Describes operations; this component does not grant or execute them. */
export function memoryAccessLabels(inventory: Inventory | undefined, locale: string): string[] {
  const language = locale.startsWith('zh') ? 1 : 0
  return [...new Set([
    ...inventory?.reads.flatMap(route => route.access?.kinds.map(kind => accessNames[kind][language]) ?? []) ?? [],
    ...inventory?.actions.flatMap(action => action.operation?.effects.map(effect => effectNames[effect][language]) ?? []) ?? [],
  ])]
}

export function MemoryAccessSummary(props: { inventory?: Inventory | undefined; management?: Inventory | undefined; context?: MemoryContextProfile | undefined; locale: string; compact?: boolean }) {
  const zh = props.locale.startsWith('zh'), language = zh ? 1 : 0, t = (en: string, cn: string) => zh ? cn : en
  const [open, setOpen] = useState(!props.compact)
  if (!props.inventory && !props.management) return null
  const labels = memoryAccessLabels(props.inventory, props.locale)
  const details = (items: Array<{ id: string; description: string }>) => <details className={css.interfaceDetails}><summary>{t('Interface details', '接口详情')}{items.length > 1 ? ` · ${items.length}` : ''}</summary>{items.map(item => <p key={item.id}><code>{item.id}</code>{item.description}</p>)}</details>
  const contents = (inventory: Inventory, human: boolean) => <div className={css.columns}>
    <section><h4>{t('Access', '访问方式')}</h4>{inventory.reads.length ? <ul>{operationGroups(inventory.reads, route => JSON.stringify(route.access ?? route.id)).map(group => { const route = group[0]!; return <li key={route.id}>
      <strong>{route.access ? route.access.kinds.map(kind => accessNames[kind][language]).join(' · ') : t('Read', '读取')}</strong>
      {route.access && <span className={css.kind}>{shapeNames[route.access.result][language]}</span>}
      <p>{route.access ? route.access.kinds.map(kind => accessHelp[kind][language]).join(' ') : t('Read the content offered by this Source.', '读取此来源提供的内容。')}</p>
      {details(group)}
    </li> })}</ul> : <p className={css.muted}>{t('No additional read entry points.', '未提供额外的读取入口。')}</p>}</section>
    <section><h4>{t('Changes and effects', '变更与影响')}</h4>{inventory.actions.length ? <ul>{operationGroups(inventory.actions, action => JSON.stringify([action.operation ?? action.id, action.requiresApproval])).map(group => { const action = group[0]!; return <li key={action.id}>
      <strong>{action.operation?.effects.map(effect => effectNames[effect][language]).join(' · ') ?? t('Action', '操作')}</strong>
      <p>{action.operation?.effects.map(effect => effectHelp[effect][language]).join(' ') ?? t('Use an operation defined by this Source.', '使用此来源提供的操作。')}</p>
      <div className={css.conditions}>
        {(human || action.requiresApproval) && <span>{t('Confirm before execution', '执行前确认')}</span>}
        {action.operation?.execution === 'deferred' && <span>{t('Track through completion', '持续跟踪结果')}</span>}
        {!human && action.operation?.requiresReadGrant && <span>{t('Bound to this turn’s access', '绑定本轮访问范围')}</span>}
      </div>
      {details(group)}
    </li> })}</ul> : <p className={css.muted}>{human ? t('No management changes are listed.', '未列出管理变更操作。') : t('No model changes are offered.', '未向模型开放变更操作。')}</p>}</section>
  </div>
  return <details className={css.access} open={open} onToggle={event => setOpen(event.currentTarget.open)} aria-label={t('Context access', '上下文访问')}>
    <summary><span><strong>{t('Context access', '上下文访问')}</strong><small>{labels.length ? labels.join(' · ') : props.management ? t('Managed by you', '由你管理') : t('Context summary', '上下文摘要')}</small></span><span aria-hidden="true">{open ? '−' : '+'}</span></summary>
    <div className={css.body}>
      {props.context && <p className={css.muted}>{props.context.mode === 'eager' ? t('Offers a summary at the start of a turn. The Strategy controls the final allocation.', '建议在轮次开始时提供摘要，最终分配由策略决定。') : t('Offers an entry point; details are retrieved when needed.', '先提供访问入口，按需读取详情。')}</p>}
      {props.inventory && <><h3>{t('Available to the conversation', '面向会话的能力')}</h3>{contents(props.inventory, false)}</>}
      {props.management && <><h3>{t('Managed by you', '由你管理')}</h3><p className={css.muted}>{t('These operations stay in the management page and require its own confirmation.', '这些操作通过管理页面使用，并遵循该页面的确认流程。')}</p>{contents(props.management, true)}</>}
    </div>
  </details>
}

const decisionNames: Record<MemoryContextDecisionTrace['state'], [string, string]> = {
  applied: ['Included', '已纳入'], deferred: ['Waiting for evidence', '等待证据'], excluded: ['Outside this selection', '未纳入当前选择'],
  budget: ['Limited by budget', '受预算限制'], unavailable: ['Source unavailable', '来源不可用'],
}
export function MemoryDecisionList(props: { decisions?: readonly MemoryContextDecisionTrace[] | undefined; sources?: ReadonlyArray<{ sourceInstanceKey: string; label: string }>; locale: string }) {
  const language = props.locale.startsWith('zh') ? 1 : 0, zh = language === 1
  if (!props.decisions?.length) return null
  return <section className={css.decisions} aria-label={zh ? '组合依据' : 'Composition decisions'}>
    <header><h3>{zh ? '组合依据' : 'Composition decisions'}</h3><span>{props.decisions.filter(item => item.state === 'applied').length} / {props.decisions.length} {zh ? '已纳入' : 'included'}</span></header>
    <p className={css.muted}>{zh ? '展示增强策略基于此次上下文作出的判断。已纳入表示提供了指引，不代表操作已经执行。' : 'Enhancement decisions based on this context. Included means guidance is available; it does not mean an action ran.'}</p>
    <ul>{props.decisions.map(item => <li key={item.contributionInstanceKey + '/' + item.sourceInstanceKey + '/' + item.id}>
      <header><strong>{props.sources?.find(source => source.sourceInstanceKey === item.sourceInstanceKey)?.label ?? item.sourceInstanceKey}</strong><span className={css.state} data-state={item.state}>{decisionNames[item.state][language]}</span></header>
      <p>{item.reason[zh ? 'zh-CN' : 'en']}</p>
      {item.state === 'excluded' && <small>{zh ? '当前来源选择或写入范围未包含所需操作。' : 'The current Source or write selection excludes a required operation.'}</small>}
      {item.state === 'budget' && <small>{zh ? '读取、操作或指引预算不足，本轮未提供对应指引。' : 'Read, action or guidance capacity is insufficient; its instructions are omitted.'}</small>}
      {item.state === 'unavailable' && <small>{zh ? '来源未能提供本轮上下文，相关指引已退出。' : 'The Source could not supply this turn’s context; its instructions were removed.'}</small>}
      <details><summary>{zh ? '查看判断条件' : 'Decision details'}</summary><p>{item.routeIds.length ? (zh ? '所需读取：' : 'Required reads: ') + item.routeIds.join(', ') : ''}</p><p>{item.actionIds.length ? (zh ? '所需操作：' : 'Required actions: ') + item.actionIds.join(', ') : ''}</p><code>{item.contributionInstanceKey} / {item.id}</code></details>
    </li>)}</ul>
  </section>
}

const executionNames: Record<MemoryExecutionResult['state'], [string, string]> = {
  queued: ['Queued', '已排队'], running: ['Running', '运行中'], succeeded: ['Succeeded', '已成功'], failed: ['Failed', '已失败'], cancelled: ['Cancelled', '已取消'],
  interrupted: ['Interrupted', '已中断'], 'timed-out': ['Timed out', '已超时'], unknown: ['Awaiting status', '状态待确认'],
}
export function MemoryExecutionStatus(props: { execution: MemoryExecutionResult; locale: string }) {
  const zh = props.locale.startsWith('zh'), { execution } = props
  return <span className={css.execution} data-state={execution.state} role="status"><strong>{executionNames[execution.state][zh ? 1 : 0]}</strong><small>{execution.id}</small>{execution.exitCode !== undefined && <small>{zh ? '退出码' : 'Exit code'} {execution.exitCode}</small>}</span>
}
export function MemoryResourceIdentity(props: { reference: MemoryResourceReference; locale: string }) {
  return <small className={css.resource}><span>{props.reference.path ?? props.reference.id}</span>{props.reference.revision && <span>{props.locale.startsWith('zh') ? '版本' : 'Revision'} {props.reference.revision}</span>}{props.reference.mediaType && <span>{props.reference.mediaType}</span>}</small>
}
