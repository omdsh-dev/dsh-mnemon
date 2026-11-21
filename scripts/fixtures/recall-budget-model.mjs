const text = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('\n')
const parse = message => { try { return JSON.parse(text(message)) } catch { return { error: text(message) } } }

export const RECALL_BUDGET_QUERIES = ['结账页 性能', 'ClickHouse 写入', '站会 时间']

export function recallBudgetModel(report) {
  return request => {
    const messages = request.messages ?? []
    const userIndex = messages.findLastIndex(message => message.role === 'user' && text(message).includes('recall-budget-check'))
    if (userIndex < 0) return 'Send recall-budget-check to run three different Recall queries in one turn.'
    if (text(messages[userIndex]).startsWith('Generate the session title')) return 'Recall budget check'
    const results = messages.slice(userIndex + 1).filter(message => message.role === 'tool').map(parse)
    if (results.length < RECALL_BUDGET_QUERIES.length) return { name: 'mnemon_recall', args: { query: RECALL_BUDGET_QUERIES[results.length], limit: 6 } }
    const third = results[2] ?? {}
    const contents = (third.results ?? []).map(item => item.content)
    report({ event: 'third', asked: RECALL_BUDGET_QUERIES[2], query: third.query, results: contents.length, notRun: third.notRun === true, budgetExhausted: third.budgetExhausted === true, contents })
    if (third.notRun === true) return `第三次召回「${RECALL_BUDGET_QUERIES[2]}」没有执行：本回合的两次召回预算已用完（budgetExhausted），它没有自己的结果，返回的 query 是「${third.query}」。`
    return `第三次召回「${RECALL_BUDGET_QUERIES[2]}」返回了 ${contents.length} 条结果，返回的 query 是「${third.query}」。第一条：${contents[0] ?? '（无）'}`
  }
}
