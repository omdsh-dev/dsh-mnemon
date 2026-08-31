import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMemoryTurn } from '../src/host/agent-memory-turn.ts'
import type { HostAgent } from '../src/host/dsh.ts'
import { createViewHandler } from '../src/host/view-rpc.ts'
import type { MemoryViewConfigurationRequest, MemoryViewPreferences } from '../src/host/view-protocol.ts'
import { viewManagementFixture } from './fixtures/view-management.ts'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'

const fixtures: Awaited<ReturnType<typeof viewManagementFixture>>[] = []
afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })
async function fixture(saved?: MemoryViewPreferences) {
  const value = await viewManagementFixture(saved)
  fixtures.push(value)
  return value
}
const runtimeKey = 'source:mnemon-source-runtime'
const documentsKey = 'source:mnemon-source-documents'
const spacesKey = 'source:mnemon-source-memory-spaces'
async function request(f: Awaited<ReturnType<typeof fixture>>, entries: MemoryViewConfigurationRequest['entries'] = {}): Promise<MemoryViewConfigurationRequest> {
  return { expectedRevision: (await f.management.catalog()).revision, strategyTypeId: 'default-three-tier', entries }
}
const scope = (f: Awaited<ReturnType<typeof fixture>>) => ({ storage: 'custom' as const, workspaceId: f.workspace, sessionId: 'root', agentId: 'root' })

describe('View configuration with the real pinned DSH Cordis Loader', () => {
  it('discovers disabled entries through public descriptors without activating or persisting them', async () => {
    const f = await fixture()
    const before = f.engine.contributionSnapshot().revision
    const catalog = await f.management.catalog()
    expect(catalog.entries.map(item => [item.typeId, item.enabled, item.active])).toEqual([
      ['default-three-tier', true, true], ['scoped', false, false], ['light-context', false, false], ['auto-capture', false, false],
    ])
    expect(catalog.entries[2]).toMatchObject({ label: { en: 'Light context', 'zh-CN': '轻量上下文' }, slot: 'projection', writable: true })
    expect(f.engine.contributionSnapshot().revision).toBe(before)
    expect(f.settings.mutate).not.toHaveBeenCalled()
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('previews the actual composition read-only, saves through Cordis, and keeps the old turn immutable', async () => {
    const f = await fixture()
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Keep this real context. '.repeat(100) })
    const parent = { id: 'root', session: { header: { cwd: f.workspace }, events: [] } } as unknown as HostAgent
    const owner = new AgentMemoryTurn(parent, f.live)
    await owner.begin(1)
    const current = owner.inspect()!
    const before = await f.graph.source('runtime').read<RuntimeMemorySnapshot>('snapshot')
    const revision = f.engine.contributionSnapshot().revision
    const next = await request(f, {
      light: { enabled: true, config: { maxProjectionCharacters: 512 } },
      scoped: { enabled: true, config: { sourceKeys: [runtimeKey, documentsKey, spacesKey], writableSourceKeys: [spacesKey] } },
      capture: { enabled: true, config: {} },
    })
    const preview = await f.management.preview(f.config, scope(f), next)
    expect(preview.state).toBe('preview')
    expect(preview.extensions.map(item => item.slot).sort()).toEqual(['capture', 'projection', 'selection'])
    expect(preview.projection.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(512)
    expect(preview.actions.every(action => action.sourceInstanceKey === spacesKey)).toBe(true)
    expect(preview).not.toHaveProperty('readGrants')
    expect(preview.routes.every(route => !('readGrantId' in route))).toBe(true)
    expect(f.engine.contributionSnapshot().revision).toBe(revision)
    expect(await f.graph.source('runtime').read('snapshot')).toMatchObject({ revision: before.revision, entries: before.entries, targets: before.targets })
    expect(owner.inspect()).toEqual(current)
    await f.management.apply(f.config, scope(f), next)
    expect(f.settings.mutate).toHaveBeenCalledOnce()
    expect(f.treeWrite).not.toHaveBeenCalled()
    expect(owner.inspect()).toEqual(current)
    owner.end()
    expect(owner.inspect()?.state).toBe('recent')
    expect(owner.inspect(join(f.root, 'different-workspace'))).toBeUndefined()
    await owner.begin(2)
    const actual = owner.inspect()!
    expect(actual.extensions.map(item => item.typeId)).toEqual(preview.extensions.map(item => item.typeId))
    expect(actual.projection).toEqual(preview.projection)
    expect(actual.memoryText).toBe(preview.memoryText)
    owner.dispose()
    expect(owner.inspect()).toBeUndefined()
  })

  it('changes one extension without disabling other enabled plugins or losing their config', async () => {
    const f = await fixture()
    await f.management.apply(f.config, scope(f), await request(f, {
      light: { enabled: true, config: { maxProjectionCharacters: 700 } },
      capture: { enabled: true, config: { instruction: 'Remember only user-approved preferences.' } },
    }))
    await f.management.apply(f.config, scope(f), await request(f, { light: { enabled: false, config: { maxProjectionCharacters: 700 } } }))
    const catalog = await f.management.catalog()
    expect(catalog.entries.find(item => item.entryId === 'light')).toMatchObject({ enabled: false, config: { maxProjectionCharacters: 700 } })
    expect(catalog.entries.find(item => item.entryId === 'capture')).toMatchObject({ enabled: true, active: true, config: { instruction: 'Remember only user-approved preferences.' } })
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('restores saved user choices on fresh Loader entries without editing the bundled tree', async () => {
    const f = await fixture({ strategyTypeId: 'default-three-tier', entries: {
      light: { enabled: true, config: { maxProjectionCharacters: 900 } },
      capture: { enabled: true, config: {} },
    } })
    await vi.waitFor(async () => expect((await f.management.catalog()).entries.filter(entry => entry.kind === 'strategy-extension' && entry.active)).toHaveLength(2))
    expect(f.loader.resolve('light').options.config).toEqual({ maxProjectionCharacters: 900 })
    expect(f.settings.mutate).not.toHaveBeenCalled()
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('rolls back live registrations if durable settings fail, including pinned and future views', async () => {
    const f = await fixture()
    const id = f.graph.memoryComposition.current()!.id
    vi.mocked(f.settings.mutate).mockImplementationOnce(async () => {
      // Registration updates are buffered; no half-applied Serving generation.
      expect(f.graph.memoryComposition.current()!.id).toBe(id)
      throw new Error('Disk full')
    })
    await expect(f.management.apply(f.config, scope(f), await request(f, {
      light: { enabled: true, config: {} }, capture: { enabled: true, config: {} },
    }))).rejects.toThrow('Disk full')
    expect(f.loader.resolve('light').disabled).toBe(true)
    expect(f.loader.resolve('capture').disabled).toBe(true)
    expect(f.engine.contributionSnapshot().strategyExtensions ?? []).toEqual([])
    const next = await f.graph.composableTurns.beginTurn('after-failure', scope(f))
    expect(next.view.strategyExtensions ?? []).toEqual([])
    expect(next.view.strategyTypeId).toBe('default-three-tier')
    f.graph.composableTurns.endTurn('after-failure')
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('rolls back earlier entries after a later Cordis activation fails', async () => {
    const f = await fixture()
    vi.spyOn(f.loader.resolve('capture'), 'update').mockRejectedValueOnce(new Error('Plugin activation failed'))
    await expect(f.management.apply(f.config, scope(f), await request(f, {
      light: { enabled: true, config: {} }, capture: { enabled: true, config: {} },
    }))).rejects.toThrow('Plugin activation failed')
    expect(f.loader.resolve('light').disabled).toBe(true)
    expect(f.engine.contributionSnapshot().strategyExtensions ?? []).toEqual([])
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('rejects stale and simultaneous saves before they can replace a newer choice', async () => {
    const f = await fixture()
    const next = await request(f, { light: { enabled: true, config: {} } })
    const results = await Promise.allSettled([f.management.apply(f.config, scope(f), next), f.management.apply(f.config, scope(f), next)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(f.settings.mutate).toHaveBeenCalledOnce()
    await expect(f.management.preview(f.config, scope(f), next)).rejects.toThrow('changed')
  })

  it('fences read-only and aborted requests without activating an Entry', async () => {
    const f = await fixture()
    const next = await request(f, { light: { enabled: true, config: {} } })
    const abort = new AbortController()
    abort.abort(new Error('Preview cancelled'))
    await expect(f.management.preview(f.config, scope(f), next, abort.signal)).rejects.toThrow('cancelled')
    Object.defineProperty(f.settings, 'writable', { value: false })
    await expect(f.management.apply(f.config, scope(f), next)).rejects.toThrow('read-only')
    expect((await f.management.catalog()).writable).toBe(false)
    expect(f.loader.resolve('light').disabled).toBe(true)
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('does not partially restore an invalid persisted combination', async () => {
    const f = await fixture({ entries: {
      capture: { enabled: true, config: {} }, light: { enabled: true, config: { maxProjectionCharacters: -1 } },
    } })
    await vi.waitFor(async () => expect((await f.management.catalog()).diagnostics.join(' ')).toContain('Invalid numeric'))
    expect(f.engine.contributionSnapshot().strategyExtensions ?? []).toEqual([])
    expect(f.settings.mutate).not.toHaveBeenCalled()
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('keeps other editors and the real snapshot available when an optional module is broken', async () => {
    const f = await fixture()
    f.modules['dsh-mnemon-strategy-light-context'] = { memoryStrategyConfiguration: { apiVersion: 'dsh-mnemon/strategy-configuration/v1', create: () => ({}), fields: null } }
    const catalog = await f.management.catalog()
    expect(catalog.diagnostics.join(' ')).toContain('light: Invalid Strategy configuration descriptor')
    expect(catalog.entries.map(entry => entry.entryId)).toEqual(['mnemon-strategy-default-three-tier', 'scoped', 'capture'])
    const preview = await f.management.preview(f.config, scope(f), await request(f))
    expect(preview.strategyTypeId).toBe('default-three-tier')
  })

  it.each([
    { light: { enabled: true, config: { maxProjectionCharacters: 0 } } },
    { light: { enabled: true, config: { maxProjectionCharacters: 1.5 } } },
    { capture: { enabled: true, config: { instruction: 'x'.repeat(4001) } } },
    { scoped: { enabled: true, config: { sourceKeys: [runtimeKey, runtimeKey] } } },
    { light: { enabled: true, config: { unknown: true } } },
    { missing: { enabled: true, config: {} } },
  ])('rejects invalid configuration without changing state (#%#)', async entries => {
    const f = await fixture()
    const revision = f.engine.contributionSnapshot().revision
    await expect(f.management.apply(f.config, scope(f), await request(f, entries as MemoryViewConfigurationRequest['entries']))).rejects.toThrow()
    expect(f.engine.contributionSnapshot().revision).toBe(revision)
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('rejects an unconfirmed RPC write and never invents a current turn when there is no session', async () => {
    const f = await fixture()
    const handler = createViewHandler(f.live, f.engine, f.management, 'read')
    const writer = createViewHandler(f.live, f.engine, f.management, 'write')
    const config = await request(f, { light: { enabled: true, config: {} } })
    await expect(writer('apply', { workspaceId: 'workspace', configuration: config })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('confirmation') } })
    await expect(handler('apply', { workspaceId: 'workspace', configuration: config, confirmed: true })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('channel') } })
    await expect(handler('dashboard', { workspaceId: 'workspace' })).resolves.toMatchObject({ ok: true, value: { currentUnavailable: 'no-session' } })
    await expect(handler('preview', { workspaceId: 'workspace', configuration: config })).resolves.toMatchObject({ ok: true, value: { state: 'preview' } })
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })
})
