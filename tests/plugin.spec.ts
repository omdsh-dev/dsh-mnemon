import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition, HostAgent } from "../src/host/dsh.ts"
import { apply, inject } from '../src/index.ts'
import { MnemonSubagentCoordinator } from "../src/host/subagent.ts"
import { registerTools } from "../src/host/tools.ts"
import { MemoryRuntime } from '../src/core/runtime.ts'
import type { MnemonMemoryService } from 'dsh-mnemon/extension-sdk'
import { compositionFixture } from './fixtures/composition.ts'
import { agentScope } from '../src/host/runtime.ts'
import type { MemoryEvidence } from 'dsh-mnemon/contracts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dsh: { client: { inject: string[]; platform: string } }
  devDependencies: Record<string, string>
  engines: { node: string }
  peerDependencies: Record<string, string>
}
const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
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
  const channels: unknown[] = []
  const connection = {
    rpc: {
      handle: vi.fn((...args: unknown[]) => { channels.push(args) }),
    },
  }
  const registrations: unknown[] = []
  const commands: unknown[] = []
  const listeners: unknown[] = []
  const effectCleanups: Array<() => unknown> = []
  const services = new Map<string, unknown>()
  const ctx = {
    provide: vi.fn((name: string, value: unknown) => { services.set(name, value) }),
    tools: { register: vi.fn((tool: unknown) => { tools.push(tool) }) },
    commands: { register: vi.fn((command: unknown) => { commands.push(command) }) },
    settings: {
      register: vi.fn((...args: unknown[]) => {
        registrations.push(args)
        return { get: () => (args[2] as { base?: object } | undefined)?.base ?? {} }
      }),
    },
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
  return { ctx, tools, sections, contexts, variables, channels, registrations, commands, listeners, effectCleanups }
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
  it('keeps the installed DSH prerelease family coherent', () => {
    const legacyProjection = '@deepseek-ai/dsh-session-projection-legacy'
    const directDshDependencies = Object.entries(manifest.devDependencies)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      .filter(([name]) => name !== legacyProjection)
    const lockedDshVersions = [...lockfile.matchAll(/(@deepseek-ai\/dsh(?:-[a-z0-9-]+)?)@(\d+\.\d+\.\d+-(?:alpha|rc)\.\d+)/g)]
      // Only this aliased regression fixture may use the older host contract.
      .filter(([, name, version]) => name !== '@deepseek-ai/dsh-session-projection' || version !== '0.1.0-rc.8')
      .map(match => match[2])
    const lockedRcReleases = [...lockfile.matchAll(/^  '(@deepseek-ai\/dsh(?:-[a-z0-9-]+)?)@(0\.1\.2-rc\.1)':$/gm)]
      .map(([, name, version]) => `${name}@${version}`)
    const releaseAgeExclusions = [...workspaceConfig.matchAll(/^  - '(@deepseek-ai\/dsh(?:-[a-z0-9-]+)?@0\.1\.2-rc\.1)'$/gm)]
      .map(match => match[1])

    expect(directDshDependencies.length).toBeGreaterThanOrEqual(10)
    expect(new Set(directDshDependencies.map(([, version]) => version))).toEqual(new Set(['0.1.1-rc.2']))
    expect(manifest.engines.node).toBe('>=20')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-primitives']).toContain('^0.1.1-rc.1')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-primitives']).toContain('^0.1.2-alpha.1')
    expect(lockedDshVersions.length).toBeGreaterThan(100)
    // A fresh workspace resolution may deduplicate rc.1 to the pinned rc.2.
    // Require the supported family, not the presence of an obsolete copy.
    expect(lockedDshVersions).toContain('0.1.1-rc.2')
    expect(lockedDshVersions.every(version => version === '0.1.1-rc.1' || version === '0.1.1-rc.2')).toBe(true)
  })

  it('keeps Web-only workspace and connection services out of its core dependencies', () => {
    expect(inject).toEqual(['tools', 'settings', 'commands', 'agents', 'subagents'])
  })

  it('mounts its complete Agent surface without Web-only Host services', () => {
    const fixture = context({ connection: false, workspaceRegistry: false })
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })

    expect(fixture.tools).toHaveLength(15)
    expect(fixture.sections).toEqual([expect.objectContaining({ name: 'mnemon:routing' })])
    expect(fixture.contexts).toEqual([])
    expect(fixture.variables).toHaveLength(1)
    expect(fixture.commands).toEqual([expect.objectContaining({ name: 'mnemon' })])
    expect(fixture.channels).toEqual([])
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
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-settings',
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

  it('registers the full tool surface, guidance, and split RPC channels', () => {
    const fixture = context()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    expect(fixture.tools.map(tool => (tool as { name: string }).name)).toEqual([
      'mnemon_view_route',
      'mnemon_view_action',
      'mnemon_memory_bodies',
      'mnemon_recall',
      'mnemon_related',
      'mnemon_status',
      'mnemon_document_search',
      'mnemon_document_manage',
      'mnemon_runtime_memory',
      'mnemon_remember',
      'mnemon_link',
      'mnemon_forget',
      'mnemon_memory_body_create',
      'mnemon_memory_body_update',
      'mnemon_memory_body_merge',
    ])
    expect(fixture.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: expect.objectContaining({ schema: { type: 'object', additionalProperties: true } }) }),
    ]))
    expect(fixture.tools.every(tool => (tool as { output: { schema: { type: string } } }).output.schema.type !== 'json')).toBe(true)
    const recallTool = fixture.tools.find(tool => (tool as { name: string }).name === 'mnemon_recall') as { description: string }
    expect(recallTool.description).toContain('one initial query plus one LLM-chosen different-query refinement')
    expect(recallTool.description).toContain('only when the current question needs history')
    expect(fixture.sections).toEqual([expect.objectContaining({ name: 'mnemon:routing' })])
    expect(fixture.contexts).toEqual([])
    expect(fixture.variables).toHaveLength(1)
    const guidance = (fixture.sections[0] as { text: () => string }).text()
    expect(guidance).toContain('Call mnemon_recall')
    expect(guidance).toContain('never infer a missing historical rule')
    expect(guidance.length).toBeLessThan(360)
    expect(guidance).not.toContain('RECALL RESULT')
    expect(fixture.commands).toEqual([expect.objectContaining({ name: 'mnemon' })])
    expect(fixture.channels).toHaveLength(5)
    expect(fixture.channels).toEqual(expect.arrayContaining([
      ['/dsh-mnemon-activation', expect.anything(), { authority: 'trusted-host' }],
      ['/dsh-mnemon-pack', expect.anything(), { authority: 'loopback' }],
    ]))
    expect(fixture.registrations).toEqual([
      expect.arrayContaining(['mnemon', expect.anything(), expect.objectContaining({ applies: 'live' })]),
      expect.arrayContaining(['mnemon-ui', expect.anything(), expect.objectContaining({ applies: 'live', base: { turnBar: true, saveAction: true } })]),
    ])
  })

  it('preserves rc.2 channel authorities with one call shape accepted by the authenticated alpha API', () => {
    const fixture = context()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    for (const channel of ['/dsh-mnemon-write', '/dsh-mnemon-settings', '/dsh-mnemon-pack']) {
      expect(fixture.channels).toEqual(expect.arrayContaining([
        [channel, expect.anything(), { authority: 'loopback' }],
      ]))
    }
    expect(fixture.channels).toEqual(expect.arrayContaining([
      ['/dsh-mnemon-read', expect.anything(), { authority: 'trusted-host' }],
    ]))
  })

  it('promotes management channels only through the explicit startup setting', () => {
    const fixture = context()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir(), remoteAccess: 'trusted-host' })
    for (const channel of ['/dsh-mnemon-write', '/dsh-mnemon-settings', '/dsh-mnemon-pack']) {
      expect(fixture.channels).toEqual(expect.arrayContaining([
        [channel, expect.anything(), { authority: 'trusted-host' }],
      ]))
    }
  })

  it('keeps stable live surfaces while fencing every mutation in read-only mode', async () => {
    const fixture = context()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir(), writeEnabled: false })
    expect(fixture.tools).toHaveLength(15)
    const runtimeTool = fixture.tools.find(tool => (tool as { name: string }).name === 'mnemon_runtime_memory') as {
      execute: (args: unknown, execution: unknown) => Promise<unknown>
    }
    expect(() => runtimeTool.execute({ action: 'add', target: 'memory', content: 'blocked' }, { signal: new AbortController().signal })).toThrow('read-only')
    expect(fixture.channels).toHaveLength(5)
    expect(fixture.channels).toEqual(expect.arrayContaining([
      ['/dsh-mnemon-activation', expect.anything(), { authority: 'trusted-host' }],
      ['/dsh-mnemon-pack', expect.anything(), { authority: 'loopback' }],
    ]))
    expect(fixture.contexts).toEqual([])
  })

  it('offers bounded Source-owned suggestions when a cross-language query has no exact match', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    await f.graph.source('documents').mutate('mutate', {
      action: 'create', title: 'Cold Archive Transaction Contract', description: 'Write-ahead archival ordering and recovery invariants.',
      content: 'Land the durable cold reference before moving the managed original.',
    })
    const root = { id: 'root', session: { header: { cwd: f.workspace }, events: [] } } as unknown as HostAgent
    await f.graph.composableTurns.beginTurn('root:documents', agentScope(root, f.config), 'test')
    const tools: ToolDefinition[] = []
    const coordinator = new MnemonSubagentCoordinator({ list: () => [], getProvider: () => undefined, start: vi.fn() } as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.push(tool) } } } as never, f.live, coordinator)
    const result = await tools.find(tool => tool.name === 'mnemon_document_search')!.execute({ query: '冷归档不变量' } as never, { agent: root, signal: new AbortController().signal }) as MemoryEvidence
    expect(result.items).toEqual([expect.objectContaining({
      text: expect.stringContaining('No exact match. Recent Document suggestion only'),
      provenance: expect.objectContaining({ kind: 'suggestion', title: 'Cold Archive Transaction Contract' }),
    })])
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
    const root = { id: 'root', session: { header: { cwd: f.workspace }, events: [] } } as unknown as HostAgent
    await f.graph.composableTurns.beginTurn('root:documents', agentScope(root, f.config), 'test')
    const tools: ToolDefinition[] = []
    const coordinator = new MnemonSubagentCoordinator({ list: () => [], getProvider: () => undefined, start: vi.fn() } as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.push(tool) } } } as never, f.live, coordinator)
    const result = await tools.find(tool => tool.name === 'mnemon_document_search')!.execute({ query: needle } as never, { agent: root, signal: new AbortController().signal }) as MemoryEvidence
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.text).toContain(needle)
    expect(result.items[0]!.text.length).toBeLessThanOrEqual(2_600)
    expect(JSON.stringify(result)).not.toMatch(/contentHash|generatedAt|indexPath|directory/)
    expect(JSON.stringify(result).length).toBeLessThan(8_000)
    f.graph.composableTurns.endTurn('root:documents')
  })

  it('shares one Documents route claim across the pinned root turn', async () => {
    const f = await compositionFixture()
    releases.push(f.dispose)
    const root = { id: 'root', session: { header: { cwd: f.workspace }, events: [] } } as unknown as HostAgent
    await f.graph.composableTurns.beginTurn('root:documents', agentScope(root, f.config), 'test')
    const execute = vi.spyOn(f.graph.memoryComposition.current()!, 'executeRoute')
    const tools: ToolDefinition[] = []
    const coordinator = new MnemonSubagentCoordinator({ list: () => [], getProvider: () => undefined, start: vi.fn() } as never, f.live)
    registerTools({ tools: { register: (tool: ToolDefinition) => { tools.push(tool) } } } as never, f.live, coordinator)
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
    expect(fixture.channels).toHaveLength(5)
  })

  it('atomically switches the same live RPC faces after settings validation', async () => {
    const fixture = context()
    const initialRoot = dataDir()
    const nextRoot = dataDir()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', storageScope: 'custom', dataDir: initialRoot })
    const packRegistration = fixture.channels.find(channel => (channel as unknown[])[0] === '/dsh-mnemon-pack') as [string, (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: { root: string } }>]
    await expect(packRegistration[1]('target', {})).resolves.toMatchObject({ ok: true, value: { root: initialRoot } })

    const coreRegistration = fixture.registrations.find(registration => (registration as unknown[])[0] === 'mnemon') as [string, unknown, { validate: (value: object) => void }]
    const next = { cliPath: '/fake/mnemon', storageScope: 'custom' as const, dataDir: nextRoot }
    coreRegistration[2].validate(next)
    const settingsUpdated = fixture.listeners.find(listener => (listener as unknown[])[0] === 'settings/updated') as [string, (namespace: string, value: object) => void]
    settingsUpdated[1]('mnemon', next)

    await expect(packRegistration[1]('target', {})).resolves.toMatchObject({ ok: true, value: { root: nextRoot } })
  })

  it('rejects an uninitializable live root before the active graph can move', async () => {
    const fixture = context()
    const initialRoot = dataDir()
    const invalidRoot = join(dataDir(), 'not-a-directory')
    writeFileSync(invalidRoot, 'occupied')
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', storageScope: 'custom', dataDir: initialRoot })
    await installStarter(fixture)
    const packRegistration = fixture.channels.find(channel => (channel as unknown[])[0] === '/dsh-mnemon-pack') as [string, (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: { root: string } }>]
    const coreRegistration = fixture.registrations.find(registration => (registration as unknown[])[0] === 'mnemon') as [string, unknown, { validate: (value: object) => void }]

    expect(() => coreRegistration[2].validate({ cliPath: '/fake/mnemon', storageScope: 'custom', dataDir: invalidRoot })).toThrow()
    await expect(packRegistration[1]('target', {})).resolves.toMatchObject({ ok: true, value: { root: initialRoot } })
  })

  it('retires uncommitted candidates and closes every graph with the Cordis effect', async () => {
    const fixture = context()
    const attach = vi.spyOn(MemoryRuntime.prototype, 'attachGeneration')
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    expect(attach).toHaveBeenCalledOnce()
    const active = attach.mock.results[0]!.value as ReturnType<MemoryRuntime['attachGeneration']>
    const coreRegistration = fixture.registrations.find(registration => (registration as unknown[])[0] === 'mnemon') as [string, unknown, { validate: (value: object) => void }]
    coreRegistration[2].validate({ cliPath: '/fake/mnemon', dataDir: dataDir() })
    expect(attach).toHaveBeenCalledTimes(2)
    const candidate = attach.mock.results[1]!.value as ReturnType<MemoryRuntime['attachGeneration']>
    await Promise.resolve()
    expect(() => candidate.host.acquire()).toThrow('disposed')
    for (const cleanup of fixture.effectCleanups.splice(0).reverse()) await cleanup()
    expect(() => active.host.acquire()).toThrow('disposed')
    expect(() => (fixture.ctx.get('mnemonMemory') as MnemonMemoryService).installContributions({}, { instanceId: 'closed' })).toThrow('disposed')
  })
})
