// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MemoryAccessSummary, MemoryDecisionList, MemoryExecutionStatus } from '../src/client/context-access.tsx'
afterEach(cleanup)
it('keeps human publication distinct from model proposals and exposes accessible details', () => {
  render(<MemoryAccessSummary locale="zh-CN" compact inventory={{ reads: [], actions: [{ id: 'propose', description: '提出一个候选版本', requiresApproval: false, operation: { effects: ['propose'], execution: 'immediate' } }] }} management={{ reads: [], actions: [{ id: 'publish', description: '发布已审核版本', requiresApproval: true, operation: { effects: ['publish'], execution: 'immediate' } }] }} />)
  const disclosure = screen.getByText('上下文访问').closest('summary')!
  expect(disclosure.parentElement?.hasAttribute('open')).toBe(false)
  fireEvent.click(disclosure)
  expect(disclosure.parentElement?.hasAttribute('open')).toBe(true)
  expect(screen.getByRole('heading', { name: '面向会话的能力' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '由你管理' })).toBeTruthy()
  expect(screen.getByText('提交审核', { selector: 'strong' })).toBeTruthy()
  expect(screen.getByText('执行前确认')).toBeTruthy()
})
it('explains restrictions without presenting a decision as an executed action', () => {
  const decision = { id: 'refine', sourceInstanceKey: 'source:skills', contributionInstanceKey: 'strategy-extension:refine', reason: { en: 'Evidence is ready.', 'zh-CN': '已有可用证据。' }, routeIds: ['inspect'], actionIds: ['propose'] }
  const view = render(<MemoryDecisionList locale="zh-CN" sources={[{ sourceInstanceKey: 'source:skills', label: '工作方法' }]} decisions={[{ ...decision, state: 'excluded' }]} />)
  expect(screen.getByText('未纳入当前选择')).toBeTruthy()
  expect(screen.getByText('当前来源选择或写入范围未包含所需操作。')).toBeTruthy()
  expect(screen.getByText(/不代表操作已经执行/)).toBeTruthy()
  view.rerender(<MemoryDecisionList locale="zh-CN" decisions={[{ ...decision, state: 'unavailable' }]} />)
  expect(screen.queryByText('未纳入当前选择')).toBeNull()
  expect(screen.getByText(/相关指引已退出/)).toBeTruthy()
})
it('shows a pending job as running and updates only when an outcome is observed', () => {
  const view = render(<MemoryExecutionStatus locale="zh-CN" execution={{ id: 'task-1', state: 'running' }} />)
  expect(within(screen.getByRole('status')).getByText('运行中')).toBeTruthy()
  expect(screen.queryByText('已成功')).toBeNull()
  view.rerender(<MemoryExecutionStatus locale="zh-CN" execution={{ id: 'task-1', state: 'failed', exitCode: 1 }} />)
  expect(within(screen.getByRole('status')).getByText('已失败')).toBeTruthy()
  expect(screen.getByText('退出码 1')).toBeTruthy()
})
