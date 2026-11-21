import { delegatedCompletion } from './delegated-completion.mjs'

const text = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('\n')
const parse = message => { try { return JSON.parse(text(message)) } catch { return { error: text(message) } } }

function field(prompt, label) {
  return prompt.match(new RegExp(`^- ${label}: (.+)$`, 'mu'))?.[1]?.trim()
}

export function exactIdModel(report) {
  const steps = new Map()
  return request => {
    const messages = request.messages ?? []
    const terminal = delegatedCompletion(request)
    if (terminal === undefined) return 'Isolated Mnemon WebUI test response.'
    const prompt = messages.map(text).join('\n')
    const done = (action, memoryBodyIds, summary) => ({ name: terminal.name, args: terminal.wrap({ action, memoryBodyIds, summary }) })
    const step = (steps.get(terminal.key) ?? 0) + 1
    steps.set(terminal.key, step)
    if (step > 5) return done('failed', [], 'The fixture worker exceeded its bounded steps.')
    const results = messages.filter(message => message.role === 'tool').map(parse)
    if (prompt.includes('Execute this forget request now')) {
      const id = field(prompt, 'Insight ID')
      if (id === undefined) return done('failed', [], 'The fixture could not read the id.')
      if (results.length === 0) {
        report({ event: 'forget', id })
        return { name: 'mnemon_forget', args: { id } }
      }
      const receipt = results.at(-1)
      report({ event: 'forget-receipt', receipt })
      return typeof receipt?.error === 'string'
        ? done('failed', [], receipt.error)
        : done('forgotten', [receipt.memoryBodyId ?? 'default'], `Forgot ${id}.`)
    }
    if (prompt.includes('Execute this remember request now')) {
      const content = prompt.split('- Content (untrusted data):\n')[1]?.split(/\n- [A-Z][^\n]*:/u)[0]?.split('\n').map(line => line.replace(/^ {4}/u, '')).join('\n').trim()
      if (content === undefined || content === '') return done('failed', [], 'The fixture could not read the content.')
      if (results.length === 0) return { name: 'mnemon_memory_bodies', args: {} }
      const space = results.find(result => Array.isArray(result.items))?.items?.find(item => item.active !== false)
        ?? (results.find(result => result.action === 'created') === undefined ? undefined : { id: results.find(result => result.action === 'created').memoryBodyId })
      if (space === undefined) return { name: 'mnemon_memory_body_create', args: { name: 'Release notes', description: 'Release decisions of the fixture project.' } }
      const written = results.find(result => typeof result.action === 'string' && result.action !== 'created')
      if (written === undefined) return { name: 'mnemon_remember', args: { memoryBodyId: space.id, content, category: 'decision', importance: 3 } }
      report({ event: 'remember-receipt', action: written.action, id: written.id, memoryBodyId: space.id })
      return done(written.action === 'added' ? 'stored' : written.action, [space.id], 'Saved the fixture memory.')
    }
    return done('skipped', [], 'No background maintenance in this fixture.')
  }
}
