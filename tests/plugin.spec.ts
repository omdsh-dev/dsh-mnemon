import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MnemonMemoryService } from 'dsh-mnemon/extension-sdk'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import native from 'dsh-mnemon-provider-mnemon-native'
import * as documentsPlugin from 'dsh-mnemon-source-documents'
import * as spacesPlugin from 'dsh-mnemon-source-memory-spaces'
import * as runtimePlugin from 'dsh-mnemon-source-runtime'
import * as autoCapture from 'dsh-mnemon-strategy-auto-capture'
import * as strategyPlugin from 'dsh-mnemon-strategy-default-three-tier'
import * as lightContext from 'dsh-mnemon-strategy-light-context'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import { MemoryRuntime } from '../src/core/runtime.ts'
import type { HostAgent, HostContextShape, HostSessionEvent, HostSettingsService, ToolDefinition } from "../src/host/dsh.ts"
import { MemoryPluginInstallation } from '../src/host/plugin-installation.ts'
import type { ProcessOptions } from '../src/host/process.ts'
import { agentScope } from '../src/host/runtime.ts'
import { MnemonSubagentCoordinator } from "../src/host/subagent.ts"
import { registerTools } from "../src/host/tools.ts"
import { apply, inject } from '../src/index.ts'
import { compositionFixture } from './fixtures/composition.ts'
import { sessionLog } from './fixtures/session-log.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dsh: { client: { inject: string[]; platform: string } }
  devDependencies: Record<string, string>
  engines: { node: string; dsh: string }
  peerDependencies: Record<string, string>
}
const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
const workspaceConfig = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')
const bundlePatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

const directories: string[] = []

const releases: Array<() => unknown> = []
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function dataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-plugin-'))
  directories.push(directory)
  return directory
}

function context(options: { connection?: boolean; workspaceRegistry?: boolean } = {}) {
  const tools: unknown[] = []
  const sections: unknown[] = []
  const contexts: unknown[] = []
  const variables: unknown[] = []
  const channels: unknown[][] = []
  const connection = {
    rpc: {
      handle: vi.fn((...args: unknown[]) => { channels.push(args) }),
    },
  }
  const commands: unknown[] = []
  const listeners: unknown[] = []
  const effectCleanups: Array<() => unknown> = []
  const services = new Map<string, unknown>()
  // DSH profile settings: forms over the owning Entry, edited through ConfigEditor.
  const entry = { id: 'mnemon', options: { id: 'mnemon', config: {} } }
  const fiber: { entry: typeof entry; config: unknown } = { entry, config: undefined }
  const editor = { entries: () => [entry] }
  const forms = {
    writable: true,
    configure: vi.fn(() => () => {}),
    describe: vi.fn((): unknown[] => []),
    mutate: vi.fn(async (..._args: unknown[]) => {}),
  }
  const ctx = {
    fiber,
    provide: vi.fn((name: string, value: unknown) => { services.set(name, value) }),
    tools: { register: vi.fn((tool: unknown) => {
      tools.push(tool)
      return vi.fn(() => { const index = tools.indexOf(tool); if (index >= 0) tools.splice(index, 1) })
    }) },
    commands: { register: vi.fn((command: unknown) => { commands.push(command) }) },
    settings: forms,
    agents: { get: vi.fn(), roots: vi.fn(() => []) },
    subagents: {
      list: vi.fn(() => ['spawn']),
      getProvider: vi.fn(() => ({ capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } })),
      start: vi.fn(),
    },
    get: vi.fn((name: string) => {
      if (name === 'systemPrompt') {
        return {
          section: (section: unknown) => { sections.push(section) },
          context: (context: unknown) => { contexts.push(context) },
          variable: vi.fn((...args: unknown[]) => { variables.push(args) }),
        }
      }
      if (name === 'workspaceRegistry' && 'workspaceRegistry' in ctx) return ctx.workspaceRegistry
      if (name === 'configEditor') return editor
      return services.get(name)
    }),
    inject: vi.fn((services: string[], callback: (value: unknown) => void) => {
      if (services.includes('connection') && !('connection' in ctx)) return
      callback(ctx)
    }),
    on: vi.fn((...args: unknown[]) => { listeners.push(args); return () => {} }),
    effect: vi.fn((callback: () => unknown) => {
      const cleanup = callback()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup as () => unknown)
      return () => {
        const index = effectCleanups.indexOf(cleanup as () => unknown)
        if (index >= 0) effectCleanups.splice(index, 1)
        if (typeof cleanup === 'function') cleanup()
      }
    }),
  }
  if (options.connection !== false) Object.assign(ctx, { connection })
  if (options.workspaceRegistry !== false) Object.assign(ctx, { workspaceRegistry: { get: vi.fn(), list: vi.fn(() => []) } })
  releases.push(async () => { for (const cleanup of effectCleanups.splice(0).reverse()) await cleanup() })
  /** DSH validates a candidate through the owner's config waterfall before committing it. */
  const preflight = (candidate: object): unknown => {
    const listener = (listeners as Array<[string, (this: unknown, raw: unknown, next: () => unknown) => unknown]>).find(([name]) => name === 'internal/config')![1]
    return listener.call(fiber, undefined, () => candidate)
  }
  /** Commit a live profile edit the way the Loader publishes volatile updates. */
  const commit = (config: object): void => {
    fiber.config = config
    ;(listeners as Array<[string, (paths: readonly (readonly string[])[]) => void]>).find(([name]) => name === 'loader/volatile-update')![1]([[]])
  }
  return { ctx, tools, sections, contexts, variables, channels, commands, listeners, effectCleanups, forms, fiber, preflight, commit }
}

async function installStarter(target: ReturnType<typeof context>) {
  const assembled = await compositionFixture()
  releases.push(assembled.dispose)
  const core = target.ctx.get('mnemonMemory') as MnemonMemoryService
  const installed = assembled.extensions.contributionSnapshot()
  for (const item of [...installed.sources, ...installed.strategies]) {
    releases.push(core.installContributions(item.kind === 'source' ? { sources: [item.definition] } : { strategies: [item.definition] }, {
      instanceId: item.provenance.entryId,
      ...(item.provenance.artifactDigest === undefined ? {} : { artifactDigest: item.provenance.artifactDigest }),
      ...(item.kind !== 'source' || item.effectiveDigest === undefined ? {} : { effectiveDigest: item.effectiveDigest }),
    }))
  }
  return core
}

describe('dsh-mnemon plugin composition', () => {
  it('registers and disposes Web RPC routes after the official Connection is already running', async () => {
    const root = new Context()
    releases.push(() => root.fiber.dispose())
    const stub = context()
    const routes = new Map<string, unknown>()
    await root.plugin({ apply: ctx => {
      ctx.provide('webServer', { register: (route: { path: string }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      } })
    } })
    for (const name of ['tools', 'commands', 'settings', 'agents', 'subagents'] as const) root.provide(name, stub.ctx[name])
    root.provide('webRuntime', {})
    // Official Web profile scopes Connection to webRuntime; Mnemon must be
    // installable after this fiber has already started, without restarting it.
    await root.plugin({ inject: ['webRuntime'], apply: ctx => { new HostConnectionService(ctx, [], { isAuthenticated: () => true } as never) } })
    const host = await root.plugin({ inject, apply: ctx => apply(ctx, { dataDir: dataDir() }) })
    const connectionFiber = [...root.registry.values()].flatMap(runtime => [...runtime.fibers])
      .find(fiber => fiber.parent === host.ctx && Object.hasOwn(fiber.inject, 'connection'))
    expect(connectionFiber).toBeDefined()
    await connectionFiber!.await()
    expect(routes.size).toBe(9)
    expect(routes.has('/dsh-mnemon-read')).toBe(true)
    expect(routes.has('/dsh-mnemon-sync')).toBe(true)
    await host.dispose()
    expect(routes.size).toBe(0)
  })

  it('keeps the installed DSH release family coherent', () => {
    // Every direct DSH package and locked DSH package follows one release, the development
    // baseline, which is one of the hosts the Starter states it runs on.
    const baseline = manifest.devDependencies['@deepseek-ai/dsh']
    const directDshDependencies = Object.entries(manifest.devDependencies)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    const lockedDshVersions = [...lockfile.matchAll(/(@deepseek-ai\/dsh(?:-[a-z0-9-]+)?)@(\d+\.\d+\.\d+(?:-(?:alpha|rc)\.\d+)?)(?=[:'(_\s])/g)]
      .map(match => match[2])

    expect(baseline).toMatch(/^\d+\.\d+\.\d+(?:-(?:alpha|rc)\.\d+)?$/)
    expect(new Set(directDshDependencies.map(([, version]) => version))).toEqual(new Set([baseline]))
    expect(manifest.engines.node).toBe('>=20')
    // DSH 0.2.1 checks engines.dsh, DSH 0.2.0 the DSH peers: both name the same hosts, prereleases included.
    expect(evaluatePluginCompatibility(manifest as never, {}, baseline)).toBeUndefined()
    for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-typert-protocol']) {
      expect(manifest.peerDependencies[name]).toBe(manifest.engines.dsh)
    }
    // DSH's frontend provides its client UI packages to plugin clients at run time; DSH 0.2.1 installs no copy a peer could name.
    expect(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-primitives']).toBeUndefined()
    expect(lockedDshVersions.length).toBeGreaterThan(100)
    expect(new Set(lockedDshVersions)).toEqual(new Set([baseline]))
    expect(workspaceConfig).not.toMatch(/^  - ['"]@deepseek-ai\/\*/m)
  })

  it('keeps Web-only workspace and connection services out of its core dependencies', () => {
    expect(inject).toEqual(['tools', 'settings', 'commands', 'agents', 'subagents'])
  })

  it('owns legacy display migration at startup, on external edits and until Host disposal', async () => {
    const fixture = context({ connection: false })
    const base = { cliPath: '/fake/mnemon', dataDir: dataDir(), displayMode: 'buildin' as const }
    let user: Record<string, unknown> = {}
    let revision = 1
    const mutate = vi.fn(async (namespace: string, ops: Array<{ path: string[]; value: unknown }>, expected: number) => {
      expect(namespace).toBe('mnemon')
      expect(expected).toBe(revision)
      expect(ops).toEqual([{ op: 'set', path: ['displayMode'], value: 'builtin' }])
      user = { ...user, displayMode: ops[0]!.value }
      revision += 1
    })
    Object.assign(fixture.ctx.settings, {
      writable: true,
      describe: () => [{ ns: 'mnemon', base, user, value: { ...base, ...user }, revision, applies: 'live' }],
      mutate,
    })
    apply(fixture.ctx as never, base)
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(user).toEqual({ displayMode: 'builtin' })
    const updated = (fixture.listeners as Array<[string, (namespace: string) => void]>)
      .find(([name]) => name === 'settings/document-updated')![1]
    user = { displayMode: 'buildin', timeoutMs: 25000 }
    revision += 1
    updated('unrelated')
    expect(mutate).toHaveBeenCalledTimes(1)
    updated('mnemon')
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(user).toEqual({ displayMode: 'builtin', timeoutMs: 25000 })
    updated('mnemon')
    expect(mutate).toHaveBeenCalledTimes(2)
    for (const cleanup of fixture.effectCleanups.splice(0).reverse()) await cleanup()
    user = { displayMode: 'buildin' }
    revision += 1
    updated('mnemon')
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(user).toEqual({ displayMode: 'buildin' })
  })

  it('mounts its complete Agent surface without Web-only Host services', async () => {
    const fixture = context({ connection: false, workspaceRegistry: false })
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    await installStarter(fixture)

    expect(fixture.tools).toHaveLength(17)
    expect(fixture.sections).toEqual([expect.objectContaining({ name: 'mnemon:routing' })])
    expect(fixture.contexts).toEqual([])
    expect(fixture.variables).toEqual([])
    expect(fixture.commands).toEqual([expect.objectContaining({ name: 'mnemon' })])
    expect(fixture.channels).toEqual([])
  })

  it('keeps the historical unsorted tool order after Host-first Starter loading settles', async () => {
    const fixture = context({ connection: false, workspaceRegistry: false })
    const ready = Promise.withResolvers<void>()
    const awaitLoader = vi.fn(() => ready.promise)
    fixture.ctx.provide('loader', { await: awaitLoader })
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    const names = () => fixture.tools.map(tool => (tool as { name: string }).name)
    expect(names()).toEqual(['mnemon_subagent_result', 'mnemon_view_route', 'mnemon_view_action'])
    // The Starter declares Host before Runtime, Documents and Memory Spaces.
    await installStarter(fixture)
    expect(names()).toEqual(['mnemon_subagent_result', 'mnemon_view_route', 'mnemon_view_action'])
    ready.resolve()
    const historical = JSON.parse(readFileSync(new URL('./fixtures/model-tools.json', import.meta.url), 'utf8')) as Array<{ name: string }>
    await vi.waitFor(() => expect(names()).toEqual(historical.map(tool => tool.name)))
    expect(awaitLoader).toHaveBeenCalled()
  })

  it('discovers a Web workspace registry that becomes available after core activation', async () => {
    const fixture = context({ workspaceRegistry: false })
    const workspace = dataDir()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', storageScope: 'workspace' })
    await installStarter(fixture)
    Object.assign(fixture.ctx, {
      workspaceRegistry: {
        get: (id: string) => id === 'late-workspace' ? { id, title: 'Late Workspace', path: workspace } : undefined,
        list: () => [{ id: 'late-workspace', title: 'Late Workspace', path: workspace }],
      },
    })

    const readRegistration = fixture.channels.find(channel => (channel as unknown[])[0] === '/dsh-mnemon-read') as [
      string,
      (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: { directory: string } }>,
    ]
    await expect(readRegistration[1]('runtime-memory', { workspaceId: 'late-workspace' })).resolves.toMatchObject({
      ok: true,
      value: { directory: join(workspace, '.mnemon', 'runtime') },
    })
  })

  it('exports a DSH Web client with its ordering dependencies', () => {
    expect(manifest.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-layout',
        '@deepseek-ai/dsh-client-ui-sidebar',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-ui-session',
        '@deepseek-ai/dsh-client-locale',
      ],
      platform: 'web',
    })
  })

  it('anchors client discovery on the Host Entry while the Starter declares every plugin', () => {
    expect(bundlePatch).toMatch(/- id: mnemon\n(?:\s+#.*\n)*\s+name: dsh-mnemon\n/u)
    expect(bundlePatch).not.toContain('bundledContributions')
    expect(bundlePatch).not.toContain('name: dsh-mnemon/core')
  })

  it('registers the full tool surface, guidance, and split RPC channels', async () => {
    const fixture = context()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    await installStarter(fixture)
    // This context has no Loader and activates Sources incrementally; the
    // Host-first Loader test above separately asserts the unsorted bootstrap order.
    expect(fixture.tools.map(tool => (tool as { name: string }).name).sort()).toEqual([
      'mnemon_subagent_result',
      'mnemon_view_route',
      'mnemon_view_action',
      'mnemon_memory_bodies',
      'mnemon_recall',
      'mnemon_related',
      'mnemon_status',
      'mnemon_document_search',
      'mnemon_document_create',
      'mnemon_document_manage',
      'mnemon_runtime_memory',
      'mnemon_remember',
      'mnemon_link',
      'mnemon_forget',
      'mnemon_memory_body_create',
      'mnemon_memory_body_update',
      'mnemon_memory_body_merge',
    ].sort())
    expect(fixture.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: expect.objectContaining({ schema: { type: 'object', additionalProperties: true } }) }),
    ]))
    expect(fixture.tools.every(tool => (tool as { output: { schema: { type: string } } }).output.schema.type !== 'json')).toBe(true)
    const recallTool = fixture.tools.find(tool => (tool as { name: string }).name === 'mnemon_recall') as { description: string }
    expect(recallTool.description).toContain('one initial query plus one LLM-chosen different-query refinement')
    expect(recallTool.description).toContain('only when the current question needs history')
    expect(fixture.sections).toEqual([expect.objectContaining({ name: 'mnemon:routing' })])
    expect(fixture.contexts).toEqual([])
    expect(fixture.variables).toEqual([])
    const guidance = (fixture.sections[0] as { text: () => string }).text()
    expect(guidance).toContain('mnemon_view_route')
    expect(guidance).toContain('Never infer missing historical facts')
    expect(guidance).not.toMatch(/Documents|mnemon_recall|mnemon_runtime_memory/)
    expect(guidance.length).toBeLessThan(360)
    expect(guidance).not.toContain('RECALL RESULT')
    expect(fixture.commands).toEqual([expect.objectContaining({ name: 'mnemon' })])
    expect(fixture.channels.map(([channel]) => channel)).toEqual(expect.arrayContaining(['/dsh-mnemon-activation', '/dsh-mnemon-pack', '/dsh-mnemon-sync']))
    expect(fixture.channels).toHaveLength(9)
    // The settings bridge serves each Mnemon namespace from the owning profile Entry.
    fixture.forms.describe.mockReturnValue([{ ns: 'mnemon', value: { conversationInteraction: { turnBar: true, saveAction: false } }, base: {}, user: {}, revision: 3, applies: 'live' }])
    const settingsChannel = fixture.channels.find(([channel]) => channel === '/dsh-mnemon-settings')![1] as (endpoint: string, payload: unknown) => Promise<unknown>
    await expect(settingsChannel('get', { namespace: 'mnemon-ui' })).resolves.toMatchObject({
      ok: true, value: { status: 'ready', revision: 3, writable: true, value: { turnBar: true, saveAction: false } },
    })
  })

  it('keeps stable live surfaces while fencing every mutation in read-only mode', async () => {
    const fixture = context()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir(), writeEnabled: false })
    await installStarter(fixture)
    expect(fixture.tools).toHaveLength(17)
    const runtimeTool = fixture.tools.find(tool => (tool as { name: string }).name === 'mnemon_runtime_memory') as {
      execute: (args: unknown, execution: unknown) => Promise<unknown>
    }
    expect(() => runtimeTool.execute({ action: 'add', target: 'memory', content: 'blocked' }, { signal: new AbortController().signal })).toThrow('read-only')
    expect(fixture.channels).toHaveLength(9)
    expect(fixture.channels.map(([channel]) => channel)).toEqual(expect.arrayContaining(['/dsh-mnemon-activation', '/dsh-mnemon-pack', '/dsh-mnemon-sync']))
    expect(fixture.contexts).toEqual([])
  })

  it('offers bounded Source-owned suggestions when a cross-language query has no exact match', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    await f.graph.source('documents').mutate('mutate', {
      action: 'create', title: 'Cold Archive Transaction Contract', description: 'Write-ahead archival ordering and recovery invariants.',
      content: 'Land the durable cold reference before moving the managed original.',
    })
    const root = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    await f.graph.composableTurns.beginTurn('root:documents', agentScope(root, f.config), 'test')
    const tools: ToolDefinition[] = []
    const coordinator = new MnemonSubagentCoordinator({ list: () => [], getProvider: () => undefined, start: vi.fn() } as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } } } as never, f.live, coordinator, f.extensions)
    const result = await tools.find(tool => tool.name === 'mnemon_document_search')!.execute({ query: '冷归档不变量' } as never, { agent: root, signal: new AbortController().signal }) as { results: unknown[]; suggestions: unknown[]; suggestionHint: string }
    expect(result.results).toEqual([])
    expect(result.suggestions).toEqual([expect.objectContaining({
      excerpt: expect.stringContaining('Land the durable cold reference'),
      title: 'Cold Archive Transaction Contract',
    })])
    expect(result.suggestionHint).toContain('No exact match.')
    f.graph.composableTurns.endTurn('root:documents')
  })

  it('returns bounded query-local evidence without copying managed record internals', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const needle = 'TENANT-SKEW-NEEDLE-729'
    await f.graph.source('documents').mutate('mutate', {
      action: 'create', title: 'Long incident record', description: 'A deliberately long managed record.', sourcePaths: ['reports/incident.md'],
      content: 'before '.repeat(1_500) + needle + '\n' + 'after '.repeat(1_500),
    })
    const root = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    await f.graph.composableTurns.beginTurn('root:documents', agentScope(root, f.config), 'test')
    const tools: ToolDefinition[] = []
    const coordinator = new MnemonSubagentCoordinator({ list: () => [], getProvider: () => undefined, start: vi.fn() } as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } } } as never, f.live, coordinator, f.extensions)
    const result = await tools.find(tool => tool.name === 'mnemon_document_search')!.execute({ query: needle } as never, { agent: root, signal: new AbortController().signal }) as { results: Array<{ content: string }> }
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.content).toContain(needle)
    expect(result.results[0]!.content.length).toBeLessThanOrEqual(2_600)
    expect(JSON.stringify(result)).not.toMatch(/contentHash|generatedAt|indexPath|directory/)
    expect(JSON.stringify(result).length).toBeLessThan(8_000)
    f.graph.composableTurns.endTurn('root:documents')
  })

  it('shares one Documents route claim across the pinned root turn', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const root = { id: 'root', session: { header: { cwd: f.workspace }, ...sessionLog() } } as unknown as HostAgent
    const turn = await f.graph.composableTurns.beginTurn('root:documents', agentScope(root, f.config), 'test')
    const route = turn.view.routes.find(route => route.sourceRouteId === 'search')!
    const execute = vi.spyOn(f.graph.memoryComposition.current()!.sourceRuntime(route.sourceInstanceKey)!, 'query')
    const tools: ToolDefinition[] = []
    const coordinator = new MnemonSubagentCoordinator({ list: () => [], getProvider: () => undefined, start: vi.fn() } as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } } } as never, f.live, coordinator, f.extensions)
    const tool = tools.find(candidate => candidate.name === 'mnemon_document_search')!
    const execution = { agent: root, signal: new AbortController().signal }
    expect(await tool.execute({ query: 'ORCHID-47 root cause' } as never, execution)).not.toHaveProperty('notRun')
    expect(await tool.execute({ query: 'incident ORCHID generation key' } as never, execution)).toMatchObject({ notRun: true, results: [] })
    expect(execute).toHaveBeenCalledOnce()
    f.graph.composableTurns.endTurn('root:documents')
  })

  it('keeps guidance and Web RPC registrations stable while their live values are disabled', () => {
    const fixture = context()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir(), routingGuidance: false, tabEnabled: false })
    expect(fixture.sections).toEqual([
      expect.objectContaining({ name: 'mnemon:routing', text: expect.any(Function) }),
    ])
    expect(fixture.contexts).toEqual([])
    expect((fixture.sections[0] as { text: () => string }).text()).toBe('')
    expect(fixture.channels).toHaveLength(9)
  })

  it('atomically switches the same live RPC faces after a committed profile edit', async () => {
    const fixture = context()
    const initial = { cliPath: '/fake/mnemon', storageScope: 'custom' as const, dataDir: dataDir() }
    const next = { ...initial, dataDir: dataDir() }
    fixture.fiber.config = initial
    apply(fixture.ctx as never, initial)
    const packRegistration = fixture.channels.find(channel => (channel as unknown[])[0] === '/dsh-mnemon-pack') as [string, (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: { root: string } }>]
    await expect(packRegistration[1]('target', {})).resolves.toMatchObject({ ok: true, value: { root: initial.dataDir } })

    expect(fixture.preflight(next)).toBe(next)
    fixture.commit(next)

    await expect(packRegistration[1]('target', {})).resolves.toMatchObject({ ok: true, value: { root: next.dataDir } })
  })

  it('persists a newly enabled watermark through the normal settings update before immediate recreation', async () => {
    const directory = dataDir()
    const initial = { cliPath: '/fake/mnemon', storageScope: 'custom' as const, dataDir: directory, idleReviewMs: 5_000,
      idleReview: { maxPerSession: 1, minIntervalMs: 30_000 } }
    const review = vi.spyOn(MnemonSubagentCoordinator.prototype, 'review').mockResolvedValue({ delegated: false, action: 'skipped', summary: 'Synthetic reviewer.', documentIds: [] })
    vi.spyOn(MnemonSubagentCoordinator.prototype, 'checkReviewAccess').mockResolvedValue(true)
    const mount = async (config: typeof initial & { idleReview: typeof initial.idleReview & { persistWatermark?: boolean } }) => {
      const f = context()
      const hooks = new Map<string, Array<(...args: any[]) => any>>()
      const events: HostSessionEvent[] = []
      const agent = { id: 'settings-parent', status: 'idle', session: { header: { cwd: directory }, ...sessionLog(events) },
        ctx: { on: (name: string, hook: (...args: any[]) => any) => { const list = hooks.get(name) ?? []; list.push(hook); hooks.set(name, list); return () => { const index = list.indexOf(hook); if (index >= 0) list.splice(index, 1) } },
          get: () => undefined, effect: (callback: () => unknown) => { const cleanup = callback(); return typeof cleanup === 'function' ? cleanup : () => {} } },
        followup: vi.fn(), steer: vi.fn(), inject: vi.fn() } as unknown as HostAgent
      f.ctx.agents.roots.mockReturnValue([agent] as never)
      f.ctx.agents.get.mockImplementation(id => id === agent.id ? agent : undefined)
      f.fiber.config = config
      apply(f.ctx as never, config)
      await installStarter(f)
      const run = async (turn: number) => {
        events.push({ type: 'turn/start', data: { turn } })
        await hooks.get('system-prompt/assemble')![0]!({ sections: [], contexts: [] }, { agent, signal: new AbortController().signal }, async () => ({ sections: [], contexts: [] }))
        const messages = [{ id: `message-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please remember this synthetic decision: ' + 'SQLite. '.repeat(40) }] }]
        const payload = { agent, messages, turn, step: 1, signal: new AbortController().signal }
        await hooks.get('agent/pre-step')!.reduceRight<() => Promise<unknown>>((next, hook) => () => hook(payload, next), async () => ({ kind: 'enter', messages }))()
        await hooks.get('agent/request')!.reduceRight<() => Promise<unknown>>((next, hook) => () => hook(payload, next), async () => ({}))()
        await hooks.get('agent/turn-stopping')![0]!({ agent, turn, signal: new AbortController().signal })
        const event = { type: 'turn/end', data: { turn } }
        events.push(event); for (const hook of hooks.get('session/event')!) hook(agent.session, event)
      }
      return { ...f, run, stop: async () => { for (const cleanup of f.effectCleanups.splice(0).reverse()) await cleanup() } }
    }
    const first = await mount(initial)
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    try {
      await first.run(1); await first.run(2); await vi.advanceTimersByTimeAsync(5_000)
      expect(review).toHaveBeenCalledOnce()
      const enabled = { ...initial, idleReview: { ...initial.idleReview, persistWatermark: true } }
      first.commit(enabled)
      await first.stop()
      // No lifecycle status read or new turn occurs between commit and teardown.
      const reopened = await mount(enabled)
      const filename = join(directory, 'state', 'idle-review', createHash('sha256').update('settings-parent').digest('hex') + '.json')
      expect(JSON.parse(readFileSync(filename, 'utf8'))).toMatchObject({ attempts: 1, lastReviewAttemptAt: 1_005_000 })
      await reopened.run(1); await reopened.run(2); await vi.advanceTimersByTimeAsync(5_000)
      expect(review).toHaveBeenCalledOnce()
      await reopened.stop()
    } finally { vi.useRealTimers(); await first.stop() }
  })

  it('rejects an uninitializable live root before the active graph can move', async () => {
    const fixture = context()
    const initialRoot = dataDir()
    const invalidRoot = join(dataDir(), 'not-a-directory')
    writeFileSync(invalidRoot, 'occupied')
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', storageScope: 'custom', dataDir: initialRoot })
    await installStarter(fixture)
    const packRegistration = fixture.channels.find(channel => (channel as unknown[])[0] === '/dsh-mnemon-pack') as [string, (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: { root: string } }>]

    expect(() => fixture.preflight({ cliPath: '/fake/mnemon', storageScope: 'custom', dataDir: invalidRoot })).toThrow(/ENOTDIR|EEXIST|not a directory/iu)
    await expect(packRegistration[1]('target', {})).resolves.toMatchObject({ ok: true, value: { root: initialRoot } })
  })

  it('retires validation candidates and closes every graph with the Cordis effect', async () => {
    const fixture = context()
    const attach = vi.spyOn(MemoryRuntime.prototype, 'attachGeneration')
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    // Registration validates via lightweight composition dry-run before the single active graph starts.
    expect(attach).toHaveBeenCalledTimes(1)
    const [active] = attach.mock.results.map(result => result.value as ReturnType<MemoryRuntime['attachGeneration']>)
    fixture.preflight({ cliPath: '/fake/mnemon', dataDir: dataDir() })
    expect(attach).toHaveBeenCalledTimes(1)
    for (const cleanup of fixture.effectCleanups.splice(0).reverse()) await cleanup()
    expect(() => active!.host.acquire()).toThrow('disposed')
    expect(() => (fixture.ctx.get('mnemonMemory') as MnemonMemoryService).installContributions({}, { instanceId: 'closed' })).toThrow('disposed')
  })
})

describe('explicit default Starter', () => {
  const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
  afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose() })

  it('mounts real Cordis Entries, recomposes remaining Sources, and keeps old leases after unload', async () => {
    const value = await compositionFixture()
    fixtures.push(value)
    const { extensions, graph, releases } = value
    expect(extensions.contributionSnapshot()).toMatchObject({
      revision: 4,
      sources: [
        { instanceKey: 'source:mnemon-source-runtime' },
        { instanceKey: 'source:mnemon-source-documents' },
        { instanceKey: 'source:mnemon-source-memory-spaces', effectiveDigest: expect.stringMatching(/^providers:/u) },
      ],
      strategies: [{ instanceKey: 'strategy:mnemon-strategy-default-three-tier' }],
    })
    const lease = graph.memoryComposition.acquire()
    try {
      await releases[0]!()
      expect(graph.memoryComposition.inspect().evaluation).toMatchObject({
        state: 'ready',
        sourceInstanceKeys: ['source:mnemon-source-documents', 'source:mnemon-source-memory-spaces'],
      })
      expect(graph.memoryComposition.inspect().drainingGenerationIds).toContain(lease.id)
    } finally { lease.release() }
    expect(graph.memoryComposition.inspect().drainingGenerationIds).toEqual([])
  })

  it('keeps stable Starter Entries inside the legacy core lifecycle gate', () => {
    expect([runtimePlugin.name, documentsPlugin.name, spacesPlugin.name, strategyPlugin.name]).toEqual([
      'dsh-mnemon-source-runtime', 'dsh-mnemon-source-documents', 'dsh-mnemon-source-memory-spaces', 'dsh-mnemon-strategy-default-three-tier',
    ])
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(/- insert:\n(?:    #.*\n)*    - id: mnemon-bundle\n      name: dsh-mnemon\/bundle\n      group: true\n      disabled: !!js/u)
    expect(patch).not.toContain('mnemon-starter')
    expect(patch).not.toContain('inject:')
    expect(patch).toContain("[...loader.entries()].find(entry => entry.options.id === 'mnemon')")
    expect(patch).toContain('entry.evaluate(entry.options.disabled.__jsExpr)')
    expect(patch).toMatch(/        - id: mnemon\n          # Core\/Host/u)
    for (const name of [runtimePlugin.name, documentsPlugin.name, spacesPlugin.name, strategyPlugin.name]) {
      expect(patch).toMatch(new RegExp(`        - id: ${name.slice(4)}\\n          name: ${name}`, 'u'))
    }
    for (const name of [autoCapture.name, lightContext.name, scoped.name]) {
      expect(patch).toMatch(new RegExp(`        - id: ${name.slice(4)}\\n          name: ${name}\\n          disabled: true`, 'u'))
    }
    expect(patch).not.toContain('dsh-mnemon/source-')
    expect(patch).not.toContain('bundledContributions')
  })

  it('allows a Source to mount only its explicitly selected private children', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      const applyProvider = vi.fn(native.apply)
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        const result = await spacesPlugin.installMemorySpaces(ctx, [{ instanceId: 'work-native', module: { ...native, apply: applyProvider }, config: undefined }])
        expect(result).toBeUndefined()
      } }, { instanceId: 'memory-spaces/custom:team' })
      expect(applyProvider).toHaveBeenCalledOnce()
      expect(runner.context.get('mnemonProvider', false)).toBeUndefined()
      expect(runner.inspect().evaluation.sourceInstanceKeys).toEqual(['source:memory-spaces/custom:team'])
      await expect(spacesPlugin.apply(new Context(), { providers: ['not-installed'] })).rejects.toThrow('DSH Loader')
      await expect(runner.mount(spacesPlugin, { instanceId: 'duplicate', config: {
        providers: ['dsh-mnemon-provider-mnemon-native', 'dsh-mnemon-provider-mnemon-native'],
      } })).rejects.toThrow('duplicate Memory Space Provider child')
    } finally { await runner.dispose() }
  })
})

describe('dshmarket client-only shim Entries (#359)', () => {
  const shimEntry = (name: string) => `include:dsh-market:mkt-client-${name}`
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

  async function starterComposition() {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-market-shim-'))
    const runner = new MemoryCompositionRunner({
      strategyTypeId: 'default-three-tier',
      sourceConfiguration: source => source.manifest.typeId === 'runtime' || source.manifest.typeId === 'documents' ? { dataDir: directory } : {},
    })
    cleanups.push(async () => { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) })
    await runner.mount(strategyPlugin, { instanceId: 'include:mnemon-strategy-default-three-tier' })
    await runner.mount(runtimePlugin, { instanceId: 'include:mnemon-source-runtime' })
    await runner.mount(documentsPlugin, { instanceId: 'include:mnemon-source-documents' })
    await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
      await spacesPlugin.installMemorySpaces(ctx, [{ instanceId: native.id, module: native, config: undefined }])
    } }, { instanceId: 'include:mnemon-source-memory-spaces' })
    return runner
  }

  async function sourceKeys(runner: MemoryCompositionRunner) {
    return (await runner.managementCatalog()).sources.map(source => source.sourceInstanceKey).sort()
  }

  it('adds no second Runtime Memory or Project Documents, so the layered View still composes', async () => {
    const runner = await starterComposition()
    const before = await sourceKeys(runner)
    expect(before).toEqual(['source:include:mnemon-source-documents', 'source:include:mnemon-source-memory-spaces', 'source:include:mnemon-source-runtime'])
    await runner.mount(runtimePlugin, { instanceId: shimEntry('dsh-mnemon-source-runtime') })
    await runner.mount(documentsPlugin, { instanceId: shimEntry('dsh-mnemon-source-documents') })
    const turn = await runner.beginTurn()
    expect(turn.view.sourcePresentations?.length).toBeGreaterThan(0)
    turn.release()
    expect(await sourceKeys(runner)).toEqual(before)
  })

  it('mounts Memory Spaces there without its Providers and without an error', async () => {
    const runner = await starterComposition()
    const before = await sourceKeys(runner)
    await runner.mount(spacesPlugin, { instanceId: shimEntry('dsh-mnemon-source-memory-spaces') })
    expect(await sourceKeys(runner)).toEqual(before)
  })

  it('still composes a second configured instance under an ordinary Entry', async () => {
    const runner = await starterComposition()
    await runner.mount(runtimePlugin, { instanceId: 'runtime-work' })
    await expect(runner.mount(spacesPlugin, { instanceId: 'spaces-work' })).rejects.toThrow('at least one explicit Provider child')
    expect(await sourceKeys(runner)).toContain('source:runtime-work')
  })
})

describe('DSH-native Memory plugin installation', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

  async function profile() {
    const root = await mkdtemp(join(tmpdir(), 'mnemon-plugin-install-'))
    roots.push(root)
    const directory = join(root, 'profiles', 'web')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'cordis.yml'), '[]\n')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2))
    const loader = { entries: () => [], config: { baseUrl: pathToFileURL(join(directory, 'cordis.yml')).href } }
    const documents = new Map<string, { value: Record<string, unknown>; revision: number; validate?: (value: never) => void }>()
    const listeners = new Map<string, Set<(...args: any[]) => void>>()
    const emit = (name: string, ...args: any[]) => { for (const listener of listeners.get(name) ?? []) listener(...args) }
    const settings: HostSettingsService = {
      writable: true,
      register: (namespace, _schema, options) => {
        if (!documents.has(namespace)) documents.set(namespace, { value: structuredClone(options.base ?? {}) as Record<string, unknown>, revision: 0,
          ...(options.validate === undefined ? {} : { validate: options.validate as (value: never) => void }) })
        return { get: () => documents.get(namespace)!.value as never }
      },
      describe: () => [...documents].map(([ns, value]) => ({ ns, value: value.value, revision: value.revision, applies: 'live' as const })),
      mutate: vi.fn(async (namespace, operations, expectedRevision) => {
        const current = documents.get(namespace)!
        if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error('Settings changed concurrently')
        const next = structuredClone(current.value)
        for (const operation of operations) {
          if (operation.op !== 'set' || operation.path.length !== 1) throw new Error('Unexpected settings mutation')
          next[operation.path[0]!] = structuredClone(operation.value)
        }
        current.validate?.(next as never)
        current.value = next
        current.revision += 1
        emit('settings/updated', namespace, next)
      }),
      onUpdated: listener => {
        const entries = listeners.get('settings/updated') ?? new Set()
        entries.add(listener)
        listeners.set('settings/updated', entries)
        return () => { entries.delete(listener) }
      },
    }
    const ctx = {
      settings,
      get: (name: string) => name === 'loader' ? loader : undefined,
      on: (name: string, listener: (...args: any[]) => void) => {
        const entries = listeners.get(name) ?? new Set()
        entries.add(listener)
        listeners.set(name, entries)
        return () => { entries.delete(listener) }
      },
    } as unknown as HostContextShape
    return { root, directory, ctx, settings, documents, emit }
  }

  const registryManifest = (name = 'dsh-mnemon-strategy-focus') => ({
    name, version: '0.5.0-beta.4', description: 'A bounded test Strategy.',
    peerDependencies: { 'dsh-mnemon': '^0.5.0-beta.1' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  })

  it('reports the exact active Profile and keeps suggestions distinct from activation', async () => {
    const f = await profile()
    const manager = new MemoryPluginInstallation(f.ctx, { resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    expect(manager.environment()).toEqual({ supported: true, profileName: 'web', suggestions: [
      'dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture',
    ] })
  })

  it('discovers a compatible Source or Strategy only from an exact package name', async () => {
    const f = await profile()
    const fetchPackage = vi.fn(async (name: string, _tag: string) => registryManifest(name))
    const manager = new MemoryPluginInstallation(f.ctx, { currentVersion: '0.5.0-beta.1', fetchPackage,
      resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    await expect(manager.inspect('dsh-mnemon-strategy-focus')).resolves.toEqual({
      packageName: 'dsh-mnemon-strategy-focus', version: '0.5.0-beta.4', kind: 'strategy',
      description: 'A bounded test Strategy.', mnemonPeerRange: '^0.5.0-beta.1', installed: false,
    })
    expect(fetchPackage).toHaveBeenCalledWith('dsh-mnemon-strategy-focus', 'beta')
    await expect(manager.inspect('file:../plugin')).rejects.toThrow('exact dsh-mnemon')
  })

  it('rejects packages that cannot join the DSH bundle stack', async () => {
    const f = await profile()
    const manager = new MemoryPluginInstallation(f.ctx, { fetchPackage: async name => ({ ...registryManifest(name), dsh: undefined }),
      resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    await expect(manager.inspect('dsh-mnemon-source-notes')).rejects.toThrow('bundle patch')
  })

  it('installs an inspected exact version through the current DSH Profile and verifies registration', async () => {
    const f = await profile()
    const processRunner = vi.fn(async (command: string, args: readonly string[], options: ProcessOptions) => {
      const value = JSON.parse(await readFile(join(f.directory, 'package.json'), 'utf8')) as Record<string, any>
      value.dependencies['dsh-mnemon-strategy-focus'] = '0.5.0-beta.4'
      value.dsh.profile.bundles.push('dsh-mnemon-strategy-focus')
      await writeFile(join(f.directory, 'package.json'), JSON.stringify(value, null, 2))
      expect(command).toBe(process.execPath)
      expect(args).toEqual(['/opt/dsh/lib/bin.js', 'plugin', '--profile', 'web', 'add', 'dsh-mnemon-strategy-focus@0.5.0-beta.4', '--save-exact'])
      expect(options.env?.DSH_HOME).toBe(f.root)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const manager = new MemoryPluginInstallation(f.ctx, { currentVersion: '0.5.0-beta.1', fetchPackage: async name => registryManifest(name), processRunner,
      resolveDshCommand: () => ({ command: process.execPath, prefix: ['/opt/dsh/lib/bin.js'] }) })
    await expect(manager.install('dsh-mnemon-strategy-focus', '0.5.0-beta.4')).resolves.toEqual({
      packageName: 'dsh-mnemon-strategy-focus', version: '0.5.0-beta.4', profileName: 'web', installed: true, restartRequired: true,
    })
    expect(processRunner).toHaveBeenCalledOnce()
  })

  it('requires a Loader-owned Profile and rechecks the inspected version', async () => {
    const noLoader = { get: () => undefined } as unknown as HostContextShape
    expect(new MemoryPluginInstallation(noLoader).environment()).toMatchObject({ supported: false, reason: 'loader-unavailable' })
    const f = await profile()
    const manager = new MemoryPluginInstallation(f.ctx, { fetchPackage: async name => registryManifest(name), resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    await expect(manager.install('dsh-mnemon-strategy-focus', '0.5.0-beta.3')).rejects.toThrow('version changed')
  })
})

describe('profile generation imports against host-owned framework packages', () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const repoManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

  function generation() {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-generation-import-'))
    const profile = join(directory, 'profiles/web')
    const installed = join(directory, 'profiles/.generations/live/mnemon/node_modules')
    const packageRoot = join(installed, 'dsh-mnemon')
    mkdirSync(packageRoot, { recursive: true })
    cpSync(join(repoRoot, 'lib'), join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(repoManifest))

    const dependencies = { ...repoManifest.dependencies, ...repoManifest.peerDependencies }
    const hostModules = join(directory, 'profiles/node_modules')
    for (const name of Object.keys(dependencies)) {
      const target = join(name.startsWith('@deepseek-ai/') ? hostModules : installed, name)
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(join(repoRoot, 'node_modules', name), target, 'junction')
    }
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    symlinkSync(packageRoot, join(profile, 'node_modules/dsh-mnemon'), 'junction')
    return { directory, profile }
  }

  it('loads the complete built Starter with the host Cosmokit and live configuration', () => {
    const fixture = generation()
    try {
      const entry = join(fixture.profile, 'check.mjs')
      writeFileSync(entry, `
        import assert from 'node:assert/strict'
        import * as mnemon from 'dsh-mnemon'
        const config = mnemon.Config({ displayMode: 'builtin', remoteAccess: 'read-only' })
        assert.equal(typeof config.displayMode?.get, 'function')
        assert.equal(config.displayMode.get(), 'builtin')
        assert.equal(config.remoteAccess, 'read-only')
        assert.equal(typeof mnemon.apply, 'function')
        assert.equal(mnemon.name, 'dsh-mnemon')
        console.log(JSON.stringify({ loaded: true }))
      `)
      const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 20_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ loaded: true })
    } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
  })
})
