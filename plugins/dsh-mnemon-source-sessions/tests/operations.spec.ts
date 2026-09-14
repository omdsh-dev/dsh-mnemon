import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { RecordStore } from 'dsh-mnemon/source-sdk'
import type { DshWorkspaceAdapter } from 'dsh-mnemon-workspace-kit/dsh'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { createSessionsSource } from '../src/index.ts'
import { sessionOperation } from '../src/operations.ts'
import { modelCatalog } from '../src/catalog.ts'
const scope = { storage: 'custom' as const, workspaceId: '/project', sessionId: 'primary' }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-session-operations-')), store = new RecordStore(directory)
  const create = vi.fn(async () => ({})), deliver = vi.fn(async () => ({ status: 'idle', delivery: 'followup' })), adapter = { create, deliver } as unknown as DshWorkspaceAdapter
  return { directory, store, create, deliver, adapter }
}
describe('native session operations', () => {
  it('persists one launch and message across independent engines and rejects request id reuse', async () => {
    const { directory, store, adapter, create, deliver } = await fixture(), input = { requestId: 'one', preset: 'standard', provider: 'local', model: 'test', text: 'Review the design.', wake: true }
    const first = await sessionOperation(store, adapter, 'session-create', input, scope)
    expect(create).toHaveBeenCalledWith(scope, expect.objectContaining({ preset: 'standard', agentOptions: { provider: 'local', model: 'test' } }))
    expect(deliver).toHaveBeenCalledWith(expect.any(String), input.text, scope, expect.objectContaining({ plugin: 'dsh-mnemon-source-sessions', wake: true }))
    expect(await sessionOperation(new RecordStore(directory), adapter, 'session-create', input, scope)).toMatchObject({ ...first as object, replayed: true })
    expect(create).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce()
    await expect(sessionOperation(store, adapter, 'session-create', { ...input, text: 'different' }, scope)).rejects.toThrow('different operation')
  })
  it('does not retry uncertain delivery or accept invalid model overrides', async () => {
    const { store, adapter, create, deliver } = await fixture()
    await expect(sessionOperation(store, adapter, 'session-create', { requestId: 'bad', model: 'test' }, scope)).rejects.toThrow('both provider and model')
    expect(create).not.toHaveBeenCalled()
    deliver.mockRejectedValueOnce(new Error('Transport interrupted'))
    const input = { requestId: 'send', sessionId: 'peer', text: 'One message' }
    await expect(sessionOperation(store, adapter, 'session-send', input, scope)).rejects.toThrow('Transport interrupted')
    await expect(sessionOperation(store, adapter, 'session-send', input, scope)).rejects.toThrow('uncertain')
    expect(deliver).toHaveBeenCalledOnce()
  })
  it('requires actual Core authority before creating a normal session', async () => {
    const { directory, adapter, create } = await fixture(), runner = new MemoryCompositionRunner()
    try {
      await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [createSessionsSource({ dataDir: directory }, adapter)], strategies: [defineMemoryStrategy({ manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'session-policy', packageName: 'session-policy', deterministic: true, supportedSourceRoles: ['session-history'], maxSources: 1, maxActions: 8, maxRoutes: 8 }, compose(_request, sources) { return { strategyTypeId: 'session-policy', explanation: 'Native session authority test', sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, routeIds: source.routeIds, actionIds: source.actionIds })) } } })] }) } }, { instanceId: 'session-test' })
      const turn = await runner.beginTurn({ scope }), action = turn.view.actionOffers.find(value => value.sourceActionId === 'session-create')!
      expect(action.authority).toBe('session-management')
      await expect(turn.executeAction(action.id, { requestId: 'authorized' }, () => false)).rejects.toThrow(/authoriz/i)
      expect(create).not.toHaveBeenCalled()
      await turn.executeAction(action.id, { requestId: 'authorized', preset: 'standard' }, () => true)
      expect(create).toHaveBeenCalledOnce()
    } finally { await runner.dispose() }
  })
})
it('preserves unknown and negative image capability and reads exact unlisted models without exposing private metadata', async () => {
  const llm = { listProviders: () => [{ id: 'local', name: 'Local' }], listModels: async () => [{ provider: 'local', id: 'unknown', name: 'Unknown', credential: 'PRIVATE' }, { provider: 'local', id: 'text', name: 'Text', inputModalities: ['text'] as const }], resolveModelInfo: vi.fn(async (_provider: string, id: string) => ({ provider: 'local', id, name: 'Exact', inputModalities: ['text', 'image'] as const, context: { contextWindow: 64000 }, reasoning: { efforts: [] }, credential: 'PRIVATE' })) }
  const catalog = await modelCatalog(llm, {}, new AbortController().signal)
  expect(catalog.items[0]?.provenance).toMatchObject({ imageInput: null })
  expect(catalog.items[1]?.provenance).toMatchObject({ imageInput: false })
  expect((await modelCatalog(llm, { provider: 'local', model: 'unlisted' }, new AbortController().signal)).items[0]?.provenance).toMatchObject({ imageInput: true, contextWindow: 64000 })
  expect(JSON.stringify(catalog)).not.toContain('PRIVATE')
})
