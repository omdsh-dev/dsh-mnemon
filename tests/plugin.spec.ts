import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../src/contracts.ts'
import { apply, inject } from '../src/index.ts'
import { MnemonSubagentCoordinator } from '../src/subagent.ts'
import { registerTools } from '../src/tools.ts'
import { memoryExtensions } from '../packages/extension-sdk/src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dsh: { client: { inject: string[]; platform: string } }
  devDependencies: Record<string, string>
  engines: { node: string }
  peerDependencies: Record<string, string>
}
const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')

const directories: string[] = []

afterEach(() => {
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
  const ctx = {
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
      return undefined
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
  return { ctx, tools, sections, contexts, variables, channels, registrations, commands, listeners, effectCleanups }
}

describe('dsh-mnemon plugin composition', () => {
  it('keeps the installed DSH prerelease family coherent', () => {
    const legacyProjection = '@deepseek-ai/dsh-session-projection-legacy'
    const directDshDependencies = Object.entries(manifest.devDependencies)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      .filter(([name]) => name !== legacyProjection)
    const lockedDshVersions = [...lockfile.matchAll(/(@deepseek-ai\/dsh(?:-[a-z0-9-]+)?)@(\d+\.\d+\.\d+-rc\.\d+)/g)]
      // Only this aliased regression fixture may use the older host contract.
      .filter(([, name, version]) => name !== '@deepseek-ai/dsh-session-projection' || version !== '0.1.0-rc.8')
      .map(match => match[2])

    expect(manifest.devDependencies[legacyProjection]).toBe('npm:@deepseek-ai/dsh-session-projection@0.1.0-rc.8')
    expect(directDshDependencies).toHaveLength(20)
    expect(new Set(directDshDependencies.map(([, version]) => version))).toEqual(new Set(['0.1.1-rc.2']))
    expect(manifest.engines.node).toBe('>=20')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-primitives']).toContain('^0.1.1-rc.1')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-primitives']).toContain('^0.1.2-alpha.1')
    expect(lockedDshVersions.length).toBeGreaterThan(100)
    expect(new Set(lockedDshVersions)).toEqual(new Set(['0.1.1-rc.1', '0.1.1-rc.2']))
  })

  it('keeps Web-only workspace and connection services out of its core dependencies', () => {
    expect(inject).toEqual(['tools', 'settings', 'commands', 'agents', 'subagents'])
  })

  it('mounts its complete Agent surface without Web-only Host services', () => {
    const fixture = context({ connection: false, workspaceRegistry: false })
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })

    expect(fixture.tools).toHaveLength(13)
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

  it('registers the full tool surface, guidance, and split RPC channels', () => {
    const fixture = context()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    expect(fixture.tools.map(tool => (tool as { name: string }).name)).toEqual([
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

  it('promotes all rc.2 management channels only through the startup compatibility setting', () => {
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
    expect(fixture.tools).toHaveLength(13)
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

  it('offers compact recent-document suggestions when a cross-language query has no exact match', async () => {
    const fixture = context()
    const workspace = dataDir()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    const tools = fixture.tools as Array<{
      name: string
      execute: (args: unknown, execution: unknown) => Promise<unknown>
    }>
    const agent = {
      id: 'document-worker',
      options: {},
      session: { header: { origin: 'subagent', cwd: workspace }, events: [] },
    }
    const execution = { agent, signal: new AbortController().signal }
    await tools.find(tool => tool.name === 'mnemon_document_manage')!.execute({
      action: 'create',
      title: 'Cold Archive Transaction Contract',
      description: 'Write-ahead archival ordering and recovery invariants.',
      content: 'Land the durable cold reference before moving the managed original.',
    }, execution)

    const result = await tools.find(tool => tool.name === 'mnemon_document_search')!.execute({
      query: '冷归档不变量',
    }, execution) as { total: number; results: unknown[]; suggestions: Array<{ title: string }>; suggestionHint: string }

    expect(result.total).toBe(0)
    expect(result.results).toEqual([])
    expect(result.suggestions).toEqual([expect.objectContaining({ title: 'Cold Archive Transaction Contract' })])
    expect(result.suggestionHint).toContain('mnemon_recall')
    expect(result.suggestionHint).toContain('rather than repeating Document search')
  })

  it('returns bounded query-local document evidence without managed-record internals', async () => {
    const fixture = context()
    const workspace = dataDir()
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    const tools = fixture.tools as Array<{
      name: string
      execute: (args: unknown, execution: unknown) => Promise<unknown>
    }>
    const agent = {
      id: 'document-boundary-worker',
      options: {},
      session: { header: { origin: 'subagent', cwd: workspace }, events: [] },
    }
    const execution = { agent, signal: new AbortController().signal }
    const needle = 'TENANT-SKEW-NEEDLE-729'
    await tools.find(tool => tool.name === 'mnemon_document_manage')!.execute({
      action: 'create',
      title: 'Long incident record',
      description: 'A deliberately long managed record.',
      sourcePaths: ['reports/incident.md'],
      content: `${'before '.repeat(1_500)}${needle}\n${'after '.repeat(1_500)}`,
    }, execution)

    const result = await tools.find(tool => tool.name === 'mnemon_document_search')!.execute({ query: needle }, execution) as {
      results: Array<Record<string, unknown> & { content: string }>
      hint: string
    }

    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.content).toContain(needle)
    expect(result.results[0]!.content.length).toBeLessThanOrEqual(2_600)
    expect(result.results[0]).not.toHaveProperty('contentHash')
    expect(result.results[0]).not.toHaveProperty('revision')
    expect(result).not.toHaveProperty('generatedAt')
    expect(JSON.stringify(result).length).toBeLessThan(8_000)
    expect(result.hint).toContain('do not repeat Document search')
  })

  it('does not repeat Documents I/O after a pinned root turn spends its search slot', async () => {
    const registered: ToolDefinition[] = []
    const controller = {
      search: vi.fn(async (query: string) => ({ query, includeArchived: false, total: 0, results: [] })),
      snapshot: vi.fn(() => ({ documents: [] })),
    }
    const documents = {
      forAgent: vi.fn(() => controller),
    }
    const memoryViews = {
      activeTurn: vi.fn().mockReturnValue({ turnId: 'root:documents', viewId: 'view-documents' }),
      sourceState: vi.fn(() => ({ memoryBodyIds: ['project'] })),
    }
    const runtime = {
      config: { memoryTopology: undefined },
      forAgent: vi.fn(() => ({
        service: { config: { memoryTopology: undefined } },
        runtimeMemory: {},
        documents,
        memoryViews,
      })),
    }
    const coordinator = new MnemonSubagentCoordinator(
      { list: () => [], getProvider: () => undefined, start: vi.fn() } as never,
      runtime as never,
    )
    registerTools({ tools: { register: (tool: ToolDefinition) => { registered.push(tool) } } } as never, runtime as never, coordinator)
    const tool = registered.find(candidate => candidate.name === 'mnemon_document_search')!
    const execution = { agent: { id: 'root', options: {}, session: { header: {}, events: [] } }, signal: new AbortController().signal }

    const first = await tool.execute({ query: 'ORCHID-47 root cause' } as never, execution as never)
    expect(first).not.toHaveProperty('notRun')
    await expect(tool.execute({ query: 'incident ORCHID generation key' } as never, execution as never)).resolves.toMatchObject({ notRun: true, results: [] })
    expect(controller.search).toHaveBeenCalledOnce()
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
    const packRegistration = fixture.channels.find(channel => (channel as unknown[])[0] === '/dsh-mnemon-pack') as [string, (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: { root: string } }>]
    const coreRegistration = fixture.registrations.find(registration => (registration as unknown[])[0] === 'mnemon') as [string, unknown, { validate: (value: object) => void }]

    expect(() => coreRegistration[2].validate({ cliPath: '/fake/mnemon', storageScope: 'custom', dataDir: invalidRoot })).toThrow()
    await expect(packRegistration[1]('target', {})).resolves.toMatchObject({ ok: true, value: { root: initialRoot } })
  })

  it('retires uncommitted settings candidates and disposes the active runtime with the Cordis effect', async () => {
    const fixture = context()
    const targets = (memoryExtensions as unknown as { targets: Set<unknown> }).targets
    const baseline = targets.size
    apply(fixture.ctx as never, { cliPath: '/fake/mnemon', dataDir: dataDir() })
    expect(targets.size).toBe(baseline + 1)

    const coreRegistration = fixture.registrations.find(registration => (registration as unknown[])[0] === 'mnemon') as [string, unknown, { validate: (value: object) => void }]
    coreRegistration[2].validate({ cliPath: '/fake/mnemon', dataDir: dataDir() })
    expect(targets.size).toBe(baseline + 2)
    await Promise.resolve()
    expect(targets.size).toBe(baseline + 1)

    for (const cleanup of fixture.effectCleanups.splice(0).reverse()) cleanup()
    expect(targets.size).toBe(baseline)
  })
})
