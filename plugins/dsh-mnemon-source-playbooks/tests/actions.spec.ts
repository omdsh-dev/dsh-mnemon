import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import type { DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'
import { createPlaybooksSource } from '../src/index.ts'
it('gates prompt authoring and invocation, rejects stale versions and duplicate schedules, and steers only with explicit wake', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-prompt-actions-')), runner = new MemoryCompositionRunner(), deliver = vi.fn(async () => ({ status: 'running', delivery: 'steering' }))
  const adapter = { deliver, services: { agents: { get: () => ({ status: 'running' }) } } } as unknown as DshWorkspaceAdapter
  try {
    await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [createPlaybooksSource({ dataDir: directory }, { adapter })], strategies: [defineMemoryStrategy({ manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'prompt-policy', packageName: 'prompt-policy', deterministic: true, supportedSourceRoles: ['instruction-library'], maxSources: 1, maxRoutes: 8, maxActions: 16 }, compose(_request, sources) { return { strategyTypeId: 'prompt-policy', explanation: 'Prompt action authority test', sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, routeIds: source.routeIds, actionIds: source.actionIds })) } } })] }) } }, { instanceId: 'prompt-test' })
    const turn = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: '/project', sessionId: 'one' } })
    const action = (id: string) => turn.view.actionOffers.find(value => value.sourceActionId === id)!.id
    await expect(turn.executeAction(action('create-prompt'), { title: 'Check', content: 'Inspect {{target}}', data: { tags: 'quality', summary: 'Check results' } }, () => false)).rejects.toThrow(/authoriz/i)
    const created = await turn.executeAction(action('create-prompt'), { title: 'Check', content: 'Inspect {{target}}', data: { tags: 'quality', summary: 'Check results' } }, () => true)
    let book = created.details as { id: string; version: number }
    expect(book.id).toBeTypeOf('string')
    const updated = await turn.executeAction(action('update-prompt'), { id: book.id, version: book.version, data: { summary: 'Validate exact results', category: 'Quality' } }, () => true)
    book = updated.details as { id: string; version: number }
    const read = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: '/project', sessionId: 'one' } })
    const route = read.view.routes.find(route => route.sourceRouteId === 'search')!
    const found = await read.executeRoute(route.id, { name: 'check', category: 'Quality', tag: 'quality', summary: 'exact' })
    expect(found.items).toHaveLength(1)
    expect(found.items[0]?.text).toContain('"enabled":true')
    expect((await read.executeRoute(route.id, { name: 'check', category: 'Other' })).items).toHaveLength(0)
    await expect(turn.executeAction(action('use-prompt'), { id: book.id, version: 99 }, () => true)).rejects.toThrow('version changed')
    const scheduled = await turn.executeAction(action('schedule-prompt'), { id: book.id, version: book.version, variables: { target: 'tests' }, count: 0 }, () => true)
    await expect(turn.executeAction(action('schedule-prompt'), { id: book.id, version: book.version, variables: { target: 'tests' } }, () => true)).rejects.toThrow('active schedule')
    const schedule = scheduled.details as { id: string; version: number }
    await turn.executeAction(action('stop-prompt'), { id: schedule.id, version: schedule.version }, () => true)
    await turn.executeAction(action('use-prompt'), { id: book.id, version: book.version, variables: { target: 'tests' }, wake: true }, () => true)
    expect(deliver).toHaveBeenCalledWith('one', expect.stringContaining('Inspect tests'), expect.any(Object), expect.objectContaining({ steering: true, wake: false, plugin: 'dsh-mnemon-source-playbooks' }))
    expect(deliver).toHaveBeenCalledOnce()
  } finally { await runner.dispose() }
})
