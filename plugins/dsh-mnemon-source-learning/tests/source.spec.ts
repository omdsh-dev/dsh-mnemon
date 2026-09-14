import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { COMPOSABLE_MEMORY_API_VERSION, DEFAULT_MEMORY_VIEW_BUDGET } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { digest, type RecordSnapshot } from 'dsh-mnemon/source-sdk'
import { createLearningSource } from '../src/source.ts'
import { LearningStore, learningWindow } from '../src/learning.ts'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
it('requires an actual inspected View, keeps candidates out of recall and records use separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mnemon-learning-source-')); dirs.push(root)
  const scope = { storage: 'custom' as const, workspaceId: '/project', sessionId: 'session-a' }, runner = new MemoryCompositionRunner()
  const source = createLearningSource({ dataDir: root }, { complete: async () => { throw new Error('Not used by in-turn reviews') } })
  await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [source] }) } }, { instanceId: 'learning' })
  await runner.mount({ apply(ctx: Context) { installMemory(ctx, { strategies: [defineMemoryStrategy({ manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'learn-test', packageName: 'learn-test', deterministic: true, supportedSourceRoles: ['learning-context'], maxSources: 1, maxRoutes: 2, maxActions: 2 }, compose(_request, sources) { return { strategyTypeId: 'learn-test', explanation: 'Test learning contracts', sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, projection: { mode: 'eager', maxCharacters: 1000 }, routeIds: source.routeIds, actionIds: source.actionIds })) } } })] }) } }, { instanceId: 'policy' })
  const learning = new LearningStore(join(root, 'sources', 'learning', digest('source:learning').slice(0, 20)))
  await learning.observe(scope, { eventKey: 'turn-1', origin: 'human-turn', title: 'Project convention', content: 'Use typed public contracts for plugins.' })
  try {
    const turn = await runner.beginTurn({ scope, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 48_000, maxEvidenceResults: 12 } })
    const read = turn.view.routes.find(route => route.sourceRouteId === 'review-input')!, recall = turn.view.routes.find(route => route.sourceRouteId === 'search')!, offer = turn.view.actionOffers.find(action => action.sourceActionId === 'complete-review')!
    const payload = learningWindow(await learning.store.read(), scope)!
    const input = { token: payload.token, summary: 'A durable project convention was explicit.', proposals: [{ category: 'fact', scope: 'project', title: 'Public plugin contracts', content: 'Use typed public contracts for plugins.', evidenceIds: [payload.evidence[0]!.id] }] }
    const next = await runner.beginTurn({ scope, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 48_000 } })
    await expect(next.executeAction(next.view.actionOffers.find(a => a.sourceActionId === 'complete-review')!.id, input, () => true)).rejects.toThrow('Inspect review-input')
    await turn.executeRoute(read.id, {})
    expect((await turn.executeAction(offer.id, input, () => true)).completion).toBe('committed')
    expect((await turn.executeRoute(recall.id, {})).items).toHaveLength(0)
    const management = await runner.managementClient('source:learning', scope)
    const pending = (await management.read('snapshot')).value as unknown as RecordSnapshot, candidate = pending.records.find(r => r.kind === 'proposal')!
    expect(candidate.state).toBe('pending')
    await management.mutate('approve', { id: candidate.id, version: candidate.version }, { confirmed: true })
    const adoptedTurn = await runner.beginTurn({ scope, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 48_000 } })
    expect((await adoptedTurn.executeRoute(adoptedTurn.view.routes.find(r => r.sourceRouteId === 'search')!.id, {})).items[0]?.id).toBe(candidate.id)
    const use = adoptedTurn.view.actionOffers.find(a => a.sourceActionId === 'report-use')!
    await adoptedTurn.executeAction(use.id, { id: candidate.id }, () => true)
    await adoptedTurn.executeAction(use.id, { id: candidate.id }, () => true)
    const after = (await management.read('snapshot')).value as unknown as RecordSnapshot
    expect(after.records.find(r => r.id === candidate.id)?.data).toMatchObject({ uses: 1, helpful: 0 })
  } finally { await runner.dispose() }
})
