import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMemoryTurn } from '../src/host/agent-memory-turn.ts'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { MemoryPluginManagement } from '../src/host/plugin-management.ts'
import { createViewHandler } from '../src/host/view-rpc.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from '../src/host/runtime.ts'
import type { MemoryViewConfigurationRequest, MemoryViewPreferences } from '../src/host/view-protocol.ts'
import { viewManagementFixture, type ViewManagementFixtureOptions } from './fixtures/view-management.ts'
import type { RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import type { Context } from '@deepseek-ai/cordis'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, defineMemoryStrategyConfiguration, installMemory } from 'dsh-mnemon/extension-sdk'
import { sessionLog } from './fixtures/session-log.ts'

type Fixture = Awaited<ReturnType<typeof viewManagementFixture>>

describe('View configuration with the real pinned DSH Cordis Loader', () => {
  const fixtures: Fixture[] = []
  afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })
  async function fixture(saved?: MemoryViewPreferences, anchor?: string, stored?: Record<string, object>) {
    const value = await viewManagementFixture(saved, anchor, stored)
    fixtures.push(value)
    return value
  }
  const runtimeKey = 'source:mnemon-source-runtime'
  const documentsKey = 'source:mnemon-source-documents'
  const spacesKey = 'source:mnemon-source-memory-spaces'
  async function request(f: Fixture, entries: MemoryViewConfigurationRequest['entries'] = {}): Promise<MemoryViewConfigurationRequest> {
    return { expectedRevision: (await f.management.catalog()).revision, strategyTypeId: 'default-three-tier', entries }
  }
  const scope = (f: Fixture) => ({ storage: 'custom' as const, workspaceId: f.workspace, sessionId: 'root', agentId: 'root' })

  it('discovers disabled entries through public descriptors without activating or persisting them', async () => {
    const f = await fixture()
    const before = f.engine.contributionSnapshot().revision
    const catalog = await f.management.catalog()
    expect(catalog.entries.map(item => [item.typeId, item.enabled, item.active])).toEqual([
      ['documents', true, true], ['memory-spaces', true, true], ['runtime', true, true], ['default-three-tier', true, true],
      ['auto-capture', false, false], ['light-context', false, false], ['scoped', false, false],
    ])
    expect(catalog.entries.find(entry => entry.typeId === 'light-context')).toMatchObject({
      label: { en: 'Light context', 'zh-CN': '轻量上下文' }, slot: 'projection', writable: true,
      roles: ['strategy-extension'], requires: ['strategy'],
    })
    expect(catalog.entries.find(entry => entry.typeId === 'memory-spaces')).toMatchObject({ roles: ['source'], provides: expect.arrayContaining([{ id: 'source.durable-evidence', exclusive: false }]) })
    expect(f.engine.contributionSnapshot().revision).toBe(before)
    expect(f.settings.mutate).not.toHaveBeenCalled()
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('applies Source and Strategy activation through one graph transaction', async () => {
    const f = await fixture()
    await f.management.apply(f.config, scope(f), await request(f, {
      capture: { enabled: true, config: {} },
    }))
    expect(f.engine.contributionSnapshot().strategyExtensions?.map(value => value.definition.manifest.typeId)).toContain('auto-capture')

    await expect(f.management.apply(f.config, scope(f), await request(f, {
      'mnemon-source-memory-spaces': { enabled: false, config: {} },
    }))).rejects.toThrow('source.durable-evidence')
    expect(f.loader.resolve('mnemon-source-memory-spaces').disabled).toBe(false)

    await f.management.apply(f.config, scope(f), await request(f, {
      'mnemon-source-memory-spaces': { enabled: false, config: {} },
      capture: { enabled: false, config: {} },
    }))
    expect(f.loader.resolve('mnemon-source-memory-spaces').disabled).toBe(true)
    expect(f.engine.contributionSnapshot().sources.some(value => value.provenance.entryId === 'mnemon-source-memory-spaces')).toBe(false)
    expect(f.graph.memoryComposition.inspect().evaluation.state).toBe('ready')
    const turn = await f.graph.composableTurns.beginTurn('without-durable-source', scope(f))
    expect(turn.view.sourcePresentations?.map(value => value.sourceInstanceKey)).not.toContain(spacesKey)
    f.graph.composableTurns.endTurn(turn.turnId)
  })

  it('previews the actual composition read-only, saves through Cordis, and keeps the old turn immutable', async () => {
    const f = await fixture()
    await f.graph.source('runtime').mutate('mutate', { action: 'add', target: 'memory', content: 'Keep this real context. '.repeat(100) })
    const parent = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
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
    expect(preview.sourcePresentations?.map(item => item.sourceInstanceKey)).toEqual([runtimeKey, documentsKey, spacesKey])
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

  it('selects another complete Strategy and can return without uninstalling the previous composition', async () => {
    const f = await fixture()
    const name = 'dsh-mnemon-strategy-empty-view'
    const descriptor = defineMemoryStrategyConfiguration({ kind: 'strategy', typeId: 'empty-view', fields: [],
      label: { en: 'Empty view', 'zh-CN': '空视图' }, description: { en: 'Test-only complete Strategy.', 'zh-CN': '测试策略。' },
      create: () => ({ strategies: [defineMemoryStrategy({ manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'empty-view', packageName: name,
        deterministic: true, supportedSourceRoles: ['working-context', 'narrative', 'durable-evidence'], maxSources: 3, maxRoutes: 1, maxActions: 1 },
        compose: () => ({ strategyTypeId: 'empty-view', explanation: 'Explicit empty test view.', sources: [] }) })] }),
    })
    f.modules[name] = { name, inject: ['mnemonMemory'], memoryStrategyConfiguration: descriptor, apply: (ctx: Context) => installMemory(ctx, descriptor.create({})) }
    await f.loader.root.update([...f.loader.entries()].map(entry => entry.options).concat({ id: 'empty', name, disabled: true }))
    const discovered = await f.management.catalog()
    expect(discovered.diagnostics).toEqual([])
    expect(discovered.entries.find(entry => entry.entryId === 'empty')).toMatchObject({ typeId: 'empty-view', enabled: false, writable: true })
    await f.management.apply(f.config, scope(f), await request(f, { light: { enabled: true, config: { maxProjectionCharacters: 512 } } }))
    const alternate = { ...await request(f, { empty: { enabled: true, config: {} } }), strategyTypeId: 'empty-view' }
    expect(await f.management.preview(f.config, scope(f), alternate)).toMatchObject({ strategyTypeId: 'empty-view', projection: [], extensions: [] })
    await f.management.apply(f.config, scope(f), alternate)
    const graph = createRuntimeGraph(f.management.resolveConfig(f.config), f.workspace, f.engine)
    try {
      const turn = await graph.composableTurns.beginTurn('alternate', scope(f))
      expect(turn.view.strategyTypeId).toBe('empty-view')
      expect(turn.view.strategyExtensions ?? []).toEqual([])
      graph.composableTurns.endTurn(turn.turnId)
    } finally { graph.dispose() }
    expect(f.loader.resolve('light').disabled).toBe(false)
    expect(f.loader.resolve('mnemon-strategy-default-three-tier').disabled).toBe(false)
    await f.management.apply(f.config, scope(f), await request(f))
    const restored = await f.management.preview(f.config, scope(f), await request(f))
    expect(restored.extensions.map(value => value.typeId)).toEqual(['light-context'])
    expect(f.loader.resolve('empty').disabled).toBe(false)
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('restores saved user choices on fresh Loader entries without editing the bundled tree', async () => {
    const f = await fixture({ strategyTypeId: 'default-three-tier', entries: {
      light: { enabled: true, config: { maxProjectionCharacters: 900 } },
      capture: { enabled: true, config: {} },
    } })
    await vi.waitFor(async () => expect((await f.management.catalog()).entries.filter(entry => entry.roles.includes('strategy-extension') && entry.active)).toHaveLength(2))
    expect(f.loader.resolve('light').options.config).toEqual({ maxProjectionCharacters: 900 })
    expect(f.settings.mutate).not.toHaveBeenCalled()
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('isolates Profiles sharing one settings document, and restores only the matching Loader anchor', async () => {
    const webAnchor = 'file:///isolated/profiles/web/cordis.yml'
    const first = await fixture(undefined, webAnchor)
    await first.management.apply(first.config, scope(first), await request(first, { light: { enabled: true, config: { maxProjectionCharacters: 700 } } }))
    const namespace = first.management.settingsNamespace
    const stored = { [namespace]: first.settingsDocuments.get(namespace)!.value as MemoryViewPreferences }
    const headless = await fixture(undefined, 'file:///isolated/profiles/headless/cordis.yml', stored)
    expect(headless.management.settingsNamespace).not.toBe(namespace)
    expect(headless.loader.resolve('light').disabled).toBe(true)
    const restarted = await fixture(undefined, webAnchor, stored)
    expect(restarted.management.settingsNamespace).toBe(namespace)
    await vi.waitFor(async () => expect((await restarted.management.catalog()).entries.find(entry => entry.entryId === 'light')).toMatchObject({ active: true, config: { maxProjectionCharacters: 700 } }))
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

  it('keeps a newly opened workspace on the committed baseline during an in-flight save', async () => {
    const f = await fixture()
    const mutate = f.settings.mutate.bind(f.settings)
    let opened: ReturnType<typeof createRuntimeGraph> | undefined
    vi.mocked(f.settings.mutate).mockImplementationOnce(async (...args) => {
      opened = createRuntimeGraph(f.config, join(f.root, 'new-workspace'), f.engine)
      const before = await opened.composableTurns.beginTurn('during-commit', scope(f))
      expect(before.view.strategyExtensions ?? []).toEqual([])
      opened.composableTurns.endTurn(before.turnId)
      await mutate(...args)
    })
    await f.management.apply(f.config, scope(f), await request(f, { light: { enabled: true, config: {} } }))
    try {
      const after = await opened!.composableTurns.beginTurn('after-commit', scope(f))
      expect(after.view.strategyExtensions?.map(entry => entry.typeId)).toEqual(['light-context'])
      opened!.composableTurns.endTurn(after.turnId)
    } finally { opened?.dispose() }
  })

  it('does not endlessly retry a failing startup overlay through its own rollback events', async () => {
    const f = await fixture({ entries: { light: { enabled: true, config: {} }, capture: { enabled: true, config: {} } } })
    const update = vi.spyOn(f.loader.resolve('capture'), 'update').mockRejectedValue(new Error('Startup plugin failure'))
    await vi.waitFor(async () => expect((await f.management.catalog()).diagnostics.join(' ')).toContain('rollback was incomplete'))
    // One attempt plus the explicit rollback. Its Loader events must not
    // schedule another activation loop against unchanged persisted settings.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(update).toHaveBeenCalledTimes(2)
    expect(f.loader.resolve('light').disabled).toBe(true)
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
    expect(catalog.diagnostics.join(' ')).toContain('light: Invalid plugin configuration descriptor')
    expect(catalog.entries.filter(entry => entry.roles.includes('strategy') || entry.roles.includes('strategy-extension')).map(entry => entry.entryId)).toEqual(['mnemon-strategy-default-three-tier', 'capture', 'scoped'])
    const preview = await f.management.preview(f.config, scope(f), await request(f))
    expect(preview.strategyTypeId).toBe('default-three-tier')
  })

  it.each([
    { light: { enabled: true, config: { maxProjectionCharacters: 0 } } },
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

  it('keeps plugin inspection read-only and requires confirmation before DSH installation', async () => {
    const f = await fixture()
    const installation = {
      environment: () => ({ supported: true, profileName: 'web', suggestions: ['dsh-mnemon-strategy-focus'] }),
      registered: () => [],
      inspect: vi.fn(async () => ({ packageName: 'dsh-mnemon-strategy-focus', version: '0.5.0-beta.4', kind: 'strategy', mnemonPeerRange: '^0.5.0', installed: false })),
      install: vi.fn(async () => ({ packageName: 'dsh-mnemon-strategy-focus', version: '0.5.0-beta.4', profileName: 'web', installed: true, restartRequired: true })),
    }
    const reader = createViewHandler(f.live, f.engine, f.management, 'read', undefined, installation as never)
    const writer = createViewHandler(f.live, f.engine, f.management, 'write', undefined, installation as never)
    await expect(reader('inspect-plugin', { packageName: 'dsh-mnemon-strategy-focus' })).resolves.toMatchObject({ ok: true, value: { kind: 'strategy' } })
    await expect(writer('install-plugin', { packageName: 'dsh-mnemon-strategy-focus', version: '0.5.0-beta.4' })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('confirmation') } })
    await expect(writer('install-plugin', { packageName: 'dsh-mnemon-strategy-focus', version: '0.5.0-beta.4', confirmed: true })).resolves.toMatchObject({ ok: true, value: { restartRequired: true } })
    expect(installation.install).toHaveBeenCalledOnce()
    await expect(reader('dashboard', {})).resolves.toMatchObject({ ok: true, value: { pluginInstallation: { supported: true, profileName: 'web' } } })
  })

  it('reports the main Strategy the profile chose on the dashboard, else the default one', async () => {
    const chosen = await fixture({ strategyTypeId: 'general', entries: {} })
    await expect(createViewHandler(chosen.live, chosen.engine, chosen.management, 'read')('dashboard', { workspaceId: 'workspace' }))
      .resolves.toMatchObject({ ok: true, value: { strategyTypeId: 'general' } })
    const unchosen = await fixture()
    await expect(createViewHandler(unchosen.live, unchosen.engine, unchosen.management, 'read')('dashboard', { workspaceId: 'workspace' }))
      .resolves.toMatchObject({ ok: true, value: { strategyTypeId: 'default-three-tier' } })
  })

  it('aligns a listed session whose Agent is not loaded with the workspace DSH lists it under', async () => {
    const f = await fixture()
    const listed = { id: 'workspace', path: f.workspace, title: 'Fixture', sessionIds: ['listed'] }
    const live = new LiveMnemonRuntime(f.graph, { list: () => [listed], get: id => id === 'workspace' ? listed : undefined }, undefined, f.engine)
    try {
      // No loaded Agent, so the lifecycle knows no root for the session.
      const memoryView = vi.fn(() => undefined)
      const lifecycle = { workspaceRoot: () => undefined, memoryView, turnActivities: () => ({ cursor: 0, activities: [] }) }
      const handler = createViewHandler(live, f.engine, f.management, 'read', lifecycle as never)
      await expect(handler('dashboard', { sessionId: 'listed', workspaceId: 'workspace' })).resolves.toMatchObject({ ok: true, value: { currentUnavailable: 'not-generated' } })
      await expect(handler('dashboard', { sessionId: 'listed' })).resolves.toMatchObject({ ok: true, value: { currentUnavailable: 'not-generated' } })
      expect(memoryView.mock.calls).toEqual([['listed', f.workspace], ['listed', f.workspace]])
      // A session no workspace lists stays unaligned with a selected workspace.
      await expect(handler('dashboard', { sessionId: 'elsewhere', workspaceId: 'workspace' })).resolves.toMatchObject({ ok: true, value: { currentUnavailable: 'unaligned' } })
    } finally {
      live.dispose()
    }
  })

  it('keeps durable turn activity beside, rather than inside, the frozen View inspection', async () => {
    const f = await fixture()
    const preview = await f.management.preview(f.config, scope(f), await request(f))
    const current = { ...preview, state: 'active' as const, turn: 7 }
    const activity = { turn: 7, count: 1, names: ['mnemon_document_search'], recalls: 0, writes: 0,
      documentSearches: 1, inspections: 0, failures: 0,
      retrieved: [{ callId: 'read-1', toolName: 'mnemon_document_search', sourceTypeId: 'documents', operationId: 'search',
        items: [{ id: 'doc-1', title: 'Release plan' }] }], writebacks: [] }
    const lifecycle = {
      workspaceRoot: () => f.workspace,
      memoryView: () => current,
      turnActivities: () => ({ cursor: 9, activities: [activity] }),
    }
    const handler = createViewHandler(f.live, f.engine, f.management, 'read', lifecycle as never)
    const response = await handler('dashboard', { sessionId: 'root', workspaceId: 'workspace' })
    expect(response).toMatchObject({ ok: true, value: { current: { id: current.id, turn: 7 }, activity } })
    expect(current).not.toHaveProperty('activity')
  })
})

describe('View overlays across full profile reconciliation', () => {
  const fixtures: Fixture[] = []
  afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })

  async function fixture() {
    const f = await viewManagementFixture()
    fixtures.push(f)
    const mutate = vi.mocked(f.settings.mutate).getMockImplementation()!
    // Match the public ConfigEditor contract: reconcile the complete profile
    // before validation and again after persisting a settings edit.
    vi.mocked(f.settings.mutate).mockImplementation(async (...args) => {
      await f.reconcileProfile()
      await mutate(...args)
      await f.reconcileProfile()
    })
    return f
  }

  const scope = (f: Fixture) => ({ storage: 'custom' as const, workspaceId: f.workspace, sessionId: 'root', agentId: 'root' })
  async function apply(f: Fixture, entries: MemoryViewConfigurationRequest['entries']) {
    return f.management.apply(f.config, scope(f), {
      expectedRevision: (await f.management.catalog()).revision,
      strategyTypeId: 'default-three-tier', entries,
    })
  }

  it('keeps the same profile namespace for the public ctx and legacy context Loader anchors', async () => {
    const f = await fixture()
    const baseUrl = 'file:///isolated/profiles/web/cordis.yml'
    const namespace = (anchor: object) => new MemoryPluginManagement({
      settings: f.settings,
      get: () => ({ entries: () => f.loader.entries(), ...anchor }),
    } as unknown as HostContextShape, f.engine, f.settings).settingsNamespace
    const expected = namespace({ config: { baseUrl } })
    expect(expected).toMatch(/^mnemon-view-[a-f0-9]{16}$/u)
    expect(namespace({ ctx: { baseUrl } })).toBe(expected)
    expect(namespace({ context: { baseUrl } })).toBe(expected)
    expect(namespace({ ctx: { baseUrl }, context: { baseUrl: 'file:///different/' } })).toBe(expected)
    expect(namespace({ config: { baseUrl }, ctx: { baseUrl: 'file:///different/' } })).toBe(expected)
  })

  it('keeps an enabled-by-profile extension disabled and preserves untouched saved choices after a save', async () => {
    const f = await fixture()
    f.profileEntries.find(entry => entry.id === 'light')!.disabled = false
    await f.reconcileProfile()
    await apply(f, {
      capture: { enabled: true, config: { instruction: 'Keep approved preferences.' } },
    })
    await apply(f, { light: { enabled: false, config: { maxProjectionCharacters: 700 } } })

    const catalog = await f.management.catalog()
    expect(catalog.entries.find(entry => entry.entryId === 'light')).toMatchObject({ enabled: false, active: false, config: { maxProjectionCharacters: 700 } })
    expect(catalog.entries.find(entry => entry.entryId === 'capture')).toMatchObject({ enabled: true, active: true, config: { instruction: 'Keep approved preferences.' } })
    expect(f.settingsDocuments.get(f.management.settingsNamespace)!.value).toMatchObject({ entries: {
      light: { enabled: false, config: { maxProjectionCharacters: 700 } },
      capture: { enabled: true, config: { instruction: 'Keep approved preferences.' } },
    } })
    const turn = await f.graph.composableTurns.beginTurn('after-profile-save', scope(f))
    expect(turn.view.strategyExtensions?.map(value => value.typeId)).toEqual(['auto-capture'])
    f.graph.composableTurns.endTurn(turn.turnId)
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it.each(['mnemon', 'another-plugin'])('restores saved choices before a catalog reads a %s settings write', async namespace => {
    const f = await fixture()
    await apply(f, { light: { enabled: true, config: { maxProjectionCharacters: 900 } } })
    if (namespace !== 'mnemon') f.settings.register(namespace, {}, { base: { enabled: true }, applies: 'live' })
    const revision = f.settingsDocuments.get(namespace)!.revision
    await f.settings.mutate(namespace, [{ op: 'set', path: ['enabled'], value: false }], revision)

    // No polling or timer wait: the response itself fences the pending restore.
    const catalog = await f.management.catalog()
    expect(catalog.entries.find(entry => entry.entryId === 'light')).toMatchObject({ enabled: true, active: true, config: { maxProjectionCharacters: 900 } })
    expect(catalog.diagnostics).toEqual([])
    expect(f.settings.mutate).toHaveBeenCalledTimes(2)
    const preview = await f.management.preview(f.config, scope(f), { expectedRevision: catalog.revision, strategyTypeId: 'default-three-tier', entries: {} })
    expect(preview.extensions.map(value => value.typeId)).toEqual(['light-context'])
  })

  it('waits for the real Loader activation while a catalog restores a reloaded profile', async () => {
    const f = await fixture()
    await apply(f, { light: { enabled: true, config: {} } })
    const entry = f.loader.resolve('light')
    const update = entry.update.bind(entry)
    let began!: () => void
    const restoring = new Promise<void>(resolve => { began = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(entry, 'update').mockImplementation(async options => {
      if (options.disabled === false) { began(); await gate }
      await update(options)
    })
    await f.reconcileProfile()
    let returned = false
    const catalog = f.management.catalog().then(value => { returned = true; return value })
    try {
      await restoring
      expect(returned).toBe(false)
    } finally { release() }
    expect((await catalog).entries.find(value => value.entryId === 'light')).toMatchObject({ enabled: true, active: true })
  })

  it('retains a second profile reload arriving during an in-flight restore', async () => {
    const f = await fixture()
    await apply(f, { light: { enabled: true, config: {} } })
    await f.reconcileProfile()
    const entry = f.loader.resolve('light')
    const update = entry.update.bind(entry)
    vi.spyOn(entry, 'update').mockImplementationOnce(async options => {
      await update(options)
      await f.reconcileProfile()
    })
    const catalog = await f.management.catalog()
    expect(catalog.entries.find(value => value.entryId === 'light')).toMatchObject({ enabled: true, active: true })
    expect(catalog.diagnostics).toEqual([])
  })

  it('retries catalog discovery when a reload arrives during an asynchronous module import', async () => {
    const f = await fixture()
    await apply(f, { light: { enabled: true, config: {} } })
    const original = vi.mocked(f.loader.import).getMockImplementation()!
    let began!: () => void
    const importing = new Promise<void>(resolve => { began = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(f.loader.import).mockImplementationOnce(async name => {
      began()
      await gate
      return original(name)
    })
    const catalog = f.management.catalog()
    try {
      await importing
      await f.reconcileProfile()
    } finally { release() }
    expect((await catalog).entries.find(value => value.entryId === 'light')).toMatchObject({ enabled: true, active: true })
  })

  it('compensates durable settings before restoring the live graph if the post-save replay fails', async () => {
    const f = await fixture()
    const entry = f.loader.resolve('light')
    const update = entry.update.bind(entry)
    let enables = 0
    vi.spyOn(entry, 'update').mockImplementation(async options => {
      if (options.disabled === false && ++enables === 2) throw new Error('Post-save activation failed')
      await update(options)
    })

    await expect(apply(f, { light: { enabled: true, config: {} } })).rejects.toThrow('Post-save activation failed')
    expect(f.settings.mutate).toHaveBeenCalledTimes(2)
    expect(f.settingsDocuments.get(f.management.settingsNamespace)!.value).toEqual({ entries: {} })
    expect(entry.disabled).toBe(true)
    expect(f.engine.contributionSnapshot().strategyExtensions ?? []).toEqual([])
    const turn = await f.graph.composableTurns.beginTurn('after-compensation', scope(f))
    expect(turn.view.strategyExtensions ?? []).toEqual([])
    f.graph.composableTurns.endTurn(turn.turnId)
    expect((await f.management.catalog()).diagnostics).toEqual([])
  })

  it('reports an incomplete rollback when the compensating settings write fails', async () => {
    const f = await fixture()
    const entry = f.loader.resolve('light')
    const update = entry.update.bind(entry)
    const mutate = vi.mocked(f.settings.mutate).getMockImplementation()!
    let writes = 0
    vi.mocked(f.settings.mutate).mockImplementation(async (...args) => {
      if (++writes === 2) throw new Error('Compensation disk failure')
      await mutate(...args)
    })
    let enables = 0
    vi.spyOn(entry, 'update').mockImplementation(async options => {
      if (options.disabled === false && ++enables === 2) throw new Error('Post-save activation failed')
      await update(options)
    })

    const error = await apply(f, { light: { enabled: true, config: {} } }).catch(error => error as AggregateError)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map(value => value.message)).toEqual(['Post-save activation failed', 'Compensation disk failure'])
    expect((await f.management.catalog()).diagnostics.join(' ')).toContain('rollback was incomplete')
    expect(entry.disabled).toBe(true)
    expect(f.settingsDocuments.get(f.management.settingsNamespace)!.value).toMatchObject({ entries: { light: { enabled: true } } })
    expect(f.settings.mutate).toHaveBeenCalledTimes(2)
  })

  it('does not compensate over a newer saved choice after a replay failure', async () => {
    const f = await fixture()
    const entry = f.loader.resolve('light')
    const update = entry.update.bind(entry)
    const newer = { strategyTypeId: 'default-three-tier', entries: { light: { enabled: true, config: { maxProjectionCharacters: 900 } } } }
    let enables = 0
    vi.spyOn(entry, 'update').mockImplementation(async options => {
      if (options.disabled === false && ++enables === 2) {
        const document = f.settingsDocuments.get(f.management.settingsNamespace)!
        document.value = newer
        document.revision += 1
        throw new Error('Post-save activation failed')
      }
      await update(options)
    })

    const error = await apply(f, { light: { enabled: true, config: {} } }).catch(error => error as AggregateError)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[1].message).toContain('settings changed before rollback')
    expect(f.settingsDocuments.get(f.management.settingsNamespace)!.value).toEqual(newer)
    expect(f.settings.mutate).toHaveBeenCalledOnce()
    expect(entry.disabled).toBe(true)
  })
})

describe('memory plugin enablement owned by the DSH profile patch', () => {
  const fixtures: Fixture[] = []
  afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })

  async function fixture(saved?: MemoryViewPreferences, options: ViewManagementFixtureOptions = {}) {
    const value = await viewManagementFixture(saved, undefined, {}, { pluginManager: true, ...options })
    fixtures.push(value)
    return value
  }
  const scope = (f: Fixture) => ({ storage: 'custom' as const, workspaceId: f.workspace, sessionId: 'root', agentId: 'root' })
  async function apply(f: Fixture, entries: MemoryViewConfigurationRequest['entries'], strategyTypeId = 'default-three-tier') {
    await f.management.apply(f.config, scope(f), { expectedRevision: (await f.management.catalog()).revision, strategyTypeId, entries })
  }
  const saved = (f: Fixture) => f.settingsDocuments.get(f.management.settingsNamespace)!.value as MemoryViewPreferences
  const entry = async (f: Fixture, entryId: string) => (await f.management.catalog()).entries.find(value => value.entryId === entryId)!

  it('writes enablement through the DSH plugin manager and saves only configuration', async () => {
    const f = await fixture()
    await apply(f, { capture: { enabled: true, config: { instruction: 'Keep approved preferences.' } } })
    expect(f.pluginManager.setPluginEnabled).toHaveBeenCalledExactlyOnceWith('capture', true)
    expect(f.profileEntries.find(row => row.id === 'capture')).toMatchObject({ disabled: false })
    expect(saved(f).entries).toEqual({ capture: { config: { instruction: 'Keep approved preferences.' } } })
    expect(await entry(f, 'capture')).toMatchObject({ enabled: true, active: true, config: { instruction: 'Keep approved preferences.' } })
    expect(f.treeWrite).not.toHaveBeenCalled()
  })

  it('keeps a DSH Plugins page toggle instead of restoring an older choice', async () => {
    const f = await fixture()
    await apply(f, { light: { enabled: true, config: { maxProjectionCharacters: 700 } } })
    // The Plugins page switch writes the same profile row and reconciles.
    await f.pluginManager.setPluginEnabled('light', false)
    expect(await entry(f, 'light')).toMatchObject({ enabled: false, active: false, config: { maxProjectionCharacters: 700 } })
    await f.reconcileProfile()
    expect(await entry(f, 'light')).toMatchObject({ enabled: false, active: false })
    await f.pluginManager.setPluginEnabled('light', true)
    // Saved configuration still applies once the row runs again.
    expect(await entry(f, 'light')).toMatchObject({ enabled: true, active: true, config: { maxProjectionCharacters: 700 } })
  })

  it('moves previously saved enablement into the profile patch once', async () => {
    const f = await fixture({ strategyTypeId: 'default-three-tier', entries: {
      light: { enabled: true, config: { maxProjectionCharacters: 900 } },
      scoped: { enabled: false, config: {} },
    } })
    await f.management.catalog()
    expect(f.pluginManager.setPluginEnabled.mock.calls).toEqual([['light', true], ['scoped', false]])
    expect(saved(f)).toEqual({ strategyTypeId: 'default-three-tier', entries: { light: { config: { maxProjectionCharacters: 900 } }, scoped: { config: {} } } })
    expect(await entry(f, 'light')).toMatchObject({ enabled: true, active: true, config: { maxProjectionCharacters: 900 } })
    await f.reconcileProfile()
    await f.management.catalog()
    expect(f.pluginManager.setPluginEnabled).toHaveBeenCalledTimes(2)
  })

  it('switches between mutually exclusive main Strategies in one transaction', async () => {
    const f = await fixture(undefined, { generalStrategy: true })
    await apply(f, {
      general: { enabled: true, config: {} },
      'mnemon-strategy-default-three-tier': { enabled: false, config: {} },
    }, 'general')
    // The new main Strategy starts before the previous one stops.
    expect(f.pluginManager.setPluginEnabled.mock.calls).toEqual([['general', true], ['mnemon-strategy-default-three-tier', false]])
    expect(saved(f).strategyTypeId).toBe('general')
    const turn = await f.graph.composableTurns.beginTurn('after-switch', scope(f))
    expect(turn.view.strategyTypeId).toBe('general')
    f.graph.composableTurns.endTurn(turn.turnId)
  })

  it('rolls enablement back when the saved View no longer composes', async () => {
    const f = await fixture(undefined, { generalStrategy: true })
    // Selecting a Strategy whose Entry stays off must not leave half-applied rows.
    await expect(apply(f, { capture: { enabled: true, config: {} } }, 'general')).rejects.toThrow('selected memory Strategy type is unavailable: general')
    expect(f.pluginManager.setPluginEnabled).not.toHaveBeenCalled()
    expect(await entry(f, 'capture')).toMatchObject({ enabled: false, active: false })
    expect(saved(f).entries).toEqual({})
  })
})
