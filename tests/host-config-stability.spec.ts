import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { COMPOSABLE_MEMORY_API_VERSION } from '../src/core/contracts/index.ts'
import { defineMemorySource, defineMemoryStrategy, evaluateMemoryComposition } from '../src/core/index.ts'
import { asPlainObject, isPlainObject } from '../src/core/json.ts'
import { MemoryRuntime } from '../src/core/runtime.ts'
import {
  defineMemoryStrategyConfiguration,
  memoryStrategyConfigurationValues,
} from '../src/sdk/strategy-configuration.ts'
import {
  Config,
  createStorageRoot,
  DEFAULT_SKILLS_CONFIG,
  expandUserPath,
  ProfileMnemonSettings,
  resolveConfig,
  validateCustomDataDir,
  validateRuntimeComposition,
  withMainStrategy,
} from '../src/host/config/index.ts'
import { migrateLegacyDisplayMode } from '../src/host/settings.ts'
import { preferences as parseViewPreferences } from '../src/host/view-preferences.ts'
import { MnemonPackManager } from '../src/host/pack.ts'
import { MnemonGitSync } from '../src/host/git-sync.ts'
import { StorageScopeInspector } from '../src/host/storage-scope.ts'
import { createTunnelFetch } from '../src/host/github-transport.ts'
import { SkillEvolution } from '../src/host/skill-evolution.ts'
import { LiveMnemonRuntime, createRuntimeGraph } from '../src/host/runtime.ts'
import { assertDshOutputSchema, assertDshOutputValue } from '../src/host/subagent-output-schema.ts'
import { fetchNpmLatest } from '../src/host/version-updates.ts'
import { MemoryPluginInstallation } from '../src/host/plugin-installation.ts'
import type { HostAgent, HostContextShape } from '../src/host/dsh.ts'
import { cleanupLifecycleDirectories, fixture as lifecycleFixture, userMessage } from './fixtures/lifecycle.ts'

function fixtureSource(instance = 'fixture-source') {
  const definition = defineMemorySource({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION,
      kind: 'source',
      typeId: instance,
      packageName: `dsh-mnemon-source-${instance}`,
      role: 'fixture',
      capabilities: ['project'],
      consistency: 'exact-snapshot',
    },
    create: context => ({
      facts: () => ({
        sourceInstanceKey: context.sourceInstanceKey,
        sourceTypeId: instance,
        role: 'fixture',
        availability: 'ready' as const,
        revision: 'r1',
        capabilities: ['project' as const],
        routeIds: [],
        actionIds: [],
      }),
      project: () => ({ fragments: [] }),
    }),
  })
  return {
    kind: 'source' as const,
    instanceKey: `source:${instance}`,
    provenance: { packageName: definition.manifest.packageName, entryId: instance },
    definition,
  }
}

function fixtureStrategy(instance = 'default-three-tier') {
  const definition = defineMemoryStrategy({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION,
      kind: 'strategy',
      typeId: instance,
      packageName: `dsh-mnemon-strategy-${instance}`,
      deterministic: true,
      supportedSourceRoles: ['fixture'],
      maxSources: 10,
      maxRoutes: 10,
      maxActions: 10,
    },
    compose: () => ({ strategyTypeId: instance, sources: [], explanation: 'Fixture.' }),
  })
  return {
    kind: 'strategy' as const,
    instanceKey: `strategy:${instance}`,
    provenance: { packageName: definition.manifest.packageName, entryId: instance },
    definition,
  }
}

afterAll(cleanupLifecycleDirectories)

describe('Host, Core, SDK and configuration stability fixes', () => {
  const directories: string[] = []
  const roots: Context[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0).reverse()) await root.fiber.dispose()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function tempDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `mnemon-stability-${label}-`))
    directories.push(dir)
    return dir
  }

  it('Bug #4: yields to the event loop instead of blocking with Atomics.wait during pack lock contention', async () => {
    const rootDir = tempDir('pack-lock')
    mkdirSync(join(rootDir, 'runtime'), { recursive: true })
    writeFileSync(join(rootDir, 'runtime', 'memories.json'), `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`)
    const config = resolveConfig({ dataDir: rootDir, storageScope: 'custom' })
    const storageRoot = createStorageRoot(config)
    const manager = new MnemonPackManager(storageRoot, config)

    // Pre-create a non-stale lock file and remove it asynchronously on a timer.
    const lockPath = join(rootDir, '.dsh-pack.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))

    let timerFiredWhileWaiting = false
    const releaseTimer = setTimeout(() => {
      timerFiredWhileWaiting = true
      rmSync(lockPath, { force: true })
    }, 35)

    try {
      const exported = await manager.exportPack('runtime')
      expect(timerFiredWhileWaiting).toBe(true)
      expect(exported.manifest.components).toEqual(['runtime'])
    } finally {
      clearTimeout(releaseTimer)
      rmSync(lockPath, { force: true })
    }
  })

  it('Bug #5: dry-run validateRuntimeComposition performs zero disk I/O and onUpdated triggers displayMode migration', async () => {
    const missingDataDir = join(tempDir('dry-run-parent'), 'never-created-root')
    const runtime = new MemoryRuntime()
    runtime.installContributions({
      sources: [fixtureSource()],
      strategies: [fixtureStrategy('default-three-tier'), fixtureStrategy('alternate-strategy')],
    })
    const validConfig = resolveConfig({ dataDir: missingDataDir, storageScope: 'custom' })
    expect(() => validateRuntimeComposition(validConfig, runtime)).not.toThrow()
    expect(existsSync(missingDataDir)).toBe(false)

    // Unknown main strategy in committed contributions fails dry-run validation without creating directories.
    const invalidConfig = withMainStrategy(validConfig, { strategyTypeId: 'non-existent-strategy' })
    expect(() => validateRuntimeComposition(invalidConfig, runtime)).toThrow('non-existent-strategy')
    expect(existsSync(missingDataDir)).toBe(false)
    await runtime.dispose()

    // Live commit via ProfileMnemonSettings.onUpdated triggers migrateLegacyDisplayMode('buildin' -> 'builtin').
    const cordisRoot = new Context()
    roots.push(cordisRoot)
    let storedConfig: Record<string, unknown> = { displayMode: 'buildin' }
    let revision = 1
    const forms = {
      writable: true,
      configure: vi.fn(() => vi.fn()),
      describe: vi.fn(() => [{
        ns: 'mnemon-instance',
        revision,
        applies: 'live' as const,
        value: storedConfig,
        base: {},
        user: storedConfig,
      }]),
      mutate: vi.fn(async (_ns: string, ops: Array<{ op: string; path: readonly string[]; value?: unknown }>) => {
        for (const op of ops) {
          if (op.op === 'set' && op.path[0] === 'displayMode') {
            storedConfig = { ...storedConfig, displayMode: op.value }
          }
        }
        revision += 1
      }),
    }
    const entry = { id: 'include:mnemon-instance', options: { id: 'mnemon-instance', config: storedConfig } }
    cordisRoot.provide('settings', forms)
    cordisRoot.provide('configEditor', { entries: () => [entry] })

    let settings!: ProfileMnemonSettings
    let childCtx!: Context
    const fiber = await cordisRoot.plugin({
      inject: ['settings'],
      apply(ctx: Context, _config: Record<string, unknown>) {
        childCtx = ctx
        ;(ctx.fiber as unknown as { entry?: typeof entry }).entry = entry
        settings = new ProfileMnemonSettings(ctx as unknown as HostContextShape, storedConfig)
        settings.register('mnemon', Config, { base: {}, applies: 'live' })
        settings.onUpdated(namespace => {
          if (namespace === 'mnemon') void migrateLegacyDisplayMode(settings)
        })
      },
    }, storedConfig)

    fiber.config = { displayMode: createVolatile('buildin') }
    const scope = Object.create(childCtx) as Context & { [Context.filter]: (owner: Context) => boolean }
    scope[Context.filter] = (owner: Context) => owner.fiber === fiber
    cordisRoot.events.emit(scope, 'loader/volatile-update', [['displayMode']])

    await vi.waitFor(() => {
      expect(forms.mutate).toHaveBeenCalledWith(
        'mnemon-instance',
        [{ op: 'set', path: ['displayMode'], value: 'builtin' }],
        1,
      )
    })
    expect(storedConfig.displayMode).toBe('builtin')
  })

  it('Bug #6: serializes concurrent MnemonGitSync.configure updates under lock and guards showUtf8 against binary paths', async () => {
    const emptyRoot = join(tempDir('git-sync-invalid'), 'uncreated')
    const invalidConfig = resolveConfig({ dataDir: emptyRoot, storageScope: 'custom' })
    const invalidRunner = createStorageRoot(invalidConfig)
    const invalidSync = new MnemonGitSync(invalidRunner, invalidConfig, new MnemonPackManager(invalidRunner, invalidConfig))
    await expect(invalidSync.configure({ branch: 'bad..branch' })).rejects.toThrow()
    expect(existsSync(emptyRoot)).toBe(false)

    const rootDir = tempDir('git-sync')
    const config = resolveConfig({ dataDir: rootDir, storageScope: 'custom' })
    const runner = createStorageRoot(config)
    const sync = new MnemonGitSync(runner, config, new MnemonPackManager(runner, config))

    await Promise.all([
      sync.configure({ branch: 'backup-main' }),
      sync.configure({ subdir: 'team-memory' }),
      sync.configure({ authorName: 'Coordinator Bot' }),
    ])
    const saved = sync.settings().read()
    expect(saved).toMatchObject({
      branch: 'backup-main',
      subdir: 'team-memory/',
      authorName: 'Coordinator Bot',
    })

    const showUtf8 = (sync as unknown as {
      showUtf8(commit: string, path: string): Promise<Uint8Array | undefined>
    }).showUtf8.bind(sync)
    await expect(showUtf8('HEAD', 'mnemon/payload/memory-spaces/default/mnemon.db')).rejects.toThrow(
      'binary git object reads are unsupported through UTF-8 git show',
    )
  })

  it('Bug #7: skips symlinks in StorageScopeInspector, marks nested state dirs ready, and accepts Windows ~\\ paths', () => {
    expect(expandUserPath('~\\mnemon-custom', '/Users/alice')).toBe(join('/Users/alice', 'mnemon-custom'))
    expect(validateCustomDataDir('~\\mnemon-custom')).toBe('~\\mnemon-custom')

    const rootDir = tempDir('storage-scope')
    mkdirSync(join(rootDir, 'runtime'), { recursive: true })
    const content = `${JSON.stringify({
      version: 1,
      entries: [{
        content: 'Keep builds deterministic',
        target: 'memory',
        importance: 'normal',
        created_at: '2026-08-14T12:00:00.000Z',
        updated_at: '2026-08-14T12:00:00.000Z',
      }],
    }, null, 2)}\n`
    writeFileSync(join(rootDir, 'runtime', 'memories.json'), content)
    writeFileSync(join(rootDir, 'runtime', 'USER.md'), '')
    writeFileSync(join(rootDir, 'runtime', 'MEMORY.md'), 'Keep builds deterministic\n')
    // Create a self-referential symlink cycle inside runtime/
    symlinkSync(rootDir, join(rootDir, 'runtime', 'cycle-link'))

    // Create state/ containing ONLY a subdirectory (idle-review watermark) and no direct top-level files.
    mkdirSync(join(rootDir, 'state', 'idle-review'), { recursive: true })
    writeFileSync(join(rootDir, 'state', 'idle-review', 'session.json'), '{"attempts":1}\n')

    const config = resolveConfig({ dataDir: rootDir, storageScope: 'custom' })
    const inspector = new StorageScopeInspector(createStorageRoot(config), config)
    const catalog = inspector.catalog()
    const customScope = catalog.scopes.find(scope => scope.kind === 'custom')!
    const runtimeArea = customScope.areas.find(area => area.kind === 'runtime')!
    const stateArea = customScope.areas.find(area => area.kind === 'state')!

    expect(runtimeArea.status).toBe('ready')
    expect(runtimeArea.bytes).toBeGreaterThan(0)
    expect(stateArea.status).toBe('ready')
    expect(stateArea.bytes).toBeGreaterThan(0)
  })

  it('Bug #8: enforces TLS handshake timeout and AbortSignal cancellation on CONNECT proxy tunnels', async () => {
    const sockets = new Set<import('node:net').Socket>()
    const stalledProxy = createTcpServer(socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', () => {
        // Reply 200 Connection Established, then stall TLS handshake indefinitely.
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      })
    })
    await new Promise<void>(resolveReady => stalledProxy.listen(0, '127.0.0.1', resolveReady))
    const port = (stalledProxy.address() as AddressInfo).port

    try {
      const tunnelFetch = createTunnelFetch({ url: `http://127.0.0.1:${port}`, source: 'environment' }, 90)
      await expect(tunnelFetch('https://api.github.com/user')).rejects.toThrow(/TLS handshake through the proxy did not finish within 90ms/u)
      await vi.waitFor(() => expect(sockets.size).toBe(0))

      const abortTunnel = createTunnelFetch({ url: `http://127.0.0.1:${port}`, source: 'environment' }, 5_000)
      const controller = new AbortController()
      const pending = abortTunnel('https://api.github.com/user', { signal: controller.signal })
      setTimeout(() => controller.abort(Object.assign(new Error('Caller aborted'), { name: 'AbortError' })), 30)
      await expect(pending).rejects.toThrow()
      await vi.waitFor(() => expect(sockets.size).toBe(0))
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolveClosed => stalledProxy.close(() => resolveClosed()))
    }
  })

  it('Bug #9: excludes noMaintenance turns from reviewActivity and bounds per-turn lifecycle maps at 128', async () => {
    const f = lifecycleFixture()
    try {
      await f.preStep([userMessage('Please do not save memory for this scratch turn.')], 1)
      await f.turnStopping(1)
      const afterNoMaint = f.lifecycle.snapshot('session-1').current!
      expect(afterNoMaint.reviewActivity).toMatchObject({
        turnCount: 0,
        totalUserTextLength: 0,
      })

      for (let turn = 2; turn <= 140; turn += 1) {
        await f.preStep([userMessage(`Regular turn ${turn}`)], turn)
        const assistantEvent = {
          type: 'assistant/message',
          data: {
            turn,
            message: { content: [{ type: 'text', text: `Assistant reply ${turn}` }] },
          },
        }
        f.events.push(assistantEvent)
        f.agentListeners.get('session/event')?.(f.agent.session, assistantEvent)
        await f.turnStopping(turn)
      }

      const capped = f.lifecycle.snapshot('session-1').current!
      expect(capped.reviewActivity.turnCount).toBeLessThanOrEqual(128)
    } finally {
      f.stop()
    }
  })

  it('Bug #10: resets suggestion-status to pending even when reading suggestions throws, and awaits active jobs on dispose()', async () => {
    const mutations: Array<{ op: string; input: unknown }> = []
    let failSuggestionsRead = false

    const skillsForError = new SkillEvolution({
      settings: () => ({ ...DEFAULT_SKILLS_CONFIG, autoBacktest: false }),
      source: () => undefined,
      runTask: async (_ws, _signal, fn) => fn({} as HostAgent),
      skillTask: async () => { throw new Error('Model draft failure') },
    })

    const port = {
      read: vi.fn(async (operation: string) => {
        if (operation === 'evidence-pack') {
          return {
            action: 'update',
            skillName: 'demo-skill',
            suggestion: { id: 'sug-1', status: 'pending', summary: 'Improve demo skill', signals: [], confidence: 0.9 },
            skill: { key: 'user-dsh:demo-skill', root: 'user-dsh', path: '/tmp/SKILL.md', content: '# Demo\n', hash: 'abc', readOnly: false },
            excerpts: [],
            cases: [],
            catalog: [],
          }
        }
        if (operation === 'drafts') return []
        if (operation === 'suggestions' && failSuggestionsRead) throw new Error('Transient SQLite busy')
        return []
      }),
      mutate: vi.fn(async (op: string, input: unknown) => {
        mutations.push({ op, input })
        return {}
      }),
    }

    failSuggestionsRead = true
    await skillsForError.draft(port as never, undefined, { suggestionId: 'sug-1' })
    await vi.waitFor(() => {
      expect(mutations).toContainEqual(expect.objectContaining({
        op: 'suggestion-status',
        input: expect.objectContaining({ id: 'sug-1', status: 'pending' }),
      }))
    })
    await skillsForError.dispose()

    // Part 2: dispose() awaits in-flight background job settlement before resolving.
    let jobSettled = false
    let markStarted!: () => void
    const started = new Promise<void>(resolveStarted => { markStarted = resolveStarted })
    const slowPort = {
      ...port,
      mutate: vi.fn(async (op: string, input: unknown) => {
        if (op === 'suggestion-status' && (input as { status?: string }).status === 'pending') {
          await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 35))
          jobSettled = true
        }
        return {}
      }),
    }
    const skillsForDispose = new SkillEvolution({
      settings: () => ({ ...DEFAULT_SKILLS_CONFIG, autoBacktest: false }),
      source: () => undefined,
      runTask: async (_ws, signal) => {
        markStarted()
        await new Promise<void>((_, rejectAbort) => {
          signal.addEventListener('abort', () => rejectAbort(signal.reason ?? new Error('aborted')), { once: true })
        })
        throw new Error('aborted')
      },
      skillTask: async () => ({ structured: {} }),
    })

    failSuggestionsRead = false
    await skillsForDispose.draft(slowPort as never, undefined, { suggestionId: 'sug-1' })
    await started
    await skillsForDispose.dispose()
    expect(jobSettled).toBe(true)
  })

  it('Bug #11: rejects Date, Map, and Set in isPlainObject, memoryStrategyConfigurationValues, and view-preferences', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
    expect(isPlainObject(new Set())).toBe(false)
    expect(() => asPlainObject(new Date())).toThrow('value must be an object')

    const descriptor = defineMemoryStrategyConfiguration({
      kind: 'strategy',
      typeId: 'demo-strategy',
      label: { en: 'Demo', 'zh-CN': '演示' },
      description: { en: 'Demo descriptor', 'zh-CN': '演示配置' },
      fields: [{ key: 'limit', input: 'number', label: { en: 'Limit', 'zh-CN': '上限' }, minimum: 1, maximum: 100 }],
      create: () => ({}),
    })
    for (const nonPlain of [new Date(), new Map(), new Set()]) {
      expect(() => memoryStrategyConfigurationValues(descriptor, nonPlain)).toThrow('Plugin configuration must be an object')
      expect(() => parseViewPreferences({ entries: nonPlain } as never)).toThrow()
      expect(() => parseViewPreferences({ entries: { demo: { enabled: true, config: nonPlain } } } as never)).toThrow()
    }
  })

  it('Bug #12: skips disposed generation hosts in batch() and isolates listener exceptions in Core and Host runtimes', async () => {
    const coreRuntime = new MemoryRuntime()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const healthyHost = coreRuntime.attachGeneration({})
    const disposedHost = coreRuntime.attachGeneration({})

    const secondCommittedListener = vi.fn()
    coreRuntime.onCommittedContributionsChanged(() => { throw new Error('First committed listener boom') })
    coreRuntime.onCommittedContributionsChanged(secondCommittedListener)

    const secondRegistryListener = vi.fn()
    coreRuntime.onContributionsChanged(() => { throw new Error('First registry listener boom') })
    coreRuntime.onContributionsChanged(secondRegistryListener)

    await coreRuntime.batch(async () => {
      coreRuntime.installContributions({
        sources: [fixtureSource()],
        strategies: [fixtureStrategy()],
      })
      await disposedHost.dispose()
    })

    expect(secondCommittedListener).toHaveBeenCalledTimes(1)
    expect(secondRegistryListener).toHaveBeenCalledTimes(1)
    await healthyHost.dispose()
    await coreRuntime.dispose()

    // Also verify LiveMnemonRuntime.swap isolates changeListeners errors.
    const rootA = tempDir('live-swap-a')
    const rootB = tempDir('live-swap-b')
    const ext = new MemoryRuntime()
    const graphA = createRuntimeGraph(resolveConfig({ dataDir: rootA, storageScope: 'custom' }), undefined, ext)
    const graphB = createRuntimeGraph(resolveConfig({ dataDir: rootB, storageScope: 'custom' }), undefined, ext)
    const live = new LiveMnemonRuntime(graphA, undefined, undefined, ext)
    const healthyChangeListener = vi.fn()
    live.onChanged(() => { throw new Error('Listener failure during swap') })
    live.onChanged(healthyChangeListener)
    expect(() => live.swap(graphB)).not.toThrow()
    expect(healthyChangeListener).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
    live.dispose()
    await ext.dispose()
  })

  it('Bug #13 (parts 2 & 3): validates array schema.items in executeRoute and enforces minLength in subagent output schemas', async () => {
    const querySpy = vi.fn()
    const arraySourceDef = defineMemorySource({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION,
        kind: 'source',
        typeId: 'items-source',
        packageName: 'dsh-mnemon-source-items',
        role: 'working-context',
        capabilities: ['project', 'search'],
        consistency: 'exact-snapshot',
        routes: [{
          id: 'filter-by-tags',
          description: 'Filter items by string tags.',
          capability: 'search',
          inputSchema: {
            type: 'object',
            required: ['tags'],
            additionalProperties: false,
            properties: {
              tags: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          maxCalls: 2,
          maxResults: 5,
          maxCharacters: 500,
        }],
      },
      create: context => ({
        facts: () => ({
          sourceInstanceKey: context.sourceInstanceKey,
          sourceTypeId: 'items-source',
          role: 'working-context',
          availability: 'ready' as const,
          revision: 'r1',
          capabilities: ['project' as const, 'search' as const],
          routeIds: ['filter-by-tags'],
          actionIds: [],
        }),
        project: () => ({
          fragments: [],
          readGrant: {
            id: `${context.sourceInstanceKey}/grant`,
            sourceInstanceKey: context.sourceInstanceKey,
            schema: 'items/grant-v1',
            value: {},
            revision: 'g1',
            consistency: 'exact-snapshot' as const,
          },
        }),
        query: async req => {
          querySpy(req.input)
          return {
            id: 'ev-1',
            viewId: req.view.id,
            routeId: req.route.id,
            sourceInstanceKey: context.sourceInstanceKey,
            observedAt: '2026-08-30T00:00:00.000Z',
            items: [],
            truncated: false,
          }
        },
      }),
    })

    const arrayStrategyDef = defineMemoryStrategy({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION,
        kind: 'strategy',
        typeId: 'items-strategy',
        packageName: 'dsh-mnemon-strategy-items',
        deterministic: true,
        supportedSourceRoles: ['working-context'],
        maxSources: 4,
        maxRoutes: 4,
        maxActions: 4,
      },
      compose: (_request, sources) => ({
        strategyTypeId: 'items-strategy',
        sources: sources.map(item => ({
          sourceInstanceKey: item.sourceInstanceKey,
          mode: 'routed' as const,
          routeIds: ['filter-by-tags'],
        })),
        explanation: 'Route with array items schema.',
      }),
    })

    const evaluated = await evaluateMemoryComposition({
      contributions: {
        revision: 1,
        sources: [{
          kind: 'source',
          instanceKey: 'source:items-source',
          provenance: { packageName: 'dsh-mnemon-source-items', entryId: 'items-source' },
          definition: arraySourceDef,
        }],
        strategies: [{
          kind: 'strategy',
          instanceKey: 'strategy:items-strategy',
          provenance: { packageName: 'dsh-mnemon-strategy-items', entryId: 'items-strategy' },
          definition: arrayStrategyDef,
        }],
      },
      request: {
        scope: { storage: 'global' },
        scenario: 'test',
        budget: {
          maxProjectionCharacters: 1_000,
          maxRoutes: 4,
          maxActions: 4,
          maxEvidenceResults: 4,
          maxEvidenceCharacters: 500,
        },
      },
    })
    expect(evaluated.generation).toBeDefined()
    expect(evaluated.view).toBeDefined()
    const routeId = evaluated.view!.routes[0]!.id

    await expect(
      evaluated.generation!.executeRoute(evaluated.view!, routeId, { tags: ['valid', 42] }),
    ).rejects.toThrow('tags[1]')
    expect(querySpy).not.toHaveBeenCalled()

    await expect(
      evaluated.generation!.executeRoute(evaluated.view!, routeId, { tags: ['valid', 'also-valid'] }),
    ).resolves.toMatchObject({ items: [] })
    expect(querySpy).toHaveBeenCalledTimes(1)
    await evaluated.generation!.dispose()

    // Bug #13 part 3: minLength support in subagent-output-schema.ts
    const schema = {
      type: 'object',
      required: ['title'],
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 3 },
      },
    }
    expect(() => assertDshOutputSchema(schema, 'testSchema')).not.toThrow()
    expect(() => assertDshOutputSchema({
      type: 'object',
      required: ['title'],
      additionalProperties: false,
      properties: { title: { type: 'string', minLength: -1 } },
    }, 'badSchema')).toThrow('minLength')
    expect(() => assertDshOutputValue(schema, { title: 'ok-title' }, 'testValue')).not.toThrow()
    expect(() => assertDshOutputValue(schema, { title: 'no' }, 'testValue')).toThrow('at least 3')
  })

  it('Bug #14: honors npm_config_registry in fetchNpmLatest and resolves profile paths via configEditor / profileContext', async () => {
    const registryServer = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'dsh-mnemon', version: '9.8.7', requestedUrl: req.url }))
    })
    await new Promise<void>(resolveListening => registryServer.listen(0, '127.0.0.1', resolveListening))
    const port = (registryServer.address() as AddressInfo).port
    const previousRegistry = process.env.npm_config_registry

    try {
      process.env.npm_config_registry = `http://127.0.0.1:${port}/`
      await expect(fetchNpmLatest('dsh-mnemon', 'latest')).resolves.toBe('9.8.7')
    } finally {
      if (previousRegistry === undefined) delete process.env.npm_config_registry
      else process.env.npm_config_registry = previousRegistry
      await new Promise<void>(resolveClosed => registryServer.close(() => resolveClosed()))
    }

    // MemoryPluginInstallation resolves profile directory via configEditor.documentPath even when loader.config.baseUrl is absent.
    const dshHome = tempDir('dsh-home')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {} }))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

    const mockCtx = {
      get(serviceName: string) {
        if (serviceName === 'loader') return { entries: () => [] }
        if (serviceName === 'configEditor') return { documentPath: join(profileDir, 'cordis.patch.yml') }
        if (serviceName === 'profileContext') return { home: dshHome, dir: profileDir }
        return undefined
      },
    } as unknown as HostContextShape

    const installation = new MemoryPluginInstallation(mockCtx, {
      resolveDshCommand: () => ({ command: '/usr/local/bin/dsh', prefix: [] }),
    })
    expect(installation.environment()).toMatchObject({
      supported: true,
      profileName: 'desktop',
    })
  })
})
