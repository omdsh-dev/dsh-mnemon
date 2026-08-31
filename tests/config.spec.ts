import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'
import type { ProcessOptions, ProcessRunner } from '../src/process.ts'
import { createRunner } from '../src/runner.ts'

afterEach(() => vi.unstubAllEnvs())

describe('Mnemon config and resolution', () => {
  it('materializes conservative defaults', () => {
    expect(resolveConfig({})).toMatchObject({
      storageScope: 'global',
      runtimeUserScope: 'storage',
      timeoutMs: 10_000,
      defaultRecallLimit: 10,
      runtimeMemory: {
        memoryLimitBytes: 10_240,
        userLimitBytes: 4_096,
        maintenanceMaxTokens: 8_192,
      },
      embedding: {
        enabled: false,
        endpoint: 'http://localhost:11434',
        model: 'nomic-embed-text',
      },
      memoryTopology: {
        id: 'default-three-tier',
        strategyId: 'default-three-tier',
        layers: {
          runtime: { enabled: true, participation: { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' }, adapterIds: [] },
          documents: { enabled: true, participation: { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' }, adapterIds: [] },
          'memory-spaces': { enabled: true, participation: { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' }, adapterIds: [] },
        },
      },
      recallQuality: {
        policy: 'strict-v1',
        lowScoreThreshold: 0.25,
        highScoreThreshold: 0.6,
        candidateMultiplier: 3,
        maxMediumResults: 4,
        maxUnknownResults: 2,
      },
      routingGuidance: true,
      lifecycleEnabled: true,
      recallMode: 'guided',
      writebackMode: 'guided',
      idleReviewMs: 30_000,
      displayMode: 'sidebar',
      tabEnabled: true,
      writeEnabled: true,
      remoteAccess: 'read-only',
      conversationInteraction: { turnBar: true, saveAction: true },
      persistenceStrategy: {
        mode: 'manual',
        providerId: 'mnemon-native',
        prompt: '',
        rules: {
          allowedProviderIds: ['mnemon-native'],
          dataBoundary: 'allow-remote',
          requiredCapabilities: [],
          preference: 'balanced',
        },
        providerConnections: {},
      },
      taskAgentModel: { mode: 'inherit' },
    })
  })

  it('resolves independently switchable memory layer participation without deleting bindings', () => {
    expect(resolveConfig({
      memoryTopology: {
        layers: {
          documents: {
            enabled: false,
            participation: { recall: 'manual', write: 'off' },
            adapterIds: ['openviking', 'openviking'],
          },
        },
      },
    }).memoryTopology.layers.documents).toEqual({
      enabled: false,
      participation: { recall: 'manual', write: 'off', projection: 'automatic', maintenance: 'automatic' },
      adapterIds: ['openviking'],
    })
    expect(() => resolveConfig({ memoryTopology: { strategyId: '../unsafe' } })).toThrow('memory strategy id')
  })

  it('resolves all eight built-in Layer switch combinations without changing the fixed default policy', () => {
    const ids = ['runtime', 'documents', 'memory-spaces'] as const
    for (let mask = 0; mask < 8; mask += 1) {
      const layers = Object.fromEntries(ids.map((id, index) => [id, { enabled: (mask & (1 << index)) !== 0 }]))
      const resolved = resolveConfig({ memoryTopology: { layers } }).memoryTopology.layers
      for (const id of ids) {
        expect(resolved[id]).toEqual({
          enabled: layers[id]!.enabled,
          participation: { recall: 'automatic', write: 'automatic', projection: 'automatic', maintenance: 'automatic' },
          adapterIds: [],
        })
      }
    }
  })

  it('validates configurable recall quality policy thresholds and expansion', () => {
    expect(resolveConfig({
      recallQuality: { policy: 'team-v2', lowScoreThreshold: 0.2, highScoreThreshold: 0.7, candidateMultiplier: 2, maxMediumResults: 5, maxUnknownResults: 1 },
    }).recallQuality).toEqual({ policy: 'team-v2', lowScoreThreshold: 0.2, highScoreThreshold: 0.7, candidateMultiplier: 2, maxMediumResults: 5, maxUnknownResults: 1 })
    expect(() => resolveConfig({ recallQuality: { lowScoreThreshold: 0.7, highScoreThreshold: 0.6 } })).toThrow('less than')
    expect(() => resolveConfig({ recallQuality: { candidateMultiplier: 1.5 } })).toThrow('integer')
    expect(() => resolveConfig({ recallQuality: { policy: '../unsafe' } })).toThrow('policy id')
    expect(() => resolveConfig({ recallQuality: { maxMediumResults: 51 } })).toThrow('max medium')
    expect(() => resolveConfig({ recallQuality: { maxUnknownResults: -1 } })).toThrow('max unknown')
  })

  it('resolves bounded Runtime Memory capacity and maintenance budgets', () => {
    expect(resolveConfig({
      runtimeMemory: {
        memoryLimitBytes: 20_480,
        userLimitBytes: 10_240,
        maintenanceMaxTokens: 32_768,
      },
    }).runtimeMemory).toEqual({
      memoryLimitBytes: 20_480,
      userLimitBytes: 10_240,
      maintenanceMaxTokens: 32_768,
    })
    expect(() => resolveConfig({ runtimeMemory: { memoryLimitBytes: 0 } })).toThrow('MEMORY.md limit')
    expect(() => resolveConfig({ runtimeMemory: { userLimitBytes: 1.5 } })).toThrow('USER.md limit')
    expect(() => resolveConfig({ runtimeMemory: { maintenanceMaxTokens: 1_000_001 } })).toThrow('maintenance maxTokens')
  })

  it('inherits the DSH new-session model by default and validates fixed task routes', () => {
    expect(resolveConfig({}).taskAgentModel).toEqual({ mode: 'inherit' })
    expect(resolveConfig({
      taskAgentModel: { mode: 'fixed', provider: ' deepseek ', model: ' deepseek-chat ' },
    }).taskAgentModel).toEqual({ mode: 'fixed', provider: 'deepseek', model: 'deepseek-chat' })
    expect(() => resolveConfig({ taskAgentModel: { mode: 'fixed', provider: 'deepseek' } }))
      .toThrow('provider and model')
  })

  it('normalizes and validates DSH-managed Mnemon embedding settings', () => {
    expect(resolveConfig({
      embedding: { enabled: true, endpoint: ' https://ollama.example.test/prefix/// ', model: ' qwen3-embedding:0.6b ', apiKey: '  sk-secret  ' },
    }).embedding).toEqual({
      enabled: true,
      endpoint: 'https://ollama.example.test/prefix',
      model: 'qwen3-embedding:0.6b',
      apiKey: 'sk-secret',
      protocol: 'auto',
    })
    expect(resolveConfig({}).embedding).toMatchObject({ enabled: false, endpoint: 'http://localhost:11434', model: 'nomic-embed-text', apiKey: '', protocol: 'auto' })
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'ftp://ollama.example.test' } })).toThrow('HTTP or HTTPS')
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'http://user:secret@localhost:11434' } })).toThrow('without credentials')
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'http://localhost:11434?tenant=one' } })).toThrow('without credentials')
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'http://localhost:11434?' } })).toThrow('without credentials')
    expect(() => resolveConfig({ embedding: { enabled: true, endpoint: 'http://localhost:11434#' } })).toThrow('without credentials')
    expect(() => resolveConfig({ embedding: { enabled: true, model: 'bad\nmodel' } })).toThrow('control characters')
    expect(() => resolveConfig({ embedding: { enabled: true, apiKey: 'bad\nkey' } })).toThrow('without control characters')
    expect(() => resolveConfig({ embedding: { enabled: true, apiKey: 'k'.repeat(2049) } })).toThrow('0..2048')
    expect(() => resolveConfig({ embedding: { enabled: true, protocol: 'grpc' as never } })).toThrow('unsupported embedding protocol')
  })

  it('resolves a bounded automatic persistence strategy without changing its provider connections', () => {
    expect(resolveConfig({
      persistenceStrategy: {
        mode: 'automatic',
        prompt: 'Prefer shared project memory.',
        rules: {
          allowedProviderIds: ['mnemon-native', 'openviking', 'openviking'],
          dataBoundary: 'allow-remote',
          requiredCapabilities: ['graph'],
          preference: 'shared-first',
        },
        providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
      },
    }).persistenceStrategy).toEqual({
      mode: 'automatic',
      providerId: 'mnemon-native',
      prompt: 'Prefer shared project memory.',
      rules: {
        allowedProviderIds: ['mnemon-native', 'openviking'],
        dataBoundary: 'allow-remote',
        requiredCapabilities: ['graph'],
        preference: 'shared-first',
      },
      providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
    })
  })

  it('migrates the settings schema empty candidate list to the conservative manual default', () => {
    expect(resolveConfig({ persistenceStrategy: { mode: 'manual', rules: { allowedProviderIds: [] } } }).persistenceStrategy.rules.allowedProviderIds)
      .toEqual(['mnemon-native'])
    expect(() => resolveConfig({ persistenceStrategy: { mode: 'automatic', rules: { allowedProviderIds: [] } } }))
      .toThrow('at least one allowed provider')
  })

  it('retains the rc.2 management authority setting for branch-free rollback compatibility', () => {
    expect(resolveConfig({ remoteAccess: 'trusted-host' }).remoteAccess).toBe('trusted-host')
  })

  it('keeps explicit conversation-surface opt-outs', () => {
    expect(resolveConfig({ conversationInteraction: { turnBar: false, saveAction: false } }).conversationInteraction)
      .toMatchObject({ turnBar: false, saveAction: false })
  })

  it.each(['builtin', 'sidebar'] as const)('preserves displayMode=%s without changing storage or visibility', displayMode => {
    const legacy = { displayMode, storageScope: 'workspace' as const, tabEnabled: false, writeEnabled: false }
    const parsed = Config(legacy)
    expect(resolveConfig(parsed)).toMatchObject({ displayMode, storageScope: 'workspace', tabEnabled: false, writeEnabled: false })
    expect(resolveConfig({}).displayMode).toBe('sidebar')
    expect(Config({}).displayMode).toBe('sidebar')
    expect(legacy).toEqual({ displayMode, storageScope: 'workspace', tabEnabled: false, writeEnabled: false })
  })

  it('normalizes legacy buildin input to builtin without changing storage, visibility, or caller data', () => {
    const legacy = { displayMode: 'buildin' as const, storageScope: 'workspace' as const, tabEnabled: false }
    expect(resolveConfig(Config(legacy))).toMatchObject({ displayMode: 'builtin', storageScope: 'workspace', tabEnabled: false })
    expect(resolveConfig(legacy).displayMode).toBe('builtin')
    expect(legacy.displayMode).toBe('buildin')
  })

  it.each(['built-in', 'Builtin', 'unknown', '', true])('rejects invalid displayMode=%s', displayMode => {
    expect(() => Config({ displayMode } as never)).toThrow()
    expect(() => resolveConfig({ displayMode } as never)).toThrow('displayMode')
  })

  it('resolves the one storage-scope setting and preserves legacy dataDir as custom', () => {
    expect(resolveConfig({ storageScope: 'workspace' })).toMatchObject({ storageScope: 'workspace' })
    expect(resolveConfig({ dataDir: '/memory/custom' })).toMatchObject({
      storageScope: 'custom', dataDir: '/memory/custom',
    })
    expect(() => resolveConfig({ storageScope: 'custom' })).toThrow('custom dataDir')
    expect(() => resolveConfig({ storageScope: 'custom', dataDir: 'relative/memory' })).toThrow('absolute')
  })

  it('keeps USER.md on the selected root by default and accepts an explicit global profile', () => {
    expect(resolveConfig({ storageScope: 'workspace' })).toMatchObject({ storageScope: 'workspace', runtimeUserScope: 'storage' })
    expect(resolveConfig({ storageScope: 'workspace', runtimeUserScope: 'global' })).toMatchObject({ storageScope: 'workspace', runtimeUserScope: 'global' })
    expect(() => resolveConfig({ runtimeUserScope: 'workspace' as never })).toThrow('USER.md scope')
  })

  it('migrates the selected root from the former named-Pack settings', () => {
    expect(resolveConfig({
      storageScope: 'custom',
      customPackId: 'research',
      customPacks: [
        { id: 'project', name: 'Project', dataDir: '/memory/project' },
        { id: 'research', name: 'Research', dataDir: '~/memory/research' },
      ],
    })).toMatchObject({
      storageScope: 'custom',
      dataDir: '~/memory/research',
    })
  })

  it('rejects duplicate, missing, and unsafe custom Pack definitions', () => {
    expect(() => resolveConfig({ customPacks: [{ id: 'same', name: 'One', dataDir: '/one' }, { id: 'same', name: 'Two', dataDir: '/two' }] })).toThrow('duplicate')
    expect(() => resolveConfig({ storageScope: 'custom', customPackId: 'missing', customPacks: [{ id: 'other', name: 'Other', dataDir: '/other' }] })).toThrow('unknown custom Pack')
    expect(() => resolveConfig({ customPacks: [{ id: '../bad', name: 'Bad', dataDir: '/bad' }] })).toThrow('id')
  })

  it('rejects unsafe store names', () => {
    expect(() => resolveConfig({ store: '../other' })).toThrow('store')
  })

  it('preserves Mnemon environment and active-store semantics when config is omitted', () => {
    vi.stubEnv('MNEMON_DATA_DIR', '/memory-root')
    vi.stubEnv('MNEMON_STORE', 'shared')
    const process: ProcessRunner = async () => ({ stdout: '{}', stderr: '', exitCode: 0 })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)
    expect(runner.effectiveDataDir()).toBe('/memory-root')
    expect(runner.effectiveStore()).toBe('shared')
  })

  it('injects saved embedding overrides into every Mnemon process without changing the Host environment', async () => {
    vi.stubEnv('MNEMON_EMBED_ENDPOINT', 'http://launchctl.example:11434')
    vi.stubEnv('MNEMON_EMBED_MODEL', 'launchctl-model')
    vi.stubEnv('MNEMON_EMBED_API_KEY', 'host-secret')
    vi.stubEnv('MNEMON_EMBED_PROTOCOL', 'openai')
    vi.stubEnv('MNEMON_EMBED_DIMENSIONS', '256')
    const processRunner = vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    const runner = createRunner(resolveConfig({
      cliPath: '/fake/mnemon',
      embedding: { enabled: true, endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b' },
    }), processRunner)

    await runner.runText(['status'])

    expect(processRunner).toHaveBeenCalledWith('/fake/mnemon', ['status'], expect.objectContaining({
      env: expect.objectContaining({
        MNEMON_EMBED_ENDPOINT: 'http://127.0.0.1:11434',
        MNEMON_EMBED_MODEL: 'qwen3-embedding:0.6b',
        MNEMON_EMBED_API_KEY: '',
        MNEMON_EMBED_DIMENSIONS: '256',
      }),
    }))
    const options = processRunner.mock.calls[0]![2] as ProcessOptions
    expect(options.env?.MNEMON_EMBED_PROTOCOL).toBeUndefined()
    expect(process.env.MNEMON_EMBED_ENDPOINT).toBe('http://launchctl.example:11434')
    expect(process.env.MNEMON_EMBED_MODEL).toBe('launchctl-model')
    expect(process.env.MNEMON_EMBED_API_KEY).toBe('host-secret')
  })

  it('forwards a saved embedding API key and protocol over the inherited Host environment', async () => {
    vi.stubEnv('MNEMON_EMBED_API_KEY', 'host-secret')
    const processRunner = vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    const runner = createRunner(resolveConfig({
      cliPath: '/fake/mnemon',
      embedding: { enabled: true, endpoint: 'http://127.0.0.1:8080/api', model: 'bge-m3-mlx-8bit', apiKey: ' sk-managed ', protocol: 'openai' },
    }), processRunner)

    await runner.runText(['status'])

    expect(processRunner).toHaveBeenCalledWith('/fake/mnemon', ['status'], expect.objectContaining({
      env: expect.objectContaining({
        MNEMON_EMBED_API_KEY: 'sk-managed',
        MNEMON_EMBED_PROTOCOL: 'openai',
      }),
    }))
  })

  it('leaves child environment inheritance untouched when the DSH override is disabled', async () => {
    vi.stubEnv('MNEMON_EMBED_ENDPOINT', 'http://launchctl.example:11434')
    const processRunner = vi.fn<ProcessRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    const runner = createRunner(resolveConfig({
      cliPath: '/fake/mnemon',
      embedding: { enabled: false, endpoint: 'http://ignored.example:11434', model: 'ignored' },
    }), processRunner)

    await runner.runText(['status'])

    expect(processRunner.mock.calls[0]![2]).not.toHaveProperty('env')
  })

  it('serializes CLI processes so concurrent WebUI reads cannot race Mnemon migrations', async () => {
    let active = 0
    let maximumActive = 0
    const process = vi.fn<ProcessRunner>(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return { stdout: '{}', stderr: '', exitCode: 0 }
    })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)

    await Promise.all([
      runner.runText(['status']),
      runner.runText(['viz', '--format', 'html', '--output', '-']),
      runner.runText(['--version'], { globalFlags: false }),
    ])

    expect(process).toHaveBeenCalledTimes(3)
    expect(maximumActive).toBe(1)
  })

  it('continues the CLI queue after one command fails', async () => {
    const process = vi.fn<ProcessRunner>()
      .mockResolvedValueOnce({ stdout: '', stderr: 'locked', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: 'recovered', stderr: '', exitCode: 0 })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)

    await expect(runner.runText(['status'])).rejects.toThrow('locked')
    await expect(runner.runText(['--version'], { globalFlags: false })).resolves.toBe('recovered')
  })

  it('keeps a related CLI batch contiguous in the shared process queue', async () => {
    const events: string[] = []
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      events.push(String(args.at(-1)))
      await Promise.resolve()
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)

    const batch = runner.runTextBatch([{ args: ['first'] }, { args: ['second'] }])
    const queued = runner.runText(['third'])
    await Promise.all([batch, queued])

    expect(events).toEqual(['first', 'second', 'third'])
  })

  it('points launch failures at the environment variable and actual settings namespace', async () => {
    const process = vi.fn<ProcessRunner>().mockRejectedValue(new Error('spawn mnemon ENOENT'))
    const runner = createRunner(resolveConfig({ cliPath: '/missing/mnemon' }), process)

    await expect(runner.runText(['status'])).rejects.toThrow('MNEMON_CLI_PATH or mnemon.cliPath')
  })

  it('holds the CLI queue across one exclusive Pack operation', async () => {
    const events: string[] = []
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      events.push(`cli:${args.at(-1)}:start`)
      await Promise.resolve()
      events.push(`cli:${args.at(-1)}:end`)
      return { stdout: '{}', stderr: '', exitCode: 0 }
    })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)

    const first = runner.runText(['first'])
    const exclusive = runner.withExclusive(async () => {
      events.push('pack:start')
      await Promise.resolve()
      events.push('pack:end')
    })
    const second = runner.runText(['second'])
    await Promise.all([first, exclusive, second])

    expect(events).toEqual(['cli:first:start', 'cli:first:end', 'pack:start', 'pack:end', 'cli:second:start', 'cli:second:end'])
  })
})
