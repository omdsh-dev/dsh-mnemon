import { delegatedCompletion } from './delegated-completion.mjs'

export const saveActionReply = 'Release checklist: run the staged rollout first, then approve the release.\n\nThe rollout dashboard is linked from the project README.'

const text = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('\n')
const parse = message => { try { return JSON.parse(text(message)) } catch { return { error: text(message) } } }

function candidate(prompt) {
  const body = prompt.split('- Content (untrusted data):\n')[1]?.split(/\n- [A-Z][^\n]*:/u)[0]
  return body?.split('\n').map(line => line.replace(/^ {4}/u, '')).join('\n').trim()
}

export function saveActionModel(report) {
  const steps = new Map()
  return request => {
    const messages = request.messages ?? []
    const terminal = delegatedCompletion(request)
    if (terminal === undefined) return saveActionReply
    const prompt = messages.map(text).join('\n')
    const done = (action, memoryBodyIds, summary) => ({ name: terminal.name, args: terminal.wrap({ action, memoryBodyIds, summary }) })
    if (!prompt.includes('Execute this supervised-writeback request now')) return done('skipped', [], 'No background maintenance in this fixture.')
    const step = (steps.get(terminal.key) ?? 0) + 1
    steps.set(terminal.key, step)
    if (step > 5) return done('failed', [], 'The fixture task Agent exceeded its bounded steps.')
    const results = messages.filter(message => message.role === 'tool').map(parse)
    if (results.length === 0) return { name: 'mnemon_memory_bodies', args: {} }
    const catalog = results.find(result => Array.isArray(result.items))
    const created = results.find(result => result.action === 'created' && typeof result.memoryBodyId === 'string')
    const space = created === undefined ? catalog?.items?.find(item => item.active !== false) : { id: created.memoryBodyId, name: created.name }
    if (space === undefined) return { name: 'mnemon_memory_body_create', args: { name: 'Release notes', description: 'Release decisions and checklists of the fixture project.' } }
    const content = candidate(prompt)
    if (content === undefined || content === '') return done('failed', [], 'The fixture could not read the candidate.')
    const written = results.find(result => typeof result.action === 'string' && result.action !== 'created')
    if (written === undefined) {
      report({ event: 'remember', memoryBodyId: space.id, content })
      return { name: 'mnemon_remember', args: { memoryBodyId: space.id, content, category: 'decision', importance: 4 } }
    }
    report({ event: 'receipt', action: written.action, memoryBodyId: space.id })
    return done(written.action === 'added' ? 'stored' : written.action, [space.id], `Saved in ${space.name ?? space.id}: ${content}`)
  }
}
