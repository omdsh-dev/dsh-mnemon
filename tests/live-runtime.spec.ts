import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { HostAgent, HostAgentsService, HostContextShape, HostSubagentsService, HostWorkspaceRegistry } from '../src/contracts.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from '../src/live-runtime.ts'
import { createReadHandler, createWriteHandler } from '../src/rpc.ts'
import { MnemonLifecycle } from '../src/lifecycle.ts'
import { MnemonSubagentCoordinator } from '../src/subagent.ts'
import { MemoryExtensionHost } from '../packages/extension-sdk/src/index.ts'

const directories: string[] = []

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

function agent(id: string, cwd: string): HostAgent {
  return {
    id,
    status: 'idle',
    session: { header: { cwd }, events: [] },
    ctx: { on: vi.fn(), effect: vi.fn() },
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('LiveMnemonRuntime workspace routing', () => {
  it.each(['global', 'workspace', 'custom', 'legacy-custom'] as const)('maps Builtin session reads and writes to %s storage without a workspace override', async storageScope => {
    const globalRoot = temporaryDirectory('builtin-global')
    const customRoot = temporaryDirectory('builtin-custom')
    const initialRoot = temporaryDirectory('builtin-host')
    const workspaceOne = temporaryDirectory('builtin-one')
    const workspaceTwo = temporaryDirectory('builtin-two')
    vi.stubEnv('MNEMON_DATA_DIR', globalRoot)
    const sessions = [agent('session-1', workspaceOne), agent('session-2', workspaceTwo)]
    const workspaces = sessions.map((session, index) => ({ id: `workspace-${index + 1}`, title: `Workspace ${index + 1}`, path: session.session.header!.cwd! }))
    const runtime = new LiveMnemonRuntime(createRuntimeGraph(resolveConfig({
      displayMode: 'builtin', cliPath: '/fake/mnemon',
      ...(storageScope === 'legacy-custom' ? {} : { storageScope }),
      ...(storageScope === 'custom' || storageScope === 'legacy-custom' ? { dataDir: customRoot } : {}),
    }), initialRoot), {
      get: id => workspaces.find(workspace => workspace.id === id), list: () => workspaces,
    }, {
      get: id => sessions.find(session => session.id === id), roots: () => sessions,
    })
    const subagents = { run: vi.fn() }
    const lifecycle = new MnemonLifecycle({ agents: { get: (id: string) => sessions.find(session => session.id === id) } } as HostContextShape,
      new MnemonSubagentCoordinator(subagents as unknown as HostSubagentsService, runtime), runtime.config, runtime)
    const read = createReadHandler(runtime, lifecycle)
    const write = createWriteHandler(runtime, lifecycle)
    try {
      for (const session of sessions) {
        const expected = storageScope === 'workspace' ? join(session.session.header!.cwd!, '.mnemon') : storageScope === 'global' ? globalRoot : customRoot
        expect(runtime.route({ sessionId: session.id })).toMatchObject({ selectedRoot: expected, effectiveRoot: expected, aligned: true })
        await expect(write('runtime-memory', { sessionId: session.id, action: 'add', target: 'memory', content: `Memory from ${session.id}` })).resolves.toMatchObject({ ok: true })
        await expect(write('document', { sessionId: session.id, action: 'create', title: `Document from ${session.id}`, content: `# ${session.id}` })).resolves.toMatchObject({ ok: true })
      }
      for (const session of sessions) {
        const expectedSessions = storageScope === 'workspace' ? [session] : sessions
        const memory = await read('runtime-memory', { sessionId: session.id })
        expect(memory).toMatchObject({ ok: true, value: { entries: expect.arrayContaining(expectedSessions.map(item => expect.objectContaining({ content: `Memory from ${item.id}` }))) } })
        if (memory.ok) expect((memory.value as { entries: unknown[] }).entries).toHaveLength(expectedSessions.length)
        const documents = await read('documents', { sessionId: session.id })
        expect(documents).toMatchObject({ ok: true, value: { activeCount: expectedSessions.length } })
      }
      expect(subagents.run).not.toHaveBeenCalled()
    } finally {
      runtime.dispose()
    }
  })

  it('builds one composable memory generation beside the compatible runtime services', () => {
    const runtime = createRuntimeGraph(resolveConfig({ storageScope: 'global', cliPath: '/fake/mnemon' }))
    const descriptor = runtime.memoryKernel.descriptor()
    expect(descriptor).toMatchObject({
      topology: {
        id: 'default-three-tier',
        generation: 1,
        layers: [
          { id: 'runtime', enabled: true },
          { id: 'documents', enabled: true },
          { id: 'memory-spaces', enabled: true },
        ],
      },
      catalog: {
        layers: [{ id: 'runtime' }, { id: 'documents' }, { id: 'memory-spaces' }],
        strategies: [{ id: 'default-three-tier' }],
      },
    })
    expect(descriptor.catalog.adapters.map(adapter => adapter.id)).toEqual(expect.arrayContaining(['mnemon-native', 'openviking', 'supermemory']))
  })

  it('wires configured Runtime Memory limits into each runtime generation', () => {
    const runtime = createRuntimeGraph(resolveConfig({
      storageScope: 'global',
      cliPath: '/fake/mnemon',
      runtimeMemory: { memoryLimitBytes: 20_480, userLimitBytes: 10_240, maintenanceMaxTokens: 32_768 },
    }))
    expect(runtime.runtimeMemory.limits).toEqual({ memory: 20_480, user: 10_240 })
    expect(runtime.config.runtimeMemory.maintenanceMaxTokens).toBe(32_768)
    runtime.dispose()
  })

  it('combines an opt-in global USER.md with project memory under the same configured limits', async () => {
    const globalRoot = temporaryDirectory('global-user-profile')
    const projectRoot = temporaryDirectory('project-runtime')
    vi.stubEnv('MNEMON_DATA_DIR', globalRoot)
    const runtime = createRuntimeGraph(resolveConfig({
      storageScope: 'custom',
      dataDir: projectRoot,
      runtimeUserScope: 'global',
      runtimeMemory: { memoryLimitBytes: 20_480, userLimitBytes: 10_240 },
      cliPath: '/fake/mnemon',
    }))

    await runtime.runtimeMemory.mutate({ action: 'add', target: 'user', content: 'Stash local changes before pulling.' })
    await runtime.runtimeMemory.mutate({ action: 'add', target: 'memory', content: 'Exclude deployment YAML in this project.' })
    await runtime.runtimeMemory.mutate({ action: 'add', target: 'user', content: `profile-capacity:${'u'.repeat(6_000)}` })
    await runtime.runtimeMemory.mutate({ action: 'add', target: 'memory', content: `project-capacity-a:${'m'.repeat(6_000)}` })
    await runtime.runtimeMemory.mutate({ action: 'add', target: 'memory', content: `project-capacity-b:${'m'.repeat(6_000)}` })

    expect(runtime.runtimeMemory.userPath).toBe(join(globalRoot, 'runtime', 'USER.md'))
    expect(runtime.runtimeMemory.memoryPath).toBe(join(projectRoot, 'runtime', 'MEMORY.md'))
    const snapshot = runtime.runtimeMemory.snapshot()
    expect(snapshot.entries.map(entry => entry.content)).toEqual(expect.arrayContaining([
      'Stash local changes before pulling.',
      'Exclude deployment YAML in this project.',
    ]))
    expect(snapshot.entries).toHaveLength(5)
    expect(snapshot.targets.user).toMatchObject({ limit: 10_240, used: expect.any(Number) })
    expect(snapshot.targets.user.used).toBeGreaterThan(4_096)
    expect(snapshot.targets.memory).toMatchObject({ limit: 20_480, used: expect.any(Number) })
    expect(snapshot.targets.memory.used).toBeGreaterThan(10_240)
    runtime.dispose()
  })

  it('discovers extension layers as disabled topology candidates until explicitly configured', () => {
    const extensions = new MemoryExtensionHost()
    extensions.register({
      descriptor: { id: 'episodic-extension', version: '1', label: 'Episodic', description: 'External episodic layer.' },
      layers: [{ descriptor: { id: 'episodic', label: 'Episodic', description: 'External event memory.', role: 'episodic', order: 400, capabilities: ['recall', 'write'] } }],
    })
    const discovered = createRuntimeGraph(resolveConfig({ storageScope: 'global', cliPath: '/fake/mnemon' }), undefined, extensions)
    expect(discovered.memoryTopology.snapshot().layers.find(layer => layer.id === 'episodic')).toMatchObject({
      enabled: false,
      participation: { recall: 'manual', write: 'manual' },
    })
    discovered.dispose()

    const configured = createRuntimeGraph(resolveConfig({
      storageScope: 'global',
      cliPath: '/fake/mnemon',
      memoryTopology: { layers: { episodic: { enabled: true, participation: { recall: 'automatic' } } } },
    }), undefined, extensions)
    expect(configured.memoryTopology.snapshot().layers.find(layer => layer.id === 'episodic')).toMatchObject({ enabled: true, participation: { recall: 'automatic' } })
    configured.dispose()
  })

  it('reconciles extensions registered and unloaded after the runtime is live', () => {
    const extensions = new MemoryExtensionHost()
    const runtime = createRuntimeGraph(resolveConfig({ storageScope: 'global', cliPath: '/fake/mnemon' }), undefined, extensions)
    const dispose = extensions.register({
      descriptor: { id: 'late-extension', version: '1', label: 'Late', description: 'Late contribution.' },
      layers: [{ descriptor: { id: 'late-layer', label: 'Late', description: 'Late memory layer.', role: 'late-memory', order: 500, capabilities: ['recall'] } }],
    })
    expect(runtime.memoryTopology.snapshot().layers.find(layer => layer.id === 'late-layer')).toMatchObject({ enabled: false })
    dispose()
    expect(runtime.memoryTopology.snapshot().layers.find(layer => layer.id === 'late-layer')).toBeUndefined()
    runtime.dispose()
  })

  it('rejects automatic extension projection without a MemorySource and assembles contributed Sources when present', async () => {
    const missing = new MemoryExtensionHost()
    missing.register({
      descriptor: { id: 'missing-projector', version: '1', label: 'Missing', description: 'Projection fixture.' },
      layers: [{ descriptor: { id: 'episodes', label: 'Episodes', description: 'Episodic projection.', role: 'episodes', order: 400, capabilities: ['project'] } }],
    })
    const config = resolveConfig({
      storageScope: 'global',
      cliPath: '/fake/mnemon',
      memoryTopology: { layers: { episodes: { enabled: true, participation: { projection: 'automatic' } } } },
    })
    expect(() => createRuntimeGraph(config, undefined, missing)).toThrow('no MemorySource: episodes')

    const extensions = new MemoryExtensionHost()
    extensions.register({
      descriptor: { id: 'episodes-source', version: '1', label: 'Episodes', description: 'Source fixture.' },
      layers: [{ descriptor: { id: 'episodes', label: 'Episodes', description: 'Episodic projection.', role: 'episodes', order: 400, capabilities: ['project'] } }],
      sources: [{
        layerId: 'episodes',
        mode: 'routed',
        snapshot: () => ({ revision: 'episodes-1', wake: 'Recent bounded episodes are available.' }),
      }],
    })
    const graph = createRuntimeGraph(config, undefined, extensions)
    const turn = await graph.memoryViews.beginTurn('session:1', { storage: 'global', sessionId: 'session', agentId: 'session' })
    expect(graph.memoryViews.wake(turn.viewId).sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ layerId: 'episodes', mode: 'routed' }),
    ]))
    graph.memoryViews.endTurn(turn.turnId)
    graph.dispose()
  })

  it('keeps one Agent on its pinned runtime graph across a live swap and releases it at turn end', async () => {
    const config = resolveConfig({ storageScope: 'global', cliPath: '/fake/mnemon' })
    const first = createRuntimeGraph(config)
    const runtime = new LiveMnemonRuntime(first)
    const sessionAgent = agent('session-1', temporaryDirectory('pinned-runtime'))
    const context = await first.memoryViews.beginTurn('session-1:1', { storage: 'global', sessionId: 'session-1', agentId: 'session-1' })
    const release = runtime.bindAgentRuntime(sessionAgent.id, first)
    const second = createRuntimeGraph(config)

    runtime.swap(second)
    expect(runtime.snapshot()).toBe(second)
    expect(runtime.forAgent(sessionAgent)).toBe(first)
    expect(runtime.forAgent(sessionAgent).memoryViews.activeTurn(sessionAgent.id)).toEqual(context)
    const childCwd = sessionAgent.session.header!.cwd!
    const child = agent('child-1', childCwd)
    child.session.header = { origin: 'subagent', parentSession: sessionAgent.id, cwd: childCwd }
    expect(runtime.forAgent(child)).toBe(first)

    first.memoryViews.endTurn(context.turnId)
    release()
    expect(runtime.forAgent(sessionAgent)).toBe(second)
    runtime.dispose()
    expect(() => runtime.forAgent(sessionAgent)).toThrow('disposed')
  })

  it('separates the inspected workspace from the current session execution workspace', () => {
    const workspaceOne = temporaryDirectory('workspace-one')
    const workspaceTwo = temporaryDirectory('workspace-two')
    const initialRoot = temporaryDirectory('initial')
    const workspaces = [
      { id: 'workspace-1', title: 'Workspace One', path: workspaceOne },
      { id: 'workspace-2', title: 'Workspace Two', path: workspaceTwo },
    ]
    const registry = {
      get: (id: string) => workspaces.find(workspace => workspace.id === id),
      list: () => workspaces,
    } satisfies HostWorkspaceRegistry
    const sessionAgent = agent('session-1', workspaceOne)
    const agents = {
      get: (id: string) => id === sessionAgent.id ? sessionAgent : undefined,
      roots: () => [sessionAgent],
    } satisfies HostAgentsService
    const config = resolveConfig({ storageScope: 'workspace', cliPath: '/fake/mnemon' })
    const runtime = new LiveMnemonRuntime(createRuntimeGraph(config, initialRoot), registry, agents)

    expect(runtime.forAgent(sessionAgent).runner.effectiveDataDir()).toBe(join(workspaceOne, '.mnemon'))
    expect(runtime.forWorkspaceId('workspace-2').runner.effectiveDataDir()).toBe(join(workspaceTwo, '.mnemon'))
    expect(runtime.route({ workspaceId: 'workspace-2', sessionId: 'session-1' })).toMatchObject({
      selectedRoot: join(workspaceTwo, '.mnemon'),
      effectiveRoot: join(workspaceOne, '.mnemon'),
      aligned: false,
      selectedWorkspace: { id: 'workspace-2' },
      effectiveWorkspace: { id: 'workspace-1' },
    })
    expect(runtime.route({ workspaceId: 'workspace-1', sessionId: 'session-1' }).aligned).toBe(true)
  })

  it('rejects arbitrary workspace identifiers at the Host boundary', () => {
    const workspace = temporaryDirectory('workspace')
    const config = resolveConfig({ storageScope: 'workspace', cliPath: '/fake/mnemon' })
    const registry = { get: vi.fn(), list: vi.fn(() => []) } satisfies HostWorkspaceRegistry
    const runtime = new LiveMnemonRuntime(createRuntimeGraph(config, workspace), registry, { get: vi.fn(), roots: vi.fn(() => []) })

    expect(() => runtime.forWorkspaceId('../../private')).toThrow('selected DSH workspace is unavailable')
    expect(registry.get).toHaveBeenCalledWith('../../private')
  })

  it('keeps global and custom storage on their configured singleton root', () => {
    const workspace = temporaryDirectory('workspace')
    const globalRuntime = new LiveMnemonRuntime(createRuntimeGraph(resolveConfig({ storageScope: 'global', cliPath: '/fake/mnemon' }), workspace))
    const customRoot = temporaryDirectory('custom')
    const customRuntime = new LiveMnemonRuntime(createRuntimeGraph(resolveConfig({ storageScope: 'custom', dataDir: customRoot, cliPath: '/fake/mnemon' }), workspace))
    const sessionAgent = agent('session-1', temporaryDirectory('other-workspace'))

    expect(globalRuntime.forAgent(sessionAgent)).toBe(globalRuntime.snapshot())
    expect(customRuntime.forAgent(sessionAgent)).toBe(customRuntime.snapshot())
    expect(customRuntime.route({ sessionId: 'session-1' })).toMatchObject({ selectedRoot: customRoot, effectiveRoot: customRoot, aligned: true })
  })

  it('routes Headless workspace storage by Agent cwd without a Web workspace registry', () => {
    const initialRoot = temporaryDirectory('headless-initial')
    const workspace = temporaryDirectory('headless-workspace')
    const sessionAgent = agent('headless-session', workspace)
    const agents = {
      get: (id: string) => id === sessionAgent.id ? sessionAgent : undefined,
      roots: () => [sessionAgent],
    } satisfies HostAgentsService
    const runtime = new LiveMnemonRuntime(
      createRuntimeGraph(resolveConfig({ storageScope: 'workspace', cliPath: '/fake/mnemon' }), initialRoot),
      undefined,
      agents,
    )

    expect(runtime.forAgent(sessionAgent).runner.effectiveDataDir()).toBe(join(workspace, '.mnemon'))
    expect(runtime.route({ sessionId: sessionAgent.id })).toMatchObject({
      selectedRoot: join(workspace, '.mnemon'),
      effectiveRoot: join(workspace, '.mnemon'),
      aligned: true,
    })
    expect(() => runtime.forWorkspaceId('web-only-selection')).toThrow('selected DSH workspace is unavailable')
  })
})
