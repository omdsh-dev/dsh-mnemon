import { afterEach, describe, expect, it } from 'vitest'
import { compositionFixture } from './fixtures/composition.ts'
const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
async function fixture() { const value = await compositionFixture(); fixtures.push(value); return value }
afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })

describe('LLM View publication boundary', () => {
  it('projects exact hot memory and compact Source covers without disclosing namespaces or control-plane paths', async () => {
    const { graph, workspace, memorySpace } = await fixture()
    const body = await memorySpace()
    await graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Use immutable per-turn context.' })
    await graph.source('documents').mutate('mutate', { action: 'create', title: 'Private title', content: 'Detailed source document.' })
    const turn = await graph.composableTurns.beginTurn('agent:1', { storage: 'custom', workspaceId: workspace, agentId: 'agent' })
    const wake = graph.composableTurns.memoryWake(turn.view.id)
    expect(wake.text).toContain('Use immutable per-turn context.')
    expect(wake.text).toContain('1 active project Document')
    expect(wake.text).not.toContain(body.id)
    expect(wake.text).not.toContain('Private title')
    expect(wake.text).not.toContain('Detailed source document.')
    expect(wake.text).not.toContain(workspace)
    // Opaque read grants remain on the Host, never in the Wake delivered to the model.
    expect(turn.view.readGrants).toHaveLength(2)
    graph.composableTurns.endTurn(turn.turnId)
  })
  it('holds a turn immutable and observes committed Source changes only at the next boundary', async () => {
    const { graph, workspace } = await fixture()
    const scope = { storage: 'custom' as const, workspaceId: workspace, agentId: 'agent' }
    const turns = graph.composableTurns
    const source = graph.source('runtime')
    await source.mutate('mutate', { action: 'add', target: 'memory', content: 'First revision.' })
    const first = await turns.beginTurn('agent:1', scope)
    const wake = turns.memoryWake(first.view.id)
    await source.mutate('mutate', { action: 'add', target: 'memory', content: 'Second revision.' })
    await graph.source('documents').mutate('mutate', { action: 'create', title: 'Next View', content: 'Not eager content.' })
    expect(await turns.beginTurn('agent:1', scope)).toBe(first)
    expect(turns.memoryWake(first.view.id)).toEqual(wake)
    turns.endTurn(first.turnId)
    const next = await turns.beginTurn('agent:2', scope)
    expect(next.view.id).not.toBe(first.view.id)
    expect(turns.memoryWake(next.view.id).text).toContain('Second revision.')
    expect(turns.memoryWake(next.view.id).text).not.toContain('Not eager content.')
    turns.endTurn(next.turnId)
  })
})
