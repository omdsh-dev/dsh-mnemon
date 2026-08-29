import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRuntime } from '../packages/extension-sdk/src/index.ts'
import { installBundledComposableMemory } from '../src/composable/defaults.ts'
import { resolveConfig } from '../src/config.ts'
import { createRuntimeGraph } from '../src/live-runtime.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0).reverse()) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mnemon-composable-turns-'))
  temporary.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const runtime = new MemoryRuntime()
  const releaseDefinitions = installBundledComposableMemory(runtime)
  const graph = createRuntimeGraph(resolveConfig({ storageScope: 'custom', dataDir: join(root, 'data'), cliPath: '/fake/mnemon' }), workspace, runtime)
  return { workspace, runtime, releaseDefinitions, graph }
}

describe('Composable Memory root-turn boundary', () => {
  it('pins one View and renders its projection plus callable Route ids into the LLM Wake', async () => {
    const { workspace, graph } = fixture()
    await graph.runtimeMemory.mutate({ action: 'add', target: 'memory', content: 'Turn-pinned composable context.' })
    await graph.documents.forWorkspace(workspace).mutate({ action: 'create', title: 'Turn route', content: 'turn-route-token' })
    const turn = await graph.composableTurns!.beginTurn('agent-1:1', {
      storage: 'custom', workspaceId: workspace, sessionId: 'agent-1', agentId: 'agent-1',
    })
    const wake = graph.composableTurns!.memoryWake(turn.view.id)

    expect(wake.text).toContain('Turn-pinned composable context.')
    expect(wake.text).toContain('source:bundled-documents/search')
    expect(wake.sections.map(section => section.layerId)).toEqual(['runtime', 'documents', 'memory-spaces'])
    expect(graph.composableTurns!.activeTurn('agent-1')).toBe(turn)

    graph.composableTurns!.endTurn(turn.turnId)
    graph.dispose()
  })

  it('executes Routes and reauthorized Actions against the exact leased generation', async () => {
    const { workspace, graph } = fixture()
    const document = await graph.documents.forWorkspace(workspace).mutate({ action: 'create', title: 'Evidence', content: 'leased-route-token' })
    const turn = await graph.composableTurns!.beginTurn('agent-1:1', {
      storage: 'custom', workspaceId: workspace, sessionId: 'agent-1', agentId: 'agent-1',
    })
    const route = turn.view.routes.find(candidate => candidate.sourceRouteId === 'search')!
    const evidence = await graph.composableTurns!.executeRoute(turn.turnId, route.id, { query: 'leased-route-token' })
    expect(evidence.items.map(item => item.id)).toEqual([document.document.id])

    const offer = turn.view.actionOffers.find(candidate => candidate.sourceActionId === 'mutate')!
    await expect(graph.composableTurns!.executeAction(turn.turnId, offer.id, {
      action: 'add', target: 'memory', content: 'denied',
    }, () => false)).rejects.toThrow('not currently authorized')
    const receipt = await graph.composableTurns!.executeAction(turn.turnId, offer.id, {
      action: 'add', target: 'memory', content: 'authorized composable write',
    }, () => true)
    expect(receipt).toMatchObject({ viewId: turn.view.id, offerId: offer.id, status: 'succeeded' })
    expect(graph.runtimeMemory.contextText()).toContain('authorized composable write')

    graph.composableTurns!.endTurn(turn.turnId)
    graph.dispose()
  })

  it('keeps a leased turn usable while explicit plugin removal fails closed for new turns', async () => {
    const { workspace, releaseDefinitions, graph } = fixture()
    const turn = await graph.composableTurns!.beginTurn('agent-1:1', {
      storage: 'custom', workspaceId: workspace, sessionId: 'agent-1', agentId: 'agent-1',
    })
    releaseDefinitions()
    await expect(graph.composableTurns!.beginTurn('agent-2:1', {
      storage: 'custom', workspaceId: workspace, sessionId: 'agent-2', agentId: 'agent-2',
    })).rejects.toThrow('No Memory Source')
    expect(graph.composableTurns!.memoryWake(turn.view.id).viewId).toBe(turn.view.id)

    graph.composableTurns!.endTurn(turn.turnId)
    graph.dispose()
  })
})
