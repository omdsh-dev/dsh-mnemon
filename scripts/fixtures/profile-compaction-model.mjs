import { delegatedCompletion } from './delegated-completion.mjs'

const text = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('\n')
const rank = { low: 0, normal: 1, critical: 2 }

export const PROFILE_COMPACTED = '回答简洁，用简体中文。'

export function profileCompactionModel(report) {
  return request => {
    const messages = request.messages ?? []
    const terminal = delegatedCompletion(request)
    if (terminal !== undefined) {
      const prompt = messages.map(text).join('\n')
      if (!prompt.includes('Run local USER.md compaction now')) {
        return { name: terminal.name, args: terminal.wrap({ action: 'skipped', summary: 'No other maintenance in this fixture.', memoryBodyIds: [] }) }
      }
      const snapshot = prompt.split('<runtime-memory-snapshot target="user">')[1]?.split('</runtime-memory-snapshot>')[0] ?? ''
      const entries = [...snapshot.matchAll(/^(\d+)\. \[importance=(\w+)/gmu)].map(match => ({ index: Number(match[1]), importance: match[2] }))
      const importance = entries.reduce((best, entry) => rank[entry.importance] > rank[best] ? entry.importance : best, 'low')
      report({ event: 'compaction', entries: entries.length, importance })
      return { name: terminal.name, args: terminal.wrap({
        action: 'compacted', summary: '合并了两条回答偏好。',
        compactedEntries: [{ content: PROFILE_COMPACTED, importance, sourceIndexes: entries.map(entry => entry.index) }],
      }) }
    }
    if (!(request.tools ?? []).some(tool => tool.function?.name === 'mnemon_runtime_memory')) return '记住偏好'
    const last = messages.at(-1)
    if (last?.role === 'tool') {
      const result = text(last)
      report({ event: 'write-result', result: result.slice(0, 300) })
      return /error/iu.test(result) ? `写入失败：${result.slice(0, 200)}` : '已记住。'
    }
    const user = [...messages].reverse().find(message => message.role === 'user' && text(message).includes('记住：'))
    const fact = text(user).match(/记住：(.+)$/mu)?.[1]?.trim()
    if (fact === undefined) return 'Isolated Mnemon WebUI test response.'
    report({ event: 'write', content: fact })
    return { name: 'mnemon_runtime_memory', args: { action: 'add', target: 'user', content: fact } }
  }
}
