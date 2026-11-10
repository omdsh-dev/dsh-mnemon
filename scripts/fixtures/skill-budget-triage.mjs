// Synthetic reuse groups and a real Source quota rejection, without model calls.
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as skillsPlugin from 'dsh-mnemon-source-skills'
import * as strategyPlugin from 'dsh-mnemon-strategy-general'

export async function seedSkillBudgetTriage({ dataDir, workspace, dshHome, agentsHome }) {
  const runner = new MemoryCompositionRunner()
  try {
    await runner.mount(strategyPlugin, { instanceId: 'strategy' })
    await runner.mount(skillsPlugin, { instanceId: 'skills', config: { dataDir, dshHome, agentsHome } })
    const client = await runner.managementClient('source:skills', { storage: 'custom', workspaceId: workspace })
    const ids = []
    for (const [name, windows, count, summary] of [
      ['release-checks', 3, 8, '重复出现的发布检查顺序，覆盖三段独立会话。'],
      ['deployment-checks', 2, 8, '两次部署中出现的检查项，仍需判断复用价值。'],
      ['incident-notes', 1, 2, '本次单一故障的排查记录，保留供人工判断。'],
    ]) {
      let id
      for (let window = 0; window < windows; window++) {
        const at = new Date().toISOString()
        const sessionId = `${name}-${window}`
        const result = await client.mutate('review-record', {
          review: { at, sessionId, sessionTitle: name, trigger: 'manual', durationMs: 10, outcome: 'suggested', summary },
          trajectory: { sessionId, sessionTitle: name, workspace, startedAt: at, endedAt: at,
            stats: { turns: count, userCharacters: 100, toolCalls: 0, toolFailures: 0, uniqueTools: 0, skills: [] },
            steps: Array.from({ length: count }, (_, index) => ({ index: index + 1, turn: index + 1, kind: 'user', text: `虚构验收步骤 ${index + 1}。` })),
          },
          annotations: [],
          suggestions: [{ skillName: name, action: 'create', summary, confidence: 0.9, signals: ['tool-failure'], steps: Array.from({ length: count }, (_, index) => index + 1) }],
          cases: [],
        }, { confirmed: true })
        id = result.value.suggestionIds[0]
      }
      ids.push(id)
    }
    for (const id of ids) {
      const result = (await client.mutate('auto-adoption-reserve', { id, limit: 2, timeZone: 'Asia/Shanghai' }, { confirmed: true })).value
      await client.mutate('auto-adoption-record', { id, stage: 'review', attempt: 0, reason: result.allowed ? 'no-cases' : result.reason,
        detail: `${result.used}/${result.limit} · ${result.date} · ${result.timeZone}` }, { confirmed: true })
      if (id === ids[2] && result.allowed) throw new Error('Fixture must reach the daily candidate limit')
    }
  } finally { await runner.dispose() }
}
