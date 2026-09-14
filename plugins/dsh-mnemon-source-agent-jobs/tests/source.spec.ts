import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import type { RecordSnapshot } from 'dsh-mnemon/source-sdk'
import { createAgentJobsSource } from '../src/index.ts'

it('composes through Core, fences copied inputs, and requires exact-plan external approval', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'job-source-'))), runner = new MemoryCompositionRunner()
  const scope = { storage: 'custom' as const, workspaceId: directory, sessionId: 'owner' }
  await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [createAgentJobsSource({ dataDir: directory, adapters: [{ id: 'fixture', label: 'Fixture', command: process.execPath, input: 'stdin', args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("complete"))'] }] })] }) } }, { instanceId: 'jobs' })
  await runner.mount({ apply(ctx: Context) { installMemory(ctx, { strategies: [defineMemoryStrategy({ manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'job-test', packageName: 'job-test', deterministic: true, supportedSourceRoles: ['agent-jobs'], maxSources: 4, maxRoutes: 8, maxActions: 16 }, compose(_request, sources) { return { strategyTypeId: 'job-test', explanation: 'Verify published operations', sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, projection: { mode: 'routed', maxCharacters: 10000 }, routeIds: source.routeIds, actionIds: source.actionIds })) } } })] }) } }, { instanceId: 'policy' })
  try {
    const client = await runner.managementClient('source:jobs', scope)
    const created = await client.mutate('create', { title: 'Input test', content: 'Run the reviewed fixture', data: { adapter: 'fixture' } }, { confirmed: true })
    const record = (created.value as unknown as RecordSnapshot).records[0]!
    const captures = [{ sourceKey: 'source:notes', label: 'Project notes', track: 'project', revision: 'revision-1', capturedAt: new Date().toISOString(), text: 'A selected context snapshot' }]
    const copied = await client.mutate('set-job-inputs', { id: record.id, images: [], contextSnapshots: captures }, { confirmed: true, expectedRevision: created.revision })
    await expect(client.mutate('set-job-inputs', { id: record.id, images: [], contextSnapshots: [] }, { confirmed: true, expectedRevision: created.revision })).rejects.toThrow(/changed|revision/)
    await expect(client.mutate('update', { id: record.id, data: { assets: [{ id: 'forged' }] } }, { confirmed: true, expectedRevision: copied.revision })).rejects.toThrow(/metadata/)
    await expect(client.mutate('import', { records: [] }, { confirmed: true })).rejects.toThrow(/cannot be imported/)
    const turn = await runner.beginTurn({ scope }), route = turn.view.routes.find(route => route.sourceRouteId === 'job-plan')!, offer = turn.view.actionOffers.find(offer => offer.sourceActionId === 'run-job')!
    const evidence = await turn.executeRoute(route.id, { id: record.id }), plan = JSON.parse(evidence.items[0]!.text)
    expect(plan.prompt).toContain('A selected context snapshot')
    await expect(turn.executeAction(offer.id, { id: record.id, plan }, () => false)).rejects.toThrow(/authoriz/)
    expect(((await client.read('snapshot')).value as unknown as RecordSnapshot).records[0]!.data.status).toBe('draft')
    await turn.executeAction(offer.id, { id: record.id, plan }, () => true)
    await expect(client.mutate('set-job-inputs', { id: record.id, images: [], contextSnapshots: [] }, { confirmed: true, expectedRevision: (await client.read('snapshot')).revision })).rejects.toThrow(/draft/)
    const outsider = await runner.managementClient('source:jobs', { ...scope, workspaceId: '/other-project' })
    await expect(outsider.read('execution-plan', { id: record.id })).rejects.toThrow(/approved/)
  } finally { await runner.dispose() }
})
