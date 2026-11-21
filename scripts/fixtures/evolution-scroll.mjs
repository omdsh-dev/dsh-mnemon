import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as skillsPlugin from 'dsh-mnemon-source-skills'
import * as strategyPlugin from 'dsh-mnemon-strategy-general'

export async function seedEvolutionScroll({ dataDir, workspace, dshHome, agentsHome }) {
  const runner = new MemoryCompositionRunner()
  try {
    await runner.mount(strategyPlugin, { instanceId: 'strategy' })
    await runner.mount(skillsPlugin, { instanceId: 'skills', config: { dataDir, dshHome, agentsHome } })
    const client = await runner.managementClient('source:skills', { storage: 'custom', workspaceId: workspace })
    for (let index = 1; index <= 10; index++) {
      const name = `scroll-check-${String(index).padStart(2, '0')}`
      const at = new Date(Date.now() - index * 60_000).toISOString()
      const rationale = index === 3
        ? Array.from({ length: 30 }, (_, line) => `验证步骤 ${line + 1}：保留用户要求的分组、版本号和检查结果，完成后逐项核对。`).join('\n\n')
        : '用户要求将重复的检查步骤整理成可复用技能，并保留每项检查的结果。'
      await client.mutate('review-record', {
        review: { at, sessionId: name, sessionTitle: `布局验证 ${index}`, trigger: 'manual', durationMs: 10, outcome: 'suggested', summary: '合成的列表滚动验收数据。' },
        trajectory: {
          sessionId: name, sessionTitle: `布局验证 ${index}`, workspace, startedAt: at, endedAt: at,
          stats: { turns: 1, userCharacters: 50, toolCalls: 0, toolFailures: 0, uniqueTools: 0, skills: [] },
          steps: [{ index: 1, turn: 1, kind: 'user', text: '请记住这次纠正的检查步骤，下一次按相同顺序核对。' }],
        },
        annotations: [{ step: 1, signal: 'correction', note: '重复的检查步骤需要保留。' }],
        suggestions: [{ skillName: name, action: 'create', summary: `建议 ${index}：保留发布检查的顺序和结果，避免重复遗漏。`, rationale, confidence: 0.9, signals: ['correction'], steps: [1] }],
        cases: [],
      }, { confirmed: true })
    }
  } finally {
    await runner.dispose()
  }
}
